# Restaurant POS — audit before the next change

**Date:** 2026-09-30 · **Commit:** `main` · **Scope:** Restaurant POS only.

> **Status: phases 1-4, 6 and 7 are done** (kitchen management and refunds
> removed, billing moved below the cart, and the menu hierarchy built:
> subsections, variants and add-ons; all 2026-09-30). Phase 5, POS filtering by
> subsection, is the one still outstanding. The rest of this
> document is the audit as written before that work, kept as the record it was
> made from. Two things it had missed, both found during the removal and both
> handled there:
>
> - **Prep-time analytics.** Restaurant reports carried a "Kitchen speed" block
>   computed from `tickets.readyAt`, which only the mark-ready action ever set.
>   It could not survive the screen that fed it, so it went too.
> - **A second refund entry point.** The Orders page had its own "Refund items"
>   action and dialog, not only the Refunds screen.
>
> What actually changed is recorded in §12, §13 and §14 at the end of this
> document.

Read with `docs/ARCHITECTURE.md` (the platform) and `docs/ANALYTICS_PARITY.md`
(the money vocabulary).

---

## 1. Restaurant POS architecture

A restaurant does not sell from a shelf. It **opens an order**, adds to it over
time, tells the kitchen what changed, and settles at the end. That shape drives
everything below.

```
open order ──► add / change / remove lines ──► send to kitchen (ticket) ──► pay ──► paid
     │                    ▲                                                   │
     └── table or takeaway┘                                              cancel│
```

### Files that are Restaurant's alone — safe to change

| Layer | File |
|---|---|
| Models | `models/MenuItem.ts`, `RestaurantOrder.ts`, `DiningTable.ts`, `RestaurantShift.ts` |
| Module | `modules/restaurant/{restaurant.service,controller,routes,validators,restaurantReports.service,shifts.service}.ts` |
| Adapters | `services/inventory/adapters/restaurant.adapter.ts`, `services/returns/adapters/restaurant.saleAdapter.ts` |
| Import | the `restaurantAdapter` block in `services/import/posImport.adapters.ts` |
| Client pages | `pages/restaurant/*` (9 pages) |
| Client features | `features/restaurant/RestaurantPrints.tsx` |
| Client api/types | `api/restaurant.ts`, `types/restaurant.ts` |

### Shared code Restaurant leans on — changing it touches other verticals

| Shared | Also used by | Why it matters here |
|---|---|---|
| `services/catalogue/posCategories.service.ts` | **Super Shop, Pharmacy** | Restaurant's menu sections ARE this service. Subcategories must not be bolted on here. |
| `services/returns/posReturns.service.ts` + figures | Super Shop, Pharmacy | The refund engine behind `/orders/:id/return`. |
| `services/pos/paymentMethods.service.ts` | all four | `settleTender` — the three tender rules. |
| `services/import/posImport.service.ts` | Super Shop, Pharmacy | Two-step menu import. |
| `features/payments/PaymentPanel.tsx`, `usePayments` | all four | The tender UI and its maths. |
| `features/catalogue/CategoryFilter.tsx` | Pharmacy (and Restaurant) | The chip row above the menu. |
| `modules/loyalty/*` | Clothing, Super Shop, Restaurant | A card is scanned when the **bill** is settled. |

### Concurrency and money

- **`rev` is the order's optimistic lock.** Every line change bumps it; paying
  and sending to the kitchen both require the `rev` the cashier saw. An order
  cannot be paid while somebody is editing it.
- **One open order per table**, enforced by a partial unique index on
  `{tableId}` — two waiters cannot seat the same table.
- **Prices are snapshots.** A line copies `nameSnapshot`, `categorySnapshot` and
  `unitPriceMinor` when added; editing the menu never rewrites an order.
- A restaurant **keeps no stock**: `restaurant.adapter` is a no-op inventory
  adapter, and `/stock-ledger` deliberately answers with an empty page.

### Permissions

There are **no restaurant-specific permissions**. Everything reuses
`sales.create`, `sales.view`, `sales.cancel`, `sales.discount`, `products.*`,
`categories.*`, `settings.edit`, `returns.*`, `reports.view`, `inventory.view`.
**There is no `kitchen.*` permission to remove.**

