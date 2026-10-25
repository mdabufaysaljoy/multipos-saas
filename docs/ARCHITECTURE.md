# Architecture

A working map of the platform, written for someone joining the project. It
describes what is there now, not what is planned. Current status — above all
for infrastructure — is `docs/IMPLEMENTATION_STATUS.md`; the infrastructure
audit and plan is `docs/INFRASTRUCTURE_ROADMAP.md`; the universal-POS programme
is `docs/UNIVERSAL_POS_PLAN.md`; the Super Shop journal that used to be the
status file is `docs/SUPERSHOP_IMPLEMENTATION_JOURNAL.md`.

## Shape

npm workspaces monorepo, TypeScript throughout (~92k lines).

```
server/   Express 5 + Mongoose 9 REST API
client/   React 19 + Vite 6 + TanStack Query + Tailwind + shadcn/ui
scripts/  run-tests.mjs (isolated DB harness) + smoke-test.mjs (the suite)
docs/     per-feature design notes
```

## Tenancy

```
Account ──┬── Wallet
          └── Workspaces (= Tenant)
                ├── posType: clothing | supershop | restaurant | pharmacy
                ├── Subscription (per workspace)
                └── Stores (branches)
```

A **workspace is one POS type** and is the `tenantId` everything is scoped by.
A **store** is a branch inside it. Catalogues are usually tenant-scoped; stock
and sales are always branch-scoped.

## Request lifecycle

```
authenticate → resolveTenant → requireVertical(x) → requireSubscribedAccess
             → requirePermission(k) → requireEntitlement(f) → validate(zod) → controller → service
```

- `authenticate` — JWT carries only a user id. Permissions are re-read from the
  database on every request, so a forged token cannot escalate.
- `resolveTenant` — the **only** place a `tenantId` enters a request, taken from
  the authenticated user. The `x-store-id` branch header is re-validated twice:
  the branch must belong to the tenant *and* the user must be assigned to it.
  Nothing tenant-scoped is ever read from a body, query or header.
- `requireVertical` — a Super Shop route refuses a Clothing workspace outright.
- `requirePermission` / `requireEntitlement` — RBAC (`config/permissions.ts`,
  defaults in `roles.defaults.ts`) and the plan feature flag are separate gates.
- `validate` — zod on params/query/body. **A zod failure is 422.**

## Money

Integer **minor units** everywhere. No float touches a monetary value; `/100`
happens only at display time. Prices, costs and totals always come from the
server — a request carries ids and quantities, never prices.

## The universal POS layer

Clothing is the reference vertical. Capabilities shared by all four live in
`server/src/services/` behind an adapter per vertical, because the four
catalogues are different models (`Product`, `ShopProduct`, `Medicine`,
`MenuItem`):

| Concern | Shared code | Adapter seam |
|---|---|---|
| Tender rules | `services/pos/paymentMethods.service.ts` (`settleTender`) | `TenderDialect` |
| Stock | `services/inventory/adapter.ts` | `adapters/<vertical>.adapter.ts` |
| Returns | `services/returns/posReturns.service.ts` | `adapters/<vertical>.saleAdapter.ts` |
| Import | `services/import/posImport.service.ts` | `posImport.adapters.ts` |
| Categories | `services/catalogue/posCategories.service.ts` | `PosCategory.vertical` |
| Ledger view | `services/inventory/posLedger.ts` | per-vertical movement model |
| Report print | `services/reports/reportPrint.ts` | — |
| Loyalty | `modules/loyalty/` | sale model passed in |

Shared means the same **capability**, not the same schema. Clothing keeps its
own returns engine (exchanges, loyalty, idempotency); the other three use the
simpler shared one.

## Restaurant: an order, not a sale

The three retail verticals ring up a basket and take the money. A restaurant
does not: it **opens an order**, adds to it over minutes or hours, tells the
kitchen what changed, and settles at the end.

```
open order ──► add / change / remove lines ──► send to kitchen (a token) ──► pay
```

What follows from that shape:

- **`RestaurantOrder.rev` is an optimistic lock.** Every line change bumps it;
  paying and sending to the kitchen both quote the `rev` the cashier saw, so an
  order cannot be paid while somebody is editing it.
- **One open order per table**, enforced by a partial unique index on `tableId`
  — two waiters cannot seat the same table.
- **A ticket carries only the change since the last one.** Each line remembers
  `sentQuantity`; a removed line is kept at quantity 0 with `voidedAt` set so the
  next ticket can say VOID. Ticket numbers come from
  `nextSequence(tenant, store, 'kitchen-ticket')` as `KOT-000001`, per branch.
