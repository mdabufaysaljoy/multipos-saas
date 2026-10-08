# Implementation status

**The source of truth for infrastructure state between sessions.** Last
verified against the code on **2026-10-08** (branch
`claude/retailer-suites-audit-e61761`). Phases completed: **0** (audit),
**1** (Redis foundation), **2** (BullMQ worker foundation).

---

## How to continue infrastructure work

Every future infrastructure session must read these four documents **before
touching anything**:

1. **`CLAUDE.md`** — the project's working rules. Note: `.gitignore` excludes
   `CLAUDE.MD`, so it is deliberately not in the repository and arrives with
   the session instead. If you do not have it, `README.md` is the in-repo
   equivalent for stack and commands.
2. **`docs/ARCHITECTURE.md`** — what the application is, how a request flows,
   and the infrastructure summary at the end.
3. **`docs/INFRASTRUCTURE_ROADMAP.md`** — the full Phase 0 audit and the plan
   for Phases 1–12. Every finding referenced below (R1–R4, I1–I4, D1–D6, B1–B10)
   is defined there.
4. **This file** — what is actually done.

Then, before implementing anything:

- **Verify the relevant area against the actual source code.** This
  documentation goes stale; the code does not. Where a document and the code
  disagree, the code is right and the document needs fixing in the same session.
- Do **not** trust a "COMPLETED" row below without a quick grep. Confirm it.
- Work **one phase at a time**, in the order in §3. Phases 1–5 have real
  dependencies on each other; the order is not cosmetic.
- Update this file in the same commit as the work it describes.

### Two things worth knowing before you start

- **Finding I1 is a live correctness bug, not a scaling concern.** POS sales in
  the Super Shop, Pharmacy and Restaurant verticals carry **no idempotency
  key** — a retried checkout can create two sales. It is additive to fix and
  depends on nothing in Phases 1–4. If a double sale is ever reported, fix it
  immediately rather than waiting for Phase 5.
- **Do not run more than one API replica until Phase 4 is complete.** The
  subscription scheduler runs inside every API process, and all rate-limit
  counters and caches are per-process. A second replica duplicates scheduled
  work and multiplies every rate limit.

---

## 1. Infrastructure status

Statuses: **COMPLETED** · **IN PROGRESS** · **NOT STARTED** · **DEFERRED** · **BLOCKED**

