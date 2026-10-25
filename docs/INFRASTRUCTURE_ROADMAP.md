# Infrastructure roadmap

**Phases 0 (audit), 1 (Redis foundation), 2 (BullMQ worker foundation)
4 (distributed rate limiting) and 5 (idempotency) are COMPLETED, and 6 (Docker)
and 7 (Compose and real
integration testing) are COMPLETED — the images are built and run. Phase 3 is PART DONE: campaign
delivery has been migrated (§5.1), the other five candidates have not. Phases
7–12 are not implemented.** Live status per area is `docs/IMPLEMENTATION_STATUS.md`,
which is the file to trust when this one and it disagree.

Written 2026-10-08 against the working tree at `claude/retailer-suites-audit-e61761`
(parent `c8b891c`). Every claim below was read from source, not from
documentation; where a doc and the code disagreed, the code won and the
disagreement is noted. Sections describing work since completed carry a
**DONE** note; the findings themselves are left as written, so a later reader
can see what was true before the change.

Companion documents:

- `docs/ARCHITECTURE.md` — what the application is and how a request flows.
- `docs/IMPLEMENTATION_STATUS.md` — the status tracker, and the file to read
  first in any future infrastructure session.

---

## 1. Current architecture

```
Browser (React 19 SPA, Vite 6)
    │  relative /api and /uploads  ← requires a single origin
    ▼
ONE Node process  (server/dist/server.js)
    ├── Express 5 app          ... 37 feature modules under /api/*
    ├── in-process scheduler   ... setInterval, started by server.ts
    ├── local disk             ... ./uploads, served by express.static
    └── Mongoose 9 ──────────► MongoDB (standalone today; Atlas is the target)
```

npm workspaces monorepo, TypeScript throughout:

| Workspace | What it is | Build | Start |
|---|---|---|---|
| `server/` | Express 5.2 + Mongoose 9.10 REST API | `tsc -p tsconfig.json` → `dist/` | `node dist/server.js` |
| `client/` | React 19 + Vite 6 SPA (POS, admin, platform, marketing site) | `tsc -b && vite build && node scripts/prerender.mjs` | static files |
| `scripts/` | `run-tests.mjs` (isolated-DB harness), `smoke-test.mjs`, payment gateway mocks | — | `npm test` |

**Process model.** Exactly one process serves everything: HTTP, the subscription
scheduler, exports, imports, campaign sending and image processing. There is no
second process of any kind — no worker, no cron daemon, no PM2.

**Boot sequence** (`server/src/server.ts`): `connectDatabase()` →
`ensureDefaultPosProducts()` → `ensurePricingCatalog()` → `app.listen(env.PORT)`
→ `startSubscriptionJobs()`. `SIGTERM`/`SIGINT` stop the timers, close the
server, disconnect Mongo, with a 10-second hard-exit backstop.

**App middleware** (`server/src/app.ts`), in order: `helmet` (with
`crossOriginResourcePolicy: cross-origin` so uploaded images embed), `cors`
with an allowlist parsed from `CLIENT_ORIGIN`, `compression`, `cookie-parser`,
`express.json({ limit: '1mb' })` capturing `rawBody` for webhook signature
verification, `express.urlencoded({ limit: '1mb' })`, `morgan('dev')` in
non-production only, the global `/api` rate limiter, `express.static` for the
uploads directory, the router, then the 404 and error handlers.
`trust proxy` is `1` in production and `false` otherwise.

**Request pipeline** (per `docs/ARCHITECTURE.md`, verified in `middleware/`):
`authenticate` → `resolveTenant` → `requireVertical` → `requireSubscribedAccess`
→ `requirePermission` → `requireEntitlement` → `validate(zod)` → controller →
service.

**Tenancy.** `Account` → one `Wallet` + many `Workspaces` (= `Tenant`, one POS
vertical each) → many `Stores` (branches). `tenantId` enters a request in
exactly one place — `middleware/tenant.ts`, from the authenticated user record,
never from a header, body or query. The `x-store-id` branch header is
re-validated twice: the branch must belong to the tenant, *and* the user must be
assigned to it.

**Verticals.** Clothing, Super Shop, Restaurant, Pharmacy — one codebase,
switched by `tenant.vertical`, with shared capabilities behind per-vertical
adapters (tender rules, stock, returns, import, categories, ledger view).

**Scale of the surface.** 71 model files, 37 route modules, 22 service
folders, 23 migration scripts, 191 explicit index declarations, 13 aggregation
pipelines.

### What is already strong

These are not roadmap items; they are the reason the roadmap is short.

- **Money.** Integer minor units everywhere; prices always come from the server.
- **Tenant isolation.** One entry point, re-validated branch scope, and the
  end-to-end suite asserts cross-tenant IDOR refusals.
- **Stock.** Taken with a single guarded `$inc` (`quantityOnHand: { $gte: n }`),
  so correctness does not depend on transactions.
- **Billing email delivery.** Already a durable, leased, retrying queue — in
  MongoDB rather than Redis (see §5.2).
- **Webhooks.** Never trusted. A notification only triggers a status query
  against the gateway, so replay is inert by construction; bKash notifications
  additionally verify the AWS SNS signature.
- **Auth.** Short-lived access token, rotating refresh token with reuse
  detection that revokes the whole chain, stored as a hash.

---

## 2. Target architecture

```
Frontend (SPA, static)
    ▼
Nginx / Cloudflare           ... TLS, one origin, static assets, /api + /uploads proxy
    ▼
API (N replicas, stateless)
    ├── MongoDB Atlas        ... replica set → transactions available
    ├── Redis                ... rate limits, locks, cache, queue backend
    └── BullMQ Worker (M replicas)
            └── repeatable jobs replace the in-process setInterval scheduler
```

Three properties define "done":

1. **The API process holds no state another replica needs.** Today it holds
   rate-limit counters, four in-memory caches and the whole job scheduler.
2. **No HTTP request does unbounded work.** Today a request may send 5,000 SMS,
   stream 200,000 rows, or create ~6,000 documents.
3. **Scheduled work runs once per cluster, not once per replica.**

---

## 3. Redis plan

### Status: FOUNDATION COMPLETED (Phase 1, 2026-10-08)

The connection exists; **no feature consumes it yet**, which is the whole scope
of Phase 1. `ioredis` 5.11 in the `server` workspace, one shared client in
`server/src/config/redis.ts`, configured by `REDIS_URL` and
`REDIS_KEY_PREFIX`, opened by `server.ts` and closed on shutdown. Redis is
optional: unset changes nothing, unreachable is retried and never fatal, and
only a malformed URL refuses to boot. Full detail, tests and limitations are in
`docs/IMPLEMENTATION_STATUS.md` §1.1.

