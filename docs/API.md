# API reference

Base URL: `/api` · All responses use one envelope.

```jsonc
{ "success": true,  "data": …, "meta": { "page": 1, "limit": 20, "total": 57, "totalPages": 3 } }
{ "success": false, "error": { "code": "…", "message": "…", "details": … } }
```

## Conventions

| Topic | Rule |
|---|---|
| Auth | `Authorization: Bearer <accessToken>` on everything except register/login/refresh/plans/webhooks |
| Store selection | Optional `x-store-id` header; must be a store the caller's tenant owns, else `403` |
| Money | Always integer **minor units** (`priceMinor: 79000` = ৳790.00) |
| Quantities | Always whole positive integers |
| Pagination | `?page=1&limit=20` (max 100); meta returned alongside |
| Search | `?search=term` — escaped before becoming a RegExp |
| Dates | ISO 8601 strings |

## Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `BAD_REQUEST` | 400 | Malformed or semantically invalid request |
| `UNAUTHORIZED` | 401 | Missing, invalid or expired access token |
| `FORBIDDEN` | 403 | Authenticated but lacking permission, or cross-tenant access |
| `NOT_FOUND` | 404 | Resource does not exist **within this tenant** |
| `CONFLICT` | 409 | Duplicate key, or a concurrent modification |
| `INSUFFICIENT_STOCK` | 409 | Not enough stock to complete the sale |
| `LIMIT_EXCEEDED` | 402 | Plan limit or feature gate hit |
| `SUBSCRIPTION_INACTIVE` | 402 | Subscription expired or suspended |
| `VALIDATION_ERROR` | 422 | Zod failure; `details[]` carries `{ path, message }` |
| `TOO_MANY_REQUESTS` | 429 | Rate limited |
| `INTERNAL` | 500 | Unexpected server error (no stack in production) |

---

## Auth — `/api/auth`

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/register` | — | Creates tenant + admin + default roles + trial. Rate limited. |
| POST | `/login` | — | Returns session and tokens; sets the refresh cookie. |
| POST | `/refresh` | — | Rotates the refresh token. Replay revokes the family. |
| POST | `/logout` | — | Revokes the presented session. |
| GET | `/me` | auth | Session, permissions, stores, entitlement. |
| POST | `/change-password` | auth | Revokes every other session. |

<details><summary><code>POST /auth/login</code></summary>

```jsonc
// request
{ "email": "admin@demostore.dev", "password": "Admin@123" }

