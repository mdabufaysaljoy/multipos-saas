/**
 * Idempotency: the shared mechanism, against a real MongoDB.
 *
 * WHY HERE AND NOT OVER HTTP. The HTTP suite proves a retried checkout returns
 * the same sale. It cannot reach any of what follows, because all of it is
 * about what happens when a request is INTERRUPTED or RACED - two requests
 * claiming the same key in the same millisecond, a claim whose lease died with
 * the process holding it, a key reused with a different basket. Over HTTP those
 * need a crash at an exact instant; here the record can simply be put into the
 * state a crash would have left, and the DATABASE is what gets asserted, not a
 * status code.
 *
 * The unique index and the concurrency it guards are real: this runs against
 * the throwaway test database, so `findOneAndUpdate` upserts really do race.
 *
 * NOT COVERED: transactions. These flows deliberately do not use them - they
 * use guarded `$inc` and compensation, which is what makes them correct on the
 * standalone MongoDB this project supports - and the test database is
 * standalone, so no transaction path is exercised or claimed.
 *
 * Run as part of `npm test`.
 */
import mongoose, { Types } from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/db';
import {
  IDEMPOTENCY_LEASE_MS,
  IDEMPOTENCY_RETENTION_MS,
  IdempotencyRecordModel,
} from '../models/IdempotencyRecord';
import {
  canonicalize,
  fingerprintOf,
  readIdempotencyKey,
  runIdempotent,
} from '../services/reliability/idempotency.service';
import { ApiError } from '../utils/ApiError';
import type { TenantContext } from '../types/express';