### Tests and CI

`scripts/smoke-test.mjs` — **52 assertions labelled `Restaurant:`** across four
sections: `Restaurant vertical` (3941), `Restaurant refunds` (9808), `Loyalty in
Restaurant` (10131), and the shared `Bulk import` section (11087). There are no
unit tests and no frontend tests. CI runs lint → typecheck → build → test.

**The suite was not run for this audit** (nothing was changed). Get the baseline
with `npm test` before the first edit; do not trust a count written down here.

---

## 2. Kitchen dependency map

This is the part most likely to be got wrong, so it is split explicitly.

### B. MUST REMAIN — the order is sent and a token is produced

| Thing | Where | Why it stays |
|---|---|---|
| `POST /orders/:id/send-to-kitchen` | `routes.ts`, `controller.sendToKitchen`, `service.sendToKitchen:378` | **This is the "Order Sent" action.** |
| Ticket number generation | `service.sendToKitchen:393-396` — `nextSequence(…, 'kitchen-ticket')` → `formatDocumentNumber('KOT-', seq)` | **This IS the token.** `KOT-000001`, per branch. |
| `RestaurantOrderLine.sentQuantity` | `models/RestaurantOrder.ts` | What the kitchen has already been told; a ticket carries only the **change** since the last one. |
| `voidedAt` on a line | same | Keeps a removed line at quantity 0 so the next ticket can say VOID. |
| `tickets[]` with `ticketNumber`, `lines`, `createdAt`, `createdBy` | same | The record of what was sent, and the source of the printed slip. |
| `GET /orders/:id/tickets/:ticketId` → `service.kitchenTicket:469` | routes/controller | Fetches one ticket **to print**. |
| `KitchenTicketSlip` / `KitchenTicketDialog` | `features/restaurant/RestaurantPrints.tsx:128` (`KitchenTicketSlip`), `:386` (`KitchenTicketDialog`) | The printed token slip. |

### A. TO REMOVE — the kitchen as a place staff work

| Thing | Where | Note |
|---|---|---|
| Kitchen screen | `pages/restaurant/KitchenPage.tsx` (123 lines) | Whole file. |
| Route + nav + guard | `routes/AppRoutes.tsx:46,204`, `layouts/AppLayout.tsx:106`, `lib/verticalRoutes.ts:11` | Three one-line edits. |
| Queue endpoint | `GET /kitchen/tickets` → `controller.kitchenQueue` → `service.kitchenQueue:424` | The order queue. |
| Completion endpoint | `POST /orders/:id/tickets/:ticketId/ready` → `controller.markTicketReady` → `service.markTicketReady:454` | The "mark done" workflow. |
| `kitchenQueueSchema` | `restaurant.validators.ts` | Only the queue uses it. |
| Ticket `status: 'ready'`, `readyAt`, `readyByNameSnapshot` | `models/RestaurantOrder.ts` | See the warning below. |
| Queue index | `restaurantOrderSchema.index({ tenantId, storeId, 'tickets.status' })` | Only the queue reads it. |

### ⚠️ Three traps

1. **`KITCHEN_TICKET_STATUSES` is `['pending','ready','void']`.** Dropping the
   enum wholesale would take `void` with it. A ticket's status is also what a
   printed slip uses to call out a void line. **Narrow it, do not delete it.**
2. **Existing orders carry tickets with `status: 'ready'`.** Removing the value
   from the enum makes those documents fail validation on any later save. Either
   keep the value and stop writing it, or migrate. Keeping it is cheaper and
   safer.
3. **`sendToKitchen` is named for the kitchen but is the Order Sent action.** A
   search-and-delete on "kitchen" removes the very thing the brief says to keep.
   If the name is to change, change it deliberately — the client calls
   `restaurantApi.sendToKitchen` and the POS binds it to a button.

---

## 3. Refund dependency map

