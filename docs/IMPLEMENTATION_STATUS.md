# Implementation status

**The source of truth for infrastructure state between sessions.** Last
verified against the code on **2026-10-08** (branch
`claude/retailer-suites-audit-e61761`, parent `c8b891c`).

---

## How to continue infrastructure work

Every future infrastructure session must read these four documents **before
touching anything**:

1. **`CLAUDE.md`** — the project's working rules. Note: it is currently provided
   at the workspace root *above* this repository, not inside it. If you cannot
   find it, `README.md` is the in-repo equivalent for stack and commands.
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
| **Redis** | **NOT STARTED** | No dependency, no `REDIS_*` env var, no client, no cache/queue/lock/session use. Nothing. |
| **BullMQ / Worker** | **NOT STARTED** | No BullMQ, Bull, Agenda, node-cron, `worker_threads`, worker entry point or PM2. One `setInterval` scheduler inside the API process (`server/src/jobs/subscription.job.ts`): an hourly billing pass and a 10-minute payment-reconciliation pass. Every pass is idempotent and batched, which is why migrating it is low-risk. |
| **Background jobs** | **NOT STARTED** | Everything runs in-request. Candidates, in priority order: SMS/email campaigns (up to 5,000 recipients, sequential, in the request), password-reset and verification emails (inline SMTP), exports (up to 200,000 rows streamed), product import commit (~6,000 documents), `sharp` image optimisation. **Exception:** billing emails already use a correct durable queue in MongoDB (`EmailNotification` — keyed, leased, 5 attempts, backoff). Keep that mechanism; move only its driver. |
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
PHASE 1   Redis foundation                          NOT STARTED   ← next
PHASE 2   BullMQ worker foundation                  NOT STARTED
PHASE 3   Background-job migration                  NOT STARTED
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

**Next phase: PHASE 1 — Redis foundation.** Scope is in
`docs/INFRASTRUCTURE_ROADMAP.md` §3. It was not started in this session, by
design: Phase 0 is audit and documentation only.

---

## 4. Change log

| Date | Change |
|---|---|
| 2026-10-08 | Phase 0 infrastructure audit. Added `docs/INFRASTRUCTURE_ROADMAP.md`. Replaced this file with the infrastructure status tracker and moved its previous contents — the Super Shop implementation journal — to `docs/SUPERSHOP_IMPLEMENTATION_JOURNAL.md`. Added the infrastructure section to `docs/ARCHITECTURE.md` and corrected its stated dependency versions. No application code changed. |
