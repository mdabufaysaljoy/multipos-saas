/**
 * Runs the end-to-end suite against an ISOLATED database and server.
 *
 * The suite signs in as the demo admin and exercises real business flows —
 * upgrading plans, creating branches, spending wallet balance. Pointed at the
 * development database it left the demo tenant on whatever plan the last test
 * happened to assign. Nothing was wrong with the tests; they simply had nowhere
 * else to run.
 *
 * So they get their own database and their own server process on their own
 * port, and the database is dropped again when the run ends. The development
 * database is never opened.
 *
 * Everything is configured through the environment the app already reads, so
 * not a single test needed changing.
 *
 * Environment:
 *   MONGODB_TEST_URI  Use this database instead of the derived one.
 *   TEST_PORT         Port for the throwaway API (default 4101).
 *   KEEP_TEST_DB      Set to "true" to preserve the database for debugging.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { startMockBkash } from './mock-bkash.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX_CLI = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));

// Both this process and the throwaway API run as `test`, so the cleanup guard
// can require it. Set before the guard reads it. `isDev` is unused in the app
// and every other switch keys on `isProd`, so nothing behaves differently from
// a development run.
process.env.NODE_ENV = 'test';

/** Derives a sibling `_test` database from the configured URI. */
function toTestUri(uri) {
  const [base, query] = uri.split('?');
  const trimmed = base.replace(/\/$/, '');
  const slash = trimmed.lastIndexOf('/');

  // A URI with no database path: append one.
  if (slash <= trimmed.indexOf('//') + 1) {
    return `${trimmed}/clothing_pos_test${query ? `?${query}` : ''}`;
  }

  const name = trimmed.slice(slash + 1);
  return `${trimmed.slice(0, slash)}/${name}_test${query ? `?${query}` : ''}`;
}

const databaseNameOf = (uri) => {
  const path = uri.split('?')[0].replace(/\/$/, '');
  return path.slice(path.lastIndexOf('/') + 1);
};

const devUri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/clothing_pos';
const testUri = process.env.MONGODB_TEST_URI ?? toTestUri(devUri);
const testDbName = databaseNameOf(testUri);

/**
 * The guard that stands between `npm test` and somebody's real data.
 *
 * Cleanup only ever runs against a database whose NAME identifies it as a test
 * database and which is demonstrably not the one the app develops against.
 * Anything else is refused rather than dropped - a wrong answer here destroys
 * data, so it fails closed.
 */
function assertSafeToDrop() {
  const reasons = [];
  if (process.env.NODE_ENV !== 'test') {
    reasons.push(`NODE_ENV is "${process.env.NODE_ENV}", not "test"`);
  }
  if (!/(^|[_-])test($|[_-])/.test(testDbName)) {
    reasons.push(`its name "${testDbName}" does not identify it as a test database`);
  }
  if (testUri === devUri) reasons.push('it is the same URI as the development database');
  if (databaseNameOf(devUri) === testDbName) reasons.push('it has the same database name as the development database');
  return reasons;
}

const unsafeReasons = assertSafeToDrop();
if (unsafeReasons.length > 0) {
  console.error('\n  Refusing to run: the test database is not safely identifiable.');
  unsafeReasons.forEach((r) => console.error(`    - ${r}`));
  console.error('  Set MONGODB_TEST_URI to a database whose name contains "test".\n');
  process.exit(1);
}

const PORT = process.env.TEST_PORT ?? '4101';
const API_BASE = `http://localhost:${PORT}/api`;
const KEEP = process.env.KEEP_TEST_DB === 'true';
// STORAGE_LOCAL_DIR is both a filesystem setting and part of the Express URL
// mount. An absolute Windows path contains `:` and `\\`, which path-to-regexp
// correctly refuses as a route. Keep the isolated directory under the checkout
// so the server receives a safe relative name; cleanup still uses its absolute
// path. The directory is removed in `teardown`, including failed test runs.
const testUploadDir = mkdtempSync(join(ROOT, '.multipos-saas-test-uploads-'));
const testUploadSetting = basename(testUploadDir);

// A local stand-in for the bKash API, so the real adapter and the full
// checkout -> callback -> activation path run on every test run with no network
// access and no real credentials. Test-only values; nothing here is a secret.
const mockBkash = await startMockBkash({ port: Number(process.env.TEST_BKASH_PORT ?? 0) });

const childEnv = {
  ...process.env,
  MONGODB_URI: testUri,
  PORT,
  NODE_ENV: 'test',
  STORAGE_LOCAL_DIR: testUploadSetting,
  SMS_MOCK_ENABLED: 'true',
  BKASH_APP_KEY: mockBkash.credentials.appKey,
  BKASH_APP_SECRET: mockBkash.credentials.appSecret,
  BKASH_USERNAME: mockBkash.credentials.username,
  BKASH_PASSWORD: mockBkash.credentials.password,
  BKASH_BASE_URL: mockBkash.url,
  BKASH_WEBHOOK_TOPIC_ARN: 'arn:aws:sns:ap-southeast-1:000000000000:bkash-test',
};

const run = (command, args, extraEnv = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...childEnv, ...extraEnv },
      stdio: 'inherit',
      shell: false,
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
    child.on('error', reject);
  });