ioredis was chosen because BullMQ supports it and does not support `node-redis`
— picking the other client would have meant adding a second one in Phase 2.

**What follows was the Phase 0 finding, kept for the record:** no
`redis`/`ioredis` dependency in any `package.json`, no `REDIS_*` variable in
`config/env.ts` or `.env.example`, no connection helper, no cache, queue, lock,
session or rate-limit store. The only mention of Redis anywhere in the
repository was a comment in `jobs/subscription.job.ts` suggesting an external
scheduler eventually.

### The in-process state Redis exists to replace

| Where | What it holds | What breaks with two replicas |
|---|---|---|
| every `rateLimit({...})` call | `express-rate-limit` default `MemoryStore` | effective limit multiplies by replica count; the login limiter is the one that matters |
| `services/site/site.service.ts` | public site settings, 60 s TTL, invalidated on admin save | an admin's save clears one replica's copy; others serve stale settings for up to 60 s |
| `services/pricing/pricing.service.ts` | `ensuredAt` guard, 60 s | catalogue seeding re-runs per replica (idempotent, just wasteful) |
| `services/payment/bkash/sns.ts` | AWS SNS signing certificates | re-fetched per replica (harmless) |
| `utils/fetchWithDnsFallback.ts` | known-bad-address memory, 10 min | per-replica learning (harmless) |

### First legitimate use cases, in order

**None of these are implemented.** Phase 1 delivered only the connection they
will share; each is the subject of its own later phase.

1. **Distributed rate limiting** — `rate-limit-redis` behind the existing
   limiters. This is the one correctness-relevant item: an IP-keyed login limit
   of 20 per 15 minutes becomes 20 × replicas without it.
2. **BullMQ backend** (Phase 2) — BullMQ requires Redis; this is the hard
   dependency that forces the phase order.
3. **Scheduler lock** — one short-lived lock so the subscription pass runs once
   per cluster. Needed only until Phase 3 moves the passes to BullMQ repeatable
   jobs, and it is the cheap intermediate step if Phase 3 slips.
4. **Shared read cache** for the public site settings, the plan/pricing
   catalogue and `/public/contact` — the three hot unauthenticated reads.
5. **Per-account login throttling** — the one abuse control that is genuinely
   missing rather than merely process-local (§6.1).

### Explicitly NOT a Redis use case here

- **Sessions.** Auth is stateless JWT plus a DB-backed refresh chain with reuse
  detection. Moving it to Redis would weaken it, not help it.
- **The email outbox.** `EmailNotification` is already durable with leases and
  retries, and it has to stay in MongoDB because the billing invariant is
  "an email exists only if an invoice exists". Do not move it.
- **Idempotency records.** They are unique partial indexes on the business
  documents themselves (§7). That is stronger than a Redis key with a TTL.

### Constraints, and how the Phase 1 foundation meets them

- **One connection, created once, lazily.** Done: a single client built at
  startup in `config/redis.ts`, never in a handler, never per request.
- **Redis being down must not take the POS down.** Done at the connection
  level: an unreachable Redis is logged and retried and never stops the boot,
  and commands fail fast (`enableOfflineQueue: false`, bounded retries per
  command) rather than hanging. **The other half is each consumer's job** —
  falling open to the memory store, or through to MongoDB, is decided by the
  feature that uses Redis, not by the connection. Phase 4 owns that for rate
  limiting.
- **Key prefix per environment.** Done: `REDIS_KEY_PREFIX`, defaulting to
  `retailersuites:<NODE_ENV>:`.
- **`REDIS_URL` in the zod schema and `.env.example` together.** Done, with one
  refinement: the schema rejects a *malformed* URL and refuses to boot, but an
  absent one is valid, because Redis is optional at this stage.

---

## 4. BullMQ / worker plan

### Status: FOUNDATION COMPLETED (Phase 2, 2026-10-08)

The foundation exists; **no queue, no processor and no migrated job**. BullMQ
5.81 reusing Phase 1's ioredis, `server/src/queues/` providing
`createAppQueue` / `createAppWorker` over one shared connection with
centralised retry, backoff, retention and naming policy, and
`server/src/worker.ts` as a separate process that starts no HTTP server and
requires Redis. Full detail, tests and limitations in
`docs/IMPLEMENTATION_STATUS.md` §1.2.

Two constraints discovered while building it, both read from BullMQ's source
and worth knowing before Phase 3: BullMQ **refuses** a client carrying an
ioredis `keyPrefix` (its own `prefix` option is used instead), and a blocking
connection **requires** `maxRetriesPerRequest: null`. The second has a
consequence for Phase 3 — an enqueue from an API request will wait rather than
fail while Redis is unreachable, so API-side enqueues must bound themselves.

**What follows was the Phase 0 finding, kept for the record:** BullMQ, Bull,
Agenda, node-cron, `worker_threads`, any separate worker entry point, any queue
abstraction and PM2 were all verified absent.

### What exists instead

`server/src/jobs/subscription.job.ts`, started by `server.ts` and described in
its own comment as a "simple in-process scheduler … adequate for a
single-instance deployment":

| Timer | Interval | Passes |
|---|---|---|
| `run` | 1 hour | `sendExpiryReminders` → `renewDueWalletSubscriptions` → `processRenewals` → `expireLapsedSubscriptions` → `issueMissingInvoices` → `issueMissingReceipts` → `retryFailedEmails` |
| `reconcile` | 10 minutes | `reconcileStalePayments` → `sendPaymentAlertDigest` |

Both fire once immediately at boot and are `.unref()`'d. Each pass is batched
(`.limit(500)` / `.limit(200)`) and written to be idempotent: conditional
updates on what was read, CAS claims, period-scoped keys. That discipline is
what makes the migration low-risk — and it means running the scheduler in two
replicas today is wasteful rather than corrupting.

### Minimum worker architecture — BUILT, minus the feature queues

One worker process, `server/src/worker.ts`, sharing the existing `config/`,
`models/` and `services/` code — not a second codebase. The shape below is what
Phase 2 implemented, except that the four feature queue files do not exist yet:
Phase 3 adds them. `queues/index.ts` turned out to be the registry plus the
factories, with the connection and the policy split into their own files.

