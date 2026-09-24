# The customer on a sale

*Task 05 of `docs/UNIVERSAL_POS_PLAN.md`.*

Every POS vertical — Clothing, Restaurant, Pharmacy, Super Shop — can attach a customer to a
sale, from the same control, through the same rules. Before this, only Clothing could: the other
three had a `customerId` field on the sale that no screen ever filled in.

Attaching a customer is **always optional**. A walk-in sale has none, and nothing in this path may
block a checkout that did not ask for one.

## 1. The one way in

| Piece | Where | What it owns |
|---|---|---|
| `CustomerPicker` | `client/src/features/customers/CustomerPicker.tsx` | Search by name or phone, or type a new customer; shows who is attached and lets the till detach them. |
| `saleCustomerFields` | same file | Turns the picked customer into the fields a sale endpoint expects. |
| `posCustomerSchema` | `server/src/modules/customers/customers.validators.ts` | The shape a till may send: name, phone, optional email — and nothing else. |
| `customerService.resolveForPosSale` | `server/src/modules/customers/customers.service.ts` | Resolves that into a customer, or none, for every vertical's sale service. |

A sale carries either an id or details, never a name the client made up:

```
customerId: "…"                                  an existing customer, by id
customer:   { name, phone, email? }              found by phone, or created with the sale
(neither)                                        a walk-in
```

`customerId` wins when both are sent. The id is resolved inside the current workspace and branch, so
an id belonging to another tenant is refused rather than attached — the same rule as every other id
the client sends.

### Creating at the till

A customer typed into the picker is **not** created when the cashier presses "Use this customer".
The details travel with the sale, and the server finds them by phone or creates them in the same
step that records the sale. Nothing is created by an abandoned checkout, and a second sale to the
same phone reuses the same customer rather than making a duplicate. Creating one this way needs the
`customers.create` permission; attaching one already on file needs only `customers.view` to find them.

## 2. When a sale counts

Attaching a customer moves their lifetime value — `orderCount`, `totalSpentMinor` and
`lastPurchaseAt` — through `customerService.applySaleStats`, the same counters the Clothing till has
always kept:

| Vertical | Counts when | Reversed when |
|---|---|---|
| Clothing | the sale completes | the sale is cancelled, or goods are returned |
| Super Shop | the sale completes | the sale is voided |
| Pharmacy | the sale completes | the sale is voided |
| Restaurant | the order is **paid** | never — an unpaid order is not revenue, and a cancelled one never becomes any |

## 3. What stays vertical

**Restaurant attaches the customer to the ORDER, not to the payment.** A table is booked in someone's
name long before anyone pays, so the picker sits in the draft order beside "Send order", and the name
shows on the open order afterwards. There is no endpoint to change the customer on an order that is
already open; if the till needs a different one, the order can be cancelled and re-opened.

**Pharmacy keeps the buyer and the patient apart.** The customer is who bought the medicine; the
prescription block names the patient and the prescriber. They are often not the same person, and the
receipt prints both.

**Clothing keeps the fuller snapshot.** A Clothing sale stores `customerSnapshot` (name, phone,
email); the other three store `customerNameSnapshot`, which is what their receipts print. That
difference is left alone — it is what their receipts and reports already read.

**Loyalty stays Clothing-only for now.** Only a scanned membership card earns or redeems points, and
the card picks the customer. Widening that to the other verticals is task 09, which this task unblocks.