- **Sending an order produces a token; nothing tracks it afterwards.** There is
  no kitchen queue and no way to mark a ticket done — that screen was removed on
  2026-09-30. A ticket is `pending` when sent and `void` when its order is
  cancelled. (`ready` survives in the enum only for orders already stored.)
- **A paid order cannot be refunded.** Restaurant refunds were removed on the
  same date. An open order is changed or cancelled instead. The shared return
  engine is untouched and still serves the other three verticals; Restaurant
  reporting keeps its refund figures so orders refunded earlier still add up.
- **The bill is never a modal.** The till's order column is header, a scrolling
  cart, then a pinned billing section (customer, discount, loyalty, tenders,
  due and change) and a pinned action bar — the same four-layer shape the Super
  Shop till uses, and the same rule: one scroll, and the money never moves. The
  panel is keyed on the order, so switching tables resets it.
- **No stock.** `restaurant.adapter` is a deliberate no-op inventory adapter and
  `/stock-ledger` answers with an empty page — the same route shape as everywhere
  else.
- **No restaurant-specific permissions.** Everything reuses `sales.*`,
  `products.*`, `returns.*`, `reports.view`, `settings.edit`.
- **The menu is a hierarchy of names.** Section → dish → size, with extras on
  the dish. `category` is a NAME (the shared `PosCategory` list); `variants[]`
  and `addOnGroups[]` are embedded on `MenuItem`. Every part is optional, so a
  dish that is just a dish at one price carries none of it. A second level,
  subsections, was built and removed again on 2026-10-02 — one level of grouping
  is what the kitchen wanted.
- **A variant is not an add-on.** A variant answers "which version?" — one is
  chosen and its price *replaces* the dish's. An add-on answers "what extra?" —
  several may be chosen and each price is *added*. They are separate arrays, and
  the server refuses a dish with sizes that is ordered without one, so a till
  can never fall back to the base price.
- **`unitPriceMinor` is the fully-loaded price of one**, variant and extras
  folded in, so reports, bills, refunds and the tender rules read one number.
- **Extras are a reusable list.** `MenuAddOn` is the workspace's list;
  `MenuAddOnOption` is one of them as offered on a dish, with that dish's own
  price. Renaming the list entry follows onto the dishes; repricing it does not,
  so a menu edit never silently reprices a live kitchen.

The audit for the next change to this vertical — dependency maps for the kitchen
and refund features, the billing flow, and the recommended menu hierarchy — is
`docs/RESTAURANT_AUDIT.md`.

## Concurrency

The deployment target *today* is standalone MongoDB — **no multi-document
transactions** — while the Compose stack (Phase 7) runs a single-node replica
set where they are available. Both paths therefore matter, and running the
replica set for the first time showed how much: eleven `create(array, {session})`
calls needed `ordered: true` and had been failing silently nowhere, because no
test had ever opened a real session. (`utils/tx.ts` probes for a replica set at boot and uses real
sessions when it finds one, so MongoDB Atlas turns transactions on without a
code change; see Infrastructure below.) Correctness does not depend on that: it
comes from ordering and compare-and-swap instead:

- stock is taken with a single guarded `$inc` (`quantityOnHand: { $gte: n }`),
  so two tills cannot sell the same unit;
- a retried or double-tapped checkout is caught by an **idempotency key**: the
  Clothing sale carries its own on the `Sale` document, and Restaurant orders,
  Super Shop sales and Pharmacy sales go through the shared
  `IdempotencyRecord` (unique on `(scope, key)`), which is claimed *before* the
  work starts so a duplicate never reaches the stock at all. `docs/API.md`
  documents the contract;
- returns *hold* a quantity on the sale line before touching stock, and release
  it on failure;
- billing claims work with a CAS and a period-scoped idempotency key.

## The public website

`/`, `/products`, `/products/:slug`, `/features`, `/pricing` and `/contact` are
the marketing site, rendered under `PublicLayout`. It shares the application's
React, Tailwind and shadcn conventions but none of its chrome, and every rule it
adds is scoped under `.public-shell` so the authenticated POS is untouched.

- **Motion has no runtime.** Scroll reveals are one `IntersectionObserver`
  (`features/public/motion.tsx`); everything else is keyframes in `index.css`.
  No animation library ships to the till.
- **The hero's till is the product, not stock art.** `PosTerminal` runs a real
  checkout - scan, basket, split tender, receipt - and the same component backs
  the POS switcher, so one component covers four verticals.
- **Nothing on the site is invented.** The POS list and capability copy come
  from `pages/public/products.data.ts`; plans, prices, limits and trial length
  are read live from `/plans`. The site cannot advertise what the backend will
  not honour.