let passed = 0;
let failed = 0;
const check = (label: string, condition: boolean, detail?: unknown) => {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${label}`, detail ?? '');
  }
};

const tenantA = new Types.ObjectId();
const tenantB = new Types.ObjectId();
const storeId = new Types.ObjectId();
const ctxFor = (tenantId: Types.ObjectId): TenantContext =>
  ({ tenantId, storeId, userId: new Types.ObjectId(), userName: 'Checker' }) as TenantContext;

/** Stands in for a sale: counts how many times the "business operation" ran. */
function fakeOperation() {
  const created: Types.ObjectId[] = [];
  const run = async () => {
    const _id = new Types.ObjectId();
    created.push(_id);
    return { _id, saleNumber: `S-${created.length}` };
  };
  return { created, run };
}

const errorCodeOf = async (work: () => Promise<unknown>): Promise<string | null> => {
  try {
    await work();
    return null;
  } catch (error) {
    return error instanceof ApiError ? error.code : `throw:${String(error)}`;
  }
};

async function main(): Promise<void> {
  await connectDatabase();
  // The unique index must exist for any of this to mean anything.
  await IdempotencyRecordModel.syncIndexes();
  console.log('\n  Idempotency (shared mechanism)\n');

  // 1. The unique index is really there -----------------------------------

  const indexes = await IdempotencyRecordModel.collection.indexes();
  const unique = indexes.find((i) => i.unique && JSON.stringify(i.key) === JSON.stringify({ scope: 1, key: 1 }));
  check('A unique index on (scope, key) exists', Boolean(unique), indexes.map((i) => i.name));
  const ttl = indexes.find((i) => typeof i.expireAfterSeconds === 'number');
  check('...and a TTL index, so records cannot accumulate for ever', Boolean(ttl), ttl);

  // 2. Canonicalisation and fingerprinting --------------------------------

  check(
    'Key order does not change the fingerprint',
    fingerprintOf({ a: 1, b: [2, 3] }) === fingerprintOf({ b: [2, 3], a: 1 }),
  );
  check(
    'Nested key order does not either',
    fingerprintOf({ x: { p: 1, q: 2 } }) === fingerprintOf({ x: { q: 2, p: 1 } }),
  );
  check('Array ORDER does matter - sale lines are not a set', fingerprintOf({ i: [1, 2] }) !== fingerprintOf({ i: [2, 1] }));
  check('A changed amount changes the fingerprint', fingerprintOf({ amountMinor: 100 }) !== fingerprintOf({ amountMinor: 101 }));
  check('A number and its string are not the same input', fingerprintOf({ v: 1 }) !== fingerprintOf({ v: '1' }));
  check('The key itself is excluded', fingerprintOf({ a: 1, idempotencyKey: 'k1' }) === fingerprintOf({ a: 1, idempotencyKey: 'k2' }));
  check('An absent field and an undefined one agree', fingerprintOf({ a: 1 }) === fingerprintOf({ a: 1, b: undefined }));
  check('An ObjectId is canonical by value, not by identity', canonicalize(new Types.ObjectId('6540000000000000000000aa')) === 'o:6540000000000000000000aa');
  check('A fingerprint is a sha256 hex digest', /^[0-9a-f]{64}$/.test(fingerprintOf({ a: 1 })));

  // 3. Key validation ------------------------------------------------------

  const asReq = (headers: Record<string, string>, body: unknown = {}) =>
    ({ header: (name: string) => headers[name.toLowerCase()], body }) as never;

  check('A header key is read', readIdempotencyKey(asReq({ 'idempotency-key': 'abcd1234' })) === 'abcd1234');
  check('A body key is accepted too', readIdempotencyKey(asReq({}, { idempotencyKey: 'abcd1234' })) === 'abcd1234');
  check('The header wins when both are sent', readIdempotencyKey(asReq({ 'idempotency-key': 'header-key-1' }, { idempotencyKey: 'body-key-1' })) === 'header-key-1');
  check('No key is allowed', readIdempotencyKey(asReq({})) === null);
  for (const bad of ['short', 'has spaces here', 'a'.repeat(201), 'bad/chars!!']) {
    check(`A malformed key is refused: "${bad.slice(0, 20)}"`, (await errorCodeOf(async () => readIdempotencyKey(asReq({ 'idempotency-key': bad })))) === 'BAD_REQUEST');
  }

  // 4. First request, then a retry -----------------------------------------

  {
    const op = fakeOperation();
    const call = (key: string | null, input: unknown = { items: [1], total: 500 }) =>
      runIdempotent({
        ctx: ctxFor(tenantA),
        operation: 'check.sale',
        key,
        input,
        resultKind: 'FakeSale',
        run: op.run,
        resultId: (r) => r._id,
        replay: async (id) => ({ _id: id, saleNumber: 'replayed', replayed: true }),
      });

    const first = await call('first-request-key-1');
    check('The first request runs the operation', op.created.length === 1, op.created.length);
    check('...and returns its result', first._id.equals(op.created[0]!), first);

    const record = await IdempotencyRecordModel.findOne({ key: 'first-request-key-1' }).lean();
    check('A completed record is stored', record?.status === 'completed', record?.status);
    check('...scoped to the workspace and branch', record?.scope === `${String(tenantA)}:${String(storeId)}:check.sale`, record?.scope);
    check('...naming what it produced', String(record?.resultId) === String(op.created[0]) && record?.resultKind === 'FakeSale', record);
    check('...with its lease released', record?.claimedUntil === null);
    check('...and no request body stored anywhere on it', !JSON.stringify(record).includes('items'), record);

    const retry = await call('first-request-key-1');
    check('A retry does NOT run the operation again', op.created.length === 1, op.created.length);
    check('...and replays the original result', String((retry as { _id: Types.ObjectId })._id) === String(op.created[0]), retry);
    check('...marked as a replay', (retry as { replayed?: boolean }).replayed === true);
  }

  // 5. Same key, different payload -> conflict ------------------------------

  {
    const op = fakeOperation();
    const call = (key: string, input: unknown) =>
      runIdempotent({
        ctx: ctxFor(tenantA),
        operation: 'check.sale',
        key,
        input,
        resultKind: 'FakeSale',
        run: op.run,
        resultId: (r) => r._id,
        replay: async (id) => ({ _id: id, saleNumber: 'replayed' }),
      });

    await call('conflict-key-0001', { items: [1], total: 500 });
    const code = await errorCodeOf(() => call('conflict-key-0001', { items: [1], total: 900 }));
    check('A reused key with different input is refused', code === 'IDEMPOTENCY_KEY_CONFLICT', code);
    check('...and the operation never ran a second time', op.created.length === 1, op.created.length);

    // The same input still replays, so the conflict is about the input only.
    const same = await call('conflict-key-0001', { items: [1], total: 500 });
    check('...while the original input still replays', Boolean(same) && op.created.length === 1);
  }

  // 6. Tenant isolation ----------------------------------------------------

  {
    const op = fakeOperation();
    const call = (tenantId: Types.ObjectId) =>
      runIdempotent({
        ctx: ctxFor(tenantId),
        operation: 'check.sale',
        key: 'shared-key-across-tenants',
        input: { items: [1] },
        resultKind: 'FakeSale',
        run: op.run,
        resultId: (r) => r._id,
        replay: async (id) => ({ _id: id, saleNumber: 'replayed' }),
      });

    await call(tenantA);
    await call(tenantB);
    check('The same key in two workspaces runs twice, not once', op.created.length === 2, op.created.length);
    const records = await IdempotencyRecordModel.find({ key: 'shared-key-across-tenants' }).lean();
    check('...as two separate records', records.length === 2, records.length);
    check('...with different scopes', new Set(records.map((r) => r.scope)).size === 2);
  }

  // 7. Concurrency: one operation, whatever the race -----------------------

  {
    const op = fakeOperation();
    const call = () =>
      runIdempotent({
        ctx: ctxFor(tenantA),
        operation: 'check.sale',
        key: 'concurrent-key-00001',
        input: { items: [1], total: 500 },
        resultKind: 'FakeSale',
        run: async () => {
          // Slow enough that every racer is inside the window at once.
          await new Promise((resolve) => setTimeout(resolve, 60));
          return op.run();
        },
        resultId: (r) => r._id,
        replay: async (id) => ({ _id: id, saleNumber: 'replayed' }),
      });

    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => call()));
    check('Eight simultaneous requests run the operation exactly ONCE', op.created.length === 1, op.created.length);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled').length;
    const inProgress = outcomes.filter(
      (o) => o.status === 'rejected' && (o.reason as ApiError)?.code === 'IDEMPOTENCY_IN_PROGRESS',
    ).length;
    check('...one is served and the rest are told it is in progress', fulfilled === 1 && inProgress === 7, { fulfilled, inProgress });

    // And the database holds exactly one record for the key.
    check('...leaving one record', (await IdempotencyRecordModel.countDocuments({ key: 'concurrent-key-00001' })) === 1);

    // Once finished, a later retry replays rather than re-running.
    const later = await call();
    check('...and a later retry replays it', op.created.length === 1 && Boolean(later), op.created.length);
  }

  // 8. A failed operation does not spend the key ---------------------------

  {
    let attempts = 0;
    const call = () =>
      runIdempotent({
        ctx: ctxFor(tenantA),
        operation: 'check.sale',
        key: 'failing-key-000001',
        input: { items: [1] },
        resultKind: 'FakeSale',
        run: async () => {
          attempts += 1;
          if (attempts === 1) throw ApiError.badRequest('Not enough stock');
          return { _id: new Types.ObjectId(), saleNumber: 'S-ok' };
        },
        resultId: (r) => r._id,
        replay: async (id) => ({ _id: id, saleNumber: 'replayed' }),
      });

    const code = await errorCodeOf(call);
    check('A rejected operation surfaces its own error', code === 'BAD_REQUEST', code);
    check('...and leaves no record behind', (await IdempotencyRecordModel.countDocuments({ key: 'failing-key-000001' })) === 0);

    const retried = await call();
    check('...so the cashier can fix it and try again with the same key', attempts === 2 && Boolean(retried));
    check('...and that attempt is recorded as completed', (await IdempotencyRecordModel.findOne({ key: 'failing-key-000001' }).lean())?.status === 'completed');
  }

  // 9. Recovery from a process that died mid-operation ---------------------

  {
    const op = fakeOperation();
    const call = () =>
      runIdempotent({
        ctx: ctxFor(tenantA),
        operation: 'check.sale',
        key: 'abandoned-key-00001',
        input: { items: [1] },
        resultKind: 'FakeSale',
        run: op.run,
        resultId: (r) => r._id,
        replay: async (id) => ({ _id: id, saleNumber: 'replayed' }),
      });

    // What a crash leaves: a claim, still processing, lease not yet expired.
    await IdempotencyRecordModel.create({
      scope: `${String(tenantA)}:${String(storeId)}:check.sale`,
      key: 'abandoned-key-00001',
      fingerprint: fingerprintOf({ items: [1] }),
      status: 'processing',
      tenantId: tenantA,
      storeId,
      operation: 'check.sale',
      claimedUntil: new Date(Date.now() + IDEMPOTENCY_LEASE_MS),
      expiresAt: new Date(Date.now() + IDEMPOTENCY_RETENTION_MS),
    });

    const blocked = await errorCodeOf(call);
    check('A live claim blocks a second attempt', blocked === 'IDEMPOTENCY_IN_PROGRESS', blocked);
    check('...and nothing ran', op.created.length === 0);

    // The lease expires: whoever held it is gone.
    await IdempotencyRecordModel.updateOne({ key: 'abandoned-key-00001' }, { $set: { claimedUntil: new Date(Date.now() - 1_000) } });
    const recovered = await call();
    check('An expired claim is taken over and the operation runs', op.created.length === 1 && Boolean(recovered), op.created.length);
    check('...and is then completed', (await IdempotencyRecordModel.findOne({ key: 'abandoned-key-00001' }).lean())?.status === 'completed');

    // Two requests finding the same dead claim must not both proceed.
    await IdempotencyRecordModel.updateOne(
      { key: 'abandoned-key-00001' },
      { $set: { status: 'processing', claimedUntil: new Date(Date.now() - 1_000), resultId: null } },
    );
    const before = op.created.length;
    const raced = await Promise.allSettled([call(), call(), call()]);
    check('Only one request takes over an expired claim', op.created.length === before + 1, op.created.length - before);
    check(
      '...and the others are told it is in progress',
      raced.filter((o) => o.status === 'rejected' && (o.reason as ApiError)?.code === 'IDEMPOTENCY_IN_PROGRESS').length === 2,
      raced.map((o) => (o.status === 'rejected' ? (o.reason as ApiError)?.code : 'ok')),
    );
  }

  // 10. No key means no protection, as documented ---------------------------

  {
    const op = fakeOperation();
    const call = () =>
      runIdempotent({
        ctx: ctxFor(tenantA),
        operation: 'check.sale',
        key: null,
        input: { items: [1] },
        resultKind: 'FakeSale',
        run: op.run,
        resultId: (r) => r._id,
        replay: async (id) => ({ _id: id, saleNumber: 'replayed' }),
      });

    await call();
    await call();
    check('Without a key the operation runs every time', op.created.length === 2, op.created.length);
    check('...and no record is written at all', (await IdempotencyRecordModel.countDocuments({ operation: 'check.sale', key: null })) === 0);
  }

  // 11. Retention ----------------------------------------------------------

  {
    const record = await IdempotencyRecordModel.findOne({ key: 'first-request-key-1' }).lean();
    const window = (record?.expiresAt?.getTime() ?? 0) - Date.now();
    check('A completed record is kept for about a day', window > 23 * 60 * 60 * 1000 && window <= IDEMPOTENCY_RETENTION_MS + 1_000, window);
  }

  await IdempotencyRecordModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });

  console.log(`\n==========  ${passed} passed, ${failed} failed  ==========\n`);
  await disconnectDatabase();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error('Idempotency check crashed:', error);
  await mongoose.connection.close().catch(() => undefined);
  process.exit(1);
});
