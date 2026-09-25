# Loyalty beyond Clothing

Universal POS task 09: the card program that Clothing has always had now runs in all four POS
types. Part 1 delivered Super Shop; part 2 added Pharmacy and Restaurant.

Nothing about the program itself changed. Clothing remains the reference: same `loyaltyService`,
same ledger, same card, same maths. What changed is that a second sale path calls the hooks.

## 1. The rule that does not bend

**Only a scanned membership card earns or redeems. A phone number never does.**

A Super Shop sale may carry a customer (task 05) and a card, or a customer alone, or neither.
A customer without a card earns nothing. The card is identified by `loyaltyMembershipId`, which the
till gets by looking the scanned barcode or card number up through `GET /loyalty/memberships/lookup`.
If the sale also names a customer, and that customer is not the card's customer, the sale is refused
(422) rather than quietly moving points onto the wrong person.

## 2. What the till sends

```jsonc
POST /api/supershop/sales
{
  "items": [...],
  "payments": [...],
  "loyaltyMembershipId": "…",   // optional; the scanned card
  "redeemPoints": 10            // optional; 0 unless the till redeems
}
```

Neither the discount nor the points are taken from the request. The server multiplies
`redeemPoints × pointValueMinor` from the branch's own loyalty settings, and works the earned points
out from the total it computed itself.

## 3. Order of operations

The same order Clothing uses, for the same reason: money must never move for points the card did not
have, and points must never move for a sale that did not happen.

1. `prepareForSale` — loads the card and the branch settings, refuses a card from another workspace
   (400), a blocked card, or more points than the balance holds (422).
2. Card vs customer check.
3. `loyaltyDiscountMinor = redeemPoints × pointValueMinor`, refused if it is worth more than the
   basket after the manual discount (422 `LOYALTY_DISCOUNT_TOO_LARGE`), or if it would leave nothing
   payable (422 `LOYALTY_NOTHING_PAYABLE`).
4. Tender settles against the reduced total — the three rules in `docs/POS_TENDER_RULES.md`.
5. `redeemForSale` against a `checkoutRef` minted before the sale exists. Anything that fails after
   this — stock, save — calls `reverseRedemption` with that same ref.
6. Stock through the inventory adapter, then the sale is saved with a loyalty snapshot.
7. `attachSale` stamps the ledger rows with the invoice number, then `earnForSale` awards
   `pointsForSpend(total − VAT)`.

Earning cannot fail the sale. The customer has paid; if the award throws, it is logged as CRITICAL
for a manual adjustment and the sale stands.

## 4. What earns

`qualifyingMinor = max(0, totalMinor − vatMinor)`.

VAT is collected for the government, so it never earns points, and the total is already net of both
the manual discount and the points spent. Clothing has no VAT on the line, so its base is the
subtotal; the intent is identical — points are earned on what the shop actually kept.

The loyalty discount is written into the sale's `discountMinor` as well as its own
`loyalty.discountMinor`, so every report that subtracts discounts stays correct without knowing
about points.

## 5. Coming back

Returns and voids run through the shared engine (`docs/RETURNS.md`), which now asks the sale adapter
to reverse loyalty if it can:

```ts
reverseLoyalty?(ctx, saleId, reason): Promise<void>;
```

Optional on purpose: Pharmacy and Restaurant do not implement it yet, and the engine simply does not
call it. Super Shop's implementation calls `loyaltyService.claimReturn`, whose cumulative maths means
a sale returned in three parts lands exactly where one whole return would have.

A void calls `applyCancellation`: everything earned is taken back, everything redeemed is given back.

Both now take the sale model as a parameter (`LoyaltySaleModel`), which is why the same service
serves `Sale` and `ShopSale` — the two documents happen to name these fields identically. A vertical
shaped differently needs a mapper, not another default.

## 6. Switching it on

Entitlement `loyalty` → plan feature `loyaltyProgram`, `verticals: ['clothing', 'supershop',
'pharmacy', 'restaurant']`.
The branch must also turn the program on in store settings (`loyalty.enabled`, `earnSpendMinor`,
`pointValueMinor`). The client mirrors the vertical list in `useLoyaltyAccess`, for rendering only —
every loyalty route checks the entitlement and the permission again on the server.

## 7. Where it appears

Navigation and Settings ask the same question the entitlement does, through one helper
(`isLoyaltyVertical` in `features/loyalty/useLoyaltyAccess`): a Super Shop workspace now has the
**Loyalty** screen in its sidebar and the **Loyalty** tab in Settings, where the program is switched
on and the earn rate and point value are set. Both are rendering decisions; the server checks the
entitlement and the permission again on every loyalty route.

## 8. At the till

`SupershopPosPage` gained what the Clothing till has: a Card button beside the customer picker, a
card code typed into (or scanned at) the same search box, the member strip with the balance and its
money value, a **Max** button, a `Points (n)` line in the basket, and `Earns n pts` for the sale
about to be rung up. Scanning a card also fills the customer, so one scan does both jobs.

## 9. What each vertical earns on

The rule is the same everywhere — points are earned on what the shop actually kept — but what
"kept" means is the vertical's own business:

| POS | Earns on | Why |
|---|---|---|
| Clothing | the sale subtotal, less discounts | the reference implementation |
| Super Shop | `total − VAT` | VAT is collected for the government, so it never earns |
| Pharmacy | the **non-prescription** part of the basket, scaled by what was charged | see below |
| Restaurant | the bill actually paid, after discounts and points | a kitchen sells one thing: the bill |

### Pharmacy: prescription medicines never earn

A pharmacy must not reward buying more prescription-only medicine, so prescription lines are left
out of the earning base entirely. The rest of the basket earns:

```ts
overTheCounterMinor = Σ line totals where !requiresPrescription
qualifyingMinor     = floor(overTheCounterMinor × totalMinor / subtotalMinor)
```

Scaling by `totalMinor / subtotalMinor` shares the sale's discount, and the points already spent,
across the basket, so a discounted sale never earns on money nobody paid. A basket of nothing but
prescription medicine is still a loyalty sale — it is recorded against the card, with zero points —
because the card was scanned and a redemption may have happened on it.

Redeeming is not restricted: points may pay for any part of a pharmacy sale, prescription or not.
Spending points is the customer's own money coming back to them, not a reward.

### Restaurant: the card is scanned when the bill is settled

A restaurant order is opened, added to, and possibly sits on a table for an hour. Points belong to
the bill, so the card is scanned in the payment dialog, not when the order is opened, and the whole
loyalty step happens inside `payOrder`. The order carries the same snapshot every other vertical
stores. A paid order cannot be cancelled, so there is no void hook here; money comes back through a
refund, and the refund reverses the points through the shared engine like everywhere else.