| Thing | Where | Shared? |
|---|---|---|
| Refunds screen | `pages/restaurant/RestaurantRefundsPage.tsx` (54 lines) | Restaurant only |
| Route + nav + guard | `routes/AppRoutes.tsx:66,334`, `layouts/AppLayout.tsx:107`, `lib/verticalRoutes.ts:11` | Restaurant only |
| `POST /orders/:id/return` | `controller.createOrderReturn` | Restaurant route |
| `GET /returns` | `controller.listOrderReturns` | Restaurant route |
| `createOrderReturnSchema` | `restaurant.validators.ts` | Restaurant only |
| `restaurant.saleAdapter.ts` | `services/returns/adapters/` | Restaurant's own adapter… |
| **`posReturns.service.ts`** | the engine | **SHARED with Super Shop and Pharmacy** |
| `RestaurantOrder.returnedTotalMinor`, `fullyReturned`, line `returnedQuantity` | model | Restaurant only |
| Refund figures in reports | `restaurantReports.service.ts` via `returnFiguresFor` | Shared helper |
| 20 assertions | `smoke-test.mjs` §`Restaurant refunds` (9808) | — |

**The engine must not be touched.** Removing Restaurant's refunds means removing
its two routes, its adapter, its page and its nav — and then deciding what the
reports say. `restaurantReports` currently subtracts refunds to get net sales; if
refunds can no longer happen the arithmetic still works (it subtracts zero), so
the safest first cut leaves the reporting alone.

**Open question for the owner:** orders already refunded carry
`returnedTotalMinor > 0`. Do their past reports keep showing that, or is the
history rewritten? Leaving it is the honest default.

---

## 4. Payment / billing flow map

```
POS page
 ├─ table or takeaway ──► POST /orders                    (opens an order)
 ├─ tap a dish        ──► POST /orders/:id/items          (adds a line, bumps rev)
 ├─ +/- / remove      ──► PATCH|DELETE …/items/:lineId    (bumps rev)
 ├─ "Send"            ──► POST …/send-to-kitchen          (TOKEN, bumps rev)
 └─ "Pay"             ──► opens <PayDialog>  ◄── the modal in question
                            ├─ discount          (sales.discount)
                            ├─ loyalty card      (scanned at the BILL)
                            ├─ <PaymentPanel>    (shared; split tenders)
                            └─ POST /orders/:id/pay { rev, payments, … }
```

### Why it is a modal

`PayDialog` (`RestaurantPosPage.tsx:504`) is a **self-contained component**: it
owns discount, loyalty member, redeem points and `usePayments(total)` state, and
resets that state on open. It was written as a modal because a restaurant only
settles once, at the end — unlike a shop till where payment is always on screen.

### Moving it below the cart

The logic does not need to change. What changes is the wrapper and the state
lifetime:

- Today the state resets on each open. Inline, it must reset when the **order**
  changes (order id, or after payment) — otherwise a discount typed for table 4
  follows you to table 7. This is the single biggest regression risk.
- The POS is a three-column layout (tables / menu / order). The order column
  becomes header + scrolling lines + **pinned billing panel** + action bar.
  Super Shop's till is now exactly this shape and is the closest reference:
  `SupershopPosPage.tsx` — four layers, one scrolling middle, payment pinned.
- `PaymentPanel` already takes an optional `compact` prop (added for Super Shop,
  defaulted off) — **no shared change needed.**
- Mobile needs the same bottom-sheet treatment Super Shop and Clothing already
  have, or the billing panel will squeeze the order lines off a phone.

---

## 5. Product / category architecture as it stands

**`MenuItem` is flat.** This is the headline finding.

```ts
MenuItem {
  tenantId, name,
  category: string,       // a NAME, not an id — "Pizza"
  description, priceMinor, // ONE price
  isAvailable, sortOrder, deletedAt
}
```

| Concept the brief wants | Exists today? |
|---|---|
| Category | **Yes** — as a name on the item, managed by the shared `PosCategory` list |
| Subcategory | **No** |
| Product | Yes — `MenuItem` is the product |
| Variants / sizes | **No** |
| Add-ons / extras | **No** |
| Option groups | **No** |
| Per-variant pricing | **No** — one `priceMinor` |
| Product attributes | **No** |

**Nothing needs to be un-built, but almost everything needs building.** There is
no duplicate concept to avoid — the risk is the opposite one.

### What the order line can already carry

