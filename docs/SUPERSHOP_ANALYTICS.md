# Super Shop — Advanced Analytics

What can be asked of a Super Shop's sales, and exactly what each answer means.

The **money vocabulary is not redefined here**. `grossSales`, `returns`,
`netSales`, `cost`, `grossProfit` and margin mean what `docs/ANALYTICS_PARITY.md`
says they mean, and what `docs/SUPERSHOP_COSTING.md` says about weighted-average
cost holds throughout. This document is about the *dimensions* and the *filters*.

## Dimensions

`GET /supershop/reports` returns, for the range and filters given:

| Block | Grain | What it answers |
|---|---|---|
| `totals` | sale | the headline: charged, returned, kept, VAT, cost, profit, margin, basket |
| `trend` | sale, per day | the shape of the period |
| `staff` | **sale** | who sold it — sales, net, basket, discounts, profit, margin |
| `branchBreakdown` | **sale** | which shop — only interesting with more than one in scope |
| `customers` | **sale** | who bought — walk-ins carry no customer and are skipped |
| `payments` | sale | how it was paid; cash is net of change given |
| `products` | line | what sold |
| `departments` | line | which aisle |
| `brands` | **line** | whose goods |
| `vatRates` | line | VAT by rate |
| `hours` | sale | when the shop is busy |
| `returns`, `voids`, `writeOffs`, `deadStock` | mixed | what went wrong or never moved |

## Filters, and the one distinction that matters

Two kinds, and they behave differently **on purpose**.

**Sale-level — `branch`, `staffId`, `paymentMethod`, `customerId`.**
They choose which sales are counted. Every figure in the response narrows with
them, and nothing is ambiguous: a basket either is or is not in scope.

**Line-level — `category`, `brand`, `productId`.**
They choose which *lines* are of interest. A sale is in scope when it contains
such a line, the per-line blocks (`products`, `departments`, `brands`,
`vatRates`) show only matching lines, and a `selection` block reports those lines
on their own — count, quantity, revenue, VAT, cost, profit, margin.

**`totals` stays sale-level even under a line filter.** A basket is not re-costed
because one line in it was asked about, and a sale-level discount cannot be
honestly attributed to one line. If you want the line figures, read `selection` —
that is exactly what it is for, and the screen labels it "the lines you filtered
to" rather than letting the header be misread.

Filters combine freely. The response echoes `filters` so a reader can always see
what produced the numbers.

## Returns, and when they cannot be attributed

A `Return` records the goods, the branch, the date and the customer. It does
**not** record which cashier made the original sale, which tender paid for it, or
which line a filter was aimed at.

So refunds narrow with **branch, date and customer**, and under a **staff**,
**payment method** or **line** filter they are **left out entirely** —
`returnsAttributable: false`, `returnAmountMinor: 0`, and the screen says why.

Subtracting every refund in the period from one cashier's sales would have been
worse than useless: it produced a large negative profit for a cashier who had
sold perfectly well, which is exactly how this was caught.

## Branch scope and who may see what

```
branch=current   (default)  this till's branch
branch=all                  every branch — ADMIN ONLY
branch=<id>                 that branch — ADMIN ONLY
```

A non-admin asking for `all` or for a branch that is not theirs is **quietly
given their own** rather than refused. That is the rule Clothing has always used
and it is deliberate: a dashboard link shared with a branch manager shows them
their own numbers instead of either leaking another shop's or breaking.

It is decided in `storeScope()` and applied to the `$match` of **every**
aggregation, so the filtering happens in the query and never in the client. The
response also carries `branches` — the branches this user may choose between,
which is one for a non-admin, so a picker cannot even offer a branch they are not
allowed to see.

`reports.view` is required, plus the `advancedAnalytics` plan feature.

## Performance

Everything is a MongoDB aggregation against `ShopSale`; no page of the report
fetches sales into the server or the browser to count them there. Every
aggregation starts from the same `$match` — tenant, branch scope, `completed`,
the date window — which `ShopSale` now indexes as
`{tenantId, storeId, status, soldAt}`.

Breakdowns are `$limit`-ed by the request's `limit` (default 10, max 50), so the
number of rows returned does not grow with the shop.

## Known limitation

Day and hour buckets use the **server process** timezone through the shared
`reportTimezone()`, not the branch's. `resolveRange` builds the range in the same
timezone, so the range and the buckets agree with each other — a shop only sees a
discrepancy if the server runs in a different timezone from the shop. Fixing it
properly means a timezone on `Store` and a change to the shared helper every
vertical uses, so it is a platform decision rather than a Super Shop one.
