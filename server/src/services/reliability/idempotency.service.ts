import crypto from 'crypto';
import { Types } from 'mongoose';
import type { Request } from 'express';
import {
  IDEMPOTENCY_LEASE_MS,
  IDEMPOTENCY_RETENTION_MS,
  IdempotencyRecordModel,
  type IdempotencyRecordDoc,
} from '../../models/IdempotencyRecord';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';
import type { TenantContext } from '../../types/express';

/**
 * Idempotency for write operations that must not happen twice.
 *
 * WHAT IT GUARANTEES. For one scope and one client key: the operation runs at
 * most once, a retry after success replays the original result, a retry while
 * the first is still running is refused rather than duplicated, and the same
 * key with different business input is refused rather than silently answering
 * about a different operation.
 *
 * WHAT IT DOES NOT GUARANTEE, and does not claim: exactly-once execution. The
 * claim and the business write are two MongoDB operations, and the flows this
 * protects deliberately do not use transactions - they use guarded `$inc` and
 * compensation instead, which is what makes them correct on the standalone
 * MongoDB this project also supports. So a process that dies between
 * committing a sale and marking the record completed leaves a claim whose lease
 * expires; the retry then re-runs the operation. That window is one update wide
 * and is the honest limit of this design. Closing it would mean putting the
 * claim inside the same transaction as the sale, which needs a replica set and
 * a change to flows this phase is not allowed to redesign.
 *
 * WHERE IT SITS. At the controller, wrapping the service call. The sale and
 * order services are not touched at all, which is the strongest guarantee
 * available that no business rule moved.
 */

/** Keys are opaque to us, but they are still untrusted input. */
const KEY_PATTERN = /^[A-Za-z0-9_:.-]{8,200}$/;

/**
 * Reads and validates the client's key.
 *
 * `Idempotency-Key` is the header; a `idempotencyKey` field in the body is
 * accepted too, because several flows in this codebase already take it that
 * way and a client should not have to care which. Absent is allowed - see
 * `runIdempotent`.
 */
export function readIdempotencyKey(req: Request): string | null {
  const header = req.header('Idempotency-Key');
  const body = (req.body as { idempotencyKey?: unknown } | undefined)?.idempotencyKey;
  const raw = typeof header === 'string' && header.trim() ? header : typeof body === 'string' ? body : null;
  if (raw === null) return null;

  const key = raw.trim();
  if (!KEY_PATTERN.test(key)) {
    throw ApiError.badRequest(
      'Idempotency-Key must be 8-200 characters of letters, digits, and - _ : . only.',
    );
  }
  return key;
}

/**
 * A stable string for any JSON-ish value.
 *
 * `JSON.stringify` is not usable for a fingerprint: object key order follows
 * insertion order, so the same logical request serialised by two clients - or
 * by the same client after an innocuous refactor - can produce different bytes
 * and a spurious conflict. This sorts object keys at every depth, keeps array
 * order (which is meaningful: sale lines), and renders types distinctly so that
 * `1` and `"1"` do not collide.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undef';
  if (value instanceof Date) return `d:${value.toISOString()}`;
  if (value instanceof Types.ObjectId) return `o:${value.toHexString()}`;
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;

  switch (typeof value) {
    case 'string':
      return `s:${value}`;
    case 'number':
      return `n:${value}`;
    case 'boolean':
      return `b:${value}`;
    case 'object': {
      const entries = Object.entries(value as Record<string, unknown>)
        // Dropped so an absent field and an explicit undefined fingerprint alike.
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${k}:${canonicalize(v)}`).join(',')}}`;
    }
    default:
      return `?:${String(value)}`;
  }
}

/**
 * The fingerprint of the business input.
 *
 * Only what decides the operation goes in. Never the Authorization header,
 * cookies, a trace id, or a timestamp the client regenerates on every retry -
 * any of those would make every retry look like a different request and defeat
 * the whole mechanism. Identity is not hashed in either: tenant and store are
 * part of the SCOPE, which is a stronger separation than a hash.
 *
 * The key itself is excluded, so sending it in the body and in the header
 * produce the same fingerprint.
 */
export function fingerprintOf(input: unknown): string {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : input;
  if (body && typeof body === 'object') delete (body as Record<string, unknown>).idempotencyKey;
  return crypto.createHash('sha256').update(canonicalize(body)).digest('hex');
}

/** A short, non-reversible reference, so a log never carries the key itself. */
const keyRef = (key: string) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);

export interface IdempotentOperation<T, R = T> {
  ctx: TenantContext;
  /** Short, stable name. Part of the scope, so it must not change casually. */
  operation: string;
  /** The client's key, or null for an unprotected request. */
  key: string | null;
  /** The business input the fingerprint is taken from. */
  input: unknown;
  /** Does the work. Called at most once per key. */
  run: () => Promise<T>;
  /** Extracts the id of what `run` created, so a retry can replay it. */
  resultId: (result: T) => Types.ObjectId | string;
  /**
   * Loads the original result for a replay. Its type may differ from `run`'s -
   * a create often returns a hydrated document where a read returns a lean one -
   * so the two are generic independently rather than forced together with a cast.
   */
  replay: (id: Types.ObjectId) => Promise<R>;
  /** Collection the result lives in, recorded so a replay cannot read the wrong thing. */
  resultKind: string;
}