- **Reduced motion is handled in CSS**, so looping decoration stops too, and no
  content is gated behind an animation that might not fire.

## Signing in

`/login` and `/register` share `AuthShell`: the counter scene on one side, the
form on the other, reflowing on a phone to branding, visual, form.

The visual is `AuthScene`: an operator at the counter ringing up a sale while
the printer feeds the receipt.

**It takes one prop — which of `idle | scanning | success | error` to show — and
nothing else.** It never sees an email, a password or an error message, and it
is not on a timer. The pages drive it from the real request: the till works
while the call is in flight, and the receipt finishes and the tick is drawn only
after the server has returned a session. There is no path where the animation
can claim a success the backend did not give.

It is inline SVG animated by the keyframes in `index.css` rather than a Lottie
player, for the same reason the marketing site has no animation runtime — and
because this product's own counter says more than a stock illustration would.

`OnboardingPage` shares the shell too, since it is the step straight after
registering; its own form and logic are untouched.

## Dependency majors, and what they cost

The stack runs **Express 5, Mongoose 9 and React 19**. Three things about
Mongoose 9 are worth knowing before writing data code:

- **A pipeline update needs `updatePipeline: true`.** An array passed to
  `updateOne` / `updateMany` / `findOneAndUpdate` is otherwise refused at
  runtime. TypeScript will not catch it where the pipeline is cast.
- **Hooks take no `next`.** A `pre` hook is called with the operation's own
  arguments and fails by throwing. A hook written `function (next) { next(err) }`
  calls an undefined `next` and raises a TypeError instead of its own message.
- **Query filters are typed strictly.** A bare `string` no longer stands in for
  a union field, so filters built from loose values need the real type.

## Testing & CI

`npm test` boots a throwaway API on its own port against a derived `*_test`
database, runs `scripts/smoke-test.mjs` (**3,570 assertions**, all over HTTP,
including cross-tenant IDOR, auth bypass and payload abuse), then runs
`server/src/seed/immutability.check.ts` at the model layer - the HTTP suite
cannot reach the immutability guards, because there is deliberately no route
that edits an invoice or a ledger row - and then drops the database. `.github/workflows/ci.yml` runs lint → typecheck → build → test on
Node 22 with a `mongo:7` service.

There are no unit tests and no frontend tests; pure-logic modules
(`shopUnits.ts`, `loyalty.math.ts`, `paymentMath.ts`) are only covered
indirectly through HTTP.

## Infrastructure

The runtime that serves traffic is **one Node process**. It serves HTTP, runs
the subscription scheduler, streams exports, commits imports, sends campaigns
and re-encodes images — all on the same event loop. A second process, the
worker, exists for background work but has nothing registered yet.

```
Browser (SPA)  ──relative /api and /uploads──►  API process  ──►  MongoDB
                                                  ├─ Express 5 app
                                                  ├─ setInterval scheduler
                                                  ├─ ./uploads on local disk
                                                  └─ Redis ──► campaign-delivery queue
                                                                        │
                                               worker process  ◄────────┘
                                                  └─ campaign delivery  ──►  MongoDB
```

What that means in practice:

- **The SPA calls relative `/api` and `/uploads`** (`client/src/api/client.ts`),
  so the client and the API must be served from one origin. There is no
  absolute-URL or CORS path in the client code.
- **Scheduled work still lives in the API process.** `jobs/subscription.job.ts` runs
  an hourly billing pass (expiry reminders, renewals, lapsing, invoices,
  receipts, email retries) and a 10-minute payment-reconciliation pass, started
  by `server.ts`. Every pass is batched and idempotent — which is why running
  two API replicas today duplicates work rather than corrupting it, and why
  moving the passes to a worker is low-risk.
- **Rate limiting counts in Redis.** All 23 policies go through
  `middleware/rateLimit.ts`, which gives `express-rate-limit` a Redis-backed
  store on the shared Phase 1 client — one atomic `EVAL` per request, keys
  namespaced as `retailersuites:<env>:rl:<policy>:<identity>`, TTL set in the
  same script. Every replica therefore sees the same counter. When Redis is
  unreachable each policy falls back as it declares: most degrade to a
  per-process counter (the limit still applies, once per replica), while four
  that guard spending or API capacity refuse with 429. When Redis was never
  configured, every policy uses the per-process counter, exactly as before
  Phase 4. `TRUST_PROXY_HOPS` decides `req.ip`, which is what most policies key
  on, so it must match the deployment.
