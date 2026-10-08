/**
 * Distributed rate limiting: the store, the keys and the fallback policy.
 *
 * WHAT IS REAL HERE. The limiter under test is the real `express-rate-limit`
 * middleware with the real `RedisRateLimitStore`, driven through real
 * request/response objects. What stands in for Redis is a small command
 * executor that implements the three commands the store uses - and it does so
 * by actually interpreting the Lua script's effect (INCR, PTTL, PEXPIRE) over a
 * map, which is enough to prove the store's own contract: one atomic call per
 * request, a counter shared by every instance pointed at it, a TTL that is
 * always set, and keys that do not collide.
 *
 * WHAT IS NOT PROVEN, and is not claimed anywhere: that a real Redis executes
 * the script atomically under genuine concurrency across processes. That is
 * Redis's guarantee, it needs a real server, and there is none on this machine
 * and none in CI. What these tests CAN rule out is the bug that would make the
 * atomicity moot - a read-then-write in our own code - and they do, by
 * asserting the store issues exactly one command per request and that the
 * script contains no separate GET/SET pair.
 *
 * Run as part of `npm test` (and on its own with `npm run test:rate-limit -w server`).
 */
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import {
  createRateLimiter,
  hashIdentity,
  incrementScript,
  rateLimitKey,
  RedisRateLimitStore,
  RedisUnavailableError,
  resetRateLimitOutageLog,
  type RateLimitRedis,
} from './rateLimit';

/**
 * A stand-in for Redis that applies the script's own semantics to a map.
 *
 * It is deliberately NOT a general Redis: it understands the one script the
 * store sends, and it records every call so the tests can assert how many
 * round trips a request costs.
 */
function fakeRedis(options: { failing?: boolean; now?: () => number } = {}) {
  const store = new Map<string, { hits: number; expiresAt: number }>();
  const calls: string[] = [];
  const now = options.now ?? (() => Date.now());

  const client: RateLimitRedis = {
    async eval(script: string, numKeys: number, ...args: (string | number)[]) {
      calls.push('eval');
      if (options.failing) throw new Error('READONLY You can\'t write against a read only replica');
      assert.equal(numKeys, 1, 'the script addresses exactly one key');
      assert.ok(script.includes('INCR'), 'the script increments');

      const key = String(args[0]);
      const windowMs = Number(args[1]);
      const existing = store.get(key);

      // Expiry, as Redis would: a key past its TTL simply is not there.
      if (existing && existing.expiresAt <= now()) store.delete(key);

      const row = store.get(key);
      if (!row) {
        store.set(key, { hits: 1, expiresAt: now() + windowMs });
        return [1, windowMs];
      }
      row.hits += 1;
      return [row.hits, Math.max(0, row.expiresAt - now())];
    },
    async del(key: string) {
      calls.push('del');
      store.delete(key);
      return 1;
    },
    async decr(key: string) {
      calls.push('decr');
      const row = store.get(key);
      if (row) row.hits -= 1;
      return row?.hits ?? 0;
    },
  };

  return { client, store, calls };
}

