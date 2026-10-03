# Pharmacy cash-drawer shifts

Pharmacy shifts are isolated from Restaurant shifts and from every other POS vertical. Opening a
shift is optional; when one is open, each new Pharmacy sale stores its `shiftId`.

## Drawer calculation

All values are integer minor units:

`expected cash = opening float + cash sales - cash refunds + pay-ins - pay-outs`

Cash sales are cash tender less change. Returns made during the shift are included by their return
time; exchange returns do not remove cash. Non-cash payments and all returns/voids are displayed on
the report but do not change the expected drawer unless the refund method is cash.

## Endpoints

| Method | Path                                      | Permission     | Purpose                               |
| ------ | ----------------------------------------- | -------------- | ------------------------------------- |
| GET    | `/api/pharmacy/shifts/current`            | `sales.create` | Open shift with a live X-report       |
| POST   | `/api/pharmacy/shifts`                    | `sales.create` | Open one shift for the current branch |
| POST   | `/api/pharmacy/shifts/:id/cash-movements` | `sales.create` | Record a pay-in or pay-out            |
| POST   | `/api/pharmacy/shifts/:id/close`          | `sales.create` | Count cash and freeze the Z-report    |
| GET    | `/api/pharmacy/shifts`                    | `reports.view` | Shift history                         |
| GET    | `/api/pharmacy/shifts/:id`                | `reports.view` | Live X-report or frozen Z-report      |

The database has a partial unique index enforcing one open Pharmacy shift per branch. Closing is
final, records the counted cash and variance, and persists the report so later catalogue or sale
changes cannot rewrite a historical Z-report.