- **The four in-memory caches are still per process.** Site settings, the
  pricing-catalogue guard, SNS certificates and the DNS fallback memory are all
  per-replica; none affects correctness.
- **Uploads are files on local disk**, under `cwd/uploads`, served by
  `express.static` and re-encoded to WebP by `sharp`. Nothing else is a file:
  exports stream straight to the response, and invoices and receipts are
  MongoDB documents.
- **Redis backs the queue.** `config/redis.ts` holds one shared `ioredis`
  client for application use; `queues/connection.ts` holds a second, built from
  the same configuration with the two overrides BullMQ requires (no ioredis
  `keyPrefix`, `maxRetriesPerRequest: null`). Redis stays **optional for the
  API**: unset or unreachable is logged and never fatal.
- **The worker process delivers campaigns.** `server/src/worker.ts`
  (`npm run worker`) is a separate process holding the BullMQ foundation in
  `server/src/queues/` — `createAppQueue` / `createAppWorker` over one shared
  connection, with retry, backoff, retention and naming centralised in
  `queues/options.ts`. It requires Redis, unlike the API, and exits non-zero
  without it. New background jobs must use these factories and register in
  `registerWorkers()`; queue payloads carry identifiers, never documents or
  secrets.
- **Campaign delivery is the one migrated workload.** `POST /messaging/campaigns`
  stores one row per recipient, charges the wallet once, enqueues one job per
  100-recipient batch on `campaign-delivery`, and returns `queued` — it no
  longer waits for thousands of sequential gateway calls. The worker claims each
  recipient with a lease before attempting it, so a retry skips what already
  went out, and a unique `(campaignId, recipient)` index means a repeated
  attempt cannot create a second row. `services/sms/campaignDelivery.service.ts`
  is the single implementation; when no Redis is configured the API calls the
  same function inline, so a deployment without Redis still sends. Everything
  else in `docs/INFRASTRUCTURE_ROADMAP.md` §5 — auth-code emails, exports,
  imports, image processing and the subscription scheduler — is still in the API
  process.
- **The API and the worker are separate processes.** The API starts no worker
  and the worker starts no HTTP server; a test asserts both from the sources.
- **There is a Docker image, a local Compose stack and a prepared production
  stack; nothing is deployed.** `docker-compose.prod.yml` plus the `deploy/`
  scripts and `docs/VPS_DEPLOYMENT.md` are ready for a single VPS — one API, one
  worker, Redis, nginx, and MongoDB Atlas by default. No server has been
  provisioned, and plain HTTP cannot hold a login session because the refresh
  cookie is `secure`, so TLS gates any real traffic.
- **HTTPS and the edge are prepared, not deployed.** `docker-compose.prod.tls.yml`
  with the `web-tls` image terminates TLS at the origin behind Cloudflare;
  `docs/CLOUDFLARE_SSL.md` has the configuration and the cutover order. Two
  things are worth knowing from it. **The SPA document's security headers live
  in nginx, not helmet** — nginx serves `index.html` from disk and never reaches
  Express, so before Phase 9 the rendered document had no CSP, HSTS or frame
  protection while helmet's full set went only to `/api`. And **`TRUST_PROXY_HOPS`
  stays 1 behind Cloudflare**: nginx resolves the real client from
  `CF-Connecting-IP` for Cloudflare-originated requests only and forwards a
  single `X-Forwarded-For` value, so raising the count would read past it into
  attacker-controlled data. `server/src/config/edgeSecurity.check.ts` asserts
  both.
- **The local stack and the image.** `docker/Dockerfile` builds one image serving both roles —
  `node dist/server.js` for the API, `node dist/worker.js` for the worker — on
  `node:22-bookworm-slim`, non-root, production dependencies only.
  `docker-compose.yml` runs nginx, the API, the worker, Redis and a **single-node
  MongoDB replica set**, which is the only place in this project where
  transactions are actually exercised. `docs/DOCKER.md` covers building,
  running, the integration tests and the limits. CI verifies; it still does not
  deploy.
- **Health is `GET /api/health`**, which returns `ok` whenever the process is
  running and does not check the database. It reports the Redis connection
  state under `data.dependencies.redis`, as information rather than a gate.
  There is no readiness endpoint.
- **Logging is a `console` wrapper** (`utils/logger.ts`) — plain text, no
  request id — and `morgan` is registered in non-production only, so production
  logs no requests. Audit logging of sensitive actions (`AuditLog`) is separate
  and does work.

The audit behind these statements, and the plan to change them, is
`docs/INFRASTRUCTURE_ROADMAP.md`. What is done so far is
`docs/IMPLEMENTATION_STATUS.md`.
