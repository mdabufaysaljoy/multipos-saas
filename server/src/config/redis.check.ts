/**
 * The Redis foundation, proven without a Redis server.
 *
 * WHY A STUB. There is no Redis in CI and no Redis service in this project's
 * test harness, and the point of this phase is precisely that the application
 * works with Redis present AND absent. A test that needed a live server could
 * assert neither half. So this talks to a minimal RESP server started inside
 * the test process on a loopback port - the same approach `zinipay.check.ts`
 * already takes for a payment gateway, for the same reason. Everything below
 * goes over a real socket, through the real ioredis client, against the real
 * module: nothing about the connection is mocked.
 *
 * Covers: configuration resolution, client construction, the key namespace
 * actually being applied, a real connectivity check, the single-client
 * guarantee, that a Redis which FAILS is never reported as healthy, that a
 * Redis which is down does not break startup, and shutdown.
 *
 * Run as part of `npm test` (and on its own with `npm run test:redis -w server`).
 */
import assert from 'node:assert/strict';
import net from 'node:net';

// ---------------------------------------------------------------- RESP stub

interface RespStub {
  url: string;
  /** Every command the stub has been sent, uppercased name first. */
  received: string[][];
  close: () => Promise<void>;
}

/** Enough of the Redis wire protocol for a client to connect, be checked and answer. */
async function startRespStub(): Promise<RespStub> {
  const received: string[][] = [];
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());

    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      // Commands arrive as RESP arrays of bulk strings: *N\r\n($len\r\n<bytes>\r\n)xN
      for (;;) {
        const parsed = parseCommand(buffer);
        if (!parsed) break;
        buffer = buffer.subarray(parsed.consumed);
        received.push(parsed.args);

        const name = (parsed.args[0] ?? '').toUpperCase();
        if (name === 'PING') socket.write('+PONG\r\n');
        else if (name === 'INFO') {
          // ioredis's ready check reads `loading` from here.
          const info = '# Server\r\nredis_version:7.2.0\r\nloading:0\r\n';
          socket.write(`$${Buffer.byteLength(info)}\r\n${info}\r\n`);
        } else if (name === 'QUIT') {
          socket.write('+OK\r\n');
          socket.end();
        } else socket.write('+OK\r\n');
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  return {
    url: `redis://127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function parseCommand(buffer: Buffer): { args: string[]; consumed: number } | null {
  if (buffer.length === 0 || buffer[0] !== 0x2a /* '*' */) return null;
  let offset = buffer.indexOf('\r\n');
  if (offset === -1) return null;

  const count = Number(buffer.subarray(1, offset).toString());
  if (!Number.isFinite(count) || count < 0) return null;
  offset += 2;

  const args: string[] = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer[offset] !== 0x24 /* '$' */) return null;
    const lengthEnd = buffer.indexOf('\r\n', offset);
    if (lengthEnd === -1) return null;
    const length = Number(buffer.subarray(offset + 1, lengthEnd).toString());
    const start = lengthEnd + 2;
    if (!Number.isFinite(length) || buffer.length < start + length + 2) return null;
    args.push(buffer.subarray(start, start + length).toString());
    offset = start + length + 2;
  }

  return { args, consumed: offset };
}

/** A port nothing is listening on, for the "Redis is down" cases. */
async function closedPortUrl(): Promise<string> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `redis://127.0.0.1:${port}`;
}

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000, label = 'condition') => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${label}`);
};

// ------------------------------------------------------------------- tests

async function main(): Promise<void> {

  const stub = await startRespStub();

  // The module reads `REDIS_URL` through the validated environment when it loads,
  // so it is set before the first import of anything that pulls `config/env` in.
  process.env.REDIS_URL = stub.url;
  process.env.REDIS_KEY_PREFIX = 'checktest';

  const {
    resolveRedisConfig,
    createRedisClient,
    connectRedis,
    disconnectRedis,
    getRedis,
    redisConfig,
    redisState,
    pingRedis,
  } = await import('./redis');

  // 1. Configuration ---------------------------------------------------------

  assert.equal(resolveRedisConfig({ NODE_ENV: 'production' }), null, 'no REDIS_URL means no Redis');
  assert.equal(resolveRedisConfig({ NODE_ENV: 'production', REDIS_URL: '   ' }), null, 'a blank REDIS_URL means no Redis');

  const defaulted = resolveRedisConfig({ NODE_ENV: 'production', REDIS_URL: 'redis://127.0.0.1:6379' });
  assert.equal(defaulted?.keyPrefix, 'retailersuites:production:', 'the namespace defaults to one per environment');
  assert.equal(defaulted?.tls, false);

  const staged = resolveRedisConfig({ NODE_ENV: 'development', REDIS_URL: 'redis://127.0.0.1:6379' });
  assert.notEqual(staged?.keyPrefix, defaulted?.keyPrefix, 'two environments must not share a namespace');

  const secured = resolveRedisConfig({ NODE_ENV: 'production', REDIS_URL: 'rediss://user:pw@redis.example.com:6380' });
  assert.equal(secured?.tls, true, 'rediss:// is recognised as TLS');

  const explicit = resolveRedisConfig({ NODE_ENV: 'test', REDIS_URL: 'redis://h:1', REDIS_KEY_PREFIX: 'mine' });
  assert.equal(explicit?.keyPrefix, 'mine:', 'an explicit namespace always ends in a separator');
  assert.equal(
    resolveRedisConfig({ NODE_ENV: 'test', REDIS_URL: 'redis://h:1', REDIS_KEY_PREFIX: 'mine:' })?.keyPrefix,
    'mine:',
    'a separator is never doubled',
  );

  assert.deepEqual(redisConfig(), { url: stub.url, keyPrefix: 'checktest:', tls: false }, 'the module reads its own configuration from the environment');

  // 2. Construction ----------------------------------------------------------

  const standalone = createRedisClient({ url: stub.url, keyPrefix: 'solo:', tls: false });
  assert.equal(standalone.status, 'wait', 'a client does not connect until it is told to');
  assert.equal(standalone.options.keyPrefix, 'solo:');
  // The option BullMQ requires, proving a queue connection can be built from the
  // same configuration without this module knowing anything about queues.
  assert.equal(
    createRedisClient({ url: stub.url, keyPrefix: 'q:', tls: false }, { maxRetriesPerRequest: null }).options.maxRetriesPerRequest,
    null,
    'callers can override the application defaults',
  );
  standalone.disconnect();

  // 3. State before connecting ----------------------------------------------

  assert.deepEqual(redisState(), { configured: true, state: 'disabled', ready: false }, 'configured but not yet opened');

  // 4. Connecting and a real connectivity check ------------------------------

  const connected = await connectRedis(5_000);
  assert.deepEqual(connected, { configured: true, state: 'ready', ready: true }, 'the connection reaches ready');

  const ping = await pingRedis();
  assert.equal(ping.ok, true, `the connectivity check succeeds: ${ping.error ?? ''}`);
  assert.equal(typeof ping.latencyMs, 'number');

  // The namespace is really applied to the wire, not just stored in options.
  await getRedis()!.set('probe', '1');
  await waitFor(() => stub.received.some((args) => args[0]?.toUpperCase() === 'SET'), 2_000, 'the SET to arrive');
  const set = stub.received.find((args) => args[0]?.toUpperCase() === 'SET');
  assert.equal(set?.[1], 'checktest:probe', 'every key is written inside the configured namespace');

  // 5. One client per process ------------------------------------------------

  const first = getRedis();
  await connectRedis(5_000);
  assert.equal(getRedis(), first, 'connecting twice reuses the one client');

  // 6. A failing Redis is never reported as healthy --------------------------

  await stub.close();
  await waitFor(() => !redisState().ready, 5_000, 'the connection to notice it is gone');

  const afterLoss = redisState();
  assert.equal(afterLoss.ready, false, 'a lost connection is not reported ready');
  assert.equal(afterLoss.configured, true, 'it is still configured, just not available');
  assert.notEqual(afterLoss.state, 'ready');

  const failedPing = await pingRedis(250);
  assert.equal(failedPing.ok, false, 'the connectivity check fails honestly when Redis is gone');
  assert.equal(typeof failedPing.error, 'string');
  assert.ok((failedPing.error ?? '').length > 0, 'and says why');

  // 7. Shutdown --------------------------------------------------------------

  await disconnectRedis();
  assert.equal(getRedis(), null, 'shutdown releases the client');
  assert.deepEqual(redisState(), { configured: true, state: 'disabled', ready: false });
  await disconnectRedis(); // Idempotent: a second shutdown must not throw.

  // 8. Startup with Redis unavailable ---------------------------------------

  // The stub is gone, so this is a server booting while Redis is down - the
  // case that must not stop the application starting.
  const unavailable = await connectRedis(250);
  assert.equal(unavailable.configured, true);
  assert.equal(unavailable.ready, false, 'startup does not pretend Redis is ready');
  assert.notEqual(unavailable.state, 'ready');
  await disconnectRedis();

  // And a client pointed at a port nothing answers on rejects rather than hanging.
  const dead = createRedisClient({ url: await closedPortUrl(), keyPrefix: 'dead:', tls: false });
  // Every caller of the factory owns its own `error` listener; without one
  // ioredis reports the failure as an unhandled event.
  dead.on('error', () => undefined);
  await assert.rejects(dead.connect(), 'connecting to a closed port fails rather than hanging');
  dead.disconnect();

  console.log('Redis foundation: configuration, namespace, connectivity, single client, honest health, shutdown and unavailability passed.');
}

main().catch((error) => {
  console.error('Redis foundation check crashed:', error);
  process.exit(1);
});