```
server/src/
├─ server.ts        API only (no startSubscriptionJobs)
├─ worker.ts        BullMQ Workers + repeatable schedulers
└─ queues/
   ├─ index.ts      queue registry, one Redis connection, shared options
   ├─ scheduled.queue.ts   the two timers above, as repeatable jobs
   ├─ messaging.queue.ts   SMS / email campaign fan-out
   ├─ export.queue.ts      large exports
   ├─ import.queue.ts      product import commit
   └─ media.queue.ts       image optimisation
```

Four queues is the floor. Defaults worth setting once, in the registry
(**implemented in `queues/options.ts`**, with `attempts: 3` rather than the 5
sketched here — 3 is the conservative default, and a queue whose work needs more
says so explicitly when it is created):

- `attempts: 3`, exponential backoff from ~10 s.
- `removeOnComplete: { age: 7 days, count: 1000 }`, `removeOnFail: { age: 30 days }`
  — failed jobs are the audit trail.
- A `jobId` derived from the business key wherever one exists, so an enqueue is
  itself idempotent.
- One worker per queue with its own concurrency: image optimisation is
  CPU-bound (`sharp`) and must be low, campaign sending is I/O-bound and gated
  by the gateway, not by us.
- Repeatable jobs replace both `setInterval` calls; `startSubscriptionJobs` is
  deleted from `server.ts` in the same change, never left running alongside.

Graceful shutdown must drain in-flight jobs before exit, or a container restart
can abandon a half-sent campaign.

---

## 5. Background-job migration plan

### Status: IN PROGRESS — 1 of 6 migrated

**Campaign delivery has moved** to the `campaign-delivery` queue (2026-10-08):
100 recipients per job, worker concurrency 1, per-recipient claim leases and a
unique `(campaignId, recipient)` index for duplicate protection, with the same
delivery function used inline when no Redis is configured. Full detail, tests
and limitations in `docs/IMPLEMENTATION_STATUS.md` §1.3.

**The other five candidates below are unchanged** and still run exactly where
this audit found them. Their per-item analysis stands as the work plan.

Before migrating the next one: campaign delivery has **not** been validated
against a real Redis (no Redis in this environment, none in CI). Prove it there
first — the reason campaigns went first was to prove the foundation.

### 5.1 Candidates, by priority

Every row below was read from the named file.

#### P1 — SMS and email campaigns — **MIGRATED 2026-10-08**

The analysis below is the Phase 0 finding, kept for the record. What was built
differs from it in one way worth noting: the wallet charge was already up front,
so the money needed no change at all — only the loop moved.

| | |
|---|---|
| Current | `services/sms/sms.service.ts` — `sendCampaign` (L161) and `sendEmailCampaign` (L334) loop over recipients **sequentially inside the HTTP request**, creating one `SmsMessage` row and one gateway call each. |
| Trigger | `POST /api/messaging/sms`, `POST /api/messaging/email` |
| Blocks a request? | **Yes, entirely.** |
| Workload | Up to **5,000 recipients** per campaign (`messaging.validators.ts`: `customerIds.max(5000)`). At even 150 ms per gateway call that is ~12 minutes in one request. |
| Safe to move? | Yes, and it is the clearest win in the audit. |
| Dependencies | SMS gateway (credentials in DB), SMTP (credentials in DB), wallet, `usageChargeService`. |
| Retry | Per recipient, not per campaign. A campaign must never be re-sent wholesale. |
| Idempotency | The wallet is charged **once, up front**, before the loop, through `usageChargeService.charge` with a unique key — so the money is already safe. The per-recipient rows are what need a key. |
| Failure handling | Campaign status `sending` → `completed`/`failed` must be set by the worker; a crashed campaign currently stays `sending` for ever. |
| Priority | **Highest.** |

#### P1 — Password-reset and contact-verification codes

| | |
|---|---|
| Current | `services/auth/passwordReset.service.ts:203` and `services/auth/verification.service.ts:183` both call `emailService.provider()` — which **re-reads SMTP credentials from MongoDB** — then connect and send, inline. |
| Trigger | `POST /api/auth/password/forgot`, `POST /api/auth/verification/send` |
| Blocks a request? | **Yes** — an SMTP handshake sits on the critical path of an unauthenticated endpoint. |
| Workload | One message, but a slow or hanging SMTP host holds the request open. |
| Safe to move? | Yes, with one constraint: `verification.service` currently **reports delivery honestly** to the caller (and in production treats a failure as an error). Queueing changes that contract to "accepted"; the UI copy must change with it. `passwordReset` already swallows failures by design (it must not become an account-existence oracle), so it can be queued as-is. |
| Retry | 2–3 attempts inside the code's TTL (codes expire); after that, silence — the user asks again. |
| Idempotency | Keyed on the code row, so a retry re-sends the same code rather than minting a new one. |
| Failure handling | Never surface gateway detail; the existing `safeError` redaction applies. |
| Priority | **High** — it is on an unauthenticated path, which makes it a cheap availability lever for an attacker. |

#### P2 — Large exports

| | |
|---|---|
| Current | `modules/exports/export.service.ts` streams straight to the response. Writers are properly streaming (`ExcelJS.stream.xlsx.WorkbookWriter`, a counted CSV writer), and PDF uses `bufferPages`. |
| Trigger | `POST /api/exports` |
| Blocks a request? | Yes — and it holds a Mongo cursor and a socket for the duration. |
| Workload | `export.limits.ts`: **200,000 rows** for CSV/XLSX/JSON, **5,000** for PDF, **5 exports per minute per user**. |
| Safe to move? | Yes, but it is a **product change**, not a refactor: the browser currently gets a file download. Moving to a worker means job → notification → signed download link, which needs somewhere to put the file (§8) and UI work. |
| Dependencies | MongoDB cursors, the dataset registry, object storage for the result. |
| Retry | Safe — an export is a pure read. Re-running produces a new file. |
| Idempotency | Not required; dedupe only to avoid charging a user twice for the same click. |
| Failure handling | Mark the job failed and keep the message; never a partial file presented as complete. |
| Priority | **Medium.** Keep the synchronous path for small exports; queue above a threshold. |

#### P2 — Product import commit

