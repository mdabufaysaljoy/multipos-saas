# Universal dashboard date ranges

*Task 12 of `docs/UNIVERSAL_POS_PLAN.md`.*

Every POS dashboard — Clothing, Restaurant, Pharmacy, Super Shop — answers the same question over
the same period, with the same presets, the same custom range and the same comparison against the
period before it. Pharmacy and Super Shop previously showed a single fixed snapshot ("today" and
"this month") with no way to ask for anything else.

## 1. The one range

| Piece | Where | What it owns |
|---|---|---|
| `dashboardRangeSchema` | `server/src/modules/reports/reports.validators.ts` | The query a dashboard accepts: a preset from `RANGE_PRESETS`, or `custom` with both dates. Defaults to `today`, because that is what a till wants when it opens. |
| `resolveDashboardWindow` | `server/src/modules/reports/reports.service.ts` | The range, the comparison period, the trend bucket and the timezone, resolved once. |
| `RangePicker` + `DASHBOARD_PRESETS` | `client/src/features/reports/RangePicker.tsx` | The control: Today · Yesterday · 7 days · 30 days · This month · Custom. |
| `DashboardKpi` | `client/src/features/reports/DashboardKpi.tsx` | One headline figure with its change against the previous period. |

A vertical supplies only its own figures. Super Shop reports VAT collected and gross profit
(net sales less VAT less cost — VAT is collected for the government, not earned); Pharmacy reports
prescription sales; Restaurant reports paid orders and the live floor; Clothing is unchanged.

### The comparison period

`resolveDashboardWindow` returns the span of equal length ending the instant the range begins, so
"last 7 days" is always measured against the 7 days before it, whatever the preset. Where the
previous period had nothing, the card says so in words rather than showing an infinite percentage.

### Buckets

`bucket` is `hour` for a single day, `day` up to 62 days, `month` beyond that, with the matching
`$dateToString` format. Only Restaurant and Clothing draw a trend today; task 13 fills that gap.

## 2. Periods and "right now"

Stock is not a period. What is low, what is expiring and what has expired describe the shelf as it
stands, so they ignore the range entirely and the pages label them that way ("Needs reordering now",
"Low stock now"). Restaurant's live floor panel works the same way. Only trading figures move with
the range.

## 3. One clock

`resolveRange` computes its boundaries with dayjs, in the server's timezone. Anything that groups
sales into days has to use the same clock, or a late-evening sale lands in the wrong bucket — or
falls outside "today" altogether.

`reportTimezone()` is now that clock, and every `$dateToString` in every vertical passes it.
Clothing's trend previously grouped in UTC while its range boundaries were local: a sale at 11pm in
Dhaka appeared under tomorrow's date. That is fixed; it was risk 5 in the plan.

## 4. What the endpoints return

`GET /api/{pharmacy,supershop,restaurant}/dashboard?preset=…[&from=&to=]`

```
range    { from, to, label, preset, bucket }
kpis     the vertical's figures for the range
previous the same figures for the period before it (comparison only)
…        the vertical's "right now" panels, unaffected by the range
```

A missing `preset` means `today`; an unknown one is a 422, as is a custom range missing a date or
ending before it starts. Permission is `reports.view` and the vertical gate is unchanged — a
dashboard is on every plan, unlike Advanced Analytics.