`RestaurantOrderLine` has `menuItemId`, `nameSnapshot`, `categorySnapshot`,
`unitPriceMinor`, `quantity`, `note`, `lineTotalMinor`. A variant and its add-ons
would need **new snapshot fields**, because an order must keep saying what was
actually sold years later.

### Where category lives, and the trap

`/restaurant/categories` is the **shared** `posCategoryService`, the same
collection Super Shop and Pharmacy use, keyed `(tenantId, vertical, slug)`. It is
a flat list of names by design.

**Do not add a `parent` to `PosCategory`.** Three verticals depend on it, its
rename cascade rewrites items by name, and a hierarchy there is a migration plus
a behaviour change for two POS types that did not ask for one.

---

## 6. Existing variant / modifier architecture elsewhere

Worth knowing before inventing something:

| Vertical | Variants | Relevance |
|---|---|---|
| **Clothing** | `ProductVariant` — a real collection, per-branch stock, SKU, its own price and cost | The closest existing model, but it is **stock-bearing and store-scoped**. A restaurant keeps no stock, so most of it is dead weight. |
| **Super Shop** | None — one price per product, `unitType` each/weight | Not a fit |
| **Pharmacy** | Batches (expiry, cost), not variants | Not a fit |

**Nothing in the codebase models add-ons or option groups.** That is genuinely new.

---

## 7. Recommended data model

Shaped to the examples in the brief, and to what a restaurant order has to
remember.

```
PosCategory (shared, unchanged)     "Pizza", "Burger", "Biryani"
        │
        ▼
MenuSubcategory (NEW, restaurant)   "Mexican Hot Pizza", "Burger Set"
        │   { tenantId, categoryName, name, slug, sortOrder, isActive, deletedAt }
        ▼
MenuItem (EXTENDED)                 + subcategory: string   (a name, like `category`)
        │
        ├── variants: [ { _id, name: "8 inch", priceMinor, sortOrder, isAvailable } ]
        │      one is `isDefault`; `priceMinor` on the item stays as the fallback
        │      for an item with no variants, so every existing dish keeps working
        │
        └── addOnGroups: [ {
               _id, name: "Extras", minSelect, maxSelect, required,
               options: [ { _id, name: "Extra cheese", priceMinor } ]
            } ]
```

**Embedded, not separate collections.** A menu is small, always read whole, and
never queried by variant — and embedding keeps the whole dish in one document,
which is how the POS already loads it.

The order line grows snapshots:

```ts
RestaurantOrderLine {
  …existing,
  subcategorySnapshot: string,
  variantId, variantNameSnapshot, variantPriceMinor,        // null for a plain dish
  addOns: [ { optionId, nameSnapshot, priceMinor } ],
  // unitPriceMinor stays THE price charged: variant price + add-ons.
  // Nothing downstream has to learn new arithmetic.
}
```

**Why `unitPriceMinor` keeps its meaning:** reports, the bill, the kitchen slip,
refund maths and `settleTender` all read it. Making it the fully-loaded price is
the one decision that stops this change rippling.

**Backwards compatibility:** every new field is optional. An existing dish has no
variants and no subcategory, and sells exactly as it does today. **No migration
is required** — the same trick `PosCategory` uses.

---

## 8. Recommended implementation phases

Ordered by dependency, not by the brief's numbering.

| Phase | Work | Why here |
|---|---|---|
| **1** ✅ | Remove Kitchen management (keep send + token) | Self-contained; shrinks the surface everything else touches |
| **2** ✅ | Remove Refunds | Self-contained; also shrinks it |
| **3** ✅ | Billing below the cart | Pure UI; no model change; unblocks judging the POS layout before it grows |
| **4** ✅ | Subcategory (model + menu screen) | The hierarchy's first half |
| **5** | POS filtering by category **and** subcategory | Needs phase 4 — **still outstanding** |
| **6** ✅ | Variants (model, menu screen, order line snapshots, pricing) | The heaviest; needs phase 4's screens |
| **7** ✅ | Add-ons / option groups | Needs phase 6's picker |

**Phases 1–3 are safe and independent. Phase 6 is where the money is** — it
changes what an order line means, and every report, bill and refund reads that.