| | |
|---|---|
| Current | `modules/productImports/import.service.ts`. Two steps, both in-request: `preview` (parse + validate, writes a `ProductImportJob` with status `pending`, TTL 60 min) and confirm (creates products through the ordinary product service). `import.limits.ts` states plainly: *"There is no queue or worker in this stack, so an import runs inside the request."* |
| Trigger | `POST /api/products/import` then the confirm route |
| Blocks a request? | Yes, the commit step. |
| Workload | **2,000 rows ≈ 6,000 documents** (product + variants + opening-stock ledger row each), 5 MB upload, 5 imports/min. |
| Safe to move? | Yes — and the model is already job-shaped (`ProductImportJob` with a status). A worker only has to advance it. |
| Dependencies | `productService`, `categoryService`, plan product limits. |
| Retry | **Only with per-row progress.** A blind retry of a half-committed import duplicates products. Record the last committed row on the job. |
| Idempotency | Per row, keyed on the job id and row number. |
| Failure handling | Partial-success is a real outcome: report created/failed counts, keep the existing `MAX_STORED_ERRORS` (200) error rows. |
| Priority | **Medium** — the 2,000-row cap is what makes this tolerable today; the cap can rise once it is queued. |

#### P2 — Image optimisation

| | |
|---|---|
| Current | `modules/uploads/uploads.routes.ts` → `inspectImage` then `optimizeToWebp` (`services/storage/imageOptimizer.ts`), inline. `sharp`, max 20 MB in, long edge capped at 2,000 px, `limitInputPixels` 50 M. |
| Trigger | every upload route |
| Blocks a request? | Yes. |
| Workload | CPU-bound native decode + resize + WebP encode. A handful of concurrent uploads can saturate the event loop's thread pool. |
| Safe to move? | Yes, with a product decision: store the original, return a URL, replace it with the optimised version when the job finishes. Validation (`inspectImage`) must **stay synchronous** — rejecting a non-image is a request-time concern. |
| Dependencies | `sharp` (native), storage provider, `StorageObject` ownership ledger. |
| Retry | Safe (pure transform). |
| Idempotency | Keyed on the storage key. |
| Failure handling | Keep the original; never leave a product with a broken image. |
| Priority | **Medium**, rising sharply if uploads become bulk. |

#### P3 — Report aggregations

| | |
|---|---|
| Current | `modules/reports/reports.service.ts` (988 lines, 6 pipelines) and `modules/supershop/supershopReports.service.ts` (689 lines), run inline per request. |
| Blocks a request? | Yes. |
| Safe to move? | **Not as a job.** A report is a read the user is waiting for. The right answers are indexes, bounded date ranges and — if it is still slow — pre-computed daily snapshots built by a worker. |
| Priority | **Low as a queue item; measure first** (§11). |

#### P3 — The two existing scheduler passes

Already listed in §4. They move to BullMQ repeatable jobs essentially as-is;
this is the lowest-risk migration in the list because every pass is already
idempotent and batched. Do it **first in Phase 3** to prove the worker, before
touching anything user-facing.

#### Not a candidate: billing emails

`services/email/transactionalEmail.service.ts` is already a correct durable
queue: an `EmailNotification` row per `key`, a 2-minute claim lease, 5 attempts,
30-minute retry backoff, and a `FRESH_PAYMENT_MS` guard so a backfill does not
email old invoices. It is driven by `retryFailedEmails()` in the hourly pass.
**Move the driver to the worker; leave the mechanism in MongoDB.** Its invariant
— an email exists only because an invoice exists — depends on being in the same
database as the invoice.

### 5.2 Migration order

```
   Campaigns         → batch queue               DONE 2026-10-08
1. Scheduler passes  → repeatable jobs           (no user-visible change)
3. Auth codes        → queue                     (watch the delivery-reporting contract)
4. Image optimise    → queue                     (validation stays inline)
5. Import commit     → queue                     (needs per-row progress first)
6. Exports           → queue + storage           (needs §8 resolved first)
```

Rule for each step: the synchronous path is deleted in the same commit that
adds the queued one. Two code paths for the same operation is how double-sends
happen.

---

## 6. Rate-limiting plan

### Status: COMPLETED (Phase 4, 2026-10-08)

All 20 limiters now count in Redis through one atomic `EVAL` per request, on the
shared Phase 1 client; three more were added (per-account login, refresh,
logout); and `trust proxy` became `TRUST_PROXY_HOPS`. Outage behaviour is
declared per policy rather than globally. Findings R1–R4 below are closed. Full
detail, the verification table and the limitations are in
`docs/IMPLEMENTATION_STATUS.md` §1.4 — including that **genuine multi-instance
behaviour was not validated**, because there is no Redis in this environment.

**What follows is the Phase 0 finding, kept for the record.**

### 6.1 Phase 0 status: IMPLEMENTED, process-local

`express-rate-limit` v7 with its **default in-memory store**. One global limiter
plus 19 route-specific ones:

| Scope | Limit (production) | Window |
|---|---|---|
| all `/api` | 600 | 1 min |
| `/auth/register`, `/auth/login`, `/auth/login/select` | 20 | 15 min |
| `/auth/password/forgot` | 5 | 15 min |
| `/auth/password/verify-code`, `/auth/password/reset` | 30 | 15 min |
| `/auth/switch-workspace` | 30 | 1 min |
| `/auth/verification/send`, `/verification/confirm` | 6 | 1 min |
| `/payments/callback/:provider` | 60 | 1 min |
| `/payments/checkout` | 10 | 1 min |
| `/messaging/*` send | 60 | 1 hour (**keyed by `tenantId`**, not IP) |
| `/exports` | 5 | 1 min |
| `/products/import` | 5 | 1 min |
| plus limiters on printing sign, platform admin actions, workspace create/cancel, subscription purchase, pricing quote, payment-provider device events | | |

Development limits are deliberately raised (5,000–20,000) so the 3,500-assertion
end-to-end suite is not throttled; production keeps the strict numbers.

### 6.2 Findings — all closed in Phase 4

| | Finding | Risk |
|---|---|---|
| R1 | **Every store is per-process memory.** | With N replicas the real limit is N × the configured one. The login limiter is the one that matters. |
| R2 | **No per-account login throttling.** Only per-IP. There is no `failedLoginAttempts` / `lockedUntil` on `User`. | A distributed credential-stuffing run against one known account is limited by nothing but the global 600/min. |
| R3 | `/auth/refresh` and `/auth/logout` have **no dedicated limiter** — only the global `/api` one. | `/refresh` mints tokens and on reuse revokes a whole chain; 600/min is loose for it. |
| R4 | Limits are IP-keyed, and `trust proxy` is hard-coded to `1` in production. | If Cloudflare *and* Nginx both sit in front (Phase 9), the hop count changes and every limiter may key on the wrong address — which can mean one shared key for the whole internet. Must be re-verified when the proxy chain changes. |

### 6.3 Plan (Phase 4) — done, with two deviations noted below

