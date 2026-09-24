# How a POS sale is paid for

*Task 02 of `docs/UNIVERSAL_POS_PLAN.md`.*

Every till in the platform settles money by the same three rules, and they now live in one place:
`server/src/services/pos/paymentMethods.service.ts`. Before this they were written out four times —
once per vertical — which is not a problem until one of them is changed.

## 1. The three rules

| Rule | What it says | Why |
|---|---|---|
| 1. Enabled for the branch | Every method that takes money must be in the branch's `paymentMethods` | The enabled list is the branch's, not the client's. A branch that turned card off cannot be made to accept one by a till that asks. |
| 2. The money covers the sale | `paid ≥ total` | A sale is never completed for less than it costs. The POS blocks it too, but this is what enforces it. |
| 3. Only cash may exceed the total | `change ≤ the cash part of the tender` | Change comes out of the drawer. An over-tendered card is a mistake, not change: refunding it needs the provider, which no till can do. |

```ts
settleTender({ totalMinor, tendered, accepted, dialect })   // all three, for a till that settles in one step
assertMethodsEnabled(accepted, methods, dialect)            // rule 1 on its own
assertCovered(totalMinor, paidMinor, dialect)               // rule 2 on its own
assertChangeIsCash(changeMinor, cashMinor, dialect)         // rule 3 on its own
```

Super Shop, Pharmacy and Restaurant settle in one step, so they call `settleTender`. Clothing's
checkout has more to weigh first — exchange credit, loyalty points covering the whole sale, and cash
handed over separately from what is applied — so it calls the individual rules from inside that
arithmetic. The membership-fee path in `loyaltyService` takes money at the till too, and obeys rule 1
through the same function; it may not exceed the fee, so it does not settle through `settleTender`.

**What a caller gets back is what the sale took** — `paidMinor`, `changeMinor`, `cashMinor`. Those
numbers are stored as returned. No vertical recomputes them, and none of them ever comes from the
client.

## 2. Where the four still differ

This was a refactor: no behaviour changed. Two differences were found while doing it, and both are
now pinned by tests rather than left to be discovered.

**The answer to a refusal.** Clothing answers `422` for a tender that does not add up; the three
newer verticals answer `400`. All four answer `400` for a method the branch has turned off. Both
dialects live side by side in `TenderDialect`, so the difference is visible in one file instead of
spread across four services.

**An over-tendered card.** The three newer verticals refuse it (rule 3). Clothing accepts it and
always has: its till sends the cash handed over separately as `cashTenderedMinor`, and *that* path
already refuses change that did not come from cash — but the plain `payments` path does not check.
So a Clothing sale paid ৳1,050 by card on a ৳1,000 total records ৳50 of change that no drawer gave.

Neither was changed here, because a refactor that quietly changes an API contract is not a refactor.
Task 03 (custom payment methods) rewrites this surface anyway, and is where they should converge.

A third, smaller difference: a Clothing payment row carries a `reference` (a bKash transaction id,
say) and the other three do not. Task 03 again.

## 3. The till, in every vertical

Task 04 put the same payment UI in all four POS pages: `client/src/features/payments/` holds
`usePayments` (the state), `paymentMath` (the arithmetic) and `PaymentPanel` (the control). Before
that, only the Clothing till could split a payment; the other three offered one method and one
"amount received" box.

**Cash is what the customer hands over.** The panel works out how much of it settles the sale and how
much is change, live, and refuses to complete until the sale is covered. An untouched cash row
follows what is still due, so an exact-cash sale needs no typing at all. Adding a second method
lowers the cash due rather than overwriting what the cashier typed.

**The methods offered are the branch's.** All four tills read `paymentMethods` from
`/stores/pos-config`, so a branch that has turned card off no longer shows Card at the till. The
three newer tills used to show a hard-coded list of six and only find out at the server.

**Two shapes, one maths.** Clothing posts `payments` (what was *applied*, adding up to the total)
plus `cashTenderedMinor`. The other three have no such field: their rows are what was *tendered*, so
`tenderedRows()` puts the cash handed over in the cash row and the server derives the change. Same
numbers either way - a ৳45 sale paid with ৳30 cash and ৳20 bKash records ৳50 paid and ৳5 change in
both.

## 4. Tenders a workspace defines itself

*Task 03.* The six built-ins — cash, bKash, Nagad, bank, card, other — exist for **every** workspace,
always. They are not rows in a collection, nothing was seeded or migrated for them, and a sale from
last year that says `cash` still means cash. Anything else a shop takes it defines itself:

```
GET    /api/payment-methods        every till may read it
POST   /api/payment-methods        settings.edit
PATCH  /api/payment-methods/:id    settings.edit
DELETE /api/payment-methods/:id    settings.edit
```

A method has a **key** and a **label**. The key (`meal-voucher`, derived from the label) is what every
payment line stores and never changes. The label is what the till and the receipt show, and it can be
changed freely — because **every sale keeps the label it was taken under**, in `methodLabel` on the
payment row (and `refundMethodLabel` on a return). Rename "Meal Voucher" to "Lunch Voucher" and last
month's receipt still says Meal Voucher, which is what actually happened.

Methods are **workspace-wide**; which branch offers which is still the branch's own `paymentMethods`
list, exactly as before. A branch cannot enable a key the workspace has not defined, and switching a
method off removes it from every branch in the same step. Built-in keys are reserved: a workspace
cannot define its own "cash".

**What changed for clients.** A payment method key is no longer a fixed enum, so a key the workspace
has never defined is refused by the branch's enabled list (**400**, "This branch does not accept X
payments") rather than by schema validation (422). A *malformed* key — wrong characters, too long —
is still 422. The platform's own payment methods (wallet top-ups, subscription purchases) are a
different thing entirely and were not touched.

**Reports** still group by the key, which is what makes history comparable; each row now also carries
`methodLabel`, resolved to what the workspace calls that key today, falling back to the key itself so
a method deleted years later still prints as something.

## 5. Tests

`scripts/smoke-test.mjs`, section **"POS tender rules (all verticals)"**, runs the same four tenders
— a disabled method, a short payment, an exact payment, a two-method split, cash over the total, and
a card over the total — through all four verticals and checks they are answered the same way. That
section is what makes "the rules are the same" a fact rather than a claim, and it is where the two
differences above are written down.