| Area | Status | What is actually there, as of 2026-10-08 |
|---|---|---|
| **Phase 0 audit** | **COMPLETED** | `docs/INFRASTRUCTURE_ROADMAP.md`, written from source. |
| **Redis** | **COMPLETED** (foundation only) | `ioredis` 5.11, one shared lazily-opened client in `server/src/config/redis.ts`, opened by `server.ts` and closed on `SIGTERM`/`SIGINT`. Configured by `REDIS_URL` (`rediss://` enables TLS from the scheme alone) and `REDIS_KEY_PREFIX` (defaults to `retailersuites:<NODE_ENV>:`). **Optional:** unset means the client is never opened and nothing changes; unreachable is logged, retried in the background and never fatal; **malformed refuses to boot**, matching the house rule that a half-configured server should not start. `/api/health` reports the live connection state additively. **Nothing consumes it yet** — by design (see §1.1). |
| **BullMQ / Worker** | **COMPLETED** (foundation only) | `bullmq` 5.81 and `server/src/queues/`: `createAppQueue(name)` and `createAppWorker(name, processor, opts)` over one shared Redis connection, with retry, backoff, retention, naming and the key namespace centralised in `queues/options.ts`. `server/src/worker.ts` is a **separate process** (`npm run worker`) that starts no HTTP server; the API starts no worker, and a test asserts both. Redis is **required** in the worker, which exits 1 with a clear message when it is missing or unreachable. **No queue and no processor is defined yet.** The `setInterval` scheduler inside the API (`jobs/subscription.job.ts` — an hourly billing pass and a 10-minute payment-reconciliation pass) is deliberately untouched and still runs exactly as before; Phase 3 migrates it. Detail in §1.2. |
| **Background jobs** | **NOT STARTED** | Nothing has been migrated: Phase 2 built the foundation, Phase 3 moves the work onto it. Everything still runs in-request. Candidates, in priority order: SMS/email campaigns (up to 5,000 recipients, sequential, in the request), password-reset and verification emails (inline SMTP), exports (up to 200,000 rows streamed), product import commit (~6,000 documents), `sharp` image optimisation. **Exception:** billing emails already use a correct durable queue in MongoDB (`EmailNotification` — keyed, leased, 5 attempts, backoff). Keep that mechanism; move only its driver. |
| **Rate limiting** | **IN PROGRESS** | `express-rate-limit` v7 with one global `/api` limiter (600/min in production) plus 19 route-specific limiters covering login, registration, password reset, verification, checkout, callbacks, exports, imports, messaging (keyed by `tenantId`), platform admin actions and more. **Gaps:** all stores are per-process memory (R1); no per-account login lockout, only per-IP (R2); `/auth/refresh` and `/auth/logout` have no dedicated limiter (R3); `trust proxy` is hard-coded to `1` and must be re-verified when Cloudflare is added (R4). |
| **Idempotency** | **IN PROGRESS** | No generic middleware. Per-resource keys with unique partial indexes on `Sale`, `Payment`, `Return`, `WalletTransaction`, `UsageCharge`, `UpgradeRequest`, `LoyaltyMembership`, each with replay-read and 11000-recovery. Wallet debits use a guarded `$gte` update; subscription purchase takes a CAS lock; webhooks are replay-safe because a notification is never believed. **Gaps:** `ShopSale`/`PharmacySale`/`RestaurantOrder` have no key at all (I1); Clothing's is optional (I2); plain returns write `null` (I3); no header convention (I4). |
| **Docker** | **NOT STARTED** | No Dockerfile, no `.dockerignore`. Core is ready (env-driven config, binds all interfaces, `npm start` → `node dist/server.js`, Node ≥ 20, graceful SIGTERM). Blockers: native `sharp` (D1), uploads on local disk (D2), `syncIndexes` disabled in production (D3), the client build fetches the API (D4), the SPA calls relative `/api` so one origin is mandatory (D5), per-replica scheduler and caches (D6). |
| **Docker Compose** | **NOT STARTED** | No `docker-compose.yml`. When written it must use a **single-node Mongo replica set**: `withTransaction` degrades to compensating writes on a standalone, and CI uses standalone `mongo:7`, so the transaction path has never run anywhere (B9). |
| **MongoDB Atlas** | **NOT STARTED** (target; code is ready) | Mongoose 9.10, one `connectDatabase(env.MONGODB_URI)`, `maxPoolSize: 20`, `serverSelectionTimeoutMS: 10_000`, `strictQuery: true`. `sanitizeFilter` is deliberately off — injection safety comes from zod parsing ids into real ObjectIds. Transaction support is probed at runtime via `hello`, so an Atlas replica-set URI simply turns transactions on with no code change. 71 models, 191 index declarations. **To do before Atlas:** make the pool size configurable (20 × replicas must fit the tier's connection limit) and make index creation an explicit production step (D3/B8). |
| **Cloudflare** | **NOT STARTED** | No configuration anywhere. When added: Full Strict TLS, never cache `/api`, keep SNS and query-string webhooks reachable, and re-verify `trust proxy` (R4). |
| **R2 / object storage** | **DEFERRED** | Deliberate. Only images and logos are files (`./uploads`, served by `express.static`, re-encoded to WebP by `sharp`, with a `StorageObject` ownership registry). PDFs and exports are streamed and never persisted; invoices and receipts are MongoDB documents. The `s3`/`cloudinary` drivers are declared but unimplemented, and the server **refuses to boot in production** if either is selected rather than silently writing to local disk. **Un-defer when:** the API runs in more than one container, or upload persistence stops being guaranteed by a mounted volume. Until then Phase 6 must mount `uploads` as a named volume and Phase 8 must back it up. |
| **CI/CD** | **IN PROGRESS** (CI yes, CD no) | `.github/workflows/ci.yml` on push to `main` and every PR: Node 22 → `npm ci` → `npm audit --audit-level=high` → lint → typecheck → build → `npm test` (~3,500 HTTP assertions against a `mongo:7` service, with throwaway masked JWT secrets). Dependabot weekly, grouped. **No deployment stage exists.** |
| **Monitoring** | **NOT STARTED** | `utils/logger.ts` is an 18-line `console` wrapper — plain text, no request id, no pino/winston (the project brief calls for pino; the code does not have it). `morgan` runs in **non-production only**, so production logs no requests. No metrics, tracing or alerting. Error handling is sound (`middleware/error.ts`: one envelope, no stack traces in production). Audit logging is implemented (`AuditLog`, never throws). `GET /api/health` returns static `ok` and **does not check MongoDB**; there is no readiness endpoint. |
| **Load testing** | **NOT STARTED** | None performed. No capacity figure in any document is measured. |
| **Scaling** | **NOT STARTED** | Single process serving HTTP, the scheduler, exports, imports, campaigns and image processing. Architecturally fine for ~10 businesses today; see the roadmap §15.2 for the per-tier readiness judgement — none of which is a capacity guarantee. |

### 1.1 Phase 1 — Redis foundation (completed 2026-10-08)

**Client: `ioredis` 5.11**, in the `server` workspace. Chosen over `node-redis`
for one decisive reason: BullMQ (Phases 2–3) supports ioredis and not
node-redis, and adding a second Redis client later to satisfy the queue would
be the exact duplication this phase exists to avoid. It also ships its own
TypeScript types and handles `rediss://` TLS from the scheme.

**Configuration** — `server/src/config/env.ts`, validated by the existing zod
schema, documented in `.env.example`:

| Variable | Meaning |
|---|---|
| `REDIS_URL` | `redis://host:port`, or `rediss://` for TLS. Optional. |
| `REDIS_KEY_PREFIX` | Key namespace. Defaults to `retailersuites:<NODE_ENV>:`. |

Three behaviours, deliberately different from each other:

- **Unset** → the client is never constructed; the application is byte-for-byte
  what it was before. Logged once at boot.
- **Set but unreachable** → the server boots anyway, the failure is logged, and
  ioredis retries with capped backoff. Startup is not delayed: a refused
  connection fails immediately, and even a hanging one is waited on for at most
  5 seconds before boot continues.
- **Malformed** → the process refuses to start, because the existing env schema
  treats a bad value as a misconfiguration rather than an absence.

**Connection architecture** — `server/src/config/redis.ts`:

- `resolveRedisConfig(source)` — pure; derives url, namespace and TLS flag.
- `createRedisClient(config, overrides?)` — the factory. Application defaults
  fail fast (`enableOfflineQueue: false`, `maxRetriesPerRequest: 2`) so a caller
  can fall back rather than hang. Overrides exist so a queue connection can be
  built from the same configuration.
- `connectRedis()` / `disconnectRedis()` — lifecycle, called from `server.ts`
  beside the MongoDB equivalents. Both idempotent; `connectRedis` never throws,
  `disconnectRedis` quits politely then drops the socket if Redis does not
  answer within 2 seconds.
- `getRedis()` / `redisConfig()` / `redisState()` / `pingRedis(timeoutMs)`.

**One client per process**, created once at startup — never in a route handler
and never per request. Nothing in the design ties it to a single process: the
factory and the resolved configuration are what the Phase 2 worker and any
further API replica will use.

**Error reporting.** ioredis emits `error` on every failed reconnect, which for
an unreachable server is several lines a second. The first is logged in full;
identical repeats are counted and re-logged at most once a minute, and the
suppressed count is reported when the connection recovers. Nothing is swallowed.

**Health.** `/api/health` is unchanged in shape, status code and MongoDB
behaviour; it gains `data.dependencies.redis = { configured, state, ready }`.
This is reporting, not gating — Redis being down does not make the endpoint
unhealthy, because nothing requires Redis and a till must keep selling. The
state is read from the live ioredis connection, so it cannot claim Redis is
fine when it is not.

**Tests** — `server/src/config/redis.check.ts`, wired into `npm test` as
`npm run test:redis` (the same `*.check.ts` convention as
`productLimits.check.ts`). It runs a minimal RESP server on a loopback port, so
everything below is a real socket through the real ioredis client against the
real module, with no Redis service and nothing about the connection mocked —
the approach `zinipay.check.ts` already uses for a payment gateway. Covered:
configuration resolution (absent, blank, default and explicit namespace,
separator handling, TLS detection); client construction and the BullMQ override;
the namespace actually appearing on the wire; a real connectivity check; the
single-client guarantee; **that a failing Redis is never reported ready**; that
a Redis which is down does not break startup; and shutdown, including a second
call.

Verified on 2026-10-08: `npm run lint`, `npm run typecheck`, `npm test`
(**4,011 + 16 + 23 + 42 assertions, 0 failures**), and the real server process
booted in all three configurations above — `ready: false` when Redis is absent
or unreachable, `ready: true` when it answers, clean `SIGTERM` exit (~60 ms) in
every case.

**Limitations, recorded honestly:**

1. **Nothing consumes Redis yet.** That is the scope of this phase. Rate
   limiting is still a per-process memory store (finding R1) and the scheduler
   still runs in every API process (B3) — so this does **not** yet make it safe
   to run more than one API replica. Phase 4 is what changes that.
2. **No real-Redis integration test in CI.** CI has no Redis service, and
   adding one belongs with the CI/CD phase. The RESP stub exercises the protocol
   and the module, but not a real server's semantics; the first consumer should
   be tested against a real Redis locally.
3. **`/api/health` reports cached connection state, not a round trip.**
   `pingRedis()` exists as the primitive, but a true readiness endpoint — and
   the Phase 0 finding that `/api/health` answers `ok` with a dead database —
   remain for the reliability/observability phase, deliberately untouched here.
4. **No connection-pool or Sentinel/Cluster configuration.** A single endpoint
   is what the roadmap's target architecture calls for; Cluster would change the
   key-namespace design and should be a deliberate decision when it is needed.

### 1.2 Phase 2 — BullMQ worker foundation (completed 2026-10-08)

**BullMQ 5.81**, in the `server` workspace. It depends on `ioredis` 5.11.1 —
the exact version Phase 1 installed — so the tree holds **one** ioredis and one
Redis configuration, which was the requirement.

**Where it lives.** `server/src/queues/`, as the Phase 0 roadmap §4 planned:

| File | Holds |
|---|---|
| `options.ts` | queue naming rules, the key namespace, default job options, default concurrency, shutdown grace, the payload policy |
| `connection.ts` | the one shared BullMQ Redis connection and its lifecycle |
| `index.ts` | `createAppQueue`, `createAppWorker`, `queueStatus`, `shutdownQueues` |
| `queues.check.ts` | the tests |

**Usage, which is the point of the phase:**

```js
const queue = createAppQueue('messaging');
await queue.add('campaign', { campaignId });              // ids, never documents

createAppWorker('messaging', processor, { concurrency: 4 });
```

A feature configures no Redis and no BullMQ for itself.

**Redis connection.** Built through the Phase 1 factory —
`createRedisClient(redisConfig(), …)` — so there is still exactly one place
that knows how to reach Redis. It cannot be the *same client*, for two reasons
read out of BullMQ's source rather than assumed:

1. BullMQ **throws** if the client it is given has an ioredis `keyPrefix`
   (`redis-connection.js`: "ioredis does not support ioredis prefixes, use the
   prefix option instead"), because its Lua scripts address keys explicitly.
   The Phase 1 client sets one by design, so the queue connection clears it and
   the namespace is applied as BullMQ's own `prefix`, derived from the same
   value: `retailersuites:<NODE_ENV>:bull`.
2. A blocking connection **throws** unless `maxRetriesPerRequest` is null. The
   Phase 1 client sets it to 2 on purpose, so an ordinary command fails fast.

`enableOfflineQueue` is also left on, unlike the application client, so a brief
reconnect delays adding a job rather than rejecting it.

**Connection count: one, plus one per worker.** Queues are non-blocking and all
share the single connection. A worker blocks on `BZPOPMIN` and therefore cannot
share one — BullMQ handles that itself by duplicating the shared connection per
worker (`worker.js`: `blockingConnection: true, shared: false`). The connection
is opened on **first use, never at import**, so importing the foundation opens
nothing and nothing is ever opened per request.

**Policy, centralised in `options.ts`:**

| Setting | Default | Why |
|---|---|---|
| `attempts` | 3 | Enough to ride out a brief failure, few enough that a broken job stops instead of hammering a third party. Finite on purpose: **no future job is accidentally infinite.** |
| `backoff` | exponential from 10s | 10s, 20s, 40s — a struggling dependency gets room. |
| `removeOnComplete` | 7 days or 1,000 | Long enough to answer "did that run?". |
| `removeOnFail` | 30 days, **no count limit** | A failed job is the record of something that did not happen; a burst must not evict the evidence. |
| concurrency | 1 | Opted into, never inherited optimistically — image work is CPU-bound, campaign sending is bounded by the gateway. |
| shutdown grace | 15s | Active jobs finish, then are abandoned to the stalled check. |

Queue names are validated, not merely documented: lowercase kebab-case, no
environment and no tenant in the name. `createAppQueue('Some Job')` throws at
the call site rather than quietly creating a queue no worker is listening to.

**Payload policy** (`options.ts`, `PAYLOAD_POLICY`): payloads live in Redis in
plain text until trimmed, so they carry **identifiers, not documents** — the
processor re-reads from MongoDB, which is also the only way it can act on
current data rather than a stale snapshot. **No secrets ever** — no gateway key,
no SMTP password, no token. Personal data only where an id will not do.

**Processes.** The API is unchanged and starts no worker; `worker.ts` starts no
HTTP server. Both are asserted by a test that reads the sources, so wiring a
worker into the API fails the suite. The worker connects MongoDB, opens and
**pings** the queue connection, registers its workers (none yet) and idles.

**Redis optionality differs by process, deliberately.** The API keeps Phase 1's
behaviour: Redis is optional and its absence changes nothing. The worker
**requires** it and exits 1 with a clear message when it is missing or
unreachable — a worker without Redis is not degraded, it is a process that will
never run a job while looking healthy.

**Observability.** `/api/health` was **not** changed; expanding the API's
health contract with queue depth belongs with the Phase 11 observability work,
and `queueStatus()` is the primitive it will read. The worker logs its start,
the Redis connection state, each worker registered, shutdown started and
shutdown completed. Failures and stalls are logged per job; completions are
logged at `debug`, so a busy hour does not make the log useless.

**Tests** — `server/src/queues/queues.check.ts`, run by `npm test` as
`npm run test:queues`. Two phases in two processes, because the foundation reads
its configuration once at load and a dynamic import is memoised even when
`require.cache` is cleared: the first runs with no Redis, then re-executes the
file as a child with `REDIS_URL` set, carrying the loader through
`process.execArgv`. Covered: queue-name validation (6 valid, 9 invalid forms),
namespace derivation and per-environment separation, every retry/retention
default including that failures are never trimmed by count, the three guards
that fire without Redis, idempotent shutdown from nothing, the source-level
API/worker separation, the BullMQ connection requirements on the live
connection, one shared connection across queues and workers, create-once
semantics for both, option overrides merging into the policy rather than
replacing it, and a bounded idempotent shutdown.

Verified on 2026-10-08: `npm run lint`, `npm run typecheck`, `npm run build`
(including `dist/worker.js`) and `npm test` (**4,011 + 16 + 23 + 42 assertions,
0 failures**, plus both foundation checks). The real worker process was also run
three ways: Redis missing → exit 1; Redis configured but unreachable → exit 1
with a clear message; Redis reachable → connects, pings, warns that no
processors are registered, idles, and exits 0 within ~50 ms on both `SIGTERM`
and `SIGINT`.

**Limitations, recorded honestly:**

1. **BullMQ's own behaviour is not tested.** Job pickup, retry on the configured
   backoff, stall detection and trimming all live in Lua scripts inside a real
   Redis, and there is no Redis in CI. Phase 1 could test its connection against
   a protocol stub because a PING is a PING; a queue cannot, and a stub
   answering BullMQ's scripts with plausible nonsense would prove the stub, not
   the system. The tests cover the policy and the guards. **The first processor
   Phase 3 adds should be exercised against a real Redis.**
2. **Nothing is queued yet,** so none of this is on a production path. The
   policy above is untried against real traffic.
3. **Enqueueing from the API needs care in Phase 3.** The queue connection uses
   `maxRetriesPerRequest: null`, as BullMQ requires, which means a command
   issued while Redis is unreachable waits instead of failing. An API request
   that enqueues must therefore bound the call itself — a timeout, and a decision
   about whether a failed enqueue is fatal to the request — or a Redis outage
   becomes a hung checkout. This is the one sharp edge the foundation hands to
   Phase 3.
4. **The worker idles with no processors.** It is honest about it (a warning at
   startup) but a process manager will still report it as healthy. Phase 3 is
   what gives it work.
5. **No queue dashboard and no queue metrics.** Deliberate: that is Phase 11.

### Deployment model

**UNDOCUMENTED.** No Dockerfile, compose file, Nginx config, PM2 ecosystem,
systemd unit, deploy script or deploy workflow exists in this repository. CI
verifies and never deploys. Whatever production exists is hand-configured on the
host and described nowhere. **Writing it down is the first Phase 8 deliverable**
and the largest operational risk in the audit.

---

## 2. Feature / product status

Infrastructure is the subject of this file; the product history lives elsewhere.

| Topic | Where |
|---|---|
| Architecture, tenancy, verticals, concurrency model | `docs/ARCHITECTURE.md` |
| Super Shop implementation journal (was this file until 2026-10-08) | `docs/SUPERSHOP_IMPLEMENTATION_JOURNAL.md` |
| Repository audits | `AUDIT.md`, `docs/AUDIT-2026-09-25.md`, `docs/AUDIT-2026-09-27.md` |
| Restaurant vertical audit | `docs/RESTAURANT_AUDIT.md` |
| Universal POS programme | `docs/UNIVERSAL_POS_PLAN.md` |
| Per-feature design notes | `docs/` (printing, returns, exports, loyalty, shifts, imports, …) |

---

## 3. Phase order

```
PHASE 0   Infrastructure audit                      COMPLETED  (2026-10-08)
PHASE 1   Redis foundation                          COMPLETED  (2026-10-08)
PHASE 2   BullMQ worker foundation                  COMPLETED  (2026-10-08)
PHASE 3   Background-job migration                  NOT STARTED   ← next
PHASE 4   Rate limiting (distributed)               NOT STARTED
PHASE 5   Idempotency / reliability                 NOT STARTED
PHASE 6   Docker                                    NOT STARTED
PHASE 7   Docker Compose + local production-like    NOT STARTED
PHASE 8   VPS deployment                            NOT STARTED
PHASE 9   Cloudflare + SSL                          NOT STARTED
PHASE 10  GitHub Actions CI/CD                      NOT STARTED
PHASE 11  Monitoring / observability                NOT STARTED
PHASE 12  Load testing / scaling                    NOT STARTED

R2 / object storage                                 DEFERRED
```

**Next phase: PHASE 3 — background-job migration.** Scope and the full
candidate list with priorities are in `docs/INFRASTRUCTURE_ROADMAP.md` §5. It
was not started in this session, by design: Phase 2 is the foundation and
nothing more.

Phase 3 uses `createAppQueue` / `createAppWorker` and registers each processor
in `registerWorkers()` in `server/src/worker.ts`. Order, from §5.2:

1. The two `setInterval` passes in `jobs/subscription.job.ts` → repeatable
   jobs. No user-visible change, every pass already idempotent, so it is the
   safest way to prove the worker. **Delete `startSubscriptionJobs` from
   `server.ts` in the same commit** — two code paths for the same work is how
   double-sends happen.
2. SMS/email campaigns → fan-out queue. The biggest single win.
3. Password-reset and verification emails — watch the delivery-reporting
   contract: `verification.service` currently tells the caller whether the
   message was delivered, which queueing changes to "accepted".
4. Image optimisation (validation stays inline), 5. import commit (needs
   per-row progress first), 6. exports (needs an answer on where the file goes).

Read limitation 3 in §1.2 before the first API-side enqueue.

---

## 4. Change log

| Date | Change |
|---|---|
| 2026-10-08 | **Phase 2 — BullMQ worker foundation.** Added `bullmq` (which reuses the ioredis Phase 1 installed) and `server/src/queues/`: `createAppQueue` / `createAppWorker` over one shared BullMQ-compatible connection built from the Phase 1 Redis configuration, with naming validation, the key namespace, conservative finite retry/backoff/retention defaults and the payload policy centralised in `queues/options.ts`, plus registries, lifecycle logging and a bounded idempotent `shutdownQueues`. Added `server/src/worker.ts`, a separate process (`npm run worker`, `npm run worker:dev`) that starts no HTTP server, requires Redis and exits 1 without it. New `server/src/queues/queues.check.ts` (run by `npm test`). **No queue, no processor and no migrated job**: the API's `setInterval` scheduler still runs exactly as before. |
| 2026-10-08 | **Phase 1 — Redis foundation.** Added `ioredis` to the `server` workspace and `server/src/config/redis.ts`: one shared, lazily-opened client with a pure config resolver, a client factory reusable by the future worker, bounded fail-fast command defaults, de-duplicated error logging, a `pingRedis` primitive and idempotent lifecycle calls wired into `server.ts` beside MongoDB's. `REDIS_URL` and `REDIS_KEY_PREFIX` added to the env schema and `.env.example`; Redis is optional, an unreachable server is never fatal, a malformed URL refuses to boot. `/api/health` additively reports the live connection state. New `server/src/config/redis.check.ts` (run by `npm test`) proves all of it against an in-process RESP stub. Nothing consumes Redis yet; rate limiting, queues and the scheduler are untouched. |
| 2026-10-08 | Phase 0 infrastructure audit. Added `docs/INFRASTRUCTURE_ROADMAP.md`. Replaced this file with the infrastructure status tracker and moved its previous contents — the Super Shop implementation journal — to `docs/SUPERSHOP_IMPLEMENTATION_JOURNAL.md`. Added the infrastructure section to `docs/ARCHITECTURE.md` and corrected its stated dependency versions. No application code changed. |
