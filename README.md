# Clothing POS — Multi-tenant SaaS Point of Sale

A production-oriented point of sale for clothing retailers. Every business gets an
isolated workspace (tenant) with its own products, stock, sales, staff and
reports, gated by a database-driven subscription.

Built with React + Vite + TypeScript on the front, Node + Express + TypeScript +
MongoDB on the back.

---

## Table of contents

1. [What works today](#what-works-today)
2. [Requirements](#requirements)
3. [Installation](#installation)
4. [Environment variables](#environment-variables)
5. [MongoDB setup](#mongodb-setup)
6. [Development commands](#development-commands)
7. [Seed data and login credentials](#seed-data-and-login-credentials)
8. [Architecture](#architecture)
9. [Authentication](#authentication)
10. [Business rules that are enforced](#business-rules-that-are-enforced)
11. [API structure](#api-structure)
12. [Testing](#testing)
13. [Phase 2 roadmap](#phase-2-roadmap)

---

## What works today

This is a functioning application backed by a real database, not a mock-up. End
to end you can:

| # | Capability | Status |
|---|------------|--------|
| 1 | Register a business / sign in | ✅ |
| 2 | Create a tenant workspace and a store | ✅ |
| 3 | Manage categories | ✅ |
| 4 | Create clothing products | ✅ |
| 5 | Generate Colour × Size variants, each with its own SKU/price/stock | ✅ |
| 6 | Add and adjust stock, with a full audit ledger | ✅ |
| 7 | Create staff accounts | ✅ |
| 8 | Assign roles and per-permission grants/denials | ✅ |
| 9 | Run the POS (search, scan, cart, tender) | ✅ |
| 10 | Change price at checkout **only** with permission | ✅ |
| 11 | Complete a sale, reduce inventory atomically | ✅ |
| 12 | Attach a customer (optional) | ✅ |
| 13 | Print a 58mm thermal receipt | ✅ |
| 14 | Search sales history | ✅ |
| 15 | Create a return from an existing sale, restoring stock | ✅ |
| 16 | Dashboard analytics with presets and custom multi-year ranges | ✅ |
| 17 | Preserve historical sales when products are edited or deleted | ✅ |
| 18 | Subscription plans, limits, entitlements, manual activation | ✅ |
| 19 | Platform-admin console (tenants, subscriptions, payments) | ✅ |
| 20 | Payment provider abstraction (bKash / Nagad / bank scaffolding) | ✅ structure, ⏳ live gateways |

---

## Requirements

- **Node.js 20+** (developed on 26)
- **MongoDB 6+** running locally, or a connection string to Atlas
- npm 9+

---

## Installation

```bash
git clone <your-repo-url> clothing-pos
cd clothing-pos
npm install          # installs the server and client workspaces
cp .env.example .env
```

Generate real JWT secrets (the example values are placeholders and the server
refuses to boot without proper ones):

```bash
node -e "console.log('JWT_ACCESS_SECRET='+require('crypto').randomBytes(48).toString('hex'));console.log('JWT_REFRESH_SECRET='+require('crypto').randomBytes(48).toString('hex'))"
```

Paste both lines into `.env`, then seed and run:

```bash
npm run seed
npm run dev
```

- API → <http://localhost:4100>
- App → <http://localhost:5173>

> **Ports.** The API defaults to **4100** and the client to **5173**. If either is
> occupied, change `PORT` in `.env` (and the `proxy` target in
> `client/vite.config.ts`). The Vite dev server also honours a `PORT` env var.

---

## Environment variables

All configuration lives in `.env` at the repository root. Nothing secret is ever
hardcoded. See `.env.example` for the full annotated list.

| Variable | Purpose | Default |
|---|---|---|
| `NODE_ENV` | `development` \| `test` \| `production` | `development` |
| `PORT` | API port | `4100` |
| `MONGODB_URI` | MongoDB connection string | `mongodb://127.0.0.1:27017/clothing_pos` |
| `JWT_ACCESS_SECRET` | Signs access tokens — **min 32 chars** | _(required)_ |
| `JWT_REFRESH_SECRET` | Signs refresh tokens — **min 32 chars** | _(required)_ |
| `ACCESS_TOKEN_TTL` | Access token lifetime | `15m` |
| `REFRESH_TOKEN_TTL` | Refresh token lifetime | `7d` |
| `BCRYPT_ROUNDS` | Password hashing cost | `10` |
| `CLIENT_ORIGIN` | Allowed CORS origin(s), comma-separated | `http://localhost:5173` |
| `STORAGE_DRIVER` | `local` \| `s3` \| `cloudinary` | `local` |
| `STORAGE_LOCAL_DIR` | Upload folder when driver is `local` | `uploads` |
| `PUBLIC_BASE_URL` | Base URL used to build public file URLs | `http://localhost:4100` |
| `DEFAULT_CURRENCY` | ISO currency for new stores | `BDT` |
| `TRIAL_DAYS` | Trial length when a plan does not specify one | `14` |
| `BKASH_*`, `NAGAD_*` | Gateway credentials (phase 2) | empty |
| `SEED_*` | Development seed credentials | see below |

The environment is validated with Zod at boot. A missing or too-short secret
produces a clear error and the process exits rather than starting insecurely.

---

## MongoDB setup

**macOS (Homebrew)**

```bash
brew tap mongodb/brew
brew install mongodb-community
brew services start mongodb-community
```

**Docker**

```bash
docker run -d --name pos-mongo -p 27017:27017 -v pos-data:/data/db mongo:7
```

### A note on transactions

Multi-document transactions require a **replica set**. A plain standalone
`mongod` — the usual local install — does not support them.

The application detects this at boot and prints which mode it is in:

```
MongoDB connected (clothing_pos); transactions UNAVAILABLE (standalone) - using compensating writes
```

**Inventory correctness does not depend on transactions.** Stock changes use a
single atomic conditional update (`{ stock: { $gte: qty } }` + `$inc`), and a
failure part-way through a multi-line sale compensates the decrements already
applied. Transactions are an additional layer when available, never the only one.

To enable them locally, run `mongod --replSet rs0` and `rs.initiate()` once.

---

## Development commands

| Command | What it does |
|---|---|
| `npm run dev` | Runs the API and the client together |
| `npm run dev:server` | API only, with hot reload (tsx watch) |
| `npm run dev:client` | Vite dev server only |
| `npm run build` | Type-checks and builds both packages |
| `npm run typecheck` | Type-checks both packages without emitting |
| `npm run seed` | Seeds plans, permissions, a demo tenant and catalogue |
| `npm run seed -- --reset` | **Wipes every collection** and re-seeds from scratch |
| `node scripts/smoke-test.mjs` | 81-check end-to-end verification against a running API |

`npm run seed` is safe to re-run: if the demo tenant already exists it does
nothing and tells you to pass `--reset`.

---

## Seed data and login credentials

`npm run seed` creates a platform admin, a demo tenant (“Denim Republic”) with a
store, 3 roles, 2 staff accounts, 7 categories, 10 clothing products expanded to
75 variants with opening stock, and 4 customers.

> ⚠️ **Development only.** These credentials come from `SEED_*` variables in
> `.env` and must never be used in production.

| Role | Email | Password | Notes |
|---|---|---|---|
| Platform admin | `platform@pos.dev` | `Platform@123` | Manages tenants, plans, subscriptions, payments |
| Tenant admin | `admin@demostore.dev` | `Admin@123` | Full control of the workspace |
| Cashier | `cashier@demostore.dev` | `Cashier@123` | **Cannot** change prices at checkout |
| Senior cashier | `senior@demostore.dev` | `Cashier@123` | **Can** change prices at checkout |

The two cashier accounts exist specifically so the price-override permission can
be tried from both sides.

---

## Architecture

### Repository layout

```
clothing-pos/
├── server/          Express + Mongoose API
├── client/          React + Vite SPA
├── scripts/         smoke-test.mjs
└── .env             single config file for both packages
```

### Backend

`route → validator → controller → service → model`. Controllers do HTTP;
services hold business rules; models hold schema and indexes. No business logic
lives in a route handler.

```
server/src/
├── config/       env.ts (Zod-validated), db.ts, permissions.ts, constants.ts
├── models/       18 Mongoose models + barrel export
├── middleware/   auth · tenant · rbac · subscription · validate · error
├── modules/      auth, stores, categories, products, inventory, customers,
│                 sales, returns, staff, roles, reports, plans,
│                 subscriptions, payments, platform, uploads, common
│                 └─ each: *.routes.ts *.controller.ts *.service.ts *.validators.ts
├── services/
│   ├── inventory/     atomic stock operations + ledger
│   ├── payment/       PaymentProvider interface, providers/, registry
│   ├── storage/       StorageProvider interface, local driver
│   └── subscription/  entitlement + provisioning
├── utils/        ApiError, money, quantity, counters, tx, pagination, tokens
├── jobs/         subscription renewal / expiry
├── seed/         seed.ts, plans.seed.ts, catalog.seed.ts
└── app.ts  server.ts
```

### Frontend

```
client/src/
├── api/          axios client with refresh-token interceptor + endpoint modules
├── components/
│   ├── ui/       shadcn-style primitives (Radix + CVA + Tailwind)
│   ├── QuantityInput.tsx   ← integer-only controlled input
│   ├── MoneyInput.tsx      ← minor-unit controlled input
│   └── DataTable, ConfirmDialog, PermissionGate, SearchInput, states
├── features/     pos/ products/ sales/ receipt/
├── hooks/        useAuth (session + permissions)
├── layouts/      AppLayout (sidebar shell)
├── lib/          money.ts, numeric.ts, utils.ts
├── pages/        one file per screen
├── routes/       AppRoutes, ProtectedRoute
└── types/        api.ts, domain.ts
```

### Data model

```
Tenant ─┬─ Store ─┬─ Category
        │         ├─ Product ── ProductVariant   ← stock/price/SKU live here
        │         ├─ Customer
        │         ├─ Sale ──(embedded)── SaleItem      ← immutable snapshots
        │         ├─ Return ──(embedded)── ReturnItem
        │         ├─ InventoryTransaction              ← append-only ledger
        │         └─ Counter                           ← invoice sequences
        ├─ User ── Role (permissions[])
        ├─ RefreshToken
        └─ Subscription ── SubscriptionEvent ── Payment

SubscriptionPlan   (global; prices live in the DB, never in code)
Permission         (mirror of the in-code catalogue)
```

Key modelling decisions:

- **Every product has at least one variant.** Products without options get a
  `Default` variant, so POS, inventory, sales and returns have one uniform code
  path instead of two.
- **Sale items are embedded snapshots**, not references. They carry
  `productNameSnapshot`, `variantNameSnapshot`, `skuSnapshot`,
  `categoryNameSnapshot`, `unitPriceMinor`, `listPriceMinor` and
  `costPriceMinorSnapshot`. History is physically immutable.
- **Soft delete everywhere** (`deletedAt`). Hard delete is never exposed.
- **Money is an integer count of minor units** (`priceMinor`) in the database,
  the API and the UI. Floating point never touches a monetary value.

See [`docs/DATABASE.md`](docs/DATABASE.md) for every field and index.

---

## Authentication

- **Access token** — JWT, 15 min, sent as `Authorization: Bearer …`.
- **Refresh token** — JWT, 7 days, delivered as an **httpOnly cookie** scoped to
  `/api/auth`, stored server-side as a SHA-256 digest.
- **Rotation with replay detection** — each refresh issues a new token and
  revokes the old one. Presenting an already-revoked token revokes the entire
  family and forces a fresh sign-in.
- **Passwords** — bcrypt, cost from `BCRYPT_ROUNDS`, `select: false` on the
  field so a hash cannot leak through a careless query.
- **Roles are never read from the token.** The token carries an id; role and
  permissions are re-read from the database on every request, so a forged or
  edited payload cannot escalate anything.
- Changing a password or deactivating an account revokes all sessions instantly.

### Permission model

```
effective = (role.permissions ∪ user.extraPermissions) − user.deniedPermissions
```

Tenant admins bypass the check entirely. Denials always beat grants. The
frontend `<PermissionGate>` only decides what is *shown* — every protected
operation is independently enforced by `requirePermission` on the server.

---

## Business rules that are enforced

These are the correctness-critical guarantees, all verified by the smoke test.

### Quantity and price

- Quantities are **whole numbers ≥ 1**. `0.001`, `1.5`, `NaN` and `Infinity` are
  rejected by Zod on the server and are unrepresentable in the UI.
- Prices are **integers in minor units, > 0** at checkout.
- **A cleared input stays cleared.** `QuantityInput` and `MoneyInput` keep a
  string draft and report `null` for empty. There is no `|| 1`, no `|| 0.001`
  and no fallback anywhere — which is exactly how a quantity silently mutates in
  other POS software.
- A cart may hold `0` or an empty field while editing; **checkout is blocked**
  with a specific message per line.

### Inventory

- Stock decrements are a single atomic conditional update:
  `findOneAndUpdate({ _id, tenantId, stock: { $gte: qty } }, { $inc: { stock: -qty } })`.
  Two concurrent sales for the last unit cannot both succeed.
- `stock < requested` → the **whole sale is rejected**; any decrements already
  applied are compensated.
- Stock can never go negative — enforced by the query condition *and* a schema
  `min: 0`.
- Every movement writes an `InventoryTransaction` with previous stock, new
  stock, type, reason, reference and actor.

### Sales

- Totals are **recomputed server-side** from stored variant prices. Client
  totals are ignored entirely.
- A price override is only accepted with `sales.changePrice`; the server compares
  against the catalogue price and rejects unauthorised deviation.
- Invoice numbers come from an atomic per-store counter — no duplicates.
- Customer information is **optional**; a walk-in sale is a first-class case.

### Returns

- A return **must** reference an existing sale. There is no standalone path.
- `returnQty ≤ soldQty − alreadyReturned`, enforced by an atomic conditional
  update on the sale line, so duplicate and excess returns fail even under
  concurrency.
- Refunds always use the **historical** price, never today's price.
- Restocking is per-line, so damaged goods can be refunded without re-shelving.

### Historical integrity

Renaming, re-pricing or deleting a product **cannot** alter a past sale. Sale
items are rendered entirely from their own snapshots and never join to the live
`Product`. Reports group on snapshot values, so a deleted product still appears
correctly in last month's figures.

### Tenant isolation

`tenantId` enters the request only from the authenticated user record — never
from a header, query string or body. A store may be selected with `x-store-id`,
but only from stores that tenant owns; anything else is a 403. Cross-tenant
reads return 404, and cross-tenant writes are rejected.

---

## API structure

Base URL `/api`. Uniform envelopes:

```jsonc
// success
{ "success": true, "data": { … }, "meta": { "page": 1, "limit": 20, "total": 57, "totalPages": 3 } }

// failure
{ "success": false, "error": { "code": "INSUFFICIENT_STOCK", "message": "…", "details": { … } } }
```

| Group | Routes |
|---|---|
| `/api/auth` | register, login, refresh, logout, me, change-password |
| `/api/stores` | list, create, pos-config, current, update |
| `/api/categories` | CRUD (soft delete) |
| `/api/products` | CRUD, `pos-search`, variant sub-routes |
| `/api/inventory` | stock list, summary, ledger, adjust |
| `/api/customers` | CRUD (soft delete) |
| `/api/sales` | create, list, get, `by-number/:n`, receipt, cancel |
| `/api/returns` | create, list, get, `returnable/:saleId` |
| `/api/staff` | CRUD, reset-password |
| `/api/roles` | CRUD, `permissions/catalog` |
| `/api/reports` | dashboard |
| `/api/plans` | public pricing; admin CRUD |
| `/api/subscriptions` | current, history, cancel, reactivate |
| `/api/payments` | providers, checkout, verify, webhook |
| `/api/platform/*` | tenants, customers, subscriptions, payments (platform admin only) |

Full request/response reference: [`docs/API.md`](docs/API.md).

---

## Testing

`scripts/smoke-test.mjs` exercises the real API against a seeded database and
covers the areas most likely to harbour subtle bugs.

```bash
npm run seed -- --reset
npm run dev:server          # in another terminal
node scripts/smoke-test.mjs
```

```
==========  81 passed, 0 failed  ==========
```

What it verifies, by section:

- **Auth & isolation** — sign-in, forged tokens, permission sets per account
- **Quantity/price validation** — `0.001`, `0`, negatives, fractional minor
  units, empty carts
- **Inventory** — overselling rejected, and a failed sale consumes **no** stock
- **Permissions** — price override blocked without the permission, allowed with
  it, and the overridden price is what gets stored
- **Sales** — server-side totals, change, snapshots, stock reduction, ledger
  reference, optional customer, receipt payload
- **Returns** — partial, excess, duplicate, no-such-sale, stock restoration,
  historical pricing, and the running returnable cap
- **Historical integrity** — rename, re-price and delete a product, then assert
  the old sale and the reports are unchanged
- **Reports** — net = gross − returns, multi-year custom ranges, deleted
  products still present
- **Tenant isolation** — tenant B cannot read, borrow a store id from, or sell
  the stock of tenant A

---

## Phase 2 roadmap

The database and service layers are already shaped for these; none requires a
migration.

- Live bKash / Nagad / bank gateways — implement `initiatePayment`,
  `verifyPayment` and `handleWebhook` in the existing provider classes
- Automatic recurring billing (`chargeRecurring` + the renewal job already
  written in `jobs/subscription.job.ts`)
- S3 / Cloudinary storage drivers behind the existing `StorageProvider`
- Multi-branch stores (the schema is already store-scoped throughout)
- Direct ESC/POS thermal printing alongside browser printing
- Purchase orders and supplier management
- Audit log of every administrative action
- Notifications (low stock, expiring subscriptions)
