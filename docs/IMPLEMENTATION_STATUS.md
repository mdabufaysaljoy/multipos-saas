# Implementation status

**The source of truth for infrastructure state between sessions.** Last
verified against the code on **2026-10-08** (branch
`claude/retailer-suites-audit-e61761`). Phases completed: **0** (audit),
**1** (Redis foundation), **2** (BullMQ worker foundation), **3 in part**
(campaign delivery migrated; the other candidates are not), **4** (distributed
rate limiting), **5** (idempotency on the sale and order flows), **6** (Docker images, now built and run), **7** (Compose + real infrastructure
integration testing).

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
| **Background jobs** | **IN PROGRESS** — 1 of 6 migrated | **Done:** campaign SMS/email delivery, on the `campaign-delivery` queue (see §1.3). **Not started, unchanged from the audit:** password-reset and verification emails (inline SMTP), exports (up to 200,000 rows streamed), product import commit (~6,000 documents), `sharp` image optimisation, and the two `setInterval` passes in `jobs/subscription.job.ts`. **Exception that stays as it is:** billing emails already use a correct durable queue in MongoDB (`EmailNotification` — keyed, leased, 5 attempts, backoff); only its driver should ever move. |
| **Rate limiting** | **COMPLETED** | `express-rate-limit` v7 with a **Redis-backed store** (`middleware/rateLimit.ts`) shared by all 23 policies — the original 1 global + 19 route limiters, migrated with their windows, limits, keys, status codes, headers and messages unchanged, plus 3 new ones. Counters live in Redis under the Phase 1 namespace, so every replica sees the same count. Findings closed: R1 (per-process stores), R2 (no per-account login protection), R3 (`/auth/refresh` and `/auth/logout` unlimited), R4 (`trust proxy` hard-coded — now `TRUST_PROXY_HOPS`). See §1.4. |
| **Idempotency** | **COMPLETED** for sale/order creation | A shared mechanism (`services/reliability/idempotency.service.ts` + `IdempotencyRecord`, unique on `(scope, key)`) now protects the three flows that had none: **Restaurant orders, Super Shop sales and Pharmacy sales**. Clothing keeps its own, older mechanism, which the audit confirmed correct, now covered by regression tests. Per-resource keys on `Payment`, `WalletTransaction`, `UsageCharge`, `UpgradeRequest` and `LoyaltyMembership` are unchanged. **Remaining gap:** a plain return (not an exchange) still stores no key — see §1.5. |
| **Docker** | **COMPLETED** | `docker/Dockerfile` builds for real — 53s, `linux/arm64`, non-root `uid=1000`, production dependencies only, one image for the API and the worker. Linux native prebuilds load inside the container (`sharp` + libvips 8.18.7, `msgpackr`, `bullmq`). Everything Phase 6 could not verify has been run; see §1.7. |
| **Docker Compose** | **COMPLETED** | `docker-compose.yml`: nginx, API, worker, Redis and a **single-node MongoDB replica set**. Only nginx publishes a port. `docker-compose.test.yml` is a test-only override that lets the repository's own end-to-end suite run against the stack. Detail in §1.7 and `docs/DOCKER.md`. |
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

### 1.3 Phase 3 (first migration) — campaign delivery (completed 2026-10-08)

**Queue `campaign-delivery`**, one job per bounded batch of recipients,
processed by the worker process from Phase 2. This is the first workload off
the request path; nothing else has moved.

**Before.** `POST /messaging/campaigns` (and `/messaging/email-campaigns`)
resolved the audience, charged the wallet, then looped the recipients
**sequentially inside the HTTP request** — creating a row, calling the gateway
and saving, one at a time, for up to 5,000 recipients. The caller waited for
all of it. An API crash halfway left the campaign `sending` for ever, with some
messages delivered, no refund issued, and no way to resume.

**After.** The request validates, resolves the audience (tenant-scoped, as
before), creates the campaign as `queued`, writes **one row per recipient**,
charges the wallet once, enqueues one job per batch, and returns. Delivery
happens in the worker.

**Batching: 100 recipients per job** (`CAMPAIGN_BATCH_SIZE`). Chosen from what
the work costs: sends are sequential and a gateway call takes a few hundred
milliseconds, so a batch is roughly half a minute — short enough that a crash
or a redeploy loses and repeats little, long enough that 5,000 recipients is
**50 jobs rather than 5,000**. Each recipient's row carries its `batchIndex`,
so batches are disjoint and a job needs no recipient list.

**Concurrency: 1**, both at the worker and inside a batch. The implementation
this replaces sent one message at a time, the gateways' own limits are not
documented in this codebase, and the first migration's job is to be correct.
There is no `Promise.all` over recipients anywhere. Raising it later means
raising the worker's `concurrency` in `queues/campaign.queue.ts` — the delivery
code needs no change, because batches are disjoint and every recipient is
claimed before it is attempted — and it should wait for a known provider limit.

**Retry and backoff** come from the Phase 2 central policy: 3 job attempts,
exponential backoff from 10s. Per recipient there is a second bound,
`MAX_DELIVERY_ATTEMPTS = 3`, so no recipient can be attempted endlessly even
across job retries.

**Payload.** `{ campaignId, tenantId, batchIndex }` — three identifiers. No
recipient list, no message body, no credentials. The worker reads the
authoritative data from MongoDB. The job id is
`campaign:<campaignId>:batch:<n>`, so enqueueing the same batch twice is a
no-op in BullMQ.

**Delivery persistence and idempotency.** The `SmsMessage` row per recipient
already existed; this migration made it the delivery record:

| Added | Why |
|---|---|
| unique partial index `(campaignId, recipient)` | one recipient cannot appear twice in a campaign, so a repeated attempt cannot create a second row |
| `status: 'sending'` + `claimedUntil` lease | a worker *claims* a recipient before attempting it, so two workers cannot send to the same person at once |
| `attempts` | bounds transient retries per recipient |
| `failureKind: 'transient' \| 'permanent'` | separates "try again" from "trying again cannot help" |
| `batchIndex` | which job owns this recipient |

A recipient is claimed by one atomic `findOneAndUpdate`; a row already `sent` is
not a candidate, so **a retried job skips what already went out**. A row claimed
by a worker that died becomes claimable again once its lease expires. At most
one attempt per recipient per pass, so a transient failure waits for the queue's
backoff rather than being burned through in a tight loop.

