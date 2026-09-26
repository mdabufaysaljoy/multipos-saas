# Architecture

A working map of the platform, written for someone joining the project. It
describes what is there now, not what is planned. The living change log is the
root `IMPLIMENTATION_STATUS.md`; the universal-POS programme is
`docs/UNIVERSAL_POS_PLAN.md`.

## Shape

npm workspaces monorepo, TypeScript throughout (~92k lines).

```
server/   Express 4 + Mongoose 8 REST API
client/   React 18 + Vite + TanStack Query + Tailwind + shadcn/ui
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

## Concurrency

The deployment target is standalone MongoDB — **no multi-document
transactions**. Correctness comes from ordering and compare-and-swap instead:

- stock is taken with a single guarded `$inc` (`quantityOnHand: { $gte: n }`),
  so two tills cannot sell the same unit;
- returns *hold* a quantity on the sale line before touching stock, and release
  it on failure;
- billing claims work with a CAS and a period-scoped idempotency key.

## Testing & CI

`npm test` boots a throwaway API on its own port against a derived `*_test`
database, runs `scripts/smoke-test.mjs` (**3231 assertions**, all over HTTP,
including cross-tenant IDOR, auth bypass and payload abuse), then drops the
database. `.github/workflows/ci.yml` runs lint → typecheck → build → test on
Node 22 with a `mongo:7` service.

There are no unit tests and no frontend tests; pure-logic modules
(`shopUnits.ts`, `loyalty.math.ts`, `paymentMath.ts`) are only covered
indirectly through HTTP.