---

## 9. Files likely to change

| Phase | Files |
|---|---|
| 1 | `pages/restaurant/KitchenPage.tsx` (delete) · `routes/AppRoutes.tsx` · `layouts/AppLayout.tsx` · `lib/verticalRoutes.ts` · `restaurant.routes.ts` · `restaurant.controller.ts` · `restaurant.service.ts` · `restaurant.validators.ts` · `models/RestaurantOrder.ts` (index + enum) · `smoke-test.mjs` |
| 2 | `pages/restaurant/RestaurantRefundsPage.tsx` (delete) · the same three routing files · `restaurant.routes.ts` · `restaurant.controller.ts` · `restaurant.validators.ts` · `adapters/restaurant.saleAdapter.ts` · `smoke-test.mjs` |
| 3 | `RestaurantPosPage.tsx` only |
| 4 | `models/MenuItem.ts` · new `models/MenuSubcategory.ts` · new service/routes · `MenuPage.tsx` · `MenuCategoriesPage.tsx` · `posImport.adapters.ts` (restaurant block) · `api/restaurant.ts` · `types/restaurant.ts` |
| 5 | `RestaurantPosPage.tsx` · `restaurant.validators.ts` · `restaurant.service.ts` (`listMenu`) |
| 6–7 | `models/MenuItem.ts` · `models/RestaurantOrder.ts` · `restaurant.service.ts` (`addItems`, pricing) · `restaurant.validators.ts` · `MenuPage.tsx` · `RestaurantPosPage.tsx` · `RestaurantPrints.tsx` (bill + slip) |

---

## 10. Risks and regression concerns

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Deleting token generation with the kitchen.** `sendToKitchen` is named for the thing being removed. | Treat §2B as a keep-list; assert `KOT-` numbering survives. |
| R2 | **Enum narrowing breaks existing orders.** Old tickets hold `status: 'ready'`. | Keep the value, stop writing it. |
| R3 | **Inline billing leaks state between orders.** `PayDialog` resets on open; inline it has no "open". | Key the panel on order id; reset on order change and after payment. |
| R4 | **Touching `PosCategory` for subcategories.** Shared with two other verticals. | Restaurant-only `MenuSubcategory`. |
| R5 | **Changing what `unitPriceMinor` means.** Read by reports, bills, refunds, tenders. | Keep it the fully-loaded price charged. |
| R6 | **Menu capped at 100.** The POS loads `limit: 100` once and filters client-side; `MAX_PAGE_SIZE` is 100, so a bigger menu silently loses dishes — the same defect Super Shop's till had. | Fix in phase 5 with the filtering work. |
| R7 | **`rev` conflicts multiply.** Variants and add-ons mean more line edits. | Keep every mutation going through the existing `rev` guard. |
| R8 | **Menu import.** The restaurant importer writes name/price/category/sortOrder/available. | Additive columns only; a sheet without them must still import. |
| R9 | **Refund removal vs. history.** Past orders carry refund figures. | Leave reporting arithmetic alone; it subtracts zero. |
| R10 | **Loyalty at the bill.** Earning is on the settled bill. | Phase 3 must not change when the card is scanned. |

---

## 11. Test strategy

The suite is the gate: one HTTP script over real HTTP, no unit or frontend
tests. So:

1. **Establish the baseline** — run `npm test` and record the number *before*
   touching anything. Every phase below is judged against that number, not
   against a figure quoted in this document.
2. **Phase 1** — assert the keep-list explicitly *before* deleting: an order can
   be sent, a `KOT-` number is produced, a second send carries only the change,
   a voided line still appears, and the ticket still prints. Then assert the
   queue and ready endpoints are gone (404). Existing kitchen assertions in
   §`Restaurant vertical` will need rewriting, not deleting — **read them first
   to see which are testing the token and which the queue.**
3. **Phase 2** — the 20 refund assertions go; add a 404 for both routes, and
   assert **Super Shop and Pharmacy returns still pass untouched** (that is the
   proof the shared engine was not disturbed).
4. **Phase 3** — no server change, so no new assertions. Needs a browser pass
   instead: a discount typed on one order must not appear on the next.