**Failure classification** (`classifyDeliveryFailure`): invalid or rejected
recipients, SMTP 5.x.x and 55x codes, authentication and configuration errors,
and insufficient balance are **permanent** — retrying cannot help and hammering
a shared gateway damages a sender reputation every tenant depends on. Timeouts,
network errors and 4xx-style "try later" are **transient**. Anything
unrecognised is treated as transient, which is safe only because attempts are
bounded both ways. The reason is stored on the row, with credentials redacted.

**Campaign status.** `queued → sending → completed | failed`. `queued` is new;
the terminal states are unchanged, so a campaign that delivered some and failed
some is still `completed` with a non-zero `failedCount`, which is exactly what
the UI already reads. The campaign table renders no status column, so nothing
in the UI needed changing beyond the two toasts, which now say "queued —
sending now" rather than claiming every customer already has it.

**Money, unchanged.** One charge for the whole campaign up front; one refund for
the failures at the end. Finalisation is a compare-and-swap on the campaign
status, and only the caller that wins it issues the refund — without that, fifty
batch jobs would each refund the same campaign. If the enqueue itself fails, the
charge is returned, the campaign is marked `failed`, and the API reports the
failure rather than claiming the campaign was queued.

**Tenant isolation.** The worker runs outside any HTTP request, so
`resolveTenant` has not run and nothing may be inferred from a session. Every
query carries `tenantId` from the job and matches it against the campaign
itself; a campaign id alone is never trusted. A job naming another workspace
delivers nothing and leaves the campaign untouched — asserted in the tests.

**Recovery.** All state is durable in MongoDB before anything is enqueued, so:
an API crash after enqueue leaves a campaign a worker can finish; a worker crash
leaves claims that expire and are picked up again; a worker restart continues
from the rows, never from memory; a Redis outage delays delivery rather than
losing it; a provider outage becomes transient failures that retry. Nothing
depends on in-process progress.

**When Redis is absent the delivery runs inline**, exactly as it did before this
migration. Phase 1 made Redis optional for the API deliberately, and a
deployment without it must still be able to send a campaign — enqueueing into
nothing would mean a campaign that silently never goes out. It is the **same
function** either way (`deliverCampaignBatch`), reached two ways; there is no
second implementation to drift. This is also why the existing end-to-end suite
still passes unchanged: with no `REDIS_URL` it exercises the delivery code
inline, end to end, through the real provider and billing path.

**Tests.** `server/src/seed/campaignDelivery.check.ts`, run by `npm test`
(**82 assertions**). Delivery is driven through a `setCampaignSender` seam —
the same pattern `transactionalEmail.service.ts` uses — so successes, transient
failures, permanent failures and thrown errors are deterministic and no real
gateway is contacted. It covers batching; the deterministic job id; the
worker's two decisions (is this the final attempt, and should the batch be
handed back); the happy path through to `completed`; **tenant isolation**;
database-level duplicate protection; the full failure-classification table;
transient retry that skips what already went out; permanent failures never
retried; the per-recipient attempt bound; the final attempt giving up rather
than hanging; a thrown provider error not abandoning the batch; **recovery from
an expired claim**; finalisation and refund happening exactly once; cancelled
and missing campaigns; and the email channel through the same code. The 4,011
existing end-to-end assertions pass unchanged.