1. ~~`rate-limit-redis`~~ — a four-line Lua script in a store of our own
   instead: the dependency would have added a package to run it, and its key
   prefixing would have had to be reconciled with Phase 1's. One shared store,
   keys prefixed per environment. The memory fallback was kept for most
   policies, but **not blindly**: four policies that guard spending or API
   capacity refuse instead, and a Redis that was never configured is not treated
   as an outage at all.
2. Add per-account login backoff (progressive delay, then a short lock) as a
   counter in Redis plus a durable marker on the user, so it survives a flush.
3. Add limiters for `/auth/refresh` and `/auth/logout`.
4. Re-derive `trust proxy` from the actual deployed hop count and assert the
   keyed IP in a test. Do this **in the same phase as Cloudflare**, not before.
5. Keep the tenant-keyed pattern (`keyGenerator: req.ctx.tenantId`) for anything
   that spends money — several tills share one office IP, and that is exactly
   why messaging already does it.

---

## 7. Idempotency plan

### Status: COMPLETED for sale/order creation (Phase 5, 2026-10-13)

Finding **I1 is closed**: Restaurant orders, Super Shop sales and Pharmacy sales
are protected by a shared mechanism (`IdempotencyRecord`, unique on
`(scope, key)`, claimed before the work runs), applied at the controller so the
sale services were not touched. **I2** (Clothing's optional key) stands by
choice — the audit confirmed Clothing's own mechanism is correct, including
compensation on a race, so it was left alone. **I3 (plain returns) is still
open** and is the recommended next atomic migration. **I4** is closed by the
`Idempotency-Key` convention now documented in `docs/API.md`.

Full detail, the per-flow results and the limitations — including that
exactly-once execution is **not** claimed — are in
`docs/IMPLEMENTATION_STATUS.md` §1.5.

**What follows is the Phase 0 finding, kept for the record.**

### 7.1 Phase 0 status: IMPLEMENTED per resource, with real gaps

There is **no generic `Idempotency-Key` middleware**. Instead, money-moving
documents carry their own key with a unique partial index, the service reads it
back on replay, and a duplicate-key error (11000) is recovered by returning the
winner. The pattern is correct and consistently applied where it exists:

| Model | Key field | Index |
|---|---|---|
| `Sale` (Clothing) | `idempotencyKey` | unique partial on `(tenantId, storeId, idempotencyKey)` |
| `Payment` | `idempotencyKey` | unique partial |
| `Return` | `idempotencyKey` | unique partial on `(tenantId, storeId, idempotencyKey)` |
| `WalletTransaction` | `idempotencyKey` | unique partial |
| `UsageCharge` | `idempotencyKey` | unique partial |
| `UpgradeRequest` | `idempotencyKey` | unique |
| `LoyaltyMembership` | `idempotencyKey` | unique partial |

Supporting guarantees read from the code:

- **Wallet debits** use a conditional update (`balanceMinor: { $gte: amount }`),
  so concurrent debits cannot overdraw; the ledger row is written from the
  pre-image of the same atomic update.
- **Subscription purchase** takes a CAS lock on `Tenant.purchaseLockedUntil`
  and releases it conditionally.
- **Wallet renewal** uses a period-scoped key, so one period can be charged
  once.
- **Webhooks** are replay-safe by construction: nothing in a notification is
  believed, the gateway is always asked.
- **Sequence numbers** come from a single-document `findOneAndUpdate` with
  `$inc` and upsert — never a duplicate invoice number.

### 7.2 Gaps found

| | Gap | Consequence | Current mitigation |
|---|---|---|---|
| I1 | **`ShopSale`, `PharmacySale` and `RestaurantOrder` have no `idempotencyKey` at all.** Only Clothing's `Sale` does. Confirmed: no key field, no index, no key in `createSaleSchema` for Super Shop or Pharmacy. | A retried or double-submitted POS checkout can ring up **two sales** in three of four verticals. | Stock is taken by a guarded `$inc`, so stock stays right; `RestaurantOrder.rev` is an optimistic lock on payment; the client disables the button while the mutation is pending. None of these stops a genuine network retry. |
| I2 | Clothing's sale key is **optional** (`sales.validators.ts`: `.optional()`). | A client that omits it gets no protection. The POS page does send one. | Convention only. |
| I3 | **Plain returns write `idempotencyKey: null`.** Only *exchanges* carry a key (`posReturns.service.ts:138` vs `:375`). | A retried refund could refund twice. | Strong: a return *holds* the quantity on the sale line first, so a duplicate would exceed the remaining returnable quantity and be refused. Real but narrower than it looks. |
| I4 | No `Idempotency-Key` header convention, so each new money endpoint must remember to invent one. | Drift. I1 is what drift looks like. | — |

### 7.3 Plan (Phase 5) — done, except I3

1. **Close I1 first.** Add `idempotencyKey` plus the same unique partial index
   to `ShopSale`, `PharmacySale` and `RestaurantOrder`; require it in those
   `createSaleSchema`s; make the tills generate one per checkout attempt, exactly
   as `PosPage.tsx` already does. Additive migration — new optional field, new
   index.
2. Close I3: thread a key through the plain return path.
3. Make Clothing's key required (I2) once every client sends it.
4. Only then consider a shared `requireIdempotency()` middleware — a thin
   helper that standardises header parsing and the 11000-recovery read. Keep the
   storage in the business documents; do **not** move it to Redis, where a TTL
   expiry would silently re-open the window.
5. Add end-to-end assertions that fire the same POS sale twice, per vertical,
   and expect one sale. The suite already does this for Clothing.

---

## 8. File / object storage

### Current status

| | |
|---|---|
| Driver | `local` only. `STORAGE_DRIVER` accepts `local`, `s3` or `cloudinary`, but `services/storage/index.ts` **throws on boot in production** if `s3` or `cloudinary` is set, rather than silently writing to local disk. |
| Location | `path.resolve(process.cwd(), env.STORAGE_LOCAL_DIR)` — `./uploads` |
| Served by | `express.static` from the API process, `maxAge: '7d'` |
| What is stored | product and shop-product images, store/workspace logos, the public site's social image |
| Processing | magic-byte inspection, `sharp` re-encode to WebP, random UUID filenames, 20 MB ceiling, path-traversal guards on delete and list |
| Ownership | a `StorageObject` registry row per file; `releaseStorageKeys` only acts on keys the calling tenant owns — one workspace cannot delete another's files by naming them |
| Not stored as files | PDFs and exports (streamed to the response, never persisted), receipts and invoices (documents in MongoDB) |

### Decision: R2 is DEFERRED

Per the Phase 0 brief, and consistent with the audit: there is no *new*
object-storage requirement. PDFs, exports and invoices are not files on disk.

**But this is deferred, not absent.** The audit found a real local-disk
dependency that becomes a production defect at a specific, predictable moment:

- **Phase 6 (Docker).** A container's filesystem is ephemeral. Without a
  mounted volume, every uploaded image is lost on the next deploy, while the
  `StorageObject` registry still insists they exist.
- **Any second API replica.** Replica A writes the file; replica B serves the
  request for it and 404s.

So the trigger for un-deferring R2 (or any S3-compatible store) is explicit:

> **Introduce object storage at the point where the API runs in more than one
> container, or where upload persistence stops being guaranteed by a mounted
> volume.** Until then, Phase 6 must mount `./uploads` as a named volume and
> Phase 8 must back it up.

When that moment comes, the work is small and already scoped: implement
`StorageProvider` for S3/R2 (the interface, the registry and the boot-time
refusal all exist), set `STORAGE_DRIVER`, and serve images from the bucket or a
CDN instead of `express.static`.

---

## 9. Docker plan

### Status: WRITTEN, NOT BUILT (Phase 6, 2026-10-13)

`docker/Dockerfile` exists — multi-stage, `node:22-bookworm-slim`, non-root,
production-only runtime, one image serving both the API and the worker — with
`.dockerignore` and `docs/DOCKER.md`. **It has never been built or run:** there
is no container runtime on the machine, and none was installed. What was
validated another way, and what was not, is listed in
`docs/IMPLEMENTATION_STATUS.md` §1.6.

The blockers below were the Phase 0 audit's, and this is where each landed:

| | Phase 0 blocker | Outcome |
|---|---|---|
| D1 | native modules (`sharp`, `msgpackr-extract`) | Debian chosen from the lockfile's prebuild coverage; no compiler, no apt packages |
| D2 | uploads on local disk | one writable path, `/app/server/uploads`, documented as needing a volume |
| D3 | `syncIndexes` disabled in production | **still open** — an operational step, not an image concern |
| D4 | the client build fetching the API | closed: `PRERENDER_REQUIRE_API` makes it an explicit choice |
| D5 | the SPA calling relative `/api` | unchanged by design; the reverse proxy is Phase 8/9 |
| D6 | per-replica scheduler and caches | unchanged; **>1 API replica is still unsafe** |

**What follows is the Phase 0 finding, kept for the record.**

### Readiness: good core, six things to fix first

**In favour.** All configuration is environment-driven through a zod-validated
schema that fails fast. `app.listen(env.PORT)` binds all interfaces — no
hard-coded host. `npm start` is already `node dist/server.js`. `engines` requires
Node ≥ 20 and CI runs Node 22. npm with a committed lockfile. Graceful
`SIGTERM`. `localhost` appears only in defaults, log lines and test helpers.

**Blockers and traps**, each verified:

| | Issue | What to do |
|---|---|---|
| D1 | **Two native dependencies.** `sharp` has platform-specific libvips binaries, and BullMQ (Phase 2) pulls in `msgpackr-extract`, whose prebuilds are per-platform optional packages with a `node-gyp` fallback. | Build and run on the same base image; prefer Debian-slim over Alpine, or install libvips explicitly. Do not copy `node_modules` from the host. `msgpackr` works without its native accelerator, so a missing prebuild degrades rather than breaks — but verify that in the image rather than assuming it. |
| D2 | **Uploads live on local disk** at `cwd/uploads` (§8). | Named volume, and `WORKDIR` must match `STORAGE_LOCAL_DIR`'s relative resolution. |
| D3 | **`syncModelIndexes()` runs only when `!isProd`** (`config/db.ts`). A production container will not create missing indexes. | Make index creation an explicit migration/startup step for production, as the code comment already recommends. Do not flip the flag — syncing drops and rebuilds drifted indexes, which is not something to do unattended on a large collection. |
| D4 | **The client build fetches the API.** `client/scripts/prerender.mjs` reads live platform settings from `PRERENDER_API_URL`/`VITE_API_URL` (default `http://localhost:4100/api`) at build time, falling back to built-in copy with a warning. | Expected and safe — but a build inside an image with no API produces *stale marketing text, silently*. Either point it at a reachable API or accept the fallback knowingly. |
| D5 | **The SPA calls relative `/api` and `/uploads`** (`client/src/api/client.ts`: `baseURL: '/api'`). There is no absolute-URL or CORS path in the client. | The container topology **must** put the SPA and the API behind one origin. This is a constraint on the Nginx config, not a code change. |
| D6 | **The in-process scheduler runs in every replica**, and rate-limit stores and caches are per-replica (§3, §4, §6). | Scale to >1 replica only after Phases 1–4. One replica is fine before that. |

Also worth noting when the Dockerfiles are written (Phase 6):

- `node_modules/` is checked into the working tree here — a `.dockerignore` is
  mandatory, not optional.
- The env loader reads `./.env` then `../.env` relative to `cwd`; pass real
  environment variables in containers and ship no `.env`.
- The 23 migration scripts run through `tsx`, a **devDependency**. Either keep
  devDependencies in a migration stage, precompile them, or run migrations from
  the build stage — a production-only image cannot run `npm run migrate`.
- QZ Tray signing uses file paths (`QZ_CERTIFICATE_PATH`, `QZ_PRIVATE_KEY_PATH`).
  Mount them as secrets; never bake them into a layer.
- Multi-stage: deps → build (server `tsc`, client `vite build`) → slim runtime
  with `dist/` plus production dependencies only.

**Existing Docker assets: none.** No Dockerfile, no `.dockerignore`, no
`docker-compose.yml`. The only mention in the repository is a `docker run mongo:7`
line in the README for local development.

---

## 10. Docker Compose plan (Phase 7)

### Status: COMPLETED (2026-10-21)

Built as planned, including the single-node replica set — which was the whole
point, and which immediately proved it: **eleven production call sites were
broken on any replica set** (and therefore on Atlas) because
`create(array, { session })` needs `ordered: true`, and registration returned a
500. Two more real bugs surfaced the same way: BullMQ rejects a colon in a job
id, so campaign delivery failed wherever Redis was configured, and nginx cached
the API's address and answered 502 after any container recreate. Detail,
evidence and the remaining limitations are in
`docs/IMPLEMENTATION_STATUS.md` §1.7; operating instructions are in
`docs/DOCKER.md`.

**What follows was the plan, kept for the record.**

Purpose: a production-*like* local stack, so Phases 1–5 can be verified
together before any VPS work.

```
services: api, worker, mongo (single-node replica set), redis, nginx
```

- **`mongo` must be a single-node replica set**, not a standalone. Today
  `supportsTransactions()` probes `hello` for `setName`, finds nothing, and
  `withTransaction` silently degrades to compensating writes. CI uses a
  standalone `mongo:7`, so **the transaction path is currently never exercised
  anywhere**. A replset in compose is the only way to test the code path that
  production (Atlas) will actually take.
- `nginx` fronts both, giving the single origin D5 requires.
- `api` and `worker` run the same image with different commands.
- Named volumes for mongo data, redis data and `uploads`.
- Health checks and `depends_on: condition: service_healthy`, so the API does
  not boot before Mongo answers.
- This stack is for testing, never for production.

---

## 11. VPS deployment plan (Phase 8)

### Status: PREPARED, NOT DEPLOYED (2026-10-25)

The production stack, the operational scripts and the deployment guide exist
and were validated locally: `docker-compose.prod.yml`,
`docker-compose.prod.mongo.yml`, `.env.production.example`, seven `deploy/`
scripts and `docs/VPS_DEPLOYMENT.md`. **No VPS was provisioned and no remote
host was touched.** MongoDB Atlas is the default database, as planned here since
Phase 0, with self-hosting available as an explicit override.

Two things worth carrying forward. **Plain HTTP cannot hold a session**: the
refresh cookie is `secure: true` in production and a browser will not store it
over HTTP, so TLS in Phase 9 is a hard prerequisite rather than a polish step.
And **readiness is blocked on an off-server backup destination** — a backup on
the same disk as the database protects against a bad deploy and nothing else.

Detail, measured resource use and the four preparation bugs found by running it
are in `docs/IMPLEMENTATION_STATUS.md` §1.8.

**What follows was the Phase 0 finding, kept for the record.**

### Phase 0: deployment model NOT CONFIGURED IN THE REPOSITORY

Verified absent: Dockerfile, `docker-compose.yml`, any Nginx configuration, any
PM2 `ecosystem` file, any systemd unit, any deploy script, any deployment
workflow. `.github/workflows/ci.yml` is **verification only** — it never
deploys.

Whatever production exists today is configured by hand on the host and is not
described anywhere in this repository. **Capturing the current production
configuration is itself a Phase 8 deliverable**, and until it happens the
deployment is undocumented and unreproducible. That is the single largest
operational risk in this audit.

### Plan

1. Write down what production is **now**, before changing it.
2. Compose-based deploy on the VPS: `api`, `worker`, `redis`, `nginx`; MongoDB
   stays on Atlas rather than in a container.
3. Nginx: TLS, HTTP/2, static SPA with long-lived hashed assets and a no-cache
   `index.html`, `/api` and `/uploads` proxied to the API — the single origin
   D5 requires. Client-side routing fallback to `index.html`.
4. Secrets in a root-only env file (or the host's secret store), never in the
   image, never in git.
5. Zero-ish-downtime: start the new container, wait for `/api/health`, switch,
   drain the old one. `SIGTERM` handling already supports this.
6. Backups: Atlas handles the database; the `uploads` volume needs its own
   off-host backup (§8).
7. Log rotation for container logs, and a documented restart policy.

---

## 12. Cloudflare plan (Phase 9)

- DNS, TLS (Full Strict — Cloudflare must not be the only certificate), HTTP/3.
- Cache static assets aggressively; **never cache `/api`**.
- WAF plus a Cloudflare-level rate limit on `/api/auth/*` as a layer *above*
  the application's own.
- **Re-verify `trust proxy` the day Cloudflare goes in front** (finding R4).
  With Cloudflare and Nginx both in the chain, the hop count changes; a wrong
  value makes every rate limiter key on a proxy address. Use
  `CF-Connecting-IP`, restore the real IP in Nginx, and assert the keyed address
  in a test.
- Webhook endpoints must stay reachable: bKash notifications arrive via Amazon
  SNS and ZiniPay may deliver as a GET with a query string. Bot-fight rules
  must not eat them, or payments silently never complete.
- Upload size: the app's own ceilings are 1 MB JSON, 5 MB imports, 20 MB images.
  Cloudflare's plan limit must not be lower.

---

## 13. CI/CD plan (Phase 10)

### Current status

`.github/workflows/ci.yml`, on push to `main` and every PR: checkout → Node 22
→ `npm ci` → `npm audit --audit-level=high` → lint → typecheck → build →
`npm test` (the ~3,500-assertion HTTP suite against a `mongo:7` service, with
throwaway JWT secrets minted and masked per run). Concurrency group cancels
superseded runs. Dependabot runs weekly with grouped updates.

This is a solid verification pipeline. There is **no deployment stage**.

### Plan

1. Build and push images on a tag, with the git SHA as the tag.
2. Deploy job gated on a GitHub Environment with required reviewers.
3. Migrations as an explicit, logged step before the new image takes traffic —
   including the index creation D3 leaves unhandled in production.
4. Post-deploy `/api/health` (and `/api/ready`, §14) check with automatic
   rollback to the previous tag on failure.
5. Add a **replica-set** Mongo service to CI so the transaction path is covered
   (§10), alongside the existing standalone run.

---

## 14. Monitoring / logging plan (Phase 11)

### Current status

| Concern | Status |
|---|---|
| Logger | `utils/logger.ts` — an 18-line wrapper over `console`, plain-text lines, four levels, `debug` suppressed in production. **No pino, no winston** (the project brief calls for pino; the code does not have it). |
| Structure | Unstructured text with an optional metadata argument. Not machine-parseable. |
| Request id | **None.** Nothing correlates log lines to a request, a tenant or a user. |
| HTTP logs | `morgan('dev')` in non-production only, so **production logs no requests at all**. |
| Error handling | `middleware/error.ts` maps `ApiError`, `ZodError`, Mongoose validation/cast errors and 11000 duplicate keys to a single envelope; stack traces never leak in production; unknown errors log and return `INTERNAL`. Sound. |
| Audit log | `services/audit/audit.service.ts` writes `AuditLog` rows (actor, action, target, before/after, IP) and deliberately never throws. Applied to sensitive actions including `data.exported`. |
| Health | `GET /api/health` returns `{ status: 'ok', time }` — a **static response that does not check MongoDB**. A server with a dead database answers "ok". |
| Readiness | **None.** |
| Metrics / tracing / alerting | **None.** The only alerting of any kind is `sendPaymentAlertDigest`, a business email about stuck payments. |

### Plan

1. Structured JSON logging with a request id propagated through async context,
   carrying `tenantId`, `userId` and route. Keep the existing redaction habits —
   `safeError` already strips credentials from provider errors.
2. Request logging in production (sampled), which `morgan('dev')` currently
   omits entirely.
3. **Make `/api/health` honest** and add `/api/ready` that checks the Mongo
   connection state, Redis, and queue reachability. The load balancer and the
   CI deploy gate both depend on this telling the truth.
4. Queue observability: depth, failure counts, oldest waiting job. A silent
   worker backlog is the characteristic failure mode of Phase 3.
5. Error aggregation (Sentry or equivalent) wired into `errorHandler` and the
   worker's failure handler.
6. Alerts on: API 5xx rate, queue depth and failed-job count, Mongo connection
   state, Redis availability, disk usage on the `uploads` volume, and
   `EmailNotification` rows stuck at `failed`.

---

## 15. Scaling plan

### 15.1 Bottlenecks, in the order they will bite

| | Bottleneck | Evidence | Fix |
|---|---|---|---|
| B1 | **One process does everything.** A campaign send, a 200k-row export or a 2,000-row import occupies the same event loop that serves the tills. | §5 | Phases 2–3 |
| B2 | **Unbounded request work.** 5,000 recipients; 200,000 rows; ~6,000 documents. | `messaging.validators.ts`, `export.limits.ts`, `import.limits.ts` | Phase 3 |
| B3 | **The scheduler runs per replica**, so the first horizontal scale duplicates all scheduled work. | `jobs/subscription.job.ts` | Phase 2/3 |
| B4 | **Rate limits and caches are per replica.** | §3, §6 | Phases 1, 4 |
| B5 | **Connection pool is fixed at 20** per process, with no env override. | `config/db.ts` | Make it configurable before scaling replicas; 20 × N must stay inside the Atlas tier's connection limit. |
| B6 | **CPU-bound `sharp`** on the request path. | `imageOptimizer.ts` | Phase 3 |
| B7 | **Report aggregations** inline, two large services, 13 pipelines. | §5.1 | Index review, then daily snapshots if needed |
| B8 | **No production index management.** `syncIndexes` is dev-only; 191 declarations exist but nothing guarantees they are built on a production database. | `config/db.ts` | Phase 6 (D3) |
| B9 | ~~**Transactions untested.**~~ **CLOSED in Phase 7** — a single-node replica set in Compose exercises the real session path, and doing so immediately exposed eleven production call sites that failed on any replica set. CI still runs standalone, so adding a replica set there is the remaining gap. | `utils/tx.ts`, `ci.yml` | CI: Phase 10 |
| B10 | **Uploads pin the API to one node.** | §8 | Object storage, when triggered |

### 15.2 Architectural readiness by tenant count

**These are architectural readiness judgements, not capacity guarantees.** They
say what the *shape* of the system can support, not what the hardware will do.
Real capacity depends on tills per workspace, sales per hour, catalogue size,
report usage, campaign volume and the Atlas tier — and can only be established
by **load testing (Phase 12)**. No number here has been measured.

| Businesses | Readiness | What governs it |
|---|---|---|
| **10** | **Ready now.** | Single process, single replica. Current architecture is appropriate; nothing in this roadmap is required. |
| **100** | **Ready, with Phases 1–3.** | Still single-replica-viable, but campaigns, imports and exports start colliding with till traffic. The worker is what buys headroom here, not more CPU. |
| **500** | **Needs Phases 1–5 complete.** | Horizontal scale becomes attractive, which makes B3/B4 correctness issues rather than inefficiencies. Idempotency gaps (I1) matter more as retry volume grows. Index review (B7/B8) due. |
| **1,000** | **Needs Phases 1–8, plus measurement.** | Multi-replica API behind a load balancer, worker scaled separately, Atlas tier chosen from observed working set, pool sizing (B5) deliberate, object storage likely triggered (B10). Report snapshots probably required. |
| **10,000** | **Beyond what this audit can assess.** | Requires work this roadmap does not cover: data partitioning or sharding strategy, read replicas and read-preference routing, per-tenant resource isolation so one workspace's campaign cannot degrade another's till, archival of historical sales, and a load-tested capacity model. Treat it as a separate design exercise, informed by Phase 12 results — not as the end of this roadmap. |

The honest summary: **the application is well-built and its correctness
foundations are strong, but its runtime is a single process.** Everything up to
a few hundred businesses is an infrastructure exercise. Beyond that, it becomes
a data-architecture exercise.

---

## 16. Phase order

```
PHASE 0   Infrastructure audit                      ← this document (COMPLETED)
   ↓
PHASE 1   Redis foundation                          (COMPLETED 2026-10-08)
   ↓
PHASE 2   BullMQ worker foundation                  (COMPLETED 2026-10-08)
   ↓
PHASE 3   Background-job migration                  ← IN PROGRESS (campaigns done)
   ↓
PHASE 4   Rate limiting (distributed)              (COMPLETED 2026-10-08)
   ↓
PHASE 5   Idempotency / reliability                 (COMPLETED 2026-10-13)
   ↓
PHASE 6   Docker                                    (COMPLETED; built and run 2026-10-21)
   ↓
PHASE 7   Docker Compose + production-like local testing
   ↓
PHASE 8   VPS deployment                            (PREPARED 2026-10-25; not deployed)
   ↓
PHASE 9   Cloudflare + SSL                          ← next
   ↓
PHASE 10  GitHub Actions CI/CD
   ↓
PHASE 11  Monitoring / observability
   ↓
PHASE 12  Load testing / scaling
```

**R2: DEFERRED** — introduce object storage only when a real requirement
appears. The audit names that trigger precisely: the moment the API runs in more
than one container, or upload persistence is no longer guaranteed by a mounted
volume (§8).

### Two notes on the order

1. **Phase 5 (idempotency) contains the only user-visible correctness bug in
   this audit** — finding I1, missing sale idempotency in three of four POS
   verticals. It is cheap and additive, and it does not depend on Redis, the
   worker, or anything else in Phases 1–4. If a sale is ever reported as having
   been rung up twice, pull I1 forward immediately; do not wait for its phase.
2. **Do not scale to more than one API replica before Phase 4 is done.** B3 and
   B4 turn from inefficiencies into defects the moment a second replica starts.
