# Universal POS features — audit, architecture and migration plan

**Audit and plan.** It records what the four verticals do today, what "universal" should mean for each
capability, and the order the work should be done in. Tasks are marked ✅ as they land - **Task 01
(universal QZ Tray printing) is done**; everything else below is still a plan.

Date: 2026-09-24 · Commit audited: `18bc974` (main, with the Clothing work merged in)
Method: reading the code and the models, plus the checks the end-to-end suite already makes.
`npm run typecheck`, `npx eslint .`, `npm run build` and `npm test` (2,884 checks) all pass at this
commit.

---

## 1. The four verticals as they actually are

One server, one client, one database. A workspace (`Tenant`) has exactly one `vertical`, and that
single field decides everything:

```
server: router.use(..., requireVertical('clothing'))     ← per-module gate
client: VerticalPos / VerticalDashboard / VerticalAnalytics  ← per-vertical page
```

| | Clothing | Restaurant | Pharmacy | Super Shop |
|---|---|---|---|---|
| Catalogue model | `Product` + `ProductVariant` (**store-scoped**) | `MenuItem` (**tenant-scoped**) | `Medicine` (tenant) + `MedicineBatch` (store) | `ShopProduct` (tenant) + `ShopStock` (store) |
| Sale model | `Sale` (embedded items + payments) | `RestaurantOrder` (items, tickets, tables) | `PharmacySale` | `ShopSale` |
| Stock lives on | `ProductVariant.stock` | — (no stock) | `MedicineBatch.quantityOnHand` (dated batches) | `ShopStock.quantityOnHand` per branch |
| Stock ledger | `InventoryTransaction` | — | `PharmacyStockMovement` | `ShopStockMovement` |
| Category | `Category` collection, store-scoped, soft-delete | free-text `category` string | free-text `category` string | free-text `category` string |
| Returns | `Return` model: return / partial / exchange / cancel | order `cancel` only | sale `void` only | sale `void` only |
| Customer on a sale | `customerId` + picker + loyalty | `customerId` field, no UI | `customerId` field, no UI | `customerId` field, no UI |
| Module size (server) | ~6,500 lines across 8 modules | 1,830 | 1,304 | 1,137 |

**Already shared by all four:** auth, workspaces/accounts, subscriptions and entitlements, wallet and
billing, roles and permissions, audit log, storage, messaging, **customers** (`/api/customers` has no
vertical gate), platform admin, and the report range helper `resolveRange`.

**Clothing-only modules:** `products`, `categories`, `inventory`, `sales`, `returns`, `reports`,
`productImports`, `exports`, `suppliers`, `loyalty` (via entitlement `verticals: ['clothing']`).

---

## 2. Universal feature matrix

Legend: **mature** = reference implementation · **partial** = works but narrower · **missing** = absent.