// 200
{
  "success": true,
  "data": {
    "user": { "id": "…", "name": "Ayesha Rahman", "role": "admin",
              "tenantId": "…", "permissions": ["products.view", "…"] },
    "tenant": { "id": "…", "name": "Denim Republic", "status": "active" },
    "stores": [{ "id": "…", "name": "Denim Republic - Dhanmondi", "currency": "BDT" }],
    "entitlement": { "status": "active", "planName": "Showroom",
                     "features": { … }, "limits": { … }, "daysRemaining": 27, "isUsable": true },
    "needsStoreSetup": false,
    "tokens": { "accessToken": "eyJ…", "refreshToken": "eyJ…", "expiresIn": 900 }
  }
}
```
</details>

---

## Stores — `/api/stores`

| Method | Path | Permission |
|---|---|---|
| GET | `/` | auth (no store required — used during onboarding) |
| POST | `/` | tenant admin |
| GET | `/pos-config` | **auth only** — currency, tenders, tax, receipt |
| GET | `/current` | `settings.view` |
| PATCH | `/current`, `/:id` | `settings.edit` |

`pos-config` is deliberately ungated: a cashier has no `settings.view` but still
needs currency, enabled tenders and tax rates to ring up a sale.

---

## Categories — `/api/categories`

| Method | Path | Permission |
|---|---|---|
| GET | `/` `?search&includeInactive&page&limit` | `categories.view` |
| GET | `/:id` | `categories.view` |
| POST | `/` | `categories.create` |
| PATCH | `/:id` | `categories.edit` |
| DELETE | `/:id` | `categories.delete` — **soft delete**, detaches live products, leaves history untouched |

---

## Products — `/api/products`

| Method | Path | Permission |
|---|---|---|
| GET | `/pos-search` `?q&limit&categoryId&inStockOnly` | `products.view` — flat sellable variants for the till |
| GET | `/` `?search&categoryId&lowStockOnly&outOfStockOnly` | `products.view` |
| GET | `/:id` | `products.view` |
| POST | `/` | `products.create` |
| PATCH | `/:id` | `products.edit` |
| DELETE | `/:id` | `products.delete` — soft delete |
| POST | `/:id/variants` | `products.create` |
| PATCH | `/:id/variants/:variantId` | `products.edit` — **stock is not settable here** |
| DELETE | `/:id/variants/:variantId` | `products.delete` — refuses to remove the last variant |

<details><summary><code>POST /products</code></summary>

```jsonc
{
  "name": "Classic Cotton T-Shirt",
  "categoryId": "…",
  "brand": "Urban Thread",
  "options": [
    { "name": "Color", "values": ["Black", "White"] },
    { "name": "Size",  "values": ["M", "L"] }
  ],
  "variants": [
    { "attributes": [ { "name": "Color", "value": "Black" }, { "name": "Size", "value": "M" } ],
      "sellingPriceMinor": 79000, "costPriceMinor": 42000, "stock": 18, "lowStockThreshold": 4 }
  ]
}
```

SKUs are generated when omitted. Opening stock writes an `INITIAL_STOCK` ledger
row. Variant stock is only ever changed afterwards through `/inventory/adjust`,
a sale, or a return — so the ledger is always complete.
</details>

---

## Inventory — `/api/inventory`

| Method | Path | Permission |
|---|---|---|
| GET | `/` `?search&categoryId&lowStockOnly&outOfStockOnly` | `inventory.view` |
| GET | `/summary` | `inventory.view` — units, cost/retail value, low & out counts |
| GET | `/ledger` `?variantId&productId&type&from&to` | `inventory.view` |
| POST | `/adjust` | `inventory.adjust` |

```jsonc
// POST /inventory/adjust
{ "variantId": "…", "mode": "delta", "value": -3, "reason": "Damaged in transit" }
// mode "set" writes an absolute count and is guarded against concurrent edits.
```

Ledger types: `INITIAL_STOCK`, `PURCHASE`, `SALE`, `RETURN`, `MANUAL_ADJUSTMENT`,
`SALE_CANCELLED`.

---

## Customers — `/api/customers`

Standard CRUD under `customers.view|create|edit|delete`. Phone is unique per
store among live records. Delete is soft, so past sales keep their details.

---

## Sales — `/api/sales`

| Method | Path | Permission |
|---|---|---|
| POST | `/` | `sales.create` |
| GET | `/` `?search&from&to&cashierId&customerId&paymentMethod&status` | `sales.view` |
| GET | `/:id` | `sales.view` |
| GET | `/by-number/:saleNumber` | `sales.view` |
| GET | `/:id/receipt` | `sales.view` — sale + store block for the 58mm layout |
| POST | `/:id/cancel` | `sales.cancel` — restores stock; blocked once returns exist |

<details><summary><code>POST /sales</code></summary>

```jsonc
{
  "items": [
    { "variantId": "…", "quantity": 2 },
    { "variantId": "…", "quantity": 1, "unitPriceMinor": 74000 }  // needs sales.changePrice
  ],
  "customer": { "name": "Rahim Uddin", "phone": "01711000001" },  // optional
  "discountType": "percent",     // none | fixed | percent
  "discountValue": 500,          // basis points when percent; minor units when fixed
  "paymentMethod": "cash",
  "paidMinor": 200000,
  "note": ""
}
```

**Server-side rules.** `quantity` must be a whole number ≥ 1 and
`unitPriceMinor` an integer > 0. Every line is re-priced from the database;
supplied totals are ignored. An override differing from the catalogue price
requires `sales.changePrice`. Stock is decremented atomically per line, and a
failure compensates everything already applied.

Errors: `422` invalid quantity/price · `403` unauthorised override ·
`409 INSUFFICIENT_STOCK` · `402 SUBSCRIPTION_INACTIVE`.
</details>

---

## Returns — `/api/returns`

| Method | Path | Permission |
|---|---|---|
| GET | `/` `?search&from&to&saleId` | `returns.view` |
| GET | `/returnable/:saleId` | `returns.view` — per-line sold / returned / returnable |
| GET | `/:id` | `returns.view` |
| POST | `/` | `returns.create` |

```jsonc
// POST /returns
{
  "saleId": "…",
  "items": [ { "saleItemId": "…", "quantity": 2, "restock": true } ],
  "reason": "Wrong size",
  "refundMethod": "cash"
}
```

A return **must** reference a sale — there is no standalone endpoint.
`quantity ≤ soldQuantity − returnedQuantity` is enforced by an atomic
conditional update, so excess and duplicate returns fail even under concurrency.
Refunds use the original `unitPriceMinor`, never the current price.

---

## Staff — `/api/staff`

CRUD under `staff.view|create|edit|delete`, plus
`POST /:id/reset-password`. New accounts are always created with role `staff` —
admin rights can never be granted through this endpoint. Deactivating or
deleting an account revokes its sessions immediately.

```jsonc
{
  "name": "Sabbir Ahmed",
  "email": "sabbir@shop.dev",
  "password": "Cashier@123",
  "roleId": "…",
  "extraPermissions": ["sales.changePrice"],   // granted on top of the role
  "deniedPermissions": ["sales.cancel"]        // beats the role
}
```

---

## Roles — `/api/roles`

| Method | Path | Permission |
|---|---|---|
| GET | `/permissions/catalog` | auth — grouped catalogue that drives the editor |
| GET | `/` | `roles.view` |
| POST · PATCH · DELETE | `/`, `/:id` | `roles.manage` |

Built-in roles cannot be deleted, and a role still in use cannot be removed.
Editing a role bumps `permissionVersion` on every holder.

---

## Reports — `/api/reports`

`GET /dashboard` — `reports.view`

```
?preset=today|yesterday|last7|last30|thisMonth|lastMonth|thisYear|custom
&from=2025-01-01&to=2026-08-25      (required when preset=custom)
&granularity=day|week|month
&cashierId=…&limit=10
```

Returns `summary` (gross, net, orders, items, returns, AOV, gross profit),
`trend`, `topProducts`, `topVariants`, `byCategory`, `byPaymentMethod`,
`byStaff`. Every figure comes from a MongoDB aggregation — sales are never
shipped to the browser to be summed. Grouping uses snapshot fields, so deleted
products still appear correctly.

---

## Billing

### Plans — `/api/plans`
| Method | Path | Permission |
|---|---|---|
| GET | `/` | **public** — active, public plans |
| GET | `/all` · POST `/` · PATCH `/:id` · DELETE `/:id` | platform admin |

Prices live in the database. Editing a plan never rewrites an active
subscription, because each subscription froze a `planSnapshot`.

### Subscriptions — `/api/subscriptions`
| Method | Path | Permission |
|---|---|---|
| GET | `/current` | `subscription.view` — plan, entitlement, usage |
| GET | `/history` | `subscription.view` |
| POST | `/cancel` | `subscription.manage` |
| POST | `/reactivate` | `subscription.manage` |

`cancel` defaults to `immediate: false`: the next renewal is stopped while access
continues to the end of the paid period.

These routes are **not** behind `requireActiveSubscription` — an expired tenant
must still be able to see and fix their subscription.

### Payments — `/api/payments`
| Method | Path | Permission |
|---|---|---|
| POST | `/webhook/:provider` | **unauthenticated**, signature-verified |
| GET | `/providers` | auth — only providers with credentials configured |
| GET | `/` | `subscription.view` |
| POST | `/checkout` | `subscription.manage` — creates a **pending** payment |
| POST | `/verify` | `subscription.manage` — asks the provider, not the browser |

A subscription is **never** activated because the frontend says a payment
succeeded. Only a server-to-server verification or a signature-verified webhook
can do it, and webhook handling is idempotent so a redelivery cannot extend a
period twice. Unverified webhooks return `202` without acting, so a prober learns
nothing.

---

## Platform admin — `/api/platform`

Every route requires the `platform_admin` role. `resolveTenant` refuses platform
admins outright, keeping the two surfaces separate.

| Method | Path | Purpose |
|---|---|---|
| GET | `/overview` | Tenant counts, subscription mix, revenue, provider status |
| GET | `/tenants` `?search&status` | Tenant list with store/user/sale counts |
| GET | `/tenants/:id` | Full detail: owner, stores, users, subscriptions, events, payments, usage |
| PATCH | `/tenants/:id/status` | Suspend or reactivate a workspace |
| GET | `/customers` | Every workspace user across the platform |
| GET | `/subscriptions` · `/subscriptions/expiring` | Subscription list; lapsing within 7 days |
| POST | `/subscriptions` | **Manually activate** a plan, optionally recording an offline payment |
| POST | `/subscriptions/:id/extend` | Extend by periods or to a date |
| PATCH | `/subscriptions/:id/status` | Force active / suspended / expired / cancelled |
| GET | `/payments` | All payments |
| POST | `/payments/:id/mark-paid` | Confirm an offline payment (a deliberate human step) |

---

## Data export — `/api/exports`

Professional and Enterprise (`dataExport` entitlement) + `reports.export`. Files
stream to the caller and are never stored. See `docs/DATA_EXPORT.md`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/datasets` | The server-side registry: what may be exported, and in which formats |
| POST | `/` | `{ type, format, preset/from/to, branch }` → streams CSV / XLSX / JSON / PDF |
| GET | `/` | Export history (metadata only) |

---

## Product import — `/api/products/import`

**Every plan** (`productImport` entitlement — deliberately not `dataExport`) +
`products.import`, Clothing only. Two steps: nothing is created until a preview
is confirmed. See `docs/PRODUCT_IMPORT.md`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/columns` | The column contract and limits (2,000 rows, 5 MB, .xlsx/.csv) |
| POST | `/preview` | multipart `file` + `createMissingCategories` → validation, mapping, row errors, plan |
| POST | `/:id/commit` | `{ skipInvalidRows }` → creates the products through the ordinary product service |
| POST | `/:id/cancel` | Discards an unconfirmed preview |
| GET | `/` | Import history (filename, counts, status, who, when) |

---

## Uploads — `/api/uploads`

`POST /image` (multipart `file`) — `products.create`. JPEG/PNG/WebP/AVIF, 4 MB
max. Files are namespaced per tenant and stored through the `StorageProvider`
abstraction, so switching to S3 changes no call site.
