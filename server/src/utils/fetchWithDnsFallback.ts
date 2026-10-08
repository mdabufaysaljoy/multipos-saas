import { request as httpsRequest } from 'node:https';
import { resolve4 } from 'node:dns/promises';

/**
 * An HTTPS call that survives one broken DNS record.
 *
 * Some hosts publish an address that does not answer while the service itself
 * is up on the same infrastructure as the rest of the domain - a stale record,
 * a dead origin behind a CDN, or an address a particular network cannot route
 * to. The call then fails at connect time, which looks from the outside
 * exactly like the service being down.
 *
 * So a connect failure is retried against the addresses of a SIBLING hostname
 * (for `api.example.com`, the addresses of `example.com`), which is where such
 * a service almost always actually lives.
 *
 * This is safe, and does not weaken anything:
 *   - The URL, and therefore the SNI and certificate check, is unchanged. Only
 *     the address dialled differs. A wrong address cannot complete the TLS
 *     handshake, so the request fails closed rather than talking to a stranger.
 *   - The fallback address comes from DNS for the same registrable domain.
 *     Anyone able to forge that already controls the original name, so no new
 *     trust is placed in anything.
 *
 * It is a fallback, never the first choice: when the published record works,
 * nothing here runs.
 *
 * Once it has worked for a host, that is remembered for a short while and the
 * working path is used first. Otherwise EVERY call would pay the dead
 * address's connect timeout before getting anywhere, which is ten seconds a
 * customer spends watching a checkout do nothing. The memory expires so that a
 * record the provider has since fixed is picked up again on its own.
 */

/** How long a working sibling path is preferred before the published address is retried. */
const FALLBACK_MEMORY_MS = 10 * 60 * 1000;
/** host -> when the sibling path last worked. */
const knownBadAddress = new Map<string, number>();

function shouldSkipPublishedAddress(host: string): boolean {
  const since = knownBadAddress.get(host);
  if (since === undefined) return false;
  if (Date.now() - since < FALLBACK_MEMORY_MS) return true;
  knownBadAddress.delete(host);
  return false;
}

/**
 * Failures that happen BEFORE the request could have been delivered.
 *
 * The distinction matters because the retry re-sends a POST. These all mean no
 * connection was ever established, so nothing can have been acted on twice.
 * `ECONNRESET` is deliberately absent: a connection can be reset after the
 * request was sent and even acted on, and re-sending that could open a second
 * invoice. A payment left failed is better than one duplicated.
 */
const CONNECT_FAILURES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);

export function isConnectFailure(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return false;
  const cause = (error as { cause?: { code?: string } })?.cause;
  const code = cause?.code ?? (error as { code?: string })?.code;
  return typeof code === 'string' && CONNECT_FAILURES.has(code);
}

/** `api.example.com` -> `example.com`; anything without a sub-domain has no sibling. */
export function siblingHost(hostname: string): string | null {
  const labels = hostname.split('.');
  return labels.length > 2 ? labels.slice(1).join('.') : null;
}

export interface SimpleResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** One HTTPS request, dialled at a given address but spoken to as `url`. */
function requestPinned(url: URL, init: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number }, addresses: string[]): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: init.method,
        headers: init.headers,
        timeout: init.timeoutMs,
        // The ONLY thing overridden. The certificate is still checked against
        // the hostname in `url`, so this cannot redirect the call elsewhere.
        lookup: (_hostname, options, callback) => {
          const cb = callback as (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void;
          if (typeof options === 'object' && options?.all) {
            cb(null, addresses.map((address) => ({ address, family: 4 })));
            return;
          }
          cb(null, addresses[0], 4);
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () => JSON.parse(raw || '{}') as unknown,
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('The request timed out')));
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

/**
 * `fetch`, with the sibling-address retry described above.
 *
 * `onFallback` is called when the retry is used, so an operator can be told
 * their provider's DNS needs fixing rather than the problem staying silent.
 */
export async function fetchWithDnsFallback(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal; timeoutMs: number },
  onFallback?: (detail: { host: string; via: string; addresses: string[] }) => void,
): Promise<SimpleResponse> {
  const target = new URL(url);

  if (!shouldSkipPublishedAddress(target.hostname)) {
    try {
      const response = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal });
      return { ok: response.ok, status: response.status, json: () => response.json() as Promise<unknown> };
    } catch (error) {
      if (!isConnectFailure(error)) throw error;
      return await viaSibling(target, init, error, onFallback);
    }
  }
  try {
    return await viaSibling(target, init, new Error(`${target.hostname} did not answer at its published address`), onFallback);
  } catch (error) {
    // The remembered path has stopped working: forget it, so the next call
    // tries the published address again rather than staying stuck here.
    knownBadAddress.delete(target.hostname);
    throw error;
  }
}

/** The retry itself: same URL and certificate check, different address. */
async function viaSibling(
  target: URL,
  init: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number },
  error: unknown,
  onFallback?: (detail: { host: string; via: string; addresses: string[] }) => void,
): Promise<SimpleResponse> {
  {
    const sibling = siblingHost(target.hostname);
    if (!sibling) throw error;

    let addresses: string[];
    try {
      addresses = await resolve4(sibling);
    } catch {
      // The sibling does not resolve either: this is a real outage, and the
      // original failure is the honest one to report.
      throw error;
    }
    if (addresses.length === 0) throw error;

    onFallback?.({ host: target.hostname, via: sibling, addresses });
    const response = await requestPinned(target, { method: init.method, headers: init.headers, body: init.body, timeoutMs: init.timeoutMs }, addresses);
    // It answered, so prefer this path for a while instead of waiting out the
    // dead address on every single call.
    knownBadAddress.set(target.hostname, Date.now());
    return response;
  }
}