| # | Feature | Clothing | Restaurant | Pharmacy | Super Shop | Shared logic today | Vertical difference that must survive | Migration | Risk |
|---|---|---|---|---|---|---|---|---|
| 1 | QZ Tray direct printing | **mature** | **done** (task 01) | **done** (task 01) | **done** (task 01) | `features/printing/*` plus the shared `ReceiptPaper` / `useReceiptPrint` / `ReceiptPrintBar` | receipt *content* per vertical; kitchen tickets are Restaurant-only | ✅ complete | — |
| 2 | Split payment | **mature** (UI + server) | server ✅ / UI single-method | server ✅ / UI single-method | server ✅ / UI single-method | all four services validate `payments[]`, change and cash rules identically | none | Lift `PaymentPanel` + `usePayments` into a shared feature | **Low** |
| 3 | Custom payment methods | **missing** | missing | missing | missing | `PAYMENT_METHODS` is a hard-coded enum in `config/constants.ts`; `Store.paymentMethods` selects a subset | none | New `PaymentMethod` collection + snapshots on every sale model | **High** |
| 4 | Customer selection | **mature** (`CustomerPicker`) | missing UI (field exists) | missing UI (field exists) | missing UI (field exists) | `/api/customers` already shared | Restaurant selects per *order*, not per payment | Reuse the picker in 3 POS pages | **Low** |
| 4b | Loyalty (card, points, scan) | **mature** (membership, EAN-13 card, ledger, earn/redeem, returns/exchange reversal) | missing | missing | missing | `loyaltyService` is model-agnostic except for its sale hooks | earn base differs (order total vs sale subtotal); Pharmacy may exclude prescription items | Generalise the four sale hooks; widen the entitlement's `verticals` | **Medium** |
| 5 | Return / exchange / refund / cancel | **mature** | cancel only | void only | void only | nothing shared | Restaurant has no stock to return; Pharmacy must return to the *batch* it came from; Super Shop returns to `ShopStock` | New shared return engine with per-vertical inventory adapters | **High** |
| 6 | Bulk product import | **mature** (registry, preview, row errors, streamed) | missing | missing | missing | `import.parse.ts` (xlsx/csv, header detection) is already generic | mandatory columns differ per model: Clothing needs Product+Variant+Price; Super Shop barcode+price+qty; Pharmacy name+price(+batch); Restaurant name+price | Extract a column registry per vertical behind one engine | **Medium** |
| 7 | Category management + POS filter | **mature** (`Category` model, page, POS filter) | string field + client-side chip filter | string field, no filter | string field, no filter | none | a real category entity is only worth it where products are managed in bulk | Either promote the string to `Category` per vertical, or keep strings and add a shared filter API | **Medium** |
| 8 | Authorized out-of-stock sale | **mature** (`sales.sellOutOfStock`, ledger flag, negative stock allowed) | n/a (no stock) | **missing** (batch quantity is hard-blocked) | **missing** (`ShopStock.quantityOnHand` has `min: 0`) | the permission exists platform-wide | Pharmacy must never sell *expired* stock, override or not; negative batch quantity is meaningless | Per-vertical override path + ledger flag | **High** |
| 9 | Inventory management + ledger | **mature** (`InventoryTransaction`, before/after, actor, reference) | n/a | partial (`PharmacyStockMovement`) | partial (`ShopStockMovement`) | three parallel ledgers with the same shape | batch/expiry (Pharmacy), weighted-average cost (Super Shop), variants (Clothing) | Unify the *read* API and the movement contract, not the storage | **Medium** |
| 10 | Dashboard date ranges | **mature** (`RangePicker`, presets + custom) | **mature** (same picker) | **missing** (single snapshot, no query) | **missing** (single snapshot, no query) | `resolveRange` is already shared | metric names differ (orders vs sales) | Add the range to 2 endpoints + 2 pages | **Low** |
| 11 | Advanced analytics | **mature** (10 endpoints: sales, profit, breakdown, payments, returns, staff, inventory, customers, branches) | partial (1 `report` endpoint) | partial (1 `report` endpoint) | partial (1 `report` endpoint) | `advancedAnalytics` entitlement gates all four | Restaurant: tables/tickets/shifts; Pharmacy: expiry/prescription; Super Shop: VAT/dead stock | Shared metric contract; keep vertical metrics vertical | **Medium** |
| 12 | PDF / print of dashboard + analytics | **missing** (export module can produce PDF for *datasets*, not for a report view) | missing | missing | missing | `export.formats.ts` already writes CSV/XLSX/JSON/PDF from sections | — | Feed report output through the existing export writers | **Medium** |

### What this says

- **Four of the twelve are nearly free.** Printing, split payment, customer selection and dashboard
  ranges are backend-complete or vertical-neutral already; the work is wiring, not architecture.
- **Three are genuinely new architecture.** Custom payment methods, the return/exchange engine and
  out-of-stock overrides touch money, stock and history in all four verticals at once.
- **The catalogue models are the real constraint.** `MenuItem`, `Medicine` and `ShopProduct` are
  **tenant-scoped**, while Clothing's `Product` is **store-scoped**. Any shared code that assumes
  "product belongs to a branch" is wrong for three verticals, and any shared code that assumes the
  opposite is wrong for Clothing. This is the single most important fact in this document.

---

## 3. Clothing reference implementations — what is actually there