type Record_ = IdempotencyRecordDoc & { _id: Types.ObjectId };

/**
 * Runs an operation at most once per key.
 *
 * WITHOUT A KEY the operation simply runs, exactly as it did before this
 * existed. That is a deliberate, documented choice: making the header
 * mandatory would break every client that has not been updated yet, and a
 * silent server-generated key would protect nothing, since a retry would carry
 * a different one. The tills in this repository send a key; anything that does
 * not is unprotected and says so in the docs.
 */
export async function runIdempotent<T, R = T>(operation: IdempotentOperation<T, R>): Promise<T | R> {
  const { ctx, key } = operation;
  if (!key) return operation.run();

  const scope = `${String(ctx.tenantId)}:${ctx.storeId ? String(ctx.storeId) : '-'}:${operation.operation}`;
  const fingerprint = fingerprintOf(operation.input);
  const now = new Date();

  // One atomic upsert IS the claim. `returnDocument: 'before'` is null only
  // when this call inserted the record, so exactly one of two concurrent
  // requests owns the work and the other is told what is already happening.
  let previous: Record_ | null;
  try {
    previous = await IdempotencyRecordModel.findOneAndUpdate(
      { scope, key },
      {
        $setOnInsert: {
          scope,
          key,
          fingerprint,
          status: 'processing',
          tenantId: ctx.tenantId,
          storeId: ctx.storeId ?? null,
          operation: operation.operation,
          resultId: null,
          resultKind: operation.resultKind,
          claimedUntil: new Date(now.getTime() + IDEMPOTENCY_LEASE_MS),
          completedAt: null,
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_RETENTION_MS),
        },
      },
      { upsert: true, returnDocument: 'before' },
    ).lean<Record_>();
  } catch (error) {
    // Two inserts raced on the unique index. The other one won, so this request
    // behaves exactly as if it had read that record.
    if ((error as { code?: number }).code !== 11000) throw error;
    previous = await IdempotencyRecordModel.findOne({ scope, key }).lean<Record_>();
    if (!previous) throw error;
  }

  if (previous) {
    // A key is a promise about one operation. Reused with different input it is
    // a client bug, and answering about the first operation would be worse than
    // refusing.
    if (previous.fingerprint !== fingerprint) {
      logger.warn('An idempotency key was reused with different input', {
        operation: operation.operation,
        keyRef: keyRef(key),
        tenantId: String(ctx.tenantId),
      });
      throw new ApiError(
        'IDEMPOTENCY_KEY_CONFLICT',
        'This Idempotency-Key was already used for a different request. Use a new key.',
      );
    }

    if (previous.status === 'completed' && previous.resultId) {
      return operation.replay(previous.resultId);
    }

    // Still running. The request is refused rather than held: waiting would tie
    // up a connection for as long as the first one takes, and a till that gets
    // a clear "already in progress" can ask again in a moment.
    const leaseLive = previous.claimedUntil !== null && previous.claimedUntil > now;
    if (leaseLive) {
      throw new ApiError(
        'IDEMPOTENCY_IN_PROGRESS',
        'This request is already being processed. Wait a moment and ask again with the same key.',
      );
    }

    // The lease has expired, so whoever held it is gone. Take it over - but by
    // compare-and-swap on the exact lease we read, so that two requests finding
    // the same dead claim cannot both proceed.
    const taken = await IdempotencyRecordModel.findOneAndUpdate(
      { _id: previous._id, status: 'processing', claimedUntil: previous.claimedUntil },
      { $set: { claimedUntil: new Date(now.getTime() + IDEMPOTENCY_LEASE_MS) } },
      { returnDocument: 'after' },
    ).lean<Record_>();
    if (!taken) {
      throw new ApiError(
        'IDEMPOTENCY_IN_PROGRESS',
        'This request is already being processed. Wait a moment and ask again with the same key.',
      );
    }
    logger.info('Recovered an abandoned idempotent operation', {
      operation: operation.operation,
      keyRef: keyRef(key),
    });
  }

  try {
    const result = await operation.run();

    await IdempotencyRecordModel.updateOne(
      { scope, key },
      {
        $set: {
          status: 'completed',
          resultId: new Types.ObjectId(String(operation.resultId(result))),
          resultKind: operation.resultKind,
          claimedUntil: null,
          completedAt: new Date(),
          // Retention starts when the operation finished, not when it began.
          expiresAt: new Date(Date.now() + IDEMPOTENCY_RETENTION_MS),
        },
      },
    );

    return result;
  } catch (error) {
    // The operation did NOT happen, so the key must not be spent. A rejected
    // sale - no stock, a bad line, an inactive plan - is something the cashier
    // fixes and tries again, usually with the same key from the same screen;
    // a poisoned key would turn one validation error into a dead till.
    await IdempotencyRecordModel.deleteOne({ scope, key, status: 'processing' }).catch(() => undefined);
    throw error;
  }
}