/** Minimal request/response pair, enough to run the middleware for real. */
function exchange(ip: string, body: unknown = {}) {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  // Typed loosely on purpose: this stands in for an Express response and only
  // implements what the limiter touches.
  type FakeRes = Response & { statusCode: number };
  let payload: unknown;
  let ended = false;

  const req = { ip, body, method: 'POST', url: '/x', headers: {}, app: { get: () => undefined } } as unknown as Request;
  const res = {
    statusCode,
    setHeader(name: string, value: unknown) {
      headers[name.toLowerCase()] = String(value);
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    status(code: number) {
      statusCode = code;
      (this as { statusCode: number }).statusCode = code;
      return this;
    },
    send(data: unknown) {
      payload = data;
      ended = true;
      return this;
    },
    json(data: unknown) {
      payload = data;
      ended = true;
      return this;
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    removeListener() {
      return this;
    },
    headersSent: false,
    writeHead() {
      return this;
    },
    end(data?: unknown) {
      payload = data ?? payload;
      ended = true;
      return this;
    },
  } as unknown as FakeRes;

  return {
    req,
    res,
    get status() {
      return statusCode;
    },
    get body() {
      return payload;
    },
    get blocked() {
      return ended;
    },
    get headers() {
      return headers;
    },
  };
}

/** Runs the middleware once and says whether the request was allowed through. */
async function hit(limiter: ReturnType<typeof createRateLimiter>, ip: string, body: unknown = {}) {
  const ex = exchange(ip, body);
  let passed = false;
  let error: unknown;

  // The middleware either calls `next` (allowed) or answers the response
  // itself (refused). Await whichever happens, and surface a thrown error
  // rather than letting the process exit quietly around it.
  await new Promise<void>((resolve, reject) => {
    const settled = () => resolve();
    Promise.resolve(
      limiter(ex.req, ex.res, ((err?: unknown) => {
        if (err) error = err;
        else passed = true;
        settled();
      }) as never),
    )
      .then(settled)
      .catch(reject);
  });

  return { passed, error, status: ex.status, body: ex.body, headers: ex.headers };
}

async function main(): Promise<void> {
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

  console.log('\n  Distributed rate limiting\n');

  // 1. The script is atomic by construction -------------------------------

  check('The counter script increments', incrementScript.includes("redis.call('INCR'"));
  check('...sets an expiry in the same script', incrementScript.includes("redis.call('PEXPIRE'"));
  check('...and repairs a key that somehow has none', incrementScript.includes('ttl < 0'));
  check('There is no read-then-write anywhere in it', !/redis\.call\('GET'/.test(incrementScript) && !/redis\.call\('SET'/.test(incrementScript));

  // 2. Keys are namespaced, deterministic and credential-free -------------

  check('A key names its policy and identity', rateLimitKey('auth-credentials', '1.2.3.4') === 'rl:auth-credentials:1.2.3.4');
  check('A key is deterministic', rateLimitKey('api', 'x') === rateLimitKey('api', 'x'));
  check('Two policies never share a counter', rateLimitKey('api', 'x') !== rateLimitKey('export', 'x'));
  check('Two identities never share a counter', rateLimitKey('api', 'x') !== rateLimitKey('api', 'y'));
  // The Phase 1 client prefixes every key with `retailersuites:<env>:`, which
  // is why the key built here is deliberately bare.
  check('A key carries no prefix of its own, so the Redis namespace applies', !rateLimitKey('api', 'x').startsWith('retailersuites'));

  const hashed = hashIdentity('Person@Example.com'.toLowerCase());
  check('An identifier is hashed, so Redis never holds the address', !hashed.includes('@') && !hashed.includes('person'));
  check('...to a fixed, short length', hashed.length === 24 && hashIdentity('a'.repeat(254)).length === 24);
  check('...deterministically', hashed === hashIdentity('person@example.com'));
  check('...and distinctly per address', hashIdentity('a@b.com') !== hashIdentity('c@d.com'));

  // 3. Basic limit and boundary -------------------------------------------

  {
    const redis = fakeRedis();
    const store = new RedisRateLimitStore('test-basic', 'memory', () => redis.client);
    store.init({ windowMs: 60_000 } as never);

    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await store.increment('1.1.1.1'));
    check('The counter rises by one per request', results.map((r) => r.totalHits).join(',') === '1,2,3,4', results);
    check('Every request costs exactly one round trip', redis.calls.length === 4, redis.calls);
    check('A reset time is always reported', results.every((r) => r.resetTime instanceof Date));
  }

  // 4. The real middleware, at the boundary -------------------------------

  {
    const redis = fakeRedis();
    const limiter = createRateLimiter({ name: 'test-boundary', windowMs: 60_000, limit: 3, devLimit: 3, fallback: 'memory' });
    // Point the limiter's store at the fake by replacing its client resolver.
    const withFake = createRateLimiterWith(redis.client, { name: 'test-boundary', windowMs: 60_000, limit: 3, devLimit: 3, fallback: 'memory' });
    void limiter;

    const outcomes = [];
    for (let i = 0; i < 5; i += 1) outcomes.push(await hit(withFake, '2.2.2.2'));
    check('Requests below the limit pass', outcomes.slice(0, 3).every((o) => o.passed), outcomes.map((o) => o.passed));
    check('The request over the limit is refused', !outcomes[3]?.passed && outcomes[3]?.status === 429, outcomes[3]);
    check('...and stays refused', !outcomes[4]?.passed);
    check('The refusal keeps the existing envelope', (outcomes[3]?.body as { error?: { code?: string } })?.error?.code === 'TOO_MANY_REQUESTS', outcomes[3]?.body);
    check('Standard rate-limit headers are sent', Boolean(outcomes[0]?.headers['ratelimit']) || Boolean(outcomes[0]?.headers['ratelimit-limit']), outcomes[0]?.headers);
    check('A refusal says when to retry', Boolean(outcomes[3]?.headers['retry-after'] ?? outcomes[3]?.headers['ratelimit']), outcomes[3]?.headers);
  }

  // 5. Window reset --------------------------------------------------------

  {
    let clock = 1_000_000;
    const redis = fakeRedis({ now: () => clock });
    const store = new RedisRateLimitStore('test-window', 'memory', () => redis.client);
    store.init({ windowMs: 60_000 } as never);

    await store.increment('3.3.3.3');
    const second = await store.increment('3.3.3.3');
    check('Within the window the counter persists', second.totalHits === 2);
    // The reset time is real time plus the remaining TTL, so the assertion is
    // that it never exceeds one window - not that it equals the fake clock.
    check('...and the reset time never exceeds one window', second.resetTime!.getTime() - Date.now() <= 60_000, second.resetTime);

    clock += 59_999;
    check('Just before expiry the counter still stands', (await store.increment('3.3.3.3')).totalHits === 3);

    clock += 2;
    const fresh = await store.increment('3.3.3.3');
    check('After the window the counter starts again', fresh.totalHits === 1, fresh);
    const freshTtl = fresh.resetTime!.getTime() - Date.now();
    check('...with a full, bounded TTL, so no key outlives its window', freshTtl > 59_000 && freshTtl <= 60_000, freshTtl);
  }

  // 6. Concurrency: no request slips past -----------------------------------

  {
    const redis = fakeRedis();
    const store = new RedisRateLimitStore('test-race', 'memory', () => redis.client);
    store.init({ windowMs: 60_000 } as never);

    // Twenty at once against one identity. Because each is a single atomic
    // call, the hit numbers must be exactly 1..20 with nothing repeated -
    // which is what a read-then-write would break.
    const seen = (await Promise.all(Array.from({ length: 20 }, () => store.increment('4.4.4.4')))).map((r) => r.totalHits);
    check('Concurrent requests each get a distinct count', new Set(seen).size === 20, seen);
    check('...covering 1..20 with none skipped or repeated', seen.slice().sort((a, b) => a - b).join(',') === Array.from({ length: 20 }, (_v, i) => i + 1).join(','), seen);
    check('...in exactly twenty round trips', redis.calls.length === 20);
  }

  // 7. Distributed: two instances, one counter ------------------------------

  {
    const redis = fakeRedis();
    // Two stores, as two API replicas would have - separate objects, separate
    // in-process state, same Redis.
    const replicaA = new RedisRateLimitStore('test-shared', 'memory', () => redis.client);
    const replicaB = new RedisRateLimitStore('test-shared', 'memory', () => redis.client);
    replicaA.init({ windowMs: 60_000 } as never);
    replicaB.init({ windowMs: 60_000 } as never);

    const a1 = await replicaA.increment('5.5.5.5');
    const b1 = await replicaB.increment('5.5.5.5');
    const a2 = await replicaA.increment('5.5.5.5');
    check('A request to one replica is counted by the other', b1.totalHits === 2, b1);
    check('...and the count keeps rising across both', a1.totalHits === 1 && a2.totalHits === 3, [a1, a2]);
    check('A store declares that its keys are shared', replicaA.localKeys === false);

    // Different identities must not bleed across replicas either.
    const other = await replicaB.increment('6.6.6.6');
    check('A different identity starts from one', other.totalHits === 1, other);
  }

  // 8. Policy isolation ----------------------------------------------------

  {
    const redis = fakeRedis();
    const login = new RedisRateLimitStore('auth-credentials', 'memory', () => redis.client);
    const api = new RedisRateLimitStore('api', 'memory', () => redis.client);
    login.init({ windowMs: 60_000 } as never);
    api.init({ windowMs: 60_000 } as never);

    await login.increment('7.7.7.7');
    await login.increment('7.7.7.7');
    const apiFirst = await api.increment('7.7.7.7');
    check('One address on two policies keeps two counters', apiFirst.totalHits === 1, apiFirst);
    check('...stored under separate keys', redis.store.has('rl:auth-credentials:7.7.7.7') && redis.store.has('rl:api:7.7.7.7'), [...redis.store.keys()]);
  }

  // 9. TTL is always bounded -----------------------------------------------

  {
    const redis = fakeRedis();
    const store = new RedisRateLimitStore('test-ttl', 'memory', () => redis.client);
    store.init({ windowMs: 30_000 } as never);
    await store.increment('8.8.8.8');
    const row = redis.store.get('rl:test-ttl:8.8.8.8');
    check('A new counter is given an expiry immediately', Boolean(row && row.expiresAt > Date.now()), row);
    check('...no longer than its window', Boolean(row && row.expiresAt - Date.now() <= 30_000), row);
    check('No counter key exists without one', [...redis.store.values()].every((r) => Number.isFinite(r.expiresAt)));
  }

  // 10. Reset and decrement -------------------------------------------------

  {
    const redis = fakeRedis();
    const store = new RedisRateLimitStore('test-reset', 'memory', () => redis.client);
    store.init({ windowMs: 60_000 } as never);
    await store.increment('9.9.9.9');
    await store.increment('9.9.9.9');
    await store.decrement('9.9.9.9');
    check('A decrement gives a request back', (await store.increment('9.9.9.9')).totalHits === 2);
    await store.resetKey('9.9.9.9');
    check('A reset clears the counter', (await store.increment('9.9.9.9')).totalHits === 1);
  }

  // 11. Redis failure: the declared fallback, per policy --------------------

  {
    resetRateLimitOutageLog();
    const broken = fakeRedis({ failing: true });

    // `memory`: the limit still applies, per process.
    const degraded = new RedisRateLimitStore('test-degraded', 'memory', () => broken.client);
    degraded.init({ windowMs: 60_000, limit: 3 } as never);
    const degradedHits = [];
    for (let i = 0; i < 3; i += 1) degradedHits.push((await degraded.increment('1.0.0.1')).totalHits);
    check('With Redis down a memory-fallback policy keeps counting', degradedHits.join(',') === '1,2,3', degradedHits);
    check('...so it is degraded, never fail-open', degradedHits[2] === 3);

    // `closed`: the request is refused rather than allowed uncounted.
    const strict = new RedisRateLimitStore('test-strict', 'closed', () => broken.client);
    strict.init({ windowMs: 60_000 } as never);
    let refused = false;
    try {
      await strict.increment('1.0.0.2');
    } catch (error) {
      refused = error instanceof RedisUnavailableError;
    }
    check('With Redis down a closed policy refuses', refused);

    // The absent-Redis case is deliberately NOT a refusal; see 11b.

    const absentMemory = new RedisRateLimitStore('test-absent-memory', 'memory', () => null);
    absentMemory.init({ windowMs: 60_000 } as never);
    check('...while a memory policy carries on', (await absentMemory.increment('1.0.0.4')).totalHits === 1);
  }

  // 11b. "No Redis configured" is not an outage ----------------------------

  {
    resetRateLimitOutageLog();
    // Phase 1 supports running with no Redis at all. A `closed` policy must NOT
    // turn that into a dead feature - it must behave as it did before this
    // phase existed, counting in process.
    const unconfigured = new RedisRateLimitStore(
      'test-unconfigured',
      'closed',
      () => null,
      () => false,
    );
    unconfigured.init({ windowMs: 60_000 } as never);
    const hits = [];
    for (let i = 0; i < 3; i += 1) hits.push((await unconfigured.increment('1.0.1.1')).totalHits);
    check('With no Redis configured even a closed policy keeps working', hits.join(',') === '1,2,3', hits);

    // ...but the same policy DOES refuse when a configured Redis is down.
    const down = new RedisRateLimitStore(
      'test-configured-down',
      'closed',
      () => null,
      () => true,
    );
    down.init({ windowMs: 60_000 } as never);
    let refusedWhenDown = false;
    try {
      await down.increment('1.0.1.2');
    } catch (error) {
      refusedWhenDown = error instanceof RedisUnavailableError;
    }
    check('...and refuses when a configured Redis is unreachable', refusedWhenDown);
  }

  // 12. A closed policy answers 429, not 500 -------------------------------

  {
    resetRateLimitOutageLog();
    const closed = createRateLimiterWith(
      null,
      { name: 'test-closed-http', windowMs: 60_000, limit: 5, devLimit: 5, fallback: 'closed' },
      true,
    );
    const outcome = await hit(closed, '1.0.0.5');
    check('A closed policy with no Redis refuses with 429', !outcome.passed && outcome.status === 429, outcome);
    check('...in the usual error envelope', (outcome.body as { error?: { code?: string } })?.error?.code === 'TOO_MANY_REQUESTS', outcome.body);
  }

  // 13. Identity helpers ---------------------------------------------------

  {
    const redis = fakeRedis();
    const limiter = createRateLimiterWith(redis.client, {
      name: 'test-identity',
      windowMs: 60_000,
      limit: 2,
      devLimit: 2,
      fallback: 'memory',
      keyGenerator: (req) => {
        const raw = (req.body as { email?: unknown } | undefined)?.email;
        const email = typeof raw === 'string' ? raw.trim().toLowerCase().slice(0, 254) : '';
        return email.includes('@') ? `e:${hashIdentity(email)}` : `ip:${req.ip ?? 'unknown'}`;
      },
    });

    await hit(limiter, '10.0.0.1', { email: 'Victim@Example.com' });
    await hit(limiter, '10.0.0.2', { email: 'victim@example.com  ' });
    const third = await hit(limiter, '10.0.0.3', { email: 'VICTIM@EXAMPLE.COM' });
    check('One account guessed from three addresses hits one counter', !third.passed && third.status === 429, third);

    const different = await hit(limiter, '10.0.0.4', { email: 'someone@else.com' });
    check('...while another account is unaffected', different.passed);

    const noEmail = await hit(limiter, '10.0.0.5', {});
    check('A request with no identifier still gets a counter', noEmail.passed);
    check('...keyed by address, so the limiter cannot be skipped', [...redis.store.keys()].some((k) => k.includes('ip:10.0.0.5')), [...redis.store.keys()]);
    check('No key contains the address that was typed', [...redis.store.keys()].every((k) => !k.includes('@')), [...redis.store.keys()]);
  }

  console.log(`\n==========  ${passed} passed, ${failed} failed  ==========\n`);
  if (failed > 0) process.exit(1);
}

/**
 * The limiter factory, with its store pointed at a given client.
 *
 * `createRateLimiter` resolves the shared Phase 1 client, which is the right
 * thing in production and untestable here; this builds the same middleware with
 * the same store around an injected client instead.
 */
function createRateLimiterWith(
  client: RateLimitRedis | null,
  policy: Parameters<typeof createRateLimiter>[0],
  configured = client !== null,
) {
  const store = new RedisRateLimitStore(
    policy.name,
    policy.fallback,
    () => client,
    () => configured,
  );
  return createRateLimiter({ ...policy, store });
}

main().catch((error) => {
  console.error('Rate limit check crashed:', error);
  process.exit(1);
});