async function waitForHealth(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/health`);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`The test API did not become healthy on port ${PORT}`);
}

/** Stops the throwaway API so nothing holds a connection open during cleanup. */
async function stopServer(server) {
  if (!server?.pid) return;
  try {
    // Kill the whole group: `npm run dev` spawns tsx beneath itself.
    if (process.platform === 'win32') server.kill();
    else process.kill(-server.pid, 'SIGTERM');
  } catch {
    return; // Already gone.
  }
  // Give it a moment to release its Mongo connection before we drop.
  await new Promise((r) => setTimeout(r, 750));
}

/** Drops the test database. Guarded again at the moment of deletion. */
async function dropTestDatabase() {
  const connection = await mongoose.createConnection(testUri).asPromise();
  try {
    const actual = connection.db.databaseName;
    // Re-check against the name Mongo actually opened, not the one we parsed.
    if (!/(^|[_-])test($|[_-])/.test(actual)) {
      throw new Error(`connected database "${actual}" is not a test database; refusing to drop it`);
    }
    if (process.env.NODE_ENV !== 'test') {
      throw new Error(`NODE_ENV is "${process.env.NODE_ENV}"; refusing to drop a database outside a test run`);
    }
    await connection.dropDatabase();
    return actual;
  } finally {
    await connection.close();
  }
}

/**
 * Stops the API and removes the test database. Runs exactly once.
 *
 * A signal can arrive while the normal teardown is already running, so the
 * in-flight promise is reused rather than starting a second drop. Dropping an
 * already-dropped database is a no-op in Mongo, but two concurrent connections
 * racing to do it is not worth the noise.
 */
let teardownPromise = null;

function teardown(server) {
  if (teardownPromise) return teardownPromise;

  teardownPromise = (async () => {
    await stopServer(server);
    await mockBkash.close().catch(() => {});

    let cleanupError = null;
    try {
      if (KEEP) {
        console.log(`\n  Kept ${testDbName} for debugging (KEEP_TEST_DB=true).`);
      } else {
        const dropped = await dropTestDatabase();
        console.log(`\n  Cleaned up test database "${dropped}".`);
      }
    } catch (error) {
      cleanupError = error;
    }

    try {
      // Upload tests write real files. Keep those fixtures outside the checkout
      // and remove only the unique directory created by this process.
      rmSync(testUploadDir, { recursive: true, force: true });
      console.log('  Cleaned up temporary upload fixtures.\n');
    } catch (error) {
      cleanupError ??= error;
    }

    return cleanupError;
  })();

  return teardownPromise;
}

let server;
let testFailure = null;
let cleanupFailure = null;

/**
 * Ctrl-C and SIGTERM.
 *
 * Without a handler Node terminates immediately and the `finally` below never
 * runs, which is exactly how an interrupted run used to leave its database
 * behind. Cleanup is asynchronous, so the handler awaits it before exiting
 * rather than calling `process.exit` underneath itself.
 *
 * A second signal during cleanup is ignored: the run is already ending, and
 * restarting teardown would be the race this is meant to avoid.
 */
let signalled = false;

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, () => {
    if (signalled) return;
    signalled = true;
    console.log(`\n  ${signal} received - cleaning up before exit...`);

    void teardown(server).then((error) => {
      if (error) {
        console.error(`  Test cleanup failed: ${error.message}`);
        console.error(`  Remove it by hand with:  mongosh ${testDbName} --eval 'db.dropDatabase()'`);
      }
      process.exit(code);
    });
  });
}

try {
  console.log(`\n  Test database : ${testUri}`);
  console.log(`  Test API      : ${API_BASE}`);
  console.log(`  Cleanup       : ${KEEP ? 'disabled (KEEP_TEST_DB=true)' : 'drops the test database when finished'}`);
  console.log('  The development database is not touched.\n');

  // Invoke the checked-in toolchain directly. Going through `npm` with
  // `shell:true` makes Windows concatenate a command string and is both less
  // safe and unreliable in restricted runners where cmd.exe cannot be spawned.
  server = spawn(process.execPath, [TSX_CLI, 'server/src/server.ts'], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: false,
    detached: process.platform !== 'win32',
  });

  await waitForHealth();

  // A fresh database every run: the suite soft-deletes products and consumes
  // stock, so it needs known state. This also covers the case where a previous
  // run was killed before its cleanup could happen.
  await run(process.execPath, [TSX_CLI, 'server/src/seed/seed.ts', '--reset']);
  await run(process.execPath, ['scripts/smoke-test.mjs'], { API_BASE, BKASH_MOCK_URL: mockBkash.url });
  // The HTTP suite cannot reach these: there is deliberately no route that edits
  // an invoice or a ledger row, so the guards are checked at the model.
  await run(process.execPath, [TSX_CLI, 'server/src/seed/immutability.check.ts']);
  // Nor these: a code that has expired, one superseded by a newer one and the
  // resend cooldown all need the clock moved, which over HTTP would mean
  // sleeping through a minute per assertion.
  await run(process.execPath, [TSX_CLI, 'server/src/seed/passwordReset.check.ts']);
  // Nor this one: reaching ZiniPay for real would need live credentials, move
  // real money, and still could not be asked to produce a FAILED payment on
  // demand. It runs against a stub of their documented API instead.
  await run(process.execPath, [TSX_CLI, 'server/src/seed/zinipay.check.ts']);
} catch (error) {
  testFailure = error;
} finally {
  // Teardown runs whether the suite passed or failed. If a signal already
  // started it, this awaits that same operation instead of repeating it.
  cleanupFailure = await teardown(server);
}

// A cleanup problem is reported, but never in place of a test failure.
if (cleanupFailure) {
  console.error(`  Test cleanup failed: ${cleanupFailure.message}`);
  console.error(`  Remove it by hand with:  mongosh ${testDbName} --eval 'db.dropDatabase()'\n`);
}
if (testFailure) {
  console.error(`  ${testFailure.message}\n`);
}

process.exit(testFailure || cleanupFailure ? 1 : 0);