5. **Phases 4–7** — for each: the model accepts the new shape *and* still
   accepts a dish without it; pricing is the variant's, not the item's; add-ons
   add; the order line snapshots survive a menu edit; the bill and the token
   slip both show what was actually ordered; filtering by category and
   subcategory, alone and together; and cross-workspace isolation on every new
   route.
6. **Every phase**: `TZ=UTC npm test` as well as local — the CI failure recorded
   in `AUDIT-2026-09-25.md` was a timezone-dependent boundary that only appeared
   in UTC.

**A browser pass is outstanding for the whole POS.** Several rounds of Super
Shop UI work in this repository have shipped unverified visually, for the same
reason each time — signing in needs the owner's password. Phase 3 is a layout
change and should not be the next one to ship unseen.

---

## 12. What phases 1 and 2 actually removed — 2026-09-30

### Removed

| Kitchen management | Refunds |
|---|---|
| `pages/restaurant/KitchenPage.tsx` | `pages/restaurant/RestaurantRefundsPage.tsx` |
| its route, nav entry and vertical guard | its route, nav entry and vertical guard |
| `GET /restaurant/kitchen/tickets` (+ `kitchenQueue`, `kitchenQueueSchema`) | `POST /restaurant/orders/:id/return` (+ `createOrderReturn`, `createOrderReturnSchema`) |
| `POST /orders/:id/tickets/:ticketId/ready` (+ `markTicketReady`) | `GET /restaurant/returns` (+ `listOrderReturns`) |
| the `{tenantId, storeId, 'tickets.status'}` index | `services/returns/adapters/restaurant.saleAdapter.ts` |
| the "Kitchen speed" analytics, server and client | the "Refund items" action on the Orders page |

### Kept, deliberately

- **`POST /orders/:id/send-to-kitchen`.** This is the Order Sent action, and the
  only place a token is generated: `nextSequence(…, 'kitchen-ticket')` →
  `KOT-000001`, per branch. Its name still says "kitchen" because renaming a
  live endpoint is a separate, breaking change and was not asked for.
- `sentQuantity`, `voidedAt`, and change-only follow-up tickets.
- `GET /orders/:id/tickets/:ticketId` and the printed slip — reprinting a token.
- **The `'ready'` status, `readyAt` and `readyByNameSnapshot`.** Nothing writes
  them any more. They stay because orders already in the database hold tickets
  in that state, and removing the enum value would make those documents fail
  validation on their next save. The Kitchen tickets export keeps its columns
  for the same reason.
- **Refund figures in Restaurant reporting.** They subtract zero for any new
  period, and keep the history honest for orders refunded before this change.
  The "Refunded so far" line on an order still appears for those orders.

### Not touched

`posReturns.service` and the rest of the shared return engine (Clothing, Super
Shop and Pharmacy still use it — their return tests passing is the proof), the
`returns.*` permissions (shared with three other verticals), and every Clothing,
Super Shop and Pharmacy file.

There was never a `kitchen.*` permission: the screens reused `sales.view` /
`sales.create`, so nothing had to be removed from the permission catalogue.

### Verified

`npm run lint` ✅ · `npm run typecheck` ✅ · `npm run build` ✅ ·
`npm test` ✅ **3578 passed, 0 failed**.

The kitchen tests were rewritten rather than deleted: they now prove the token
survives (KOT numbering, change-only follow-up tickets, a void as a negative
line, reprinting) and that the queue and mark-ready routes answer 404. The
cross-vertical isolation the dead queue route used to prove was moved onto the
routes that remain.

**Not verified in a browser.** No Restaurant screen was opened; signing in needs
the owner's password. The nav entries, the two deleted pages and the Orders
dialog are covered by the build and typecheck only.

---

## 13. Phase 3: billing below the cart — 2026-09-30

`PayDialog` is gone. Everything it did now lives in a `BillingPanel` pinned
under the cart in the order column, on show for the whole life of an open order.

### The shape

```
Card ── header            pinned   order number · table
     ├─ cart              SCROLLS  the only scrolling thing in the column
     ├─ billing           pinned   customer · discount · loyalty · tenders · due/change
     └─ action bar        pinned   cancel · print bill · Complete sale
```