### Printing (`docs/PRINTING_ARCHITECTURE.md`)
`features/printing/`: `qzTray.ts` (single lazy connection, server-signed requests), `raster.ts`
(DOM → 1-bit raster at the printer's exact dot width), `escpos.ts` (`GS v 0` in 24-row bands, 64-NUL
resync after `ESC @`), `thermalPrintService.ts` (app-wide queue), `printerSettings.ts` (per-device
localStorage: mode, printer, language, width, dpi, feed, cutter), `useThermalPrint()`.
`ReceiptDialog` auto-prints once on `autoPrint` when `thermal.direct`, falls back to the browser
otherwise, and printing is output-only — it never calls a sale API, so a retry cannot duplicate a sale.
**None of this is Clothing-specific except the receipt component it rasterises.**

### Split payment (`features/pos/usePayments.ts` + `PaymentPanel`)
Client computes remaining/change for display; the server recomputes everything: methods must be in
`store.paymentMethods`, `paidMinor >= totalMinor`, and `change > 0` only when a cash line covers it.
Change is never revenue. The other three services implement the *same three rules* with the same error
strings — genuine duplication, ready to be shared.

### Loyalty (`docs/` + `modules/loyalty`)
`LoyaltyMembership` (EAN-13 card, one active card per customer, branch-scoped) + append-only
`LoyaltyTransaction` with a unique `dedupeKey`. Only a **scanned card** earns or redeems; a phone
number never does. Points move only through `loyaltyService` (atomic `$inc` + ledger row); sales,
returns, exchanges and cancellations call its hooks. Entitlement `loyalty` → `verticals: ['clothing']`.

