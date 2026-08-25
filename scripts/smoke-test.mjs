/**
 * End-to-end verification of the business-critical rules:
 * inventory -> sales -> returns -> historical data -> permissions.
 *
 * Run against a freshly seeded database:  npm run seed -w server && node scripts/smoke-test.mjs
 */
const BASE = process.env.API_BASE ?? 'http://localhost:4100/api';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `\n        ${JSON.stringify(detail)}` : ''}`);
  }
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

async function api(path, { method = 'GET', token, body, storeId } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(storeId ? { 'x-store-id': storeId } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, ...json };
}

async function login(email, password) {
  const res = await api('/auth/login', { method: 'POST', body: { email, password } });
  if (!res.success) throw new Error(`Login failed for ${email}: ${JSON.stringify(res)}`);
  return { token: res.data.tokens.accessToken, session: res.data };
}

async function main() {
  console.log('\n==========  Clothing POS smoke test  ==========');

  // ---------------------------------------------------------------- auth
  section('Authentication & tenant isolation');
  const admin = await login('admin@demostore.dev', 'Admin@123');
  check('Admin can sign in', Boolean(admin.token));
  check('Session exposes the tenant', Boolean(admin.session.tenant?.id));
  check('Session exposes a store', admin.session.stores.length > 0);
  check('Admin holds every permission', admin.session.user.permissions.length > 20);

  const cashier = await login('cashier@demostore.dev', 'Cashier@123');
  check(
    'Cashier LACKS sales.changePrice',
    !cashier.session.user.permissions.includes('sales.changePrice'),
    cashier.session.user.permissions,
  );

  const senior = await login('senior@demostore.dev', 'Cashier@123');
  check(
    'Senior cashier HAS sales.changePrice',
    senior.session.user.permissions.includes('sales.changePrice'),
  );

  const noAuth = await api('/products');
  check('Unauthenticated request is rejected', noAuth.status === 401);

  const badToken = await api('/products', { token: 'not-a-real-token' });
  check('Forged token is rejected', badToken.status === 401);

  // --------------------------------------------------------------- setup
  section('Catalogue');
  const products = await api('/products?limit=5', { token: admin.token });
  check('Products list loads', products.success && products.data.length > 0);

  const search = await api('/products/pos-search?q=T-Shirt&limit=50', { token: cashier.token });
  check('POS search returns sellable variants', search.success && search.data.length > 0);

  const variant = search.data.find((v) => v.stock >= 5);
  check('Found a variant with stock for testing', Boolean(variant), variant);
  if (!variant) throw new Error('No stocked variant available - re-run the seed');

  const startStock = variant.stock;
  const listPrice = variant.sellingPriceMinor;
  console.log(`        using ${variant.productName} / ${variant.variantName} (stock ${startStock}, price ${listPrice})`);

  // ------------------------------------------------ quantity & price rules
  section('Quantity and price validation (the 0.001 class of bug)');

  const fractionalQty = await api('/sales', {
    method: 'POST',
    token: admin.token,
    body: { items: [{ variantId: variant.variantId, quantity: 0.001 }], paymentMethod: 'cash' },
  });
  check('Fractional quantity 0.001 is rejected', fractionalQty.status === 422, fractionalQty.error);

  const zeroQty = await api('/sales', {
    method: 'POST',
    token: admin.token,
    body: { items: [{ variantId: variant.variantId, quantity: 0 }], paymentMethod: 'cash' },
  });
  check('Quantity 0 is rejected at checkout', zeroQty.status === 422, zeroQty.error);

  const negQty = await api('/sales', {
    method: 'POST',
    token: admin.token,
    body: { items: [{ variantId: variant.variantId, quantity: -2 }], paymentMethod: 'cash' },
  });
  check('Negative quantity is rejected', negQty.status === 422);

  const zeroPrice = await api('/sales', {
    method: 'POST',
    token: admin.token,
    body: { items: [{ variantId: variant.variantId, quantity: 1, unitPriceMinor: 0 }], paymentMethod: 'cash' },
  });
  check('Price 0 is rejected at checkout', zeroPrice.status === 422, zeroPrice.error);

  const fractionalPrice = await api('/sales', {
    method: 'POST',
    token: admin.token,
    body: { items: [{ variantId: variant.variantId, quantity: 1, unitPriceMinor: 100.5 }], paymentMethod: 'cash' },
  });
  check('Fractional minor-unit price is rejected', fractionalPrice.status === 422);

  const emptyCart = await api('/sales', {
    method: 'POST',
    token: admin.token,
    body: { items: [], paymentMethod: 'cash' },
  });
  check('Empty cart is rejected', emptyCart.status === 422);

  // -------------------------------------------------------- stock guards
  section('Inventory guards');
  const oversell = await api('/sales', {
    method: 'POST',
    token: admin.token,
    body: { items: [{ variantId: variant.variantId, quantity: startStock + 500 }], paymentMethod: 'cash' },
  });
  check('Overselling is rejected', oversell.status === 409, oversell.error?.code);

  const stockAfterOversell = await api(`/products/pos-search?q=${encodeURIComponent(variant.sku)}`, { token: admin.token });
  check(
    'Failed sale did NOT consume stock',
    stockAfterOversell.data[0]?.stock === startStock,
    { expected: startStock, actual: stockAfterOversell.data[0]?.stock },
  );

  // ------------------------------------------------------ permission gate
  section('Price-override permission (enforced on the backend)');
  const cashierOverride = await api('/sales', {
    method: 'POST',
    token: cashier.token,
    body: {
      items: [{ variantId: variant.variantId, quantity: 1, unitPriceMinor: 1000 }],
      paymentMethod: 'cash',
    },
  });
  check('Cashier WITHOUT permission cannot change price', cashierOverride.status === 403, cashierOverride.error);

  const cashierListPrice = await api('/sales', {
    method: 'POST',
    token: cashier.token,
    body: {
      items: [{ variantId: variant.variantId, quantity: 1, unitPriceMinor: listPrice }],
      paymentMethod: 'cash',
    },
  });
  check('Cashier CAN sell at the catalogue price', cashierListPrice.status === 201, cashierListPrice.error);

  const seniorOverride = await api('/sales', {
    method: 'POST',
    token: senior.token,
    body: {
      items: [{ variantId: variant.variantId, quantity: 1, unitPriceMinor: listPrice - 5000 }],
      paymentMethod: 'cash',
    },
  });
  check('Senior cashier WITH permission can change price', seniorOverride.status === 201, seniorOverride.error);
  check(
    'Overridden price is what got stored',
    seniorOverride.data?.items?.[0]?.unitPriceMinor === listPrice - 5000,
  );

  // ------------------------------------------------------------- the sale
  section('Completing a sale');
  const SALE_QTY = 3;
  const sale = await api('/sales', {
    method: 'POST',
    token: admin.token,
    body: {
      items: [{ variantId: variant.variantId, quantity: SALE_QTY }],
      customer: { name: 'Smoke Test Buyer', phone: '01999000111' },
      paymentMethod: 'cash',
      paidMinor: listPrice * SALE_QTY + 10000,
      note: 'smoke test',
    },
  });
  check('Sale completes', sale.status === 201, sale.error);
  check('Invoice number assigned', typeof sale.data?.saleNumber === 'string' && sale.data.saleNumber.startsWith('INV-'));
  check('Total is computed server-side', sale.data?.totalMinor === listPrice * SALE_QTY);
  check('Change is computed', sale.data?.changeMinor === 10000);
  check('Customer attached', sale.data?.customerSnapshot?.phone === '01999000111');
  check('Item carries a product-name snapshot', Boolean(sale.data?.items?.[0]?.productNameSnapshot));
  check('Item carries a SKU snapshot', Boolean(sale.data?.items?.[0]?.skuSnapshot));

  const afterSale = await api(`/products/pos-search?q=${encodeURIComponent(variant.sku)}`, { token: admin.token });
  // 1 (cashier) + 1 (senior) + 3 (this sale) = 5 units gone
  const expectedStock = startStock - 5;
  check(
    `Stock reduced correctly (${startStock} -> ${expectedStock})`,
    afterSale.data[0]?.stock === expectedStock,
    { expected: expectedStock, actual: afterSale.data[0]?.stock },
  );

  const ledger = await api(`/inventory/ledger?variantId=${variant.variantId}&limit=5`, { token: admin.token });
  check('Inventory ledger recorded the sale', ledger.data?.some((row) => row.type === 'SALE'));
  check('Ledger row carries the invoice number', ledger.data?.some((row) => row.referenceNumber?.startsWith('INV-')));

  const walkIn = await api('/sales', {
    method: 'POST',
    token: admin.token,
    body: { items: [{ variantId: variant.variantId, quantity: 1 }], paymentMethod: 'bkash' },
  });
  check('Sale WITHOUT a customer succeeds (customer is optional)', walkIn.status === 201, walkIn.error);


  const receipt = await api(`/sales/${sale.data._id}/receipt`, { token: admin.token });
  check('Receipt payload loads', receipt.success && Boolean(receipt.data.store.name));
  check('Receipt is configured for 58mm', receipt.data?.store?.receipt?.paperWidthMm === 58);

  // ------------------------------------------------------ split payments
  section('Tendered amount & split payments');

  const priceOf = async () => {
    const found = await api(`/products/pos-search?q=${encodeURIComponent(variant.sku)}`, { token: admin.token });
    return found.data[0];
  };
  const current = await priceOf();

  const under = await api('/sales', {
    method: 'POST',
    token: admin.token,
    body: {
      items: [{ variantId: variant.variantId, quantity: 1 }],
      paymentMethod: 'cash',
      paidMinor: Math.max(1, current.sellingPriceMinor - 100),
    },
  });
  check('Tendered BELOW total is rejected', under.status === 422, under.error);

  const exact = await api('/sales', {
    method: 'POST',
    token: admin.token,
    body: {
      items: [{ variantId: variant.variantId, quantity: 1 }],
      paymentMethod: 'cash',
      paidMinor: current.sellingPriceMinor,
    },
  });
  check('Tendered EXACTLY the total succeeds', exact.status === 201, exact.error);
  check('Exact tender produces no change', exact.data?.changeMinor === 0);

  const over = await api('/sales', {
    method: 'POST',
    token: admin.token,
    body: {
      items: [{ variantId: variant.variantId, quantity: 1 }],
      paymentMethod: 'cash',
      paidMinor: current.sellingPriceMinor + 20000,
    },
  });
  check('Tendered ABOVE total succeeds', over.status === 201, over.error);
  check('Change computed correctly', over.data?.changeMinor === 20000, {
    expected: 20000,
    actual: over.data?.changeMinor,
  });

  // Three-way split adding up to exactly the total.
  const splitPrice = current.sellingPriceMinor * 2;
  const partA = Math.floor(splitPrice / 2);
  const partB = Math.floor((splitPrice - partA) / 2);
  const partC = splitPrice - partA - partB;

  const split = await api('/sales', {
    method: 'POST',
    token: admin.token,
    body: {
      items: [{ variantId: variant.variantId, quantity: 2 }],
      paymentMethod: 'cash',
      payments: [
        { method: 'cash', amountMinor: partA },
        { method: 'bkash', amountMinor: partB },
        { method: 'nagad', amountMinor: partC },
      ],
    },
  });
  check('Three-way split payment succeeds', split.status === 201, split.error);
  check('Split breakdown stored permanently', split.data?.payments?.length === 3, split.data?.payments);
  check(
    'Split amounts sum to the total',
    split.data?.payments?.reduce((s, p) => s + p.amountMinor, 0) === split.data?.totalMinor,
  );
  check('Split marks the sale paid', split.data?.paymentStatus === 'paid');

  const shortSplit = await api('/sales', {
    method: 'POST',
    token: admin.token,
    body: {
      items: [{ variantId: variant.variantId, quantity: 1 }],
      paymentMethod: 'cash',
      payments: [{ method: 'cash', amountMinor: 100 }],
    },
  });
  check('Under-allocated split is rejected', shortSplit.status === 422, shortSplit.error);

  const zeroRow = await api('/sales', {
    method: 'POST',
    token: admin.token,
    body: {
      items: [{ variantId: variant.variantId, quantity: 1 }],
      paymentMethod: 'cash',
      payments: [
        { method: 'cash', amountMinor: current.sellingPriceMinor },
        { method: 'bkash', amountMinor: 0 },
      ],
    },
  });
  check('Zero-amount payment row is rejected', zeroRow.status === 422, zeroRow.error);

  const negativeRow = await api('/sales', {
    method: 'POST',
    token: admin.token,
    body: {
      items: [{ variantId: variant.variantId, quantity: 1 }],
      paymentMethod: 'cash',
      payments: [
        { method: 'cash', amountMinor: current.sellingPriceMinor + 500 },
        { method: 'bkash', amountMinor: -500 },
      ],
    },
  });
  check('Negative payment row is rejected', negativeRow.status === 422);

  const dupMethod = await api('/sales', {
    method: 'POST',
    token: admin.token,
    body: {
      items: [{ variantId: variant.variantId, quantity: 1 }],
      paymentMethod: 'cash',
      payments: [
        { method: 'cash', amountMinor: 100 },
        { method: 'cash', amountMinor: current.sellingPriceMinor },
      ],
    },
  });
  check('Duplicate payment method is rejected', dupMethod.status === 422, dupMethod.error);

  // ------------------------------------------------------- receipt width
  section('Receipt width');
  for (const width of [58, 78, 80]) {
    const saved = await api('/stores/current', {
      method: 'PATCH',
      token: admin.token,
      body: { receipt: { paperWidthMm: width } },
    });
    check(`Store accepts ${width}mm receipt width`, saved.data?.receipt?.paperWidthMm === width, saved.error);

    const cfg = await api('/stores/pos-config', { token: cashier.token });
    check(`POS config reports ${width}mm to the cashier`, cfg.data?.receipt?.paperWidthMm === width);
  }
  const badWidth = await api('/stores/current', {
    method: 'PATCH',
    token: admin.token,
    body: { receipt: { paperWidthMm: 72 } },
  });
  check('Unsupported receipt width is rejected', badWidth.status === 422);
  await api('/stores/current', { method: 'PATCH', token: admin.token, body: { receipt: { paperWidthMm: 58 } } });

  // --------------------------------------------------------------- returns
  section('Returns');
  const returnable = await api(`/returns/returnable/${sale.data._id}`, { token: admin.token });
  check('Returnable view loads', returnable.success);
  check('Returnable quantity equals sold quantity', returnable.data?.items?.[0]?.returnableQuantity === SALE_QTY);

  const saleItemId = returnable.data.items[0].saleItemId;

  const noSaleReturn = await api('/returns', {
    method: 'POST',
    token: admin.token,
    body: { saleId: '000000000000000000000000', items: [{ saleItemId, quantity: 1 }] },
  });
  check('Return without a valid sale is rejected', noSaleReturn.status === 404, noSaleReturn.error);

  const excessive = await api('/returns', {
    method: 'POST',
    token: admin.token,
    body: { saleId: sale.data._id, items: [{ saleItemId, quantity: SALE_QTY + 1 }] },
  });
  check('Returning MORE than sold is rejected', excessive.status === 400, excessive.error);

  const zeroReturn = await api('/returns', {
    method: 'POST',
    token: admin.token,
    body: { saleId: sale.data._id, items: [{ saleItemId, quantity: 0 }] },
  });
  check('Return quantity 0 is rejected', zeroReturn.status === 422);

  // Read live stock immediately before the return rather than assuming it:
  // earlier sections sell varying amounts, and this check is about the DELTA
  // the return produces, not the absolute number.
  const preReturn = await api(`/products/pos-search?q=${encodeURIComponent(variant.sku)}`, { token: admin.token });
  const stockBeforeReturn = preReturn.data[0].stock;

  const partial = await api('/returns', {
    method: 'POST',
    token: admin.token,
    body: { saleId: sale.data._id, items: [{ saleItemId, quantity: 2 }], reason: 'Wrong size' },
  });
  check('Partial return (2 of 3) succeeds', partial.status === 201, partial.error);
  check('Return number assigned', partial.data?.returnNumber?.startsWith('RET-'));
  check('Refund uses the historical price', partial.data?.items?.[0]?.unitPriceMinor === listPrice);

  const afterReturn = await api(`/products/pos-search?q=${encodeURIComponent(variant.sku)}`, { token: admin.token });
  check(
    `Stock restored by the return (${stockBeforeReturn} -> ${stockBeforeReturn + 2})`,
    afterReturn.data[0]?.stock === stockBeforeReturn + 2,
    { expected: stockBeforeReturn + 2, actual: afterReturn.data[0]?.stock },
  );

  const returnable2 = await api(`/returns/returnable/${sale.data._id}`, { token: admin.token });
  check('Remaining returnable is now 1', returnable2.data?.items?.[0]?.returnableQuantity === 1);

  const excessive2 = await api('/returns', {
    method: 'POST',
    token: admin.token,
    body: { saleId: sale.data._id, items: [{ saleItemId, quantity: 2 }] },
  });
  check('Cannot return 2 more when only 1 remains', excessive2.status === 400, excessive2.error);

  const finalReturn = await api('/returns', {
    method: 'POST',
    token: admin.token,
    body: { saleId: sale.data._id, items: [{ saleItemId, quantity: 1 }] },
  });
  check('Final unit can be returned', finalReturn.status === 201, finalReturn.error);

  const duplicate = await api('/returns', {
    method: 'POST',
    token: admin.token,
    body: { saleId: sale.data._id, items: [{ saleItemId, quantity: 1 }] },
  });
  check('Duplicate return after full return is rejected', duplicate.status === 400, duplicate.error);

  // ------------------------------------------------------------ barcodes
  section('Barcodes');

  const gen1 = await api('/products/barcode/generate', { method: 'POST', token: admin.token });
  const gen2 = await api('/products/barcode/generate', { method: 'POST', token: admin.token });
  check('Barcode generated', /^\d{13}$/.test(gen1.data?.barcode ?? ''), gen1.data);
  check('Generated barcodes are unique', gen1.data?.barcode !== gen2.data?.barcode);

  // EAN-13 check digit must be valid or retail scanners reject the label.
  const validEan = (code) => {
    const digits = code.split('').map(Number);
    const sum = digits.slice(0, 12).reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
    return (10 - (sum % 10)) % 10 === digits[12];
  };
  check('Generated barcode has a valid EAN-13 check digit', validEan(gen1.data.barcode));

  const bcProduct = await api('/products', {
    method: 'POST',
    token: admin.token,
    body: {
      name: 'Barcode Test Tee',
      variants: [
        { attributes: [], sellingPriceMinor: 50000, stock: 5, barcode: gen1.data.barcode },
      ],
    },
  });
  check('Product created with a barcode', bcProduct.status === 201, bcProduct.error);

  const dupBarcode = await api('/products', {
    method: 'POST',
    token: admin.token,
    body: {
      name: 'Duplicate Barcode Tee',
      variants: [{ attributes: [], sellingPriceMinor: 50000, stock: 5, barcode: gen1.data.barcode }],
    },
  });
  check('Duplicate barcode is rejected', dupBarcode.status === 409, dupBarcode.error);

  const byBarcode = await api(`/products/pos-search?q=${gen1.data.barcode}`, { token: cashier.token });
  check('POS search finds the product by barcode', byBarcode.data?.length === 1, byBarcode.data);
  check('Barcode lookup returns the right variant', byBarcode.data?.[0]?.barcode === gen1.data.barcode);

  const cashierGen = await api('/products/barcode/generate', { method: 'POST', token: cashier.token });
  check('Cashier cannot generate barcodes', cashierGen.status === 403);

  // ---------------------------------------------------- inventory filters
  section('Inventory filtering & sorting');
  const catList = await api('/categories?limit=5', { token: admin.token });
  check('Categories load for the filter', catList.data?.length > 0);

  const byCategory = await api(`/inventory?categoryId=${catList.data[0]._id}&limit=50`, { token: admin.token });
  check('Inventory filters by category', byCategory.success, byCategory.error);

  const lowToHigh = await api('/inventory?sortBy=stockAsc&limit=10', { token: admin.token });
  const highToLow = await api('/inventory?sortBy=stockDesc&limit=10', { token: admin.token });
  const ascOk = lowToHigh.data.every((r, i, a) => i === 0 || a[i - 1].stock <= r.stock);
  const descOk = highToLow.data.every((r, i, a) => i === 0 || a[i - 1].stock >= r.stock);
  check('Sort stock low->high is ordered', ascOk);
  check('Sort stock high->low is ordered', descOk);

  const byName = await api('/inventory?sortBy=name&limit=10', { token: admin.token });
  check('Sort by name works', byName.success && byName.data.length > 0);

  const badSort = await api('/inventory?sortBy=notARealSort', { token: admin.token });
  check('Unknown sort key is rejected', badSort.status === 422);

  // ------------------------------------------------- historical integrity
  section('Historical data integrity');
  const productId = variant.productId;
  const originalSale = await api(`/sales/${sale.data._id}`, { token: admin.token });
  const originalName = originalSale.data.items[0].productNameSnapshot;
  const originalPrice = originalSale.data.items[0].unitPriceMinor;

  await api(`/products/${productId}`, {
    method: 'PATCH',
    token: admin.token,
    body: { name: 'RENAMED AFTER SALE' },
  });
  const variantsNow = await api(`/products/${productId}`, { token: admin.token });
  await api(`/products/${productId}/variants/${variant.variantId}`, {
    method: 'PATCH',
    token: admin.token,
    body: { sellingPriceMinor: 1 },
  });

  const afterEdit = await api(`/sales/${sale.data._id}`, { token: admin.token });
  check('Renaming the product did NOT change the old sale', afterEdit.data.items[0].productNameSnapshot === originalName, {
    was: originalName,
    now: afterEdit.data.items[0].productNameSnapshot,
  });
  check('Changing the price did NOT change the old sale', afterEdit.data.items[0].unitPriceMinor === originalPrice, {
    was: originalPrice,
    now: afterEdit.data.items[0].unitPriceMinor,
  });
  check('Product current name did update', variantsNow.data?.name === 'RENAMED AFTER SALE');

  const del = await api(`/products/${productId}`, { method: 'DELETE', token: admin.token });
  check('Product soft-deletes', del.success && del.data.softDeleted === true);

  const afterDelete = await api(`/sales/${sale.data._id}`, { token: admin.token });
  check('Deleting the product did NOT change the old sale', afterDelete.data.items[0].productNameSnapshot === originalName);
  check('Old sale still shows its price', afterDelete.data.items[0].unitPriceMinor === originalPrice);
  check('Old sale still shows its quantity', afterDelete.data.items[0].quantity === SALE_QTY);

  const deletedSearch = await api(`/products/pos-search?q=${encodeURIComponent(variant.sku)}`, { token: admin.token });
  check('Deleted product no longer sellable in POS', deletedSearch.data.length === 0);

  const sellDeleted = await api('/sales', {
    method: 'POST',
    token: admin.token,
    body: { items: [{ variantId: variant.variantId, quantity: 1 }], paymentMethod: 'cash' },
  });
  check('Cannot sell a deleted product', sellDeleted.status === 400, sellDeleted.error);

  // ------------------------------------------------------------- reporting
  section('Reports');
  const dash = await api('/reports/dashboard?preset=last30', { token: admin.token });
  check('Dashboard loads', dash.success);
  check('Order count is reported', dash.data?.summary?.orderCount > 0);
  check('Return amount is reported', dash.data?.summary?.returnAmountMinor > 0);
  check('Net sales = gross - returns', dash.data.summary.netSalesMinor === dash.data.summary.totalSalesMinor - dash.data.summary.returnAmountMinor);
  check('Top products present', Array.isArray(dash.data?.topProducts) && dash.data.topProducts.length > 0);
  check('Deleted product still appears in reports', dash.data.topProducts.some((p) => p.name === originalName));
  check('Sales by payment method present', dash.data?.byPaymentMethod?.length > 0);
  check('Sales by staff present', dash.data?.byStaff?.length > 0);
  check('Trend series present', Array.isArray(dash.data?.trend) && dash.data.trend.length > 0);

  const multiYear = await api('/reports/dashboard?preset=custom&from=2025-01-01&to=2026-08-25', { token: admin.token });
  check('Multi-year custom range works', multiYear.success && multiYear.data.summary.orderCount > 0);

  const cashierReports = await api('/reports/dashboard?preset=today', { token: cashier.token });
  check('Cashier without reports.view is blocked', cashierReports.status === 403);

  // ---------------------------------------------------------- permissions
  section('Permission enforcement on writes');
  const cashierCreateProduct = await api('/products', {
    method: 'POST',
    token: cashier.token,
    body: { name: 'Hack', variants: [{ sellingPriceMinor: 1000, attributes: [] }] },
  });
  check('Cashier cannot create products', cashierCreateProduct.status === 403);

  const cashierStaff = await api('/staff', { token: cashier.token });
  check('Cashier cannot list staff', cashierStaff.status === 403);

  const cashierAdjust = await api('/inventory/adjust', {
    method: 'POST',
    token: cashier.token,
    body: { variantId: variant.variantId, mode: 'delta', value: 100, reason: 'hack' },
  });
  check('Cashier cannot adjust stock', cashierAdjust.status === 403);

  const cashierPlatform = await api('/platform/tenants', { token: cashier.token });
  check('Tenant user cannot reach platform admin', cashierPlatform.status === 403);

  // ------------------------------------------------------ tenant isolation
  section('Tenant isolation');
  const other = await api('/auth/register', {
    method: 'POST',
    body: {
      businessName: `Isolation Test ${Date.now()}`,
      name: 'Other Owner',
      email: `iso${Date.now()}@example.com`,
      password: 'Password@123',
    },
  });
  check('Second tenant registers', other.status === 201, other.error);
  check('New tenant starts on a trial', other.data?.entitlement?.status === 'trial');
  check('New tenant must create a store', other.data?.needsStoreSetup === true);

  const otherToken = other.data.tokens.accessToken;
  const otherStore = await api('/stores', {
    method: 'POST',
    token: otherToken,
    body: { name: 'Isolation Store', currency: 'BDT' },
  });
  check('Second tenant creates its store', otherStore.status === 201, otherStore.error);

  const crossRead = await api(`/sales/${sale.data._id}`, { token: otherToken });
  check('Tenant B cannot read tenant A\'s sale', crossRead.status === 404, crossRead.error);

  const crossProducts = await api('/products', { token: otherToken });
  check('Tenant B sees an empty catalogue', crossProducts.success && crossProducts.data.length === 0);

  const crossHeader = await api('/products', { token: otherToken, storeId: admin.session.stores[0].id });
  check('Tenant B cannot borrow tenant A\'s store id', crossHeader.status === 403, crossHeader.error);

  const crossVariantSale = await api('/sales', {
    method: 'POST',
    token: otherToken,
    body: { items: [{ variantId: variant.variantId, quantity: 1 }], paymentMethod: 'cash' },
  });
  check('Tenant B cannot sell tenant A\'s stock', crossVariantSale.status === 400, crossVariantSale.error);

  // ------------------------------------------------------------- summary
  console.log(`\n==========  ${passed} passed, ${failed} failed  ==========`);
  if (failed > 0) {
    console.log('Failing checks:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('\nSmoke test crashed:', error);
  process.exit(1);
});