The cart is capped at `38vh` on a phone, where the card has no column height to
fill, so the billing section is never pushed below the fold by a long order. On
`lg` and up the cap lifts and the cart simply takes what is left. The order
column went from `22rem` to `24rem` to fit the tenders.

### The state trap the audit called out (R3), and how it is closed

The modal reset itself every time it opened. An inline panel has no "open", so a
discount typed for table 4 could follow the cashier to table 7. The panel is
keyed on the order id, so React remounts it whenever the order changes — the
reset is structural rather than an effect somebody has to remember.

Untouched cash still follows what is due, so adding a dish mid-payment just
moves the figure rather than wiping what has been typed.

### Two defects found by looking at it

Neither would have shown up in the test suite.

1. **The discount field was outlined in red on every order.** `MoneyInput` marks
   an empty or zero amount invalid, which is right for a payment row and wrong
   for a discount nobody is giving. In a modal it flashed by; pinned on screen it
   is permanent. `MoneyInput` gained an `optional` prop, **defaulted off**, so
   the `isInvalid` expression for every existing caller is unchanged. Only this
   panel passes it.
2. **A fast double-click sent a second payment.** The button disables on
   `loading`, but three clicks in one tick beat the re-render. The server refused
   the extras on the revision check — no double charge — but the cashier saw
   "Payment failed" on a sale that had gone through. A ref guard now drops a
   click while one is in flight. Proved in the server log: before, 3 clicks gave
   `200, 409, 409`; after, 3 clicks give one `200`.

### Verified in a browser

A throwaway Restaurant workspace on `localhost` (menu, tables, trial plan), then
the whole flow driven by hand at 1440×900 and at phone width:

| | |
|---|---|
| Customer selection | new customer attached, shown on the bill |
| Order sent | `KOT-000001` generated, slip offered |
| Normal / exact payment | cash pre-filled to what is due, `Change ৳0.00` |
| Discount | ৳100 off ৳800 → `To pay ৳700.00`; server stored `discountMinor 10000` |
| Overpayment | cash ৳1000 → `Change ৳300.00` |
| Insufficient | `Remaining due ৳300.00`, Complete sale disabled |
| Split | cash ৳500 + bKash ৳200 = ৳700; server stored both rows |
| Validation | discount above the order → message, `To pay ৳0.00`, button disabled |
| Completion | both orders `paid` with the right money |
| Repeat submission | 3 clicks → 1 request |
| Phone (375px) | stacks, page scrolls, no horizontal scroll, Complete sale reachable |

`npm run lint` ✅ · `npm run typecheck` ✅ · `npm run build` ✅ ·
`npm test` ✅ **3578 passed, 0 failed** (no server change, so the count is the
same as phase 2).

---

## 14. Phases 4, 6 and 7: the menu hierarchy — 2026-09-30

Section → subsection → dish → size, with extras hanging off the dish. Built
close to what §7 recommended; where it differs, the difference is noted.

### The two kinds of option, kept apart on purpose

This is the distinction the whole model turns on:

| | Variant | Add-on |
|---|---|---|
| Answers | **which version?** | **what extra?** |
| How many | exactly one | several, within the group's limits |
| Price | **replaces** the dish's own | **adds** to the line |
| Lives on | `MenuItem.variants[]` | `MenuItem.addOnGroups[].options[]` |
| On the line | `variantId`, `variantNameSnapshot` | `addOns[]`, each with its own price |

They are separate arrays, separate validators and separate editors, so a
kitchen cannot model "Large" as an extra and end up with two sizes on one line.

### What was added

```
PosCategory (shared, untouched)   Pizza · Burger · Biryani
        │
        ▼
MenuSubcategory (NEW, restaurant) Italian · Mexican · Naga Hot
        │   { tenantId, categoryName, categorySlug, name, slug, isActive, sortOrder }
        ▼
MenuItem (EXTENDED)               + subcategory (a NAME, like category)
        ├── variants[]            { name, priceMinor, sku, isAvailable, sortOrder }
        └── addOnGroups[]         { name, minSelect, maxSelect, options[] }
```