**Two bugs these tests caught before commit**, both mine, both in this phase's
code: a transient failure was immediately re-claimable inside the same pass, so
one batch burned a recipient's three attempts in milliseconds instead of
retrying later on the backoff; and two configuration failures ("the API key is
invalid", "No SMS gateway is configured") were classified transient. A third was
caught by running the real worker process: `shutdownQueues` awaited the graceful
worker close while the forced close was fire-and-forget, so a worker whose
connection had gone hung the shutdown until the 30-second backstop killed the
process with exit 1. All three are fixed.

**Limitations, recorded honestly:**

1. **Exactly-once external delivery is not possible here, and is not claimed.**
   If a gateway accepts a message and the process dies before the row is
   updated, the claim expires and the recipient is attempted again — that person
   gets the message twice. Closing it would need provider-level idempotency
   keys, which neither the SMS gateway nor SMTP offers in this codebase. The
   design is at-least-once with durable duplicate protection either side of a
   single unprotected instant: one row update immediately after one send. **The
   money is not exposed to it** — a campaign is charged once up front and
   reconciled once at the end.
2. **BullMQ's own behaviour is still not covered by a test, and real-Redis
   validation did not happen in this session.** There is no Redis on this
   machine and no Docker to run one, and CI has no Redis service. What *was*
   verified: the worker process starts, registers `campaign-delivery` at
   concurrency 1, refuses a malformed payload, and shuts down cleanly with exit
   0. What was **not** verified anywhere: that Redis hands a real job to the
   worker, that BullMQ retries it on the configured backoff, and that a stall is
   detected. **Before trusting this in production, run one campaign against a
   real Redis with the worker attached.** Adding a `redis:7` service to
   `.github/workflows/ci.yml` and starting the worker in the harness is the
   cheapest way to make that permanent; it was deliberately not done here
   because it could not be validated locally.
3. **Two separate POSTs still create two separate campaigns.** That is unchanged
   behaviour and arguably correct, but it means the API has no request-level
   duplicate protection — a double-submitted form sends twice. The queue path is
   protected (deterministic job ids, per-recipient claims); the *request* is not.
   An `Idempotency-Key` on the endpoint belongs with Phase 5.
4. **The unique `(campaignId, recipient)` index must be created deliberately in
   production.** Mongoose only builds missing indexes outside production, and
   any pre-existing duplicate pair has to be resolved first.
5. **No progress reporting.** A caller sees `queued`, then eventually a terminal
   state; `sentCount` only becomes meaningful at the end. Per-batch progress is
   in the rows if a UI ever wants it.
6. **A 15-second shutdown grace applies per worker.** A deploy during a campaign
   waits up to that long for the batch in hand, then stops it and leaves the
   remainder to the next worker.

### 1.4 Phase 4 — distributed rate limiting (completed 2026-10-08)

**The problem.** Every limiter used `express-rate-limit`'s default
`MemoryStore`, which counts inside one process. With N replicas the real limit
is N times the configured one — a login limit of 20 per quarter hour becomes 60
across three replicas — so the limit an operator reads in the code is not the
limit an attacker meets.

**What changed: only the storage.** All 20 existing limiters keep their exact
window, limit, key, status code, headers and message. They are the same
`express-rate-limit` middleware, handed a different store. Nothing about an
allowed request changed, and no frontend change was needed.

**Algorithm: fixed window, one atomic `EVAL` per request.**

```lua
local hits = redis.call('INCR', KEYS[1])
local ttl  = redis.call('PTTL', KEYS[1])
if hits == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { hits, ttl }
```

Chosen because it is what the limiters already were — a fixed window — so
migrating changed storage and not policy; because `INCR` creates the key at 1
and the expiry is set in the **same script**, so a counter can never outlive its
window and there is no read-then-write for concurrent requests to slip through;
and because it is one round trip. A sliding window or token bucket would have
been a policy change as well as a storage change, and nothing in the audit asked
for one. A dependency (`rate-limit-redis`) was considered and not taken: it
would have added a package to run four lines of Lua, and its own key prefixing
would have had to be reconciled with Phase 1's.

**Redis architecture.** The store reuses the **shared Phase 1 client** from
`config/redis.ts`. Not the BullMQ connection, which is configured for queues,
and not a new one — so this phase adds **zero** Redis connections, and nothing
is created per request. The Phase 1 defaults are what a limiter needs:
`enableOfflineQueue: false` and a bounded `maxRetriesPerRequest`, so a command
issued while Redis is away fails in milliseconds rather than holding a request
open, which is what makes the fallback usable.

**Key design.** `rl:<policy>:<identity>`, passed bare so the Phase 1 client
prefixes it with `retailersuites:<NODE_ENV>:` — verified on the wire as
`rlwire:rl:api:::ffff:127.0.0.1` (ioredis applies `keyPrefix` to `EVAL` keys,
whose key index it knows). Two environments sharing a Redis therefore cannot
share counters, and two policies or identities never collide. An identity is an
IP, a workspace id, or a **sha256 hash** of a submitted identifier — never a
password, token or Authorization header, and nothing identifying reaches the
logs.

**Redis outage behaviour, decided per policy, not globally:**

- **`memory`** — fall back to a per-process counter. The configured limit still
  applies, once per replica, so protection degrades from N to N × replicas
  rather than disappearing. **This is not fail-open.** It is right wherever
  availability matters more than exactness: a till that cannot sign in cannot
  sell, and a cache outage must not become a trading outage.
- **`closed`** — refuse with 429. Four policies, all guarding either spending on
  the customer's behalf or the API's own capacity, where a runaway client is the
  actual threat and refusal costs only a retry: `messaging-send`, `export`,
  `product-import`, `pos-import`.

**One distinction that matters:** `closed` means "refuse while a Redis we were
told to use is unreachable", **not** "refuse because no Redis was configured".
Phase 1 made Redis optional for the API deliberately, so when `REDIS_URL` is
unset every policy uses the per-process counter — exactly the behaviour that
shipped before this phase. Without that split, Phase 4 would have silently
turned Redis into a hard dependency and taken whole features away with it. (It
did, briefly: the first version broke every messaging test, which is how it was
caught.)

**TTL.** Set in the same script that creates the counter, and the `ttl < 0`
branch repairs a key that somehow exists without one — so there is no path to an
unbounded counter key.

**Trust proxy.** Was `isProd ? 1 : false`. The hop count decides `req.ip`, and
`req.ip` is the identity nearly every limiter counts against, so it is now
configuration: **`TRUST_PROXY_HOPS`**, default `1` — unchanged behaviour today.
Too high lets a client spoof its address and mint itself a fresh bucket; too low
throttles the whole internet against one. It must be re-set when Cloudflare goes
in front (Phase 9). No limiter reads a forwarding header directly.

**Verification list — all 20 existing policies, limits preserved:**

| Policy | Route(s) | Window | Prod limit | Key | Fallback |
|---|---|---|---|---|---|
| `api` | all `/api` | 1 min | 600 | IP | memory |
| `auth-credentials` | register, login, login/select | 15 min | 20 | IP | memory |
| `auth-password-forgot` | password/forgot | 15 min | 5 | IP | memory |
| `auth-password-reset` | password/verify-code, password/reset | 15 min | 30 | IP | memory |
| `auth-switch-workspace` | switch-workspace | 1 min | 30 | IP | memory |
| `auth-verification` | verification/send, verification/confirm | 1 min | 6 | IP | memory |
| `account-topup` | account top-up | 15 min | 10 | IP | memory |
| `export` | exports | 1 min | 5 | IP | **closed** |
| `product-import` | products/import | 1 min | 5 | IP | **closed** |
| `pos-import` | POS imports | 1 min | 5 | IP | **closed** |
| `messaging-send` | messaging sends | 1 hour | 60 | **tenantId** | **closed** |
| `payment-callback` | payments/callback | 1 min | 60 | IP | memory |
| `payment-checkout` | payments/checkout | 1 min | 10 | IP | memory |
| `payment-provider-events` | provider relay events | 1 min | 120 | IP | memory |
| `platform-admin` | platform admin actions | 1 min | 60 | IP | memory |
| `pricing-quote` | pricing quotes | 1 min | 60 | IP | memory |
| `printing-sign` | printing sign | 1 min | 240 | IP | memory |
| `subscription-purchase` | subscription purchase | 1 min | 20 | IP | memory |
| `workspace-create` | workspace create | 1 hour | 10 | IP | memory |
| `workspace-cancel` | workspace cancel | 15 min | 20 | IP | memory |

Development and test limits are unchanged too (5,000–20,000), so the
end-to-end suite is not throttled.

**Three policies added:**

| Policy | Route | Window | Limit | Key | Why this number |
|---|---|---|---|---|---|
| `auth-login-account` | login | 15 min | 10 | sha256(email) | The per-IP limit cannot stop credential stuffing — a thousand hosts each making one attempt never trips it. This counts against the address someone typed. **Only failed attempts count**, so a busy till is never locked out by its own successful sign-ins. |
| `auth-refresh` | refresh | 15 min | 120 | IP | An access token lives 15 minutes, so ten tills behind one office address refresh ~40 times an hour, plus reconnection retries. Generous enough not to touch normal multi-device use. |
| `auth-logout` | logout | 15 min | 60 | IP | Cheap, but should not be unmetered. |

On key growth: an attacker can mint one key per address they guess, but each is
a few dozen bytes with a 15-minute expiry, and the rate they can be created is
bounded by the per-IP limiter that runs **first** — which is why the order on
the login route matters. Enumeration is unaffected: the key is the submitted
identifier whether or not the account exists, and the 429 body is generic.

**Logging.** A rejection is not logged per request. An outage is logged once per
policy per minute, naming the policy and the fallback taken — never a key, an
address or an identifier.

**Tests.** `server/src/middleware/rateLimit.check.ts`, run by `npm test`
(**54 assertions**). The real `express-rate-limit` middleware with the real
store, driven through real request/response objects; what stands in for Redis is
a small executor that applies the script's own semantics (INCR/PTTL/PEXPIRE)
over a map. Covered: the script is atomic by construction and contains no
GET/SET pair; key namespacing, determinism and isolation across policies and
identities; identifier hashing; the limit boundary and the 429 envelope and
headers; window reset with a controllable clock; 20 concurrent requests each
receiving a distinct count 1..20 in exactly 20 round trips; **two store
instances sharing one counter** (the distributed property of our own code);
policy isolation; TTL always bounded; decrement and reset; both fallbacks; the
absent-vs-unreachable distinction; and the account-keyed identity collapsing
three addresses onto one counter while another account is unaffected.

**Real-Redis validation: partial, and the limits of it stated plainly.** There
is no Redis on this machine and no Docker to run one, so **genuine distributed
behaviour across two processes was not proven.** What *was* proven, by running
the real API in production mode against a protocol stub and reading the wire:
the limiters issue exactly one `EVAL` per request, the key arrives namespaced by
the Phase 1 prefix (`rlwire:rl:api:…`), and the global plus both login policies
fire in the expected order. What that does **not** show is Redis executing the
script atomically under real concurrency — that is Redis's own guarantee and
needs a real server. **Before relying on this with more than one replica, run
the two-instance test against a real Redis.**

**Limitations:**

1. **Multi-instance behaviour is not production-validated** (above). The code
   has no per-instance state and the tests prove two store instances share a
   counter, but that is our code, not Redis.
2. **Redis is now a production dependency for *distributed* enforcement.** The
   API still runs without it, and still rate limits — per process. An operator
   who wants the configured limits to be the real limits across replicas must
   run Redis.
3. **Fixed window, so a burst can straddle a boundary** — up to 2× the limit
   across two adjacent windows. That was true of the previous implementation
   too; changing it would be a policy change, and a sliding window is the
   upgrade path if a burst ever matters.
4. **`TRUST_PROXY_HOPS` is unverified against the real deployment**, because
   this repository still documents no deployment (§Deployment model). The
   default preserves today's behaviour; it must be re-checked in Phase 8/9.
5. **The `export` limiter keys on IP, not on the signed-in user**, despite the
   comment in `export.limits.ts` saying "per signed-in user". That mismatch
   predates this phase and the policy was deliberately left alone rather than
   silently tightened; it is worth a decision later.
6. **No rate-limit metrics.** Rejections are observable only in logs; counters
   and a dashboard belong with Phase 11.

### 1.5 Phase 5 — idempotency on sale and order creation (completed 2026-10-13)

**Audit first, and the Phase 0 findings held — with one correction.** Finding
I1 was confirmed: `ShopSale`, `PharmacySale` and `RestaurantOrder` carried no
idempotency key, no index and no replay, so a retried checkout rang up a second
sale. Finding I2 held (Clothing's key is optional). **The correction:** Phase 0
implied Clothing's protection might leave stock double-decremented on a race.
It does not — the duplicate-key path releases the stock it took and undoes the
loyalty redemption before returning the winner. Clothing was therefore left
alone, as §14 asked, and covered by regression tests instead.

**Architecture.** One record per (scope, key) in MongoDB, claimed before the
work starts:

```
claim  →  run the operation  →  mark completed with the result's id
              ↓ failure
          release the claim
```

**In MongoDB, not Redis**, deliberately: the sale it protects is a MongoDB
write, and the protection must not be weaker than the thing it protects. A
Redis restart would forget the key and let a retry sell again. Redis is a cache
in this system; this is a ledger.

**At the controller, not in the service.** The three sale services were not
touched at all — which is the strongest guarantee available that no pricing,
stock, VAT, split-payment, loyalty or kitchen-ticket rule moved. The controller
wraps the same service call it always made.

**Storage model** (`models/IdempotencyRecord.ts`):

| Field | Why |
|---|---|
| `scope` | `<tenantId>:<storeId>:<operation>` — never the key alone |
| `key` | the client's opaque key, validated and bounded |
| `fingerprint` | sha256 of the canonicalised business input |
| `status` | `processing` \| `completed` |
| `resultId`, `resultKind` | what the operation produced, for replay |
| `claimedUntil` | the lease, so a dead process does not block a key for ever |
| `expiresAt` | TTL — records cannot accumulate |

No request body and no payment data are stored; only a hash and an id.

**Unique index: `{ scope: 1, key: 1 }`, unique.** This is *the* concurrency
guard, and the tests assert it exists. A `findOne` then `create` could not do
the job — two concurrent checkouts would both read "nothing there" and both
sell. Instead one atomic upsert claims the key, and `returnDocument: 'before'`
returning null is how a request knows it owns the work.

**Fingerprint.** sha256 over a canonical rendering that sorts object keys at
every depth, preserves array order (sale lines are a sequence, not a set), and
renders types distinctly so `1` and `"1"` differ. `JSON.stringify` is not usable
here: key order follows insertion order, so the same logical request from two
clients could produce a spurious conflict. Excluded: the Authorization header,
cookies, trace ids, regenerated timestamps, and the key itself. Identity is not
hashed in — tenant and store are part of the *scope*, which is a stronger
separation.

**Tenant scope.** The same key string in two workspaces is two records and two
operations; asserted in the tests.

**Concurrency: refuse, do not hold.** A second request arriving while the first
is still running gets `409 IDEMPOTENCY_IN_PROGRESS`. Waiting would tie up a
connection for as long as the first takes, and a till that is told plainly can
ask again in a moment. Once the first finishes, the same key replays it.

**Transaction boundary: none added, deliberately.** These flows do not use
transactions — they use guarded `$inc` and compensation, which is what makes
them correct on the standalone MongoDB this project also supports — so §9's
instruction not to introduce transactions blindly was followed. The honest
consequence is in the limitations below.

**Retry semantics.** A validation failure, a stock refusal or a plan-limit
rejection **releases** the key: the operation did not happen, so the cashier
fixes the basket and retries with the same key from the same screen. A poisoned
key would turn one validation error into a dead till. A committed operation
keeps its record for the full retention window.

**Expiration: 24 hours** after completion. A till retry, a reload or a client
backoff happens in seconds or minutes; a provider re-delivery can take hours. A
day is comfortably longer than any of those and short enough to bound the
collection. MongoDB's own TTL index removes expired records, so an attacker
sending unlimited distinct keys cannot grow the collection without bound.

**Response replay** goes through the ordinary read path — `getSale` / `getOrder`
— so a retry sees the same shape the first response had rather than a stored
copy of it, with `replayed: true` added. Status stays `201`. Nothing sensitive
is persisted to replay.

**Supported endpoints** are listed in `docs/API.md` under *Idempotency*. The key
is **optional** everywhere: making it mandatory would break clients that have
not been updated, and a server-generated key would protect nothing because a
retry would carry a different one. The tills in this repository were updated to
send one — a per-basket key, rotated once the write succeeds — so the product is
protected in practice; anything that omits the header is unprotected and the API
doc says so.

**Results.**

| Flow | Outcome |
|---|---|
| **Restaurant order** | Protected. Retry replays; a changed basket is a conflict; a different key opens a new order; five concurrent opens create **one** order; `rev` still starts at 0. |
| **Super Shop sale** | Protected. Retry replays with `replayed: true`; **stock moves exactly once** across five concurrent checkouts; weighed goods, the out-of-stock note, VAT and split payment untouched. |
| **Pharmacy sale** | Protected. Retry replays; conflict detected; five concurrent checkouts create one sale. |
| **Clothing sale** | Unchanged. Regression tests prove a retry returns the same sale and that concurrent checkouts create one. |

**Other critical flows audited, and left alone** (§15):

| Flow | Finding |
|---|---|
| Payment creation | `Payment.idempotencyKey`, unique partial index, scoped `checkout:<tenant>:<key>`. Robust. |
| Wallet debit/credit | `WalletTransaction.idempotencyKey` unique partial, plus a conditional `balanceMinor: { $gte }` so concurrent debits cannot overdraw. Robust. |
| Subscription purchase | `UpgradeRequest.idempotencyKey` unique, plus a CAS lock on `Tenant.purchaseLockedUntil`. Robust. |
| Usage charges | `UsageCharge.idempotencyKey` unique partial. Robust. |
| Loyalty | `LoyaltyMembership.idempotencyKey` unique partial; adjustments use a derived dedupe key. Robust. |
| Exchanges | `Return.idempotencyKey` required and unique per `(tenant, store, key)`. Robust. |
| **Plain returns** | **Gap, unchanged.** A refund without an exchange stores `idempotencyKey: null`. Mitigated: a return *holds* the quantity on the sale line first, so a duplicate would exceed what is returnable and be refused. Narrow, but real. **Recommended next atomic migration** — not pulled into this phase. |

**Tests.** `server/src/seed/idempotency.check.ts` (**52 assertions**, real
MongoDB) covers the unique and TTL indexes; canonicalisation and fingerprinting
including key-order independence and array-order significance; key validation;
first-request-then-retry; payload conflict; tenant isolation; **eight
simultaneous requests running the operation exactly once**; a failed operation
leaving no record and the key reusable; a live claim blocking and an expired
claim being taken over by exactly one of three racers; the no-key path; and
retention. Plus **37 endpoint assertions** in the HTTP suite across all four
verticals, asserting the sale/order lists and the stock figures — not status
codes. Total suite: 4,048 HTTP assertions, 0 failures.

**Limitations:**

1. **Exactly-once execution is not guaranteed and is not claimed.** The claim
   and the business write are two MongoDB operations. A process that dies
   between committing a sale and marking the record completed leaves a claim
   whose lease expires, and the retry re-runs the operation. The window is one
   update wide. Closing it means putting the claim inside the same transaction
   as the sale, which needs a replica set and a redesign of flows this phase was
   not allowed to touch.
2. **No transaction coverage, and none claimed.** The test database is
   standalone MongoDB, so no transaction path was exercised — consistent with
   the Phase 0 finding that CI never exercises it either.
3. **Keys are optional.** An un-updated client is unprotected. Making them
   required on the sale endpoints is a small, breaking change worth considering
   once every client sends one.
4. **The lease is 60 seconds.** A checkout slower than that could, in principle,
   have its claim taken over while still running. It is far longer than any
   observed checkout, but it is a number, not a proof.
5. **Plain returns are still unprotected** (above).

### 1.6 Phase 6 — Docker foundation (written 2026-10-13, build pending)

**One image, two roles.** The API and the worker are the same compiled server
and the same dependencies, differing only in the entrypoint: `node dist/server.js`
and `node dist/worker.js`. Building them together means a worker cannot drift
from the API it shares a database with, and a release promotes one artifact.
The API starts no worker and the worker starts no HTTP server — that separation
lives in the application, not in the Dockerfile.

**Stages:** `deps` (npm ci from the lockfile, manifests only so the slow layer
caches) → `build-server` (tsc) → `build-client` (vite, artifact only) →
`client-assets` (a `scratch` stage for exporting the SPA) → `prod-deps`
(`npm ci --omit=dev`, scoped to the server workspace) → `server` (runtime).

**Base image: `node:22-bookworm-slim`**, chosen on evidence rather than habit.
Both native packages ship prebuilt binaries, and the lockfile was read to see
which platforms are covered: `sharp` has glibc *and* musl builds, but
`msgpackr-extract` (via BullMQ) has **no musl build**. On Alpine it would fall
back to `node-gyp`, meaning python3, make and g++ in the image to compile
something that has a ready binary for Debian. Debian therefore needs **no
compiler in any stage and no apt packages at all** — `sharp` carries its own
libvips. Host `node_modules` is excluded by `.dockerignore`, so macOS binaries
can never reach a Linux image.

**Client.** The API serves `/api` and uploaded files only — it does **not**
serve the SPA, and nothing was added to make it. The client is built as a
reproducible artifact and extracted with `--target client-assets --output`;
whatever serves it must proxy `/api` on the same origin, which is the Phase 8/9
reverse proxy. Phase 0's D4 (the client build fetching the API) was closed by
the one build-script change in this phase: `PRERENDER_REQUIRE_API=true` makes an
unreachable API a build failure instead of a silent fall back to built-in
marketing copy. Unset, it falls back and warns — right for development and CI,
and now a declared choice rather than an inherited one for a release.

**Runtime.** Non-root (`node`, uid 1000), `WORKDIR /app/server` so `dist/server.js`
and the uploads path resolve exactly as the `start` script does outside a
container, `PORT` from the environment, every interface bound. Node is PID 1 and
the application registers its own SIGTERM/SIGINT handlers; `--init` is
documented for grandchild reaping.

**Secrets.** Nothing baked in. `.dockerignore` excludes `.env`, `.env.*`,
`*.pem`, `*.key` and `certs/` from the build context, so no layer can contain
them. Gateway, SMTP and SMS credentials are not environment variables at all in
this application — a platform admin stores them in the database.

**Writable paths.** Exactly one: `/app/server/uploads`, created and chowned to
`node`. Nothing else is written at runtime — exports stream to the response,
imports parse in memory, `sharp` works in memory, invoices and receipts are
MongoDB documents. It needs a named volume in Phase 7 or uploads are lost on
every deploy.

**Health.** The image's `HEALTHCHECK` hits `/api/health` and is **liveness
only**: it says the process is serving. It does not prove MongoDB is reachable
and deliberately does not fail when Redis is away, because Redis is optional for
the API and a dependency-aware check would kill working containers. The worker
has no HTTP server and **no health check was invented for it**; it must run with
`--no-healthcheck`, and `docs/DOCKER.md` says how to judge it until Phase 7.

**One real bug found and fixed.** Running the compiled worker from a reproduced
image layout showed it exiting **1** on SIGTERM: closing a BullMQ worker tears
down a connection that can emit an `error` after BullMQ has removed its
listener, which Node turns into an uncaught exception. The work was already
drained, but a container runtime reads only the exit code — it would have
restarted the worker and counted every rolling deploy as a failure. `worker.ts`
now ignores a late failure *once shutdown has begun* (logged, not silent) while
an uncaught exception before that is still fatal. It exits 0 now. Phase 2 had
not caught this because no worker was registered then.

**Validation — and what it does not cover.** There is no Docker and no container
runtime on this machine, and none was installed, so **the image has never been
built or run.** Verified another way:

- every `COPY` source exists in the build context (static parse of the Dockerfile);
- `npm ci --omit=dev --workspace server --include-workspace-root` resolves and
  scopes correctly — run for real, and the client's runtime dependencies
  (react, recharts, axios) are absent from the result;
- the runtime file set is sufficient: the image's layout was reproduced on disk
  — production-only `node_modules`, `server/dist`, the two manifests — and both
  entrypoints were started from it;
- module resolution works from `/app/server` with `node_modules` one level up;
- `express`, `mongoose`, `ioredis`, `bullmq`, `sharp`, `msgpackr`, `exceljs`,
  `pdfkit` and `nodemailer` all load under that production-only tree;
- the API answers `/api/health` and exits 0 on SIGTERM; the worker registers
  `campaign-delivery` and now exits 0 too;
- Linux prebuilds for both native packages are present in `package-lock.json`.

Not verified: that the image builds; that the **Linux** prebuilds load (only
their presence is confirmed — `sharp` was exercised on darwin-arm64);
`HEALTHCHECK`, `USER` and volume ownership as Docker applies them; the client
build inside a container. **Phase 6 is therefore recorded as written and
statically validated, not as a tested artifact.**

**Limitations carried forward unchanged** (none of these were in scope):

1. MongoDB transaction coverage is still unverified against a replica set.
2. BullMQ has still not been integration-tested against a real Redis.
3. Redis rate limiting has still not been tested across real API replicas.
4. Local uploads still need a persistence strategy; object storage stays deferred.
5. The subscription scheduler still runs inside the API process.
6. **More than one API replica is still not safe** — the per-process scheduler
   and local uploads are the two reasons.
7. Plain returns still have no idempotency key.
8. Checkout idempotency keys are still optional.
9. The idempotency completion step still has a one-update crash window.
10. The Redis-absent inline campaign fallback still exists.

### 1.7 Phase 7 — Compose and real infrastructure integration (completed 2026-10-21)

Docker Desktop was installed on this machine on 13 October, so for the first
time the images could actually be built and run. **They were.** Everything
Phase 6 recorded as unverified is now verified, and running against real
infrastructure found three bugs — one of which would have broken production
outright.

**The stack.** `docker-compose.yml`: nginx (the only published port, 8080),
the API, the worker, Redis 7.2 and MongoDB 7.0 as a **single-node replica set**.
The API and the worker are the same image with different commands. A one-shot
`mongo-init` service runs `rs.initiate()` idempotently and everything that needs
transactions waits on `service_completed_successfully` rather than merely for
mongod to answer. `docker-compose.test.yml` is a test-only override.

**Why the replica set is the centrepiece.** `mongod --replSet` does not create a
replica set; until `rs.initiate()` runs there is no primary and no transaction
support, and the application quietly falls back to compensating writes. Every
test this project has ever run — CI included — ran against a standalone server.
That is why the next item had gone unnoticed since the beginning.

#### Three bugs, found only because the infrastructure was real

**1. Every transactional write was broken on a replica set.** Mongoose refuses
`create(array, { session })` unless `ordered: true` is also set. A
single-element array still counts as an array. On a standalone server
`withTransaction` passes `session: undefined`, so the restriction never applied
and the code looked correct; on a replica set — which is to say on **MongoDB
Atlas, the intended production database** — it throws. Eleven production call sites across
seven files were affected: registration (2), role provisioning, customer
creation, product and variant creation (2), subscription provisioning (2), two
inventory paths and the wallet ledger. Registration returned a 500. All are fixed with
`ordered: true`; two false positives from the first sweep (where the word
"session" appeared only in a comment) were reverted.

**2. Campaign delivery was broken wherever Redis was configured.** BullMQ
refuses a custom job id containing a colon, and Phase 3's was
`campaign:<id>:batch:<n>`. Every enqueue failed with a 500 and the charge was
refunded. Nothing caught it: the unit tests only compared the id string to
itself, and the HTTP suite ran with Redis absent, on the inline fallback path.
The separator is now a hyphen, and `campaignDelivery.check.ts` asserts the rule
so it cannot come back.

**3. nginx cached the API's address for ever.** With the hostname written
literally in an `upstream` block, nginx resolves once at startup. Recreating the
API container gave it a new address and nginx answered 502 to everything until
nginx itself was restarted — which would have broken every deploy. It now
resolves per request through Docker's embedded DNS (`resolver 127.0.0.11`) with
the host held in a variable, and that was proven by recreating the API and
watching requests keep working.

A fourth, smaller finding: **a container runs in UTC, and some report windows
are computed from the process clock rather than from `BUSINESS_TIMEZONE`**. A
Bangladeshi shop's "today" therefore started and ended six hours early. The
infrastructure half of the fix is `TZ` in the container environment, which is
what Phase 7 did; the code half — deriving every window from the configured
business timezone — is a reporting change and is left as an open item rather
than made here.

#### Verified

| | Result |
|---|---|
| Image builds | 53s, `linux/arm64`, 556 MB server / 80 MB web |
| Non-root runtime | `uid=1000(node)`, cwd `/app/server` |
| Linux native modules | `sharp` + libvips 8.18.7, `msgpackr`, `bullmq`, `ioredis`, `mongoose`, `express` |
| No dev tooling in runtime | typescript, vite, tsx, eslint all absent |
| MongoDB replica set | `rs0`, writable primary, **transactions ENABLED** |
| Transactions | commit, rollback, **no partial write after rollback**, session closed |
| Redis | connected from API and worker; keys namespaced; nothing outside the namespace |
| Rate-limit Lua | atomic under 25 concurrent increments; TTL bounded |
| BullMQ on real Redis | enqueue, process, retry-then-succeed, exhaust to failed, jobId dedupe, clean shutdown |
| Rate limiting via nginx | 429 with the usual envelope and `Retry-After`; identity is the **real client IP**, not nginx's |
| Shared counters | two API instances: 6 requests to one, 4 to the other, then 429 — one counter at 12 |
| Idempotency | all 37 assertions against the replica set |
| Campaign queue | API enqueues, worker delivers, every recipient terminal |
| Frontend | SPA served, deep-route fallback, `index.html` `no-store`, assets immutable |
| Persistence | uploads and MongoDB data survive a full stack restart |
| Volume permissions | the non-root user writes `/app/server/uploads` with no chmod and no root |
| Graceful shutdown | API and worker both exit **0** on SIGTERM |
| Dependency restarts | API recovers from a Redis restart and a MongoDB restart |
| Replica-set init | idempotent; a second run reports "already initialised" |
| Restart loops | none; every `RestartCount` is 0 |

**Test results.** In-container infrastructure check: **31/31**. The
repository's own end-to-end suite against the stack: **3,948 passed, 6 failed** —
the six being limitations of running the host suite against containers, not
product failures (four payment tests need mock gateways the harness starts on
the host and the container cannot reach; two upload tests use `existsSync` on
the host filesystem and cannot see a file inside the container volume). All six
pass in the ordinary host run. Host regression after the production fixes:
**4,050 + 54 + 16 + 23 + 42 + 84 + 52, zero failures**, with lint, typecheck and
build clean.

**Security.** Only nginx publishes a port; MongoDB and Redis are internal.
Both app containers run non-root. Secrets come from `.env.compose`, which is
gitignored and excluded from the build context — `.gitignore` gained `.env.*`
in this phase because the file holds real generated secrets. nginx appends to
`X-Forwarded-For` rather than replacing it, and `TRUST_PROXY_HOPS=1` matches the
one proxy, which was confirmed by checking the rate-limit identity in Redis.
Redis uses `noeviction` so queue keys can never be evicted.

**Limitations.**

1. **No load test.** The resource figures in `docs/DOCKER.md` are idle
   observations, not measured capacity.
2. **More than one API replica is still not production-safe.** Running two was a
   temporary test. The subscription scheduler runs inside every API process and
   uploads are on a local volume.
3. **amd64 was never built** — everything here is arm64. A VPS build needs
   `--platform linux/amd64`.
4. **Report windows still follow the process clock**, not
   `BUSINESS_TIMEZONE`. `TZ` in the container papers over it correctly; the code
   fix is outstanding.
5. **The end-to-end suite needs a fresh database** and an API restart after a
   reset; it is stateful by design. The procedure is in `docs/DOCKER.md`.
6. Carried forward unchanged: plain returns have no idempotency key, checkout
   keys are optional, the idempotency completion step has a one-update crash
   window, and the Redis-absent inline campaign fallback still exists.

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
PHASE 3   Background-job migration                  IN PROGRESS   ← 1 of 6 done
          campaign delivery                         COMPLETED  (2026-10-08)
          auth-code emails                          NOT STARTED
          image optimisation                        NOT STARTED
          product import commit                     NOT STARTED
          exports                                   NOT STARTED
          subscription scheduler passes              NOT STARTED
PHASE 4   Rate limiting (distributed)               COMPLETED  (2026-10-08)
PHASE 5   Idempotency / reliability                 COMPLETED  (2026-10-13)
PHASE 6   Docker                                    COMPLETED  (built and run 2026-10-21)
PHASE 7   Docker Compose + local production-like    COMPLETED  (2026-10-21)
PHASE 8   VPS deployment                            NOT STARTED
PHASE 9   Cloudflare + SSL                          NOT STARTED
PHASE 10  GitHub Actions CI/CD                      NOT STARTED
PHASE 11  Monitoring / observability                NOT STARTED
PHASE 12  Load testing / scaling                    NOT STARTED

R2 / object storage                                 DEFERRED
```

**Phase 3 is part done: campaign delivery has moved (§1.3) and nothing else
has.** Before migrating the next workload, close limitation 2 in §1.3 — run one
real campaign through a real Redis with the worker attached. The point of doing
campaigns first was to prove the foundation; it is not proven until that has
happened.

The remaining candidates, with the per-item analysis, are in
`docs/INFRASTRUCTURE_ROADMAP.md` §5. Each registers its processor in
`registerWorkers()` in `server/src/worker.ts`, next to the campaign one, and
uses `createAppQueue` / `createAppWorker`. Suggested order:

1. **Password-reset and verification emails.** Watch the delivery-reporting
   contract: `verification.service` currently tells the caller whether the
   message was actually delivered, which queueing changes to "accepted". The UI
   copy has to change with it.
2. **Image optimisation** — validation (`inspectImage`) stays inline, because
   rejecting a non-image is a request-time concern.
3. **Product import commit** — needs per-row progress on the job first, or a
   retry duplicates products.
4. **Exports** — needs an answer on where the finished file goes, which is the
   object-storage question §8 of the roadmap defers.
5. **The two `setInterval` passes in `jobs/subscription.job.ts`** → repeatable
   jobs. Low risk (every pass is already idempotent) but **delete
   `startSubscriptionJobs` from `server.ts` in the same commit** — two code
   paths for the same work is how double-sends happen.

Read limitation 3 in §1.2 before the next API-side enqueue, and §1.3's
inline-fallback note before assuming a queue is always available.

---

## 4. Change log

| Date | Change |
|---|---|
| 2026-10-21 | **Phase 7 — Compose and real infrastructure integration.** Added `docker-compose.yml` (nginx, API, worker, Redis, single-node MongoDB replica set), `docker-compose.test.yml`, `docker/nginx/default.conf`, `docker/mongo/init-replica-set.sh`, `.env.compose.example` and an nginx stage in the Dockerfile. The images were **built and run for the first time**, closing every Phase 6 gap. Added `seed/infraIntegration.check.ts` (31 assertions in-container: transactions, Redis, BullMQ, the rate-limit Lua). **Three bugs fixed, each invisible until the infrastructure was real:** `create(array, { session })` needed `ordered: true` at eleven production call sites, so every transactional write — registration included — failed on a replica set and therefore on Atlas; BullMQ rejects a colon in a job id, so campaign delivery failed wherever Redis was configured; and nginx cached the API's address, answering 502 after any recreate. Also set `TZ` in the containers, because report windows follow the process clock. Host regression green. |
| 2026-10-13 | **Phase 6 — Docker foundation (written, not built).** Added `docker/Dockerfile` (multi-stage, `node:22-bookworm-slim`, non-root, production-only runtime, one image for both the API and the worker), `.dockerignore` and `docs/DOCKER.md`. Debian was chosen because the lockfile shows `msgpackr-extract` has no musl prebuild, so Alpine would need a compiler; Debian needs no apt packages at all. One build-script change: `PRERENDER_REQUIRE_API` makes an unreachable API a build failure rather than a silent fall back to built-in marketing copy. Fixed a real shutdown bug found while running the compiled worker from a reproduced image layout — it exited 1 on SIGTERM because a connection emitted after BullMQ removed its listener; a clean stop now exits 0. **The image has never been built or run: no container runtime on this machine.** No Compose, no deployment automation, no application behaviour changed. |
| 2026-10-13 | **Phase 5 — idempotency on sale and order creation.** Added a shared mechanism (`services/reliability/idempotency.service.ts`, `models/IdempotencyRecord.ts`, unique on `(scope, key)`, 24-hour retention, lease-based recovery, canonical fingerprinting) and applied it at the controller layer to **Restaurant orders, Super Shop sales and Pharmacy sales** — the three flows Phase 0 found unprotected. The sale services themselves were not touched. Clothing's older mechanism was audited, found correct (it compensates stock and loyalty on a race) and left alone with regression tests added. The POS tills now send a per-basket `Idempotency-Key`. Two error codes added; `docs/API.md` documents the contract. Payment, wallet, subscription, usage-charge, loyalty and exchange protection unchanged; plain returns remain the one known gap and are recommended as the next atomic migration. |
| 2026-10-08 | **Phase 4 — distributed rate limiting.** All 20 existing limiters moved from per-process memory to a Redis-backed store (`middleware/rateLimit.ts`) with their policies unchanged, counting through one atomic `EVAL` per request on the shared Phase 1 client — no new Redis connection, nothing per request. Added per-account login protection (failed attempts only, hashed identifier), and dedicated `/auth/refresh` and `/auth/logout` policies. Outage behaviour is declared per policy: four spend/capacity-guarding policies refuse, the rest degrade to a per-process counter; a Redis that was never configured is not treated as an outage, so a no-Redis deployment behaves exactly as before. `trust proxy` became `TRUST_PROXY_HOPS`. New `middleware/rateLimit.check.ts` (54 assertions). Closes audit findings R1–R4. |
| 2026-10-08 | **Phase 3, first migration — campaign delivery.** Campaign SMS and email delivery moved off the HTTP request onto the `campaign-delivery` queue: the request now stores the recipients, charges once, enqueues one job per 100-recipient batch and returns, and the worker delivers. Added `services/sms/campaignDelivery.service.ts` (the single delivery implementation, used by the worker and by the no-Redis inline fallback alike), `queues/campaign.queue.ts`, and `seed/campaignDelivery.check.ts` (82 assertions). `SmsMessage` gained a unique `(campaignId, recipient)` index, a claim lease, `attempts`, `failureKind` and `batchIndex`, which is what makes a worker retry skip what already went out; `SmsCampaign` gained `queued`. Money rules, terminal statuses and tenant scoping unchanged. Fixed three bugs found while testing: a transient failure being re-claimed inside the same pass, two configuration errors misclassified as transient, and `shutdownQueues` hanging when a worker's connection had gone. **No other job migrated**; the subscription scheduler, billing/auth emails, exports, imports and image processing are untouched. |
| 2026-10-08 | **Phase 2 — BullMQ worker foundation.** Added `bullmq` (which reuses the ioredis Phase 1 installed) and `server/src/queues/`: `createAppQueue` / `createAppWorker` over one shared BullMQ-compatible connection built from the Phase 1 Redis configuration, with naming validation, the key namespace, conservative finite retry/backoff/retention defaults and the payload policy centralised in `queues/options.ts`, plus registries, lifecycle logging and a bounded idempotent `shutdownQueues`. Added `server/src/worker.ts`, a separate process (`npm run worker`, `npm run worker:dev`) that starts no HTTP server, requires Redis and exits 1 without it. New `server/src/queues/queues.check.ts` (run by `npm test`). **No queue, no processor and no migrated job**: the API's `setInterval` scheduler still runs exactly as before. |
| 2026-10-08 | **Phase 1 — Redis foundation.** Added `ioredis` to the `server` workspace and `server/src/config/redis.ts`: one shared, lazily-opened client with a pure config resolver, a client factory reusable by the future worker, bounded fail-fast command defaults, de-duplicated error logging, a `pingRedis` primitive and idempotent lifecycle calls wired into `server.ts` beside MongoDB's. `REDIS_URL` and `REDIS_KEY_PREFIX` added to the env schema and `.env.example`; Redis is optional, an unreachable server is never fatal, a malformed URL refuses to boot. `/api/health` additively reports the live connection state. New `server/src/config/redis.check.ts` (run by `npm test`) proves all of it against an in-process RESP stub. Nothing consumes Redis yet; rate limiting, queues and the scheduler are untouched. |
| 2026-10-08 | Phase 0 infrastructure audit. Added `docs/INFRASTRUCTURE_ROADMAP.md`. Replaced this file with the infrastructure status tracker and moved its previous contents — the Super Shop implementation journal — to `docs/SUPERSHOP_IMPLEMENTATION_JOURNAL.md`. Added the infrastructure section to `docs/ARCHITECTURE.md` and corrected its stated dependency versions. No application code changed. |