### Returns (`modules/returns`)
Sale lookup → line selection with quantity validation against what is still returnable → refund method
(cash/wallet/**exchange**) → inventory restored through `inventoryService` → loyalty reversal → audit.
Exchange creates a *replacement sale* with its own payments (split supported) and reverses the original
lines; the replacement can be any product or variant.

### Out-of-stock (`sales.service.ts:134`)
`ctx.can(PERMISSIONS.SALES_SELL_OUT_OF_STOCK)` — read from the database per request, never from the
body. Stock may go negative only on that path; the sale line and the ledger row are both flagged, and
adjustments still refuse to go below zero.

### Import (`docs/PRODUCT_IMPORT.md`)
Server-side column registry → xlsx/csv parse with header-row detection → per-row validation → preview
→ confirm, creating through the *ordinary* product service. Ids in the file are ignored.

### Analytics (`modules/reports`)
Ten endpoints behind `advancedAnalytics`, all taking `reportRangeSchema` and sharing `resolveRange`.

---

## 4. Architecture proposal

### 4.1 What becomes shared

| Layer | New/extended | Contents |
|---|---|---|
| `server/src/services/pos/` | new | `paymentMethods.service.ts` (resolve + validate a sale's payments for any vertical), `posSale.contract.ts` (the shape every vertical's sale exposes to shared code: totals, payments, customer, lines) |
| `server/src/services/inventory/` | extend | `InventoryAdapter` interface — `reserve`, `release`, `restore`, `describe` — implemented by Clothing (variant), Pharmacy (batch/FEFO), Super Shop (stock row), Restaurant (no-op) |
| `server/src/services/returns/` | new | the return/exchange engine: validation, refund recording, loyalty hooks, audit; it calls an `InventoryAdapter` and a `SaleAdapter` |
| `server/src/modules/imports/` | extend | the existing parser + preview/commit flow, with a **column registry per vertical** |
| `server/src/modules/reports/` | extend | a shared metric contract (`overview`, `trend`, `payments`, `returns`) that each vertical's report service fills |
| `client/src/features/pos/` | extend | `PaymentPanel`, `usePayments`, `CustomerPicker` used by all four POS pages |
| `client/src/features/printing/` | unchanged | already universal — the three other receipt dialogs simply adopt `useThermalPrint` |
| `client/src/features/reports/` | extend | `RangePicker` (exists) + a `ReportDocument` wrapper the PDF/print exporter can serialise |

### 4.2 What stays vertical

Catalogue models and their validators; kitchen tickets, tables and shifts; prescriptions, batches and
expiry; VAT-per-product and weighted-average cost; variants, SKUs and barcodes; every vertical's POS
layout.

### 4.3 The adapter seam (the important bit)

```
shared engine (returns, import, out-of-stock, ledger read)
        │  asks only:  "what is this line? can you take N? put N back"
        ▼
InventoryAdapter ── clothing: ProductVariant.stock (may go negative, flagged)
                 ├─ pharmacy: MedicineBatch, FEFO, never expired, never negative
                 ├─ supershop: ShopStock row, never negative
                 └─ restaurant: no-op (no stock)
```

No shared code should ever import `ProductVariantModel` directly. That is what keeps Clothing's
behaviour intact while the other three get the same *capability* with their own rules.

---

## 5. Dependency order

```
Payment methods (3) ──► Split payment UI (2) ──┐
                                               ├──► Return / exchange / refund (5)
Inventory adapter (9) ─────────────────────────┘
        │
        └──► Out-of-stock override (8)

Customer selection (4) ──► Loyalty (4b) ──► loyalty card scan in POS

Category (7) ──► POS category filter ──► Import (6) [category column]

Dashboard ranges (10) ──► Analytics parity (11) ──► PDF/print of reports (12)

Printing (1) — independent, no dependencies
```

Two things are independent and cheap: **printing** and **dashboard ranges**. Everything expensive sits
behind **payment methods** and the **inventory adapter**.

---

## 6. Atomic task list

Each is independently executable, independently testable, and leaves the tree green.

| Task | Scope | Depends on | Effort | Risk |
|---|---|---|---|---|
| **01** Universal QZ printing ✅ **done** | Shared `ReceiptPaper` + `useReceiptPrint` + `ReceiptPrintBar`; all four verticals print direct, auto-print after a sale; widths 48/57/58/78/80/88; one shared `receiptStore` projection | — | S | Low |
| **02** Shared payment-method service | Move the three-rule validation into one service used by all four sale paths; no behaviour change, tests prove identical outcomes | — | S | Low |
| **03** Custom payment methods | `PaymentMethod` collection (tenant+store, active flag, unique active name), snapshot `{key,label}` on every sale's payment lines, settings UI, reports/receipts read the snapshot | 02 | **L** | High |
| **04** Split payment UI everywhere | `PaymentPanel` + `usePayments` in Restaurant/Pharmacy/Super Shop POS | 02 | S | Low |
| **05** POS customer selection | `CustomerPicker` in the three POS pages; server already accepts `customerId` | — | S | Low |
| **06** Inventory adapter + ledger read API | Extract `InventoryAdapter`; one paginated, filterable ledger endpoint shape for all verticals (storage stays per-vertical) | — | M | Medium |
| **07** Out-of-stock override | Per-vertical override honouring `sales.sellOutOfStock`; Pharmacy still refuses expired; ledger + sale-line flags | 06 | M | High |
| **08** Universal return/exchange/refund | Shared engine + adapters; Restaurant cancel and Pharmacy/Super Shop void become refund-capable returns | 03, 06 | **L** | High |
| **09** Universal loyalty | Generalise the sale hooks; widen the entitlement's verticals; card scan selects the customer in every POS | 05 | M | Medium |
| **10** Category management | Decide per vertical: promote to `Category` (Super Shop, Pharmacy) or keep strings (Restaurant); shared POS filter API | — | M | Medium |
| **11** Universal import | Column registry per vertical behind the existing engine | 10 | M | Medium |
| **12** Dashboard date ranges | Add `reportRangeSchema` to the Pharmacy and Super Shop dashboards; `RangePicker` on both pages | — | S | Low |
| **13** Analytics parity | Shared metric contract; fill the gaps per vertical | 12 | M | Medium |
| **14** PDF/print of reports | Serialise the current report view through `export.formats.ts` (already writes PDF) | 13 | M | Medium |

Recommended sequencing: **01 ✅ → 12 → 05 → 02 → 04 → 06 → 07 → 03 → 08 → 09 → 10 → 11 → 13 → 14.**
That front-loads the visible wins that carry almost no risk, and defers the two schema-wide changes
(payment methods, returns) until the adapter seam exists to absorb them.

---

## 7. Risks

1. **Payment-method enum is load-bearing.** `PaymentMethod` appears in four sale models, `Return`,
   `Payment`, wallet top-ups, receipts, every report's payment breakdown and the smoke suite. Task 03
   must snapshot `{key,label}` on historical rows and keep the six built-ins working unchanged.
2. **Tenant-scoped vs store-scoped catalogues.** Sharing code across them without an adapter will
   silently cross branches. Non-negotiable: shared code takes ids and quantities, never models.
3. **Pharmacy expiry.** An out-of-stock override must never become an "sell expired stock" override.
4. **Loyalty double-award.** The dedupe key is what stops it; generalising the hooks must keep one key
   per (sale, action), not per vertical.
5. **Timezone inconsistency (existing).** `resolveRange` uses the server's local day boundaries;
   Clothing's trend groups in **UTC**; the other three group in the *server's* `Intl` timezone. Three
   different answers to "which day is this sale in". Worth fixing inside task 12/13 — and worth knowing
   that it is already wrong today.
6. **Restaurant has no stock.** Do not invent one to satisfy a shared interface; the no-op adapter is
   the correct implementation.
7. **Print regressions on real hardware.** The Clothing path is proven on the owner's 48mm printer;
   the other verticals' receipts have never been rasterised. Each needs a hardware pass.
8. **Suite shape.** All 2,884 checks live in one 10k-line script; adding four verticals' worth of
   regression tests will need it split by area before it becomes unmanageable.

---

## 8. Testing strategy

Per task, in the existing smoke suite (`scripts/smoke-test.mjs`), with a section per vertical:

- **Money:** split payment across 2–3 methods, change only from cash, overpayment refused on non-cash,
  totals recomputed server-side, idempotency key replay.
- **Stock:** normal sale decrements; blocked sale when short; override only with the permission; ledger
  row per movement with before/after; concurrent sales of the last unit.
- **Returns:** full, partial, exchange cheaper/dearer, refund recorded, stock restored to the right
  place (batch/row/variant), loyalty reversed once.
- **Isolation:** every new endpoint refused across workspaces and across branches; ids from another
  tenant 404.
- **Entitlement:** each feature refused on a plan without it; Starter/Professional/Enterprise matrix.
- **Print:** direct-mode success, failure with retry, no duplicate sale on retry (assert sale count).
- **Reports:** each preset and a custom range return the same totals the sale rows imply.

Before/after regression for Clothing is mandatory on tasks 02, 03, 06, 07, 08 and 09: the same suite
must pass unchanged, and the Clothing sections must not be edited to accommodate new behaviour.

---

## 9. Documentation

- `docs/UNIVERSAL_POS_PLAN.md` (this file) — the audit, the matrix and the task list.
- `CLAUDE.md` — points at this plan and records that Clothing is the reference vertical.
- `docs/PRINTING_ARCHITECTURE.md` §2b — the universal printing architecture delivered by task 01.

Feature docs (`PRINTING_ARCHITECTURE.md`, `PRODUCT_IMPORT.md`, `DATA_EXPORT.md`,
`SUPPLIER_MANAGEMENT.md`, `CONTACT_VERIFICATION.md`, `ENTITLEMENTS.md`) remain accurate for Clothing
and are the reference material for the tasks above.

---

## 10. Recommended next task

**Task 12 — Universal dashboard date ranges.**

Task 01 is done (see `docs/PRINTING_ARCHITECTURE.md` §2b). Task 12 is the other cheap, visible one:
the Pharmacy and Super Shop dashboards take no date range at all today, while their analytics
endpoints already accept one and `resolveRange` is already shared. It is two endpoints and two pages,
with no model or money path involved - and it is the natural moment to settle the timezone
inconsistency in §7, risk 5.

Waiting for an explicit instruction before starting it.
