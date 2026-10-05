# POS cash-drawer shifts

All four POS verticals support the same optional cash-drawer lifecycle: open a
shift with a float, attach completed transactions while it is open, record
pay-ins/pay-outs, view a live X-report, and close with a physical count to
freeze the Z-report. Checkout remains available when no shift is open; those
transactions have a null `shiftId`.

Restaurant and Pharmacy retain their established vertical collections and
report shapes. Clothing and Super Shop share `PosShift`, the `/api/pos-shifts`
routes, and one report service. The shared document includes the vertical in
every unique index and every query is scoped by tenant, branch, and the
server-resolved workspace vertical.

## Cash calculation

All money is stored as integer minor units:

`expected cash = opening float + cash sales - cash refunds + pay-ins - pay-outs`

Cash sales are cash tender less change. A cash return made during a shift
reduces the drawer; exchange credit does not. Closing is final and freezes the
report, counted cash, and variance so later voids, returns, or catalogue edits
cannot rewrite the Z-report.

## Permissions

- `sales.create`: current shift, opening, pay-in/pay-out, and closing.
- `reports.view`: history and X/Z report retrieval.
- Active subscription: every shift mutation.

The database enforces at most one open shift per branch for each applicable
vertical. Server queries never accept a tenant, branch, or vertical from the
request body.

## Routes

Restaurant uses `/api/restaurant/shifts`; Pharmacy uses
`/api/pharmacy/shifts`. Clothing and Super Shop use these shared routes:

| Method | Path                                 | Purpose                         |
| ------ | ------------------------------------ | ------------------------------- |
| GET    | `/api/pos-shifts/current`            | Current shift and live X-report |
| POST   | `/api/pos-shifts`                    | Open a shift                    |
| POST   | `/api/pos-shifts/:id/cash-movements` | Record a pay-in or pay-out      |
| POST   | `/api/pos-shifts/:id/close`          | Count cash and freeze Z-report  |
| GET    | `/api/pos-shifts`                    | Paginated shift history         |
| GET    | `/api/pos-shifts/:id`                | Live or frozen report           |
