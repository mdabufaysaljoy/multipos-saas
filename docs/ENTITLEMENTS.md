# Entitlements

What a **subscription** grants. Separate from **permissions**, which are what a *user's role* grants.
A request needs both:

```
authenticated → workspace + branch → usable subscription → entitlement → permission → handler
```

Code never asks "is this the Brand plan?". It asks for an entitlement key, which the engine resolves per
request from the database (`config/entitlements.ts` → `services/entitlements/entitlementEngine.ts`).

## Feature entitlements

| Key | Plan flag | Starter | Professional | Enterprise | Enforced in |
|---|---|---|---|---|---|
| `salesReports` | `salesReports` | ✅ | ✅ | ✅ | dashboard / reports |
| `advancedAnalytics` | `advancedReports` | ❌ | ✅ | ✅ | `reports.routes.ts` |
| `customerManagement` | `customerManagement` | ✅ | ✅ | ✅ | customers |
| `inventoryLedger` | `inventoryLedger` | ✅ | ✅ | ✅ | inventory |
| `multiBranch` | `multiStore` | ❌ | ✅ | ✅ | stores / branch reports |
| `customRoles` | `customRoles` | ❌ | ✅ | ✅ | `roles.routes.ts` |
| `dataExport` | `exportData` | ❌ | ✅ | ✅ | `exports/export.routes.ts` |
| `smsMarketing` / `emailMarketing` / `marketing` | same | ❌ | ✅ | ✅ | `messaging.routes.ts` |
| `imageOptimization` | `imageOptimization` | ❌ | ❌ | ✅ | `uploads.routes.ts` |
| `loyalty` (Clothing) | `loyaltyProgram` | ❌ | ✅ | ✅ | `loyalty.routes.ts`, sales |
| `productImport` (Clothing) | `productImport` | ✅ | ✅ | ✅ | `productImports/import.routes.ts` |
| `supplierManagement` (Clothing) | `supplierManagement` | ❌ | ✅ | ✅ | `suppliers/suppliers.routes.ts` |
| `prioritySupport` | `prioritySupport` | ❌ | ❌ | ✅ | a support commitment, not a code gate |

**Data export and product import are independent.** Export moves data out and is a paid tier feature;
import brings a catalogue in and is part of every plan. Neither flag can turn the other on or off.

## Limit entitlements

`products`, `staff`, `branches`, `customers`, `monthlySales`, `storage`, `suppliers` (Clothing: Starter 0,
Professional 100, Enterprise unlimited) — see `ENTITLEMENT_LIMITS`.
`-1` means unlimited and is reported as `{ limit: null, unlimited: true }`.

## Missing keys in an old snapshot

A subscription freezes its plan in `planSnapshot`, so a subscription sold before a flag existed has no
value for it (`entitlement.service.ts`):

- **a missing limit is treated as unlimited** — a limit nobody agreed to buy must not retroactively lock
  an existing customer out of their own data;
- **a missing feature is treated as off** — a feature nobody paid for must not be given away;
- **except `productImport`, which is treated as ON**, because it is part of every plan and "off" would
  take away something that was never sold separately. A stored `false` is still respected.

Backfill migrations exist so none of this is load-bearing in practice:
`npm run migrate` (or `migrate:loyalty`, `migrate:export-permission`, `migrate:product-import`,
`migrate:suppliers`).

## Adding an entitlement

1. add the flag to `PlanFeatures` + the plan schema + `plans.validators.ts` + `FEATURE_KEYS`;
2. set it in `plans.seed.ts` for each plan;
3. add the key to `ENTITLEMENT_FEATURES` (with `verticals` when POS-specific);
4. enforce it with `requireAccess({ entitlement, permission })` on the routes;
5. add a row to the client's `planCatalog.ts` (the smoke test fails if a plan feature is unadvertised);
6. write an idempotent migration for existing plans, snapshots and roles.
