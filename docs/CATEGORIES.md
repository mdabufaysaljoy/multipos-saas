# Categories, in four POS types

Universal POS task 10. Clothing has always had real category *entities*; the other three kept a
free-text string on the item and offered no way to manage it. They now all manage their categories,
and every till can filter by them — without a single document being migrated.

## 1. Two shapes, on purpose

| POS | Where the category lives | Managed by |
|---|---|---|
| Clothing | `Category` collection, store-scoped, products point at it by `categoryId` with a name snapshot, parents supported | `modules/categories` (unchanged) |
| Super Shop | `ShopProduct.category` — a name | shared catalogue |
| Pharmacy | `Medicine.category` — a name | shared catalogue |
| Restaurant | `MenuItem.category` — a name | shared catalogue |

Universal means the same *capability*, not the same schema. Clothing manages products in bulk and
wants a hierarchy; the other three want a short list of departments, so there the **name is the
link** and the shared catalogue is the list of names.

## 2. Nothing was migrated

`PosCategory` (tenant-scoped, `{tenantId, vertical, slug}` unique while live) holds a row per name.
The list a POS returns is the **union** of:

- every row written down, and
- every name items actually carry, counted from the catalogue itself.

So a workspace that has been selling for a year appears fully populated the moment the screen opens,
and a missing row loses nothing. A name with no row comes back with `id: null`; renaming it writes
the row first, which the shopkeeper never sees.

## 3. The four routes, in three modules

```
GET    /api/<vertical>/categories?includeInactive=true
POST   /api/<vertical>/categories          { name, sortOrder? }
PATCH  /api/<vertical>/categories/:id      { name?, isActive?, sortOrder? }
DELETE /api/<vertical>/categories/:id
```

`<vertical>` is `supershop`, `pharmacy` or `restaurant`. One controller, one service
(`services/catalogue/posCategories.service.ts`), mounted by each module, so the permissions,
the vertical gate and the subscription checks are the module's own. Reading needs `products.view`;
writing needs `categories.create` / `categories.edit` / `categories.delete` — the same keys Clothing
uses, so existing staff roles work unchanged.

Each row: `{ id, name, slug, isActive, sortOrder, itemCount }`.

## 4. What the operations mean

- **Rename** rewrites every live item carrying the old name, in one `updateMany`. Sales are *not*
  touched: their `categorySnapshot` keeps the name the goods were sold under, so last month's report
  still reads as it did.
- **Hide** (`isActive: false`) retires a department without touching what sits in it. The till is not
  offered it, and new items cannot be put into it (400 `CATEGORY_HIDDEN`).
- **Remove** is refused while anything still carries the name (409 `CATEGORY_IN_USE`, with the
  count): there is nothing to detach the items to, so the shop moves them first. Hiding is the way
  to retire a department that still has stock against it.
- **Saving an item** with an unknown category adds it to the list, so a shop never has to visit this
  screen first.
- `sortOrder` decides the order on the till; equal values sort by name.

## 5. At the till

`features/catalogue/CategoryFilter` draws the chips, from that vertical's `/categories` — so a
hidden department disappears from the till as soon as it is hidden:

- **Super Shop** — picking a department browses it, which is new: before, the till showed nothing
  until something was typed or scanned.
- **Pharmacy** — filters the medicine list (`GET /pharmacy/medicines?category=…`, added here).
- **Restaurant** — the chips it always had, now driven by the catalogue instead of by whatever the
  menu happened to contain, so order and hiding are respected.

`features/catalogue/CategoryInput` is the field on an item form: type a new name or pick an existing
one.