`RestaurantOrderLine` gained `subcategorySnapshot`, `variantId`,
`variantNameSnapshot` and `addOns[]`. **`unitPriceMinor` keeps its meaning** —
the fully-loaded price of one — so reports, bills, refund maths and the tender
rules all read the number they always read (audit R5).

**`PosCategory` was not given a parent** (audit R4). It is shared with Super
Shop and Pharmacy, flat by design, and a hierarchy there would have changed two
verticals that never asked for one. `MenuSubcategory` is Restaurant's own and
deliberately mirrors the shared service's behaviour one level down: the name is
the link, an unknown name joins the list when a dish uses it, renaming rewrites
the dishes that carry it and never a past order, and a name in use can only be
hidden. It differs in the one way that matters — a subsection belongs to exactly
one section, so two sections may each have a "Hot".

**No migration.** Every new field is optional and defaults to empty. An existing
dish has no subsection and no variants, and sells exactly as it did.

### The rules, and where they live

All of them are on the server, because only the server can see the menu:

- a dish **with** variants must be ordered as one of them — otherwise a till
  could quietly fall back to the base price and charge 450 for an 850 pizza;
- a dish **without** variants must not be given one;
- a variant or add-on must belong to **that** dish;
- each add-on group must get between its own `minSelect` and `maxSelect`;
- the same extra cannot be taken twice;
- within a dish, no two sizes share a name or a code, and no two groups or
  extras share a name;
- a subsection must belong to the section the dish is in, and a hidden one
  takes no new dishes.

The POS picker enforces the same rules before it will offer the line, so a till
never sends something the server will refuse — but the server is what decides.

### Permissions, isolation, and one thing that is NOT branch-scoped

Subsections reuse `categories.view/create/edit/delete`; dishes reuse
`products.*`. No new permission was added. A Cashier can read subsections (they
need them to take an order) and can create neither.

**The menu is workspace-wide, not per branch** — that is the existing Restaurant
design, unchanged here: every branch of a restaurant serves the same menu. So
isolation is cross-workspace, and that is what the tests assert.

### Files

New: `models/MenuSubcategory.ts` · `modules/restaurant/menuSubcategories.service.ts` ·
`features/restaurant/MenuOptionsEditor.tsx` · `features/restaurant/SubcategoryInput.tsx` ·
`features/restaurant/MenuItemPicker.tsx` · `pages/restaurant/MenuSubcategoriesPage.tsx`

Changed: `models/MenuItem.ts` · `models/RestaurantOrder.ts` ·
`restaurant.{service,controller,routes,validators}.ts` · `MenuPage.tsx` ·
`RestaurantPosPage.tsx` · `RestaurantPrints.tsx` · `api/restaurant.ts` ·
`types/restaurant.ts` · routing and nav · `smoke-test.mjs`

### Verified

`npm run lint` ✅ · `npm run typecheck` ✅ · `npm run build` ✅ ·
`npm test` ✅ **3630 passed, 0 failed** (52 new, in a `Restaurant menu
hierarchy` section whose fixtures are retired at the end so later counts are
untouched).

Then in a browser, against a throwaway Restaurant workspace on `localhost`
seeded with the brief's own examples:

- the subsections screen, grouped by section, with dish counts — Pizza →
  Italian / Mexican / Naga Hot;
- the dish editor showing Section, Subsection, Base price, three sizes with
  their prices and codes, and an Extras group with min/max;
- the till asking for a size and extras, previewing 10 inch (৳650) + Extra
  cheese (৳80) = **৳730**, and the server storing exactly that;
- **the kitchen slip reading `1 × Mexican Hot Pizza (10 inch, Extra cheese)`** —
  a slip that said only "Pizza" would have the kitchen making the wrong thing.

One layout bug was found and fixed by looking: `DialogFooter` reverses its
children on a narrow screen, which put the picker's price *below* its buttons.

### Not in this phase

- **POS filtering by subsection** (phase 5). The server already accepts a
  `subcategory` filter and it is tested; the till's chip row still filters by
  section only.
- **Bulk import** does not carry a subsection or variant column, so an imported
  menu is still flat. Additive columns, when that is wanted.
- The **100-item POS menu cap** (audit R6) is still there.
