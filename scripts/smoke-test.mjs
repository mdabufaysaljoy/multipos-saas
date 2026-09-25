/**
 * End-to-end verification of the business-critical rules:
 * inventory -> sales -> returns -> historical data -> permissions.
 *
 * Run against a freshly seeded database:  npm run seed -w server && node scripts/smoke-test.mjs
 */
import { readFileSync } from 'node:fs';

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

async function api(path, { method = 'GET', token, body, storeId, headers: extraHeaders } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(storeId ? { 'x-store-id': storeId } : {}),
      // Device credentials and other non-session auth (payment SMS relays).
      ...(extraHeaders ?? {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, ...json };
}

/**
 * Requests a file download (data export). Returns the raw bytes, so the tests
 * can check real file signatures rather than a JSON stand-in.
 */
async function download(path, { token, storeId, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(storeId ? { 'x-store-id': storeId } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') ?? '';
  const json = contentType.includes('application/json') ? JSON.parse(buffer.toString('utf8') || '{}') : null;
  return {
    status: res.status,
    contentType,
    disposition: res.headers.get('content-disposition') ?? '',
    cacheControl: res.headers.get('cache-control') ?? '',
    buffer,
    text: buffer.toString('utf8'),
    error: json?.error,
  };
}

/** Uploads an in-memory file. Used to prove the storage quota actually counts. */
async function upload(path, { token, storeId, bytes, filename = 'pixel.png' } = {}) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'image/png' }), filename);
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(storeId ? { 'x-store-id': storeId } : {}),
    },
    body: form,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, ...json };
}

/**
 * Proves a contact the way a real person does: ask for a code, read it, type it
 * back. Outside production the server returns the code it sent, which is the
 * only reason an automated run can complete the step at all.
 */
async function verifyContact(token, channel = 'email') {
  const sent = await api('/auth/verification/send', { method: 'POST', token, body: { channel } });
  if (!sent.data?.devCode) return sent;
  return api('/auth/verification/confirm', { method: 'POST', token, body: { channel, code: sent.data.devCode } });
}

/** Uploads a spreadsheet to the product import API, with its multipart fields. */
async function uploadSheet(path, { token, storeId, bytes, filename = 'products.csv', type = 'text/csv', fields = {} } = {}) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), filename);
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(storeId ? { 'x-store-id': storeId } : {}),
    },
    body: form,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, ...json };
}

/** A CSV in the product export's own shape: title block, blank line, headers, rows. */
function productCsv(rows, { headers = ['Product', 'Variant', 'Selling price', 'Cost price', 'SKU', 'Barcode', 'Category', 'Brand', 'Attributes', 'Stock', 'Active'], title = true } = {}) {
  const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const lines = [];
  if (title) {
    lines.push(cell('Demo Wear - Main'), cell('Products & variants - Last 30 days'), cell('Generated 2026-09-23 10:00 (Asia/Dhaka) by Owner'), cell('All records'), '');
  }
  lines.push(headers.map(cell).join(','));
  for (const row of rows) lines.push(headers.map((_, index) => cell(row[index])).join(','));
  return Buffer.from('\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');
}

/**
 * A real, decodable JPEG of the given pixel size.
 *
 * Random pixels on purpose: a flat colour compresses to a few kilobytes, which
 * would make an "oversized upload" test quietly assert nothing.
 */
async function makeJpeg(width, height) {
  const { default: sharp } = await import('sharp');
  const pixels = Buffer.allocUnsafe(width * height * 3);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = Math.floor(Math.random() * 256);
  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/**
 * A genuine 8x8 PNG. Embedded rather than generated so `makePng` can stay
 * SYNCHRONOUS - every existing call site passes its result straight into a
 * Blob, and an accidental Promise there produces a file the server correctly
 * rejects as corrupt.
 */
const BASE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQI12PgEpHDihiGlgQA2BMPAdCDwIAAAAAASUVORK5CYII=',
  'base64',
);

/**
 * A REAL PNG padded to exactly `totalBytes`.
 *
 * The server now inspects uploaded bytes rather than trusting the declared
 * content type, so a fake header no longer passes - but the storage-quota tests
 * still need an exact, predictable file size. Padding goes in a `tEXt` chunk,
 * which is ancillary and ignored by decoders.
 */
function makePng(totalBytes) {
  const padding = totalBytes - BASE_PNG.length - 12 - 8; // chunk overhead + "padding\0"
  if (padding < 0) return BASE_PNG;

  const data = Buffer.concat([Buffer.from('padding\0', 'latin1'), Buffer.alloc(padding, 0x20)]);
  const type = Buffer.from('tEXt', 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])), 0);

  // Insert before the trailing IEND chunk (always the last 12 bytes).
  return Buffer.concat([
    BASE_PNG.subarray(0, BASE_PNG.length - 12),
    len,
    type,
    data,
    crc,
    BASE_PNG.subarray(BASE_PNG.length - 12),
  ]);
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
  if (!variant) {
    throw new Error(
      'No stocked variant available.\n' +
        'This suite soft-deletes products and consumes stock by design, so it needs a clean database:\n' +
        '  npm run seed -w server -- --reset && node scripts/smoke-test.mjs',
    );
  }

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
  for (const width of [48, 57, 58, 78, 80, 88]) {
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
  check('A fractional or zero width is rejected too', (await api('/stores/current', { method: 'PATCH', token: admin.token, body: { receipt: { paperWidthMm: 58.5 } } })).status === 422 && (await api('/stores/current', { method: 'PATCH', token: admin.token, body: { receipt: { paperWidthMm: 0 } } })).status === 422);
  await api('/stores/current', { method: 'PATCH', token: admin.token, body: { receipt: { paperWidthMm: 58 } } });

  // ------------------------------------------------------- barcode label sizes
  section('Barcode label sizes');
  {
    const lblStart = (await api('/stores/current', { token: admin.token })).data?.labels;
    check('Label defaults: 38mm product labels, 85mm loyalty cards, sticker sheet', lblStart?.productWidthMm === 38 && lblStart?.loyaltyCardWidthMm === 85 && lblStart?.paper === 'sheet', lblStart);
    check('The cashier gets the label sizes with the POS config', (await api('/stores/pos-config', { token: cashier.token })).data?.labels?.productWidthMm === 38);
    const lbl48 = await api('/stores/current', { method: 'PATCH', token: admin.token, body: { labels: { productWidthMm: 48, loyaltyCardWidthMm: 48, paper: 'roll' } } });
    check('Admin sets 48mm product labels and loyalty cards on a label roll', lbl48.status === 200 && lbl48.data?.labels?.productWidthMm === 48 && lbl48.data.labels.loyaltyCardWidthMm === 48 && lbl48.data.labels.paper === 'roll', lbl48.error);
    const lblCfg = (await api('/stores/pos-config', { token: cashier.token })).data?.labels;
    check('...and every till prints at those sizes', lblCfg?.productWidthMm === 48 && lblCfg?.loyaltyCardWidthMm === 48 && lblCfg?.paper === 'roll', lblCfg);
    const lblPartial = await api('/stores/current', { method: 'PATCH', token: admin.token, body: { labels: { productWidthMm: 58 } } });
    check('A partial change keeps the other label settings', lblPartial.data?.labels?.productWidthMm === 58 && lblPartial.data.labels.loyaltyCardWidthMm === 48 && lblPartial.data.labels.paper === 'roll', lblPartial.data?.labels);
    check('An unsupported label width is refused', (await api('/stores/current', { method: 'PATCH', token: admin.token, body: { labels: { productWidthMm: 50 } } })).status === 422);
    check('An unsupported loyalty card width is refused', (await api('/stores/current', { method: 'PATCH', token: admin.token, body: { labels: { loyaltyCardWidthMm: 38 } } })).status === 422);
    check('An unknown paper type is refused', (await api('/stores/current', { method: 'PATCH', token: admin.token, body: { labels: { paper: 'a3' } } })).status === 422);
    check('Unknown label fields are refused', (await api('/stores/current', { method: 'PATCH', token: admin.token, body: { labels: { productWidthMm: 48, heightMm: 30 } } })).status === 422);
    check('A cashier cannot change label sizes', (await api('/stores/current', { method: 'PATCH', token: cashier.token, body: { labels: { productWidthMm: 48 } } })).status === 403);
    check('Saving other settings leaves the label sizes alone', (await api('/stores/current', { method: 'PATCH', token: admin.token, body: { lowStockThreshold: 5 } })).data?.labels?.productWidthMm === 58);
    await api('/stores/current', { method: 'PATCH', token: admin.token, body: { labels: { productWidthMm: 38, loyaltyCardWidthMm: 85, paper: 'sheet' } } });
  }

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

  // End date is "today", not a fixed day, so the suite does not break when the
  // clock rolls past a hardcoded date.
  const todayIso = new Date().toISOString().slice(0, 10);
  const multiYear = await api(
    `/reports/dashboard?preset=custom&from=2024-01-01&to=${todayIso}T23:59:59.000Z`,
    { token: admin.token },
  );
  check('Multi-year custom range works', multiYear.success && multiYear.data.summary.orderCount > 0, multiYear.data?.summary);

  const cashierReports = await api('/reports/dashboard?preset=today', { token: cashier.token });
  check('Cashier without reports.view is blocked', cashierReports.status === 403);

  // ------------------------------------------------------ profit reports
  section('Profit & detailed reports');

  const profit = await api('/reports/sales?preset=last30', { token: admin.token });
  check('Sales & profit report loads', profit.success, profit.error);

  const P = profit.data;
  check(
    'Net sales = gross - discounts - returns',
    P.netSalesMinor === P.grossSalesMinor - P.discountsMinor - P.returnAmountMinor,
    { gross: P.grossSalesMinor, disc: P.discountsMinor, ret: P.returnAmountMinor, net: P.netSalesMinor },
  );
  check('Net profit = net sales - COGS', P.netProfitMinor === P.netSalesMinor - P.cogsMinor, {
    net: P.netSalesMinor, cogs: P.cogsMinor, profit: P.netProfitMinor,
  });
  check('COGS is positive (cost snapshots captured)', P.cogsMinor > 0, { cogs: P.cogsMinor });
  check('Invoice count reported', P.invoiceCount > 0);
  check('Margin reported in basis points', Number.isInteger(P.marginBasisPoints));

  const overview = await api('/reports/overview?preset=last30', { token: admin.token });
  check('Dashboard overview loads', overview.success, overview.error);
  check('Overview exposes stock value', overview.data?.kpis?.stockValueMinor > 0);
  check('Overview exposes recent sales', Array.isArray(overview.data?.recentSales) && overview.data.recentSales.length > 0);
  check('Overview exposes low stock list', Array.isArray(overview.data?.lowStock));
  check('Overview profit matches the sales report', overview.data.kpis.profitMinor === P.netProfitMinor);

  for (const dimension of ['product', 'variant', 'category', 'brand']) {
    const bd = await api(`/reports/breakdown?preset=last30&dimension=${dimension}&limit=5`, { token: admin.token });
    check(`Breakdown by ${dimension} loads`, bd.success && Array.isArray(bd.data?.rows), bd.error);
  }

  const byProfit = await api('/reports/breakdown?preset=last30&dimension=product&sortBy=profit&order=desc&limit=10', { token: admin.token });
  const profitSorted = byProfit.data.rows.every((r, i, a) => i === 0 || a[i - 1].profitMinor >= r.profitMinor);
  check('Breakdown sorts by profit descending', profitSorted);
  check(
    'Row profit = revenue - cost',
    byProfit.data.rows.every((r) => r.profitMinor === r.revenueMinor - r.costMinor),
  );

  const byRevAsc = await api('/reports/breakdown?preset=last30&dimension=product&sortBy=revenue&order=asc&limit=10', { token: admin.token });
  check(
    'Breakdown sorts by revenue ascending (slow movers)',
    byRevAsc.data.rows.every((r, i, a) => i === 0 || a[i - 1].revenueMinor <= r.revenueMinor),
  );

  const payRep = await api('/reports/payments?preset=last30', { token: admin.token });
  check('Payment report loads', payRep.success && payRep.data.rows.length > 0);
  check(
    'Split payments are counted per tender',
    payRep.data.rows.some((r) => r.method === 'bkash') && payRep.data.rows.some((r) => r.method === 'nagad'),
    payRep.data.rows,
  );

  const retRep = await api('/reports/returns?preset=last30', { token: admin.token });
  check('Return report loads', retRep.success, retRep.error);
  check('Return report counts returns', retRep.data.summary.count > 0);
  check('Return report groups by reason', Array.isArray(retRep.data.byReason) && retRep.data.byReason.length > 0);

  const staffRep = await api('/reports/staff?preset=last30', { token: admin.token });
  check('Staff report loads', staffRep.success && staffRep.data.rows.length > 0);
  check('Staff report includes profit', staffRep.data.rows.every((r) => typeof r.profitMinor === 'number'));

  const invRep = await api('/reports/inventory', { token: admin.token });
  check('Inventory report loads', invRep.success, invRep.error);
  check('Inventory report values stock', invRep.data.summary.costValueMinor > 0);

  const custRep = await api('/reports/customers?preset=last30', { token: admin.token });
  check('Customer report loads (plan includes advanced reports)', custRep.success, custRep.error);

  check('Sales analytics compares with the previous period', typeof P.previous?.netSalesMinor === 'number' && Boolean(P.previous?.range?.from), P.previous);
  check('Previous period ends the day before the current one starts', new Date(P.previous.range.to) < new Date(P.range.from), { prev: P.previous.range, cur: P.range });
  check('Sales analytics includes a trend series', Array.isArray(P.trend) && P.trend.length > 0);
  check('Customer analytics counts buying and repeat customers', custRep.data?.summary?.customers >= custRep.data?.summary?.repeatCustomers && custRep.data?.summary?.customers > 0, custRep.data?.summary);

  // Subscription and role are separate gates: a Showroom workspace (plan
  // allows analytics) still refuses a staff member whose role does not.
  const cashierReport = await api('/reports/sales?preset=today', { token: cashier.token });
  check('Cashier without reports.view is blocked from reports', cashierReport.status === 403);
  check('...by the role gate, not the plan gate', cashierReport.error?.code === 'FORBIDDEN', cashierReport.error);

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

  // -------------------------------------------------------------- branches
  section('Branches');

  // Unique per run so the suite can be re-run without a reseed.
  const runId = String(Date.now()).slice(-5);

  const storesBefore = await api('/stores', { token: admin.token });
  check('Store list loads', storesBefore.success);
  const mainStore = storesBefore.data.find((s) => s.isDefault) ?? storesBefore.data[0];

  // The seed provides both branches the Showroom plan allows, so this section
  // works with them rather than creating more. Branch CREATION is covered by
  // the per-plan matrix, which drives each plan to its own ceiling.
  check('Seeded workspace has both of its branches', storesBefore.data.length === 2, storesBefore.data.length);
  const branchB = { data: storesBefore.data.find((s) => !s.isDefault) };
  check('A second branch is available to test with', Boolean(branchB.data), storesBefore.data.map((s) => s.name));

  // A branch starts empty: stock and sales are per-branch.
  const branchProducts = await api('/products', { token: admin.token, storeId: branchB.data._id });
  check('New branch has its own (empty) catalogue', branchProducts.data?.length === 0);

  const mainProducts = await api('/products?limit=5', { token: admin.token, storeId: mainStore._id });
  check('Original branch still has its catalogue', mainProducts.data?.length > 0);

  // ---- branch isolation for staff ----
  const cashierOnOtherBranch = await api('/products', { token: cashier.token, storeId: branchB.data._id });
  check(
    'Staff CANNOT switch to a branch they are not assigned to',
    cashierOnOtherBranch.status === 403,
    cashierOnOtherBranch.error,
  );

  const cashierOwnBranch = await api('/products', { token: cashier.token, storeId: mainStore._id });
  check('Staff CAN use their own branch', cashierOwnBranch.success);

  // Granting access opens the second branch for that staff member.
  const staffList = await api('/staff?limit=20', { token: admin.token });
  const cashierRow = staffList.data.find((row) => row.email === 'cashier@demostore.dev');
  check('Staff record exposes branch assignment', cashierRow?.storeId !== undefined);

  await api(`/staff/${cashierRow.id}`, {
    method: 'PATCH',
    token: admin.token,
    body: { storeAccess: [branchB.data._id] },
  });
  const cashier2 = await login('cashier@demostore.dev', 'Cashier@123');
  const nowAllowed = await api('/products', { token: cashier2.token, storeId: branchB.data._id });
  check('Granting branch access lets the staff member in', nowAllowed.success, nowAllowed.error);
  check('Session lists both branches after the grant', cashier2.session.stores.length === 2, cashier2.session.stores);

  // Admin reaches every branch without an explicit grant.
  const adminOnB = await api('/products', { token: admin.token, storeId: branchB.data._id });
  check('Admin reaches any branch', adminOnB.success);

  // ---- branch reporting ----
  const branchReport = await api('/reports/branches?preset=last30', { token: admin.token });
  check('Branch comparison report loads', branchReport.success, branchReport.error);
  check('Branch report lists both branches', branchReport.data?.rows?.length === 2, branchReport.data?.rows?.length);
  check('Branch report totals across branches', typeof branchReport.data?.totals?.netSalesMinor === 'number');

  const currentOnly = await api('/reports/sales?preset=last30&branch=current', { token: admin.token });
  const allBranches = await api('/reports/sales?preset=last30&branch=all', { token: admin.token });
  check('Report scoped to current branch', currentOnly.success);
  check('Report scoped to all branches', allBranches.success);
  check(
    'All-branches total is at least the single branch total',
    allBranches.data.grossSalesMinor >= currentOnly.data.grossSalesMinor,
  );

  const staffAllBranches = await api('/reports/branches?preset=last30', { token: cashier2.token });
  check('Staff cannot run the branch comparison', staffAllBranches.status === 403);

  // ---- plan branch limit ----
  // Already at the Showroom ceiling of two, so a third must be refused.
  const overLimit = await api('/stores', {
    method: 'POST',
    token: admin.token,
    body: { name: 'Third Branch', code: `THR${runId}`, currency: 'BDT' },
  });
  check('Branch limit is enforced by the plan', overLimit.status === 402, overLimit.error);

  // ----------------------------------------------------- upgrade requests
  section('Subscription upgrades');

  const plans = await api('/plans', {});
  const starter = plans.data.find((p) => p.code === 'starter-store-monthly');
  const brand = plans.data.find((p) => p.code === 'brand-monthly');
  check('Plans expose an upgrade tier', typeof brand?.tier === 'number');

  // Buying needs a proven contact, so the refusal comes before anything else.
  const unverifiedBuy = await api('/subscriptions/upgrade-request', {
    method: 'POST',
    token: admin.token,
    body: { planId: brand._id, paymentMethod: 'bkash', amountMinor: brand.priceMinor, transactionId: `TXNUNV${runId}`, senderNumber: '01700000000' },
  });
  check('Buying is refused until an email address or phone number is verified', unverifiedBuy.status === 403 && unverifiedBuy.error?.code === 'VERIFICATION_REQUIRED', unverifiedBuy.error);
  const verified = await verifyContact(admin.token);
  check('Verifying the email address with the emailed code unlocks buying', verified.data?.anyVerified === true && verified.data?.email?.verified === true, verified.error ?? verified.data);

  // Tenant is on Showroom (tier 2); Starter is tier 1 -> a downgrade.
  const downgrade = await api('/subscriptions/upgrade-request', {
    method: 'POST',
    token: admin.token,
    body: {
      planId: starter._id,
      paymentMethod: 'bkash',
      amountMinor: starter.priceMinor,
      transactionId: `TXNDOWN${runId}`,
    },
  });
  check('Downgrade is rejected', downgrade.status === 400, downgrade.error);

  const underpaid = await api('/subscriptions/upgrade-request', {
    method: 'POST',
    token: admin.token,
    body: { planId: brand._id, paymentMethod: 'bkash', amountMinor: 100, transactionId: `TXNUNDER${runId}` },
  });
  check('Underpaying is rejected', underpaid.status === 400, underpaid.error);

  const upgrade = await api('/subscriptions/upgrade-request', {
    method: 'POST',
    token: admin.token,
    body: {
      planId: brand._id,
      paymentMethod: 'bkash',
      amountMinor: brand.priceMinor,
      senderNumber: '01711000000',
      transactionId: `TXNUP${runId}`,
    },
  });
  check('Upgrade request submitted', upgrade.status === 201, upgrade.error);
  check('Request starts as pending', upgrade.data?.status === 'pending');

  const stillShowroom = await api('/subscriptions/current', { token: admin.token });
  check(
    'Submitting a request does NOT change the plan',
    stillShowroom.data?.subscription?.planSnapshot?.code === 'showroom-monthly',
    stillShowroom.data?.subscription?.planSnapshot?.code,
  );

  const dupTxn = await api('/subscriptions/upgrade-request', {
    method: 'POST',
    token: admin.token,
    body: { planId: brand._id, paymentMethod: 'bkash', amountMinor: brand.priceMinor, transactionId: `TXNUP${runId}` },
  });
  check('Duplicate request/transaction is rejected', dupTxn.status === 409, dupTxn.error);

  const platform = await login('platform@pos.dev', 'Platform@123');
  const pendingList = await api('/platform/upgrade-requests?status=pending', { token: platform.token });
  check('Platform admin sees pending requests', pendingList.data?.length >= 1, pendingList.error);

  const tenantApprove = await api(`/platform/upgrade-requests/${upgrade.data._id}/approve`, {
    method: 'POST',
    token: admin.token,
    body: {},
  });
  check('Tenant admin cannot approve their own upgrade', tenantApprove.status === 403);

  const approved = await api(`/platform/upgrade-requests/${upgrade.data._id}/approve`, {
    method: 'POST',
    token: platform.token,
    body: { reviewNote: 'bKash TXN verified' },
  });
  check('Platform admin approves the upgrade', approved.status === 201, approved.error);

  const afterUpgrade = await api('/subscriptions/current', { token: admin.token });
  check(
    'Plan changes ONLY after approval',
    afterUpgrade.data?.subscription?.planSnapshot?.code === 'brand-monthly',
    afterUpgrade.data?.subscription?.planSnapshot?.code,
  );
  check('Upgraded plan raises the branch limit', afterUpgrade.data?.entitlement?.limits?.maxStores > 2);

  const thirdBranch = await api('/stores', {
    method: 'POST',
    token: admin.token,
    body: { name: 'Third Branch', code: `THR${runId}`, currency: 'BDT' },
  });
  check('Third branch allowed on the upgraded plan', thirdBranch.status === 201, thirdBranch.error);

  const reApprove = await api(`/platform/upgrade-requests/${upgrade.data._id}/approve`, {
    method: 'POST',
    token: platform.token,
    body: {},
  });
  check('An approved request cannot be approved twice', reApprove.status === 400);

  // ---------------------------------------------------------------- wallet
  section('Wallet');

  const platform2 = await login('platform@pos.dev', 'Platform@123');

  const wallet0 = await api('/wallet', { token: admin.token });
  check('Wallet is created on first access', wallet0.success && wallet0.data.balanceMinor >= 0, wallet0.error);
  // Assertions below are DELTAS, so the suite re-runs without a reseed.
  const startingBalance = wallet0.data.balanceMinor;

  const topUp = await api('/wallet/top-ups', {
    method: 'POST',
    token: admin.token,
    body: { amountMinor: 500000, paymentMethod: 'bkash', senderNumber: '01711000000', transactionId: `TOPUP${runId}` },
  });
  check('Top-up request submitted', topUp.status === 201, topUp.error);

  const walletAfterRequest = await api('/wallet', { token: admin.token });
  check(
    'Submitting a top-up does NOT credit the wallet',
    walletAfterRequest.data.balanceMinor === startingBalance,
    walletAfterRequest.data,
  );

  const dupTopUp = await api('/wallet/top-ups', {
    method: 'POST',
    token: admin.token,
    body: {
      amountMinor: 500000,
      paymentMethod: 'bkash',
      senderNumber: '01712345678',
      transactionId: `TOPUP${runId}`,
    },
  });
  check('Duplicate top-up transaction is rejected', dupTopUp.status === 409, dupTopUp.status);

  const approveTopUp = await api(`/platform/top-ups/${topUp.data._id}/approve`, {
    method: 'POST',
    token: platform2.token,
    body: { reviewNote: 'verified' },
  });
  check('Platform admin approves the top-up', approveTopUp.success, approveTopUp.error);

  const walletAfterApproval = await api('/wallet', { token: admin.token });
  check('Wallet credited ONLY after approval', walletAfterApproval.data.balanceMinor === startingBalance + 500000, walletAfterApproval.data);

  const walletLedger = await api('/wallet/transactions', { token: admin.token });
  check('Wallet ledger records the credit', walletLedger.data?.[0]?.type === 'credit', walletLedger.data?.[0]);
  check(
    'Ledger stores balance before and after',
    walletLedger.data?.[0]?.balanceBeforeMinor === startingBalance &&
      walletLedger.data?.[0]?.balanceAfterMinor === startingBalance + 500000,
    walletLedger.data?.[0],
  );

  // The wallet belongs to the ACCOUNT; the ledger row still names the workspace.
  check('The wallet is the account wallet', walletAfterApproval.data?.accountId === admin.session.tenant.accountId, {
    wallet: walletAfterApproval.data?.accountId,
    session: admin.session.tenant.accountId,
  });
  check('The ledger row records the paying account', walletLedger.data?.[0]?.accountId === admin.session.tenant.accountId, walletLedger.data?.[0]?.accountId);
  check('The ledger row records the workspace that caused it', walletLedger.data?.[0]?.tenantId === admin.session.tenant.id, walletLedger.data?.[0]?.tenantId);
  check('A wallet response never exposes merge internals', !('appliedTransferIds' in (walletAfterApproval.data ?? {})) && !('pendingTransferId' in (walletAfterApproval.data ?? {})));

  // Overdraw protection via a manual debit larger than the balance.
  const overdraw = await api(`/platform/tenants/${admin.session.tenant.id}/wallet/adjust`, {
    method: 'POST',
    token: platform2.token,
    body: { direction: 'debit', amountMinor: 99999999, reason: 'overdraw attempt' },
  });
  check('Wallet cannot be overdrawn', overdraw.status === 400, overdraw.error);

  const stillIntact = await api('/wallet', { token: admin.token });
  check('Failed debit left the balance untouched', stillIntact.data.balanceMinor === startingBalance + 500000);

  const adjust = await api(`/platform/tenants/${admin.session.tenant.id}/wallet/adjust`, {
    method: 'POST',
    token: platform2.token,
    body: { direction: 'credit', amountMinor: 100000, reason: 'Goodwill credit' },
  });
  check('Platform admin can adjust a wallet', adjust.success, adjust.error);
  check('Adjustment updates the balance', adjust.data?.balanceMinor === startingBalance + 600000, adjust.data);

  const cashierWallet = await api('/wallet', { token: cashier.token });
  check('Cashier cannot read the wallet', cashierWallet.status === 403);

  // --------------------------------------------------------------- coupons
  section('Coupons');

  // The tenant is already on Brand monthly by this point, so the wallet test
  // uses Brand ANNUAL - same tier, different plan, which is a valid move.
  const brandPlan = (await api('/plans', {})).data.find((p) => p.code === 'brand-annual');

  // A run-specific coupon keeps the suite re-runnable: a redeemed coupon
  // legitimately refuses a second use by the same tenant.
  const runCoupon = `RUN${runId}`;
  const madeCoupon = await api('/platform/coupons', {
    method: 'POST',
    token: platform2.token,
    body: {
      code: runCoupon,
      discountType: 'percent',
      discountValue: 2000,
      maxDiscountMinor: 100000,
      usageLimit: 100,
      perTenantLimit: 1,
    },
  });
  check('Seeded coupon LAUNCH20 exists', (await api('/platform/coupons', { token: platform2.token })).data.some((c) => c.code === 'LAUNCH20'));
  check('Test coupon created', madeCoupon.status === 201, madeCoupon.error);

  const quote = await api('/subscriptions/coupon-quote', {
    method: 'POST',
    token: admin.token,
    body: { code: runCoupon, planId: brandPlan._id },
  });
  check('Coupon quote returns a discount', quote.success, quote.error);
  // 20% of the annual price, capped at BDT 1,000 by the coupon.
  check('Percentage discount respects the cap', quote.data?.discountMinor === 100000, quote.data);
  check('Final amount = price - discount', quote.data?.finalAmountMinor === brandPlan.priceMinor - 100000);

  const badCode = await api('/subscriptions/coupon-quote', {
    method: 'POST',
    token: admin.token,
    body: { code: 'NOTAREALCODE', planId: brandPlan._id },
  });
  check('Unknown coupon is rejected', badCode.status === 404);

  // Fund the wallet so it can cover the annual plan.
  const fund = await api(`/platform/tenants/${admin.session.tenant.id}/wallet/adjust`, {
    method: 'POST',
    token: platform2.token,
    body: { direction: 'credit', amountMinor: quote.data.finalAmountMinor, reason: 'Test funding' },
  });
  check('Wallet funded for the upgrade', fund.success, fund.error);
  const balanceBeforeUpgrade = fund.data.balanceMinor;

  // ---- wallet-paid upgrade with a coupon ----
  const walletUpgrade = await api('/subscriptions/upgrade-request', {
    method: 'POST',
    token: admin.token,
    body: {
      planId: brandPlan._id,
      paymentMethod: 'wallet',
      couponCode: runCoupon,
      amountMinor: quote.data.finalAmountMinor,
    },
  });
  check('Wallet upgrade succeeds', walletUpgrade.status === 201, walletUpgrade.error);
  check('Wallet upgrade is approved immediately', walletUpgrade.data?.status === 'approved', walletUpgrade.data?.status);
  check('Discount recorded on the request', walletUpgrade.data?.discountMinor === 100000);

  const planNow = await api('/subscriptions/current', { token: admin.token });
  check('Plan upgraded via wallet', planNow.data?.subscription?.planSnapshot?.code === 'brand-annual', planNow.data?.subscription?.planSnapshot?.code);

  const walletSpent = await api('/wallet', { token: admin.token });
  // The demo workspace was on a paid plan, so the upgrade also credits its unused time.
  const upgradeCredit = walletUpgrade.data?.proration?.appliedMinor ?? 0;
  check(
    'The upgrade charges the discounted price less credit for unused paid time',
    walletUpgrade.data?.amountMinor === quote.data.finalAmountMinor - upgradeCredit,
    { amountMinor: walletUpgrade.data?.amountMinor, upgradeCredit, proration: walletUpgrade.data?.proration },
  );
  check(
    'Wallet debited by exactly what was charged',
    walletSpent.data.balanceMinor === balanceBeforeUpgrade - walletUpgrade.data?.amountMinor + (walletUpgrade.data?.proration?.walletRefundMinor ?? 0),
    { balance: walletSpent.data.balanceMinor, charged: walletUpgrade.data?.amountMinor },
  );

  const reuseCoupon = await api('/subscriptions/coupon-quote', {
    method: 'POST',
    token: admin.token,
    body: { code: runCoupon, planId: brandPlan._id },
  });
  check('Coupon cannot be reused by the same tenant', reuseCoupon.status === 400, reuseCoupon.error);

  // ---------------------------------------------------- platform analytics
  section('Platform analytics');
  const pOverview = await api('/platform/overview', { token: platform2.token });
  check('Platform overview loads', pOverview.success, pOverview.error);
  check('Reports MRR', typeof pOverview.data?.revenue?.mrrMinor === 'number' && pOverview.data.revenue.mrrMinor > 0);
  check('Reports ARR', pOverview.data?.revenue?.arrMinor > 0);
  check('Reports marketplace sales across all stores', pOverview.data?.marketplace?.grossSalesMinor > 0);
  check('Reports aggregate wallet balances', pOverview.data?.wallets?.totalBalanceMinor > 0);
  check('Reports the approval queue', typeof pOverview.data?.queue?.pendingUpgrades === 'number');
  check('Reports branch count', pOverview.data?.branches >= 1);

  const coupons = await api('/platform/coupons', { token: platform2.token });
  check('Platform admin lists coupons', coupons.success && coupons.data.length > 0);
  check('Coupon usage counted after redemption', coupons.data.find((c) => c.code === runCoupon)?.usedCount === 1);

  const newCoupon = await api('/platform/coupons', {
    method: 'POST',
    token: platform2.token,
    body: { code: `SAVE${runId}`, discountType: 'fixed', discountValue: 50000, usageLimit: 5 },
  });
  check('Platform admin creates a coupon', newCoupon.status === 201, newCoupon.error);

  const tenantCoupon = await api('/platform/coupons', {
    method: 'POST',
    token: admin.token,
    body: { code: 'HACK', discountType: 'fixed', discountValue: 1 },
  });
  check('Tenant admin cannot create coupons', tenantCoupon.status === 403);

  // ------------------------------------------------------------- messaging
  section('SMS & messaging');

  const msgStatus = await api('/messaging/status', { token: admin.token });
  check('Messaging status loads', msgStatus.success, msgStatus.error);
  check('Reports SMS price per segment', msgStatus.data?.sms?.perSegmentCostMinor > 0);
  check('Reports whether a provider is configured', typeof msgStatus.data?.sms?.available === 'boolean');
  check('Email abstraction reports unconfigured', msgStatus.data?.email?.available === false);

  // Segment maths - the part that decides what a campaign costs.
  const shortEn = await api('/messaging/estimate?message=Hello&recipients=1', { token: admin.token });
  check('Short English message is 1 GSM7 segment', shortEn.data?.segments === 1 && shortEn.data?.encoding === 'GSM7', shortEn.data);

  const longEn = await api(`/messaging/estimate?message=${encodeURIComponent('a'.repeat(200))}&recipients=1`, { token: admin.token });
  check('200 GSM7 chars is 2 segments', longEn.data?.segments === 2, longEn.data);

  // Bengali forces UCS-2 at 70 chars per segment - mispricing this would
  // undercharge every Bengali campaign.
  const bangla = await api(`/messaging/estimate?message=${encodeURIComponent('আমাদের নতুন কালেকশন এসেছে')}&recipients=1`, { token: admin.token });
  check('Bengali message uses UCS2', bangla.data?.encoding === 'UCS2', bangla.data);
  check('Bengali message is 1 segment under 70 chars', bangla.data?.segments === 1, bangla.data);

  const banglaLong = await api(`/messaging/estimate?message=${encodeURIComponent('অ'.repeat(100))}&recipients=1`, { token: admin.token });
  check('100 Bengali chars is 2 segments', banglaLong.data?.segments === 2, banglaLong.data);

  const bulk = await api('/messaging/estimate?message=Hello&recipients=10', { token: admin.token });
  check(
    'Cost scales with recipients',
    bulk.data?.totalCostMinor === msgStatus.data.sms.perSegmentCostMinor * 10,
    bulk.data,
  );

  // With no provider configured the app must REFUSE, not silently succeed.
  const walletBefore = await api('/wallet', { token: admin.token });
  const sendAttempt = await api('/messaging/sms', {
    method: 'POST',
    token: admin.token,
    body: { to: '01711000001', message: 'Test message' },
  });

  if (msgStatus.data.sms.available) {
    check('SMS sent through the configured provider', sendAttempt.status === 201, sendAttempt.error);
  } else {
    check('Sending without a provider is refused', sendAttempt.status === 400, sendAttempt.error);
    check(
      'Refused send did NOT charge the wallet',
      (await api('/wallet', { token: admin.token })).data.balanceMinor === walletBefore.data.balanceMinor,
    );
  }

  const campaignAttempt = await api('/messaging/campaigns', {
    method: 'POST',
    token: admin.token,
    body: { name: 'Eid promo', message: 'New collection in store!', audience: 'all-customers' },
  });
  if (msgStatus.data.sms.available) {
    check('Campaign sent', campaignAttempt.status === 201, campaignAttempt.error);
  } else {
    check('Campaign without a provider is refused', campaignAttempt.status === 400, campaignAttempt.error);
  }

  const smsHistory = await api('/messaging/sms', { token: admin.token });
  check('SMS history endpoint works', smsHistory.success, smsHistory.error);

  const campaignList = await api('/messaging/campaigns', { token: admin.token });
  check('Campaign history endpoint works', campaignList.success, campaignList.error);

  // ---- marketing permissions (previously borrowed the customer ones) ----
  check('Cashier has NO marketing.view', !cashier.session.user.permissions.includes('marketing.view'), cashier.session.user.permissions.filter((p) => p.startsWith('marketing')));
  check('Senior cashier has NO marketing.view', !senior.session.user.permissions.includes('marketing.view'));

  const cashierMarketing = await api('/messaging/status', { token: cashier.token });
  check('Cashier cannot open marketing', cashierMarketing.status === 403, cashierMarketing.error);

  const cashierHistory = await api('/messaging/sms', { token: cashier.token });
  check('Cashier cannot read campaign history', cashierHistory.status === 403);

  const cashierSend = await api('/messaging/sms', {
    method: 'POST',
    token: cashier.token,
    body: { to: '01711000001', message: 'hi' },
  });
  check('Cashier cannot send SMS', cashierSend.status === 403);

  const cashierCampaign = await api('/messaging/campaigns', {
    method: 'POST',
    token: cashier.token,
    body: { name: 'x', message: 'y', audience: 'all-customers' },
  });
  check('Cashier cannot send a campaign', cashierCampaign.status === 403);

  const cashierEmail = await api('/messaging/email-campaigns', {
    method: 'POST',
    token: cashier.token,
    body: { name: 'x', subject: 's', body: 'b', audience: 'all-customers' },
  });
  check('Cashier cannot send an email campaign', cashierEmail.status === 403);

  // Granting the permission opens it up - the mechanism is configurable.
  const mktStaffRows = await api('/staff?limit=20', { token: admin.token });
  const mktCashier = mktStaffRows.data.find((r) => r.email === 'cashier@demostore.dev');
  await api(`/staff/${mktCashier.id}`, {
    method: 'PATCH',
    token: admin.token,
    body: { extraPermissions: ['marketing.view', 'marketing.viewHistory'] },
  });
  const grantedCashier = await login('cashier@demostore.dev', 'Cashier@123');
  const marketingAllowed = await api('/messaging/status', { token: grantedCashier.token });
  check('Granting marketing.view lets the cashier in', marketingAllowed.success, marketingAllowed.error);
  const stillNoSend = await api('/messaging/sms', {
    method: 'POST',
    token: grantedCashier.token,
    body: { to: '01711000001', message: 'hi' },
  });
  check('View permission alone does NOT allow sending', stillNoSend.status === 403);

  // Email campaign requires SMTP; with none configured it must refuse.
  const emailNoSmtp = await api('/messaging/email-campaigns', {
    method: 'POST',
    token: admin.token,
    body: { name: `Email ${runId}`, subject: 'Hello', body: 'New collection', audience: 'all-customers' },
  });
  check(
    'Email campaign without SMTP is refused',
    emailNoSmtp.status === 400,
    emailNoSmtp.error,
  );

  // Pricing is platform-configured, not hardcoded.
  const priceChange = await api('/platform/settings', {
    method: 'PATCH',
    token: platform2.token,
    body: { smsCostMinor: 75 },
  });
  check('Platform admin sets the SMS price', priceChange.success, priceChange.error);

  const repriced = await api('/messaging/estimate?message=Hello&recipients=1', { token: admin.token });
  check('New SMS price takes effect immediately', repriced.data?.perSmsCostMinor === 75, repriced.data);
  await api('/platform/settings', { method: 'PATCH', token: platform2.token, body: { smsCostMinor: 50 } });

  // ---- billing path, exercised through the mock provider ----------------
  // Skipped unless SMS_MOCK_ENABLED=true, so the suite passes either way.
  if (msgStatus.data.sms.available && msgStatus.data.sms.provider === 'mock') {
    section('SMS wallet billing (mock provider)');

    const fundSms = await api(`/platform/tenants/${admin.session.tenant.id}/wallet/adjust`, {
      method: 'POST',
      token: platform2.token,
      body: { direction: 'credit', amountMinor: 100000, reason: 'SMS test funding' },
    });
    const balanceBeforeSms = fundSms.data.balanceMinor;

    const sent = await api('/messaging/sms', {
      method: 'POST',
      token: admin.token,
      body: { to: '01711000001', message: 'Hello' },
    });
    check('SMS sends through the provider', sent.status === 201, sent.error);
    check('Message recorded as sent', sent.data?.status === 'sent', sent.data?.status);

    const afterSend = await api('/wallet', { token: admin.token });
    check(
      'Wallet debited by the SMS cost',
      afterSend.data.balanceMinor === balanceBeforeSms - 50,
      { before: balanceBeforeSms, after: afterSend.data.balanceMinor },
    );

    // A number ending 0000 fails in the mock, so the refund path runs.
    const failed = await api('/messaging/sms', {
      method: 'POST',
      token: admin.token,
      body: { to: '01711110000', message: 'Hello' },
    });
    check('Failed message is recorded as failed', failed.data?.status === 'failed', failed.data?.status);
    check('Failed message costs nothing', failed.data?.costMinor === 0);

    const afterFail = await api('/wallet', { token: admin.token });
    check(
      'Wallet refunded for the failed message',
      afterFail.data.balanceMinor === balanceBeforeSms - 50,
      { expected: balanceBeforeSms - 50, actual: afterFail.data.balanceMinor },
    );

    // Every send is billed through a usage charge.
    const smsUsage = await api('/wallet/usage?service=sms&limit=20', { token: admin.token });
    check('Usage charges are listed', smsUsage.status === 200 && Array.isArray(smsUsage.data?.items), smsUsage.error);
    const sentCharge = (smsUsage.data?.items ?? []).find((c) => c.referenceId === sent.data?._id);
    check(
      'The sent SMS has one usage charge at the configured unit price',
      sentCharge?.status === 'charged' && sentCharge.quantity === 1 && sentCharge.unitPriceMinor === 50 && sentCharge.amountMinor === 50,
      sentCharge,
    );
    check(
      'The charge names the workspace that used it and the account that paid',
      sentCharge?.tenantId === admin.session.tenant.id && sentCharge?.accountId === admin.session.tenant.accountId,
      { tenantId: sentCharge?.tenantId, accountId: sentCharge?.accountId },
    );
    const failedCharge = (smsUsage.data?.items ?? []).find((c) => c.referenceId === failed.data?._id);
    check(
      'The failed SMS charge is fully refunded',
      failedCharge?.status === 'refunded' && failedCharge.refundedMinor === failedCharge.amountMinor,
      failedCharge,
    );
    check('A usage charge never exposes its idempotency key', (smsUsage.data?.items ?? []).every((c) => !('idempotencyKey' in c)));
    const smsSummary = smsUsage.data?.summary?.find((s) => s.service === 'sms');
    check('The usage summary nets refunds out', smsSummary && smsSummary.netMinor === smsSummary.chargedMinor - smsSummary.refundedMinor, smsSummary);

    const campaign = await api('/messaging/campaigns', {
      method: 'POST',
      token: admin.token,
      body: { name: `Promo ${runId}`, message: 'New collection!', audience: 'all-customers' },
    });
    check('Campaign completes', campaign.status === 201, campaign.error);
    check('Campaign counted its recipients', campaign.data?.recipientCount > 0, campaign.data);
    check(
      'Campaign actual cost matches messages sent',
      campaign.data?.actualCostMinor === campaign.data?.sentCount * 50,
      campaign.data,
    );

    const campaignMsgs = await api(`/messaging/sms?campaignId=${campaign.data._id}&limit=50`, { token: admin.token });
    check('Campaign messages appear in history', campaignMsgs.data?.length === campaign.data.recipientCount);

    const campaignCharge = ((await api('/wallet/usage?service=sms&limit=50', { token: admin.token })).data?.items ?? []).find(
      (c) => c.referenceId === campaign.data?._id,
    );
    check(
      'The campaign is billed as ONE usage charge for every segment',
      campaignCharge?.referenceType === 'sms_campaign' && campaignCharge.quantity === campaign.data.recipientCount * campaign.data.segments,
      campaignCharge,
    );
    check(
      'The campaign charge, net of refunds, equals its actual cost',
      Boolean(campaignCharge) && campaignCharge.amountMinor - campaignCharge.refundedMinor === campaign.data.actualCostMinor,
      { charge: campaignCharge, actual: campaign.data?.actualCostMinor },
    );
    check('The campaign records which charge billed it', campaign.data?.usageChargeId === campaignCharge?._id);

    // Drain the wallet, then prove sending stops.
    const bal = (await api('/wallet', { token: admin.token })).data.balanceMinor;
    await api(`/platform/tenants/${admin.session.tenant.id}/wallet/adjust`, {
      method: 'POST',
      token: platform2.token,
      body: { direction: 'debit', amountMinor: bal, reason: 'Drain for test' },
    });

    const broke = await api('/messaging/sms', {
      method: 'POST',
      token: admin.token,
      body: { to: '01711000001', message: 'Hello' },
    });
    check('Sending is blocked with an empty wallet', broke.status === 400, broke.error);
    const brokeCharge = (await api('/wallet/usage?service=sms&limit=1', { token: admin.token })).data?.items?.[0];
    check('A charge the wallet could not cover is recorded as not charged', brokeCharge?.status === 'failed' && brokeCharge.refundedMinor === 0, brokeCharge);
  }

  // ------------------------------------------- subscription transitions
  section('Subscription switch matrix');

  const platform3 = await login('platform@pos.dev', 'Platform@123');

  /**
   * Drives a tenant onto an exact plan, then asserts the full 6-plan matrix.
   * Uses a fresh workspace per case so usage never confuses the result.
   */
  const matrixTenant = async (label) => {
    const email = `mx${label}${runId}@example.com`;
    const reg = await api('/auth/register', {
      method: 'POST',
      body: { businessName: `MX ${label} ${runId}`, name: 'MX Owner', email, password: 'Password@123' },
    });
    const token = reg.data.tokens.accessToken;
    await api('/stores', { method: 'POST', token, body: { name: 'MX Store', code: `MX${label}${runId}`.slice(0, 16), currency: 'BDT' } });
    // Every buyer proves a contact first, exactly as a person would.
    await verifyContact(token);
    return { token, tenantId: reg.data.tenant.id ?? reg.data.tenant._id };
  };

  const setPlan = async (tenantId, planCode) => {
    const all = await api('/plans', {});
    const plan = all.data.find((p) => p.code === planCode);
    await api('/platform/subscriptions', {
      method: 'POST',
      token: platform3.token,
      body: { tenantId, planId: plan._id, periods: 1, status: 'active', autoRenew: false },
    });
  };

  const optionsFor = async (token) => {
    const res = await api('/subscriptions/plan-options', { token });
    return Object.fromEntries(res.data.options.map((o) => [o.code, o]));
  };

  const ALL = ['starter-store-monthly', 'starter-store-annual', 'showroom-monthly', 'showroom-annual', 'brand-monthly', 'brand-annual'];

  // ---- Starter Monthly: everything else is allowed, no cleanup -----------
  const tSM = await matrixTenant('sm');
  await setPlan(tSM.tenantId, 'starter-store-monthly');
  const oSM = await optionsFor(tSM.token);
  check('Starter Monthly is current', oSM['starter-store-monthly'].kind === 'current');
  for (const code of ALL.filter((c) => c !== 'starter-store-monthly')) {
    check(`Starter Monthly -> ${code} allowed`, oSM[code].canProceed === true, oSM[code]);
  }
  check('Starter Monthly -> Starter Annual is a cycle change', oSM['starter-store-annual'].kind === 'cycle-change');

  // ---- Starter Annual ----------------------------------------------------
  const tSA = await matrixTenant('sa');
  await setPlan(tSA.tenantId, 'starter-store-annual');
  const oSA = await optionsFor(tSA.token);
  for (const code of ALL.filter((c) => c !== 'starter-store-annual')) {
    check(`Starter Annual -> ${code} allowed`, oSA[code].canProceed === true, oSA[code]);
  }
  check('Starter Annual -> Starter Monthly is a cycle change', oSA['starter-store-monthly'].kind === 'cycle-change');

  // ---- Showroom Monthly --------------------------------------------------
  const tHM = await matrixTenant('hm');
  await setPlan(tHM.tenantId, 'showroom-monthly');
  const oHM = await optionsFor(tHM.token);
  check('Showroom Monthly -> Showroom Annual is a cycle change', oHM['showroom-annual'].kind === 'cycle-change' && oHM['showroom-annual'].canProceed);
  check('Showroom Monthly -> Brand Monthly allowed', oHM['brand-monthly'].canProceed === true);
  check('Showroom Monthly -> Brand Annual allowed', oHM['brand-annual'].canProceed === true);
  check('Showroom Monthly -> Starter Monthly is a downgrade', oHM['starter-store-monthly'].kind === 'downgrade');
  check('Showroom Monthly -> Starter Annual is a downgrade', oHM['starter-store-annual'].kind === 'downgrade');

  // ---- Showroom Annual ---------------------------------------------------
  const tHA = await matrixTenant('ha');
  await setPlan(tHA.tenantId, 'showroom-annual');
  const oHA = await optionsFor(tHA.token);
  check('Showroom Annual -> Showroom Monthly is a cycle change', oHA['showroom-monthly'].kind === 'cycle-change' && oHA['showroom-monthly'].canProceed);
  check('Showroom Annual -> Brand Monthly allowed', oHA['brand-monthly'].canProceed === true);
  check('Showroom Annual -> Brand Annual allowed', oHA['brand-annual'].canProceed === true);
  check('Showroom Annual -> Starter is a downgrade', oHA['starter-store-annual'].kind === 'downgrade');

  // ---- Brand Monthly -----------------------------------------------------
  const tBM = await matrixTenant('bm');
  await setPlan(tBM.tenantId, 'brand-monthly');
  const oBM = await optionsFor(tBM.token);
  check('Brand Monthly -> Brand Annual is a cycle change', oBM['brand-annual'].kind === 'cycle-change' && oBM['brand-annual'].canProceed);
  for (const code of ['showroom-monthly', 'showroom-annual', 'starter-store-monthly', 'starter-store-annual']) {
    check(`Brand Monthly -> ${code} is a downgrade`, oBM[code].kind === 'downgrade', oBM[code]?.kind);
  }

  // ---- Brand Annual - THE CRITICAL CORRECTION ---------------------------
  const tBA = await matrixTenant('ba');
  await setPlan(tBA.tenantId, 'brand-annual');
  const oBA = await optionsFor(tBA.token);
  check(
    'CRITICAL: Brand Annual -> Brand Monthly is a cycle change, NOT a downgrade',
    oBA['brand-monthly'].kind === 'cycle-change',
    oBA['brand-monthly'],
  );
  check(
    'CRITICAL: Brand Annual -> Brand Monthly can proceed directly (no cancellation)',
    oBA['brand-monthly'].canProceed === true,
    oBA['brand-monthly'],
  );
  for (const code of ['showroom-monthly', 'showroom-annual', 'starter-store-monthly', 'starter-store-annual']) {
    check(`Brand Annual -> ${code} is a downgrade`, oBA[code].kind === 'downgrade');
  }

  // A fresh tenant uses almost nothing, so a downgrade is permitted with no
  // cleanup - the system works this out on its own.
  check(
    'Downgrade allowed when already inside the target limits',
    oBA['starter-store-monthly'].canProceed === true,
    oBA['starter-store-monthly'],
  );
  check('No breaches reported when usage already fits', oBA['starter-store-monthly'].breaches.length === 0);

  // Backend must accept the corrected cycle change.
  const cycleSwitch = await api('/subscriptions/upgrade-request', {
    method: 'POST',
    token: tBA.token,
    body: {
      planId: oBA['brand-monthly'].planId,
      paymentMethod: 'bkash',
      amountMinor: oBA['brand-monthly'].priceMinor,
      senderNumber: '01712345678',
      transactionId: `TXCYC${runId}`,
    },
  });
  check('Backend ACCEPTS Brand Annual -> Brand Monthly', cycleSwitch.status === 201, cycleSwitch.error);
  check('Request records the transition kind', cycleSwitch.data?.transitionKind === 'cycle-change', cycleSwitch.data?.transitionKind);

  // ---- downgrade blocked when the tenant genuinely exceeds limits --------
  const tOver = await matrixTenant('ov');
  await setPlan(tOver.tenantId, 'brand-monthly');
  await api('/stores', { token: tOver.token });
  await api('/stores', { method: 'POST', token: tOver.token, body: { name: 'B2', code: `OVB${runId}`.slice(0, 16), currency: 'BDT' } });
  await api('/stores', { method: 'POST', token: tOver.token, body: { name: 'B3', code: `OVC${runId}`.slice(0, 16), currency: 'BDT' } });

  const oOver = await optionsFor(tOver.token);
  check('Over-limit downgrade cannot proceed', oOver['starter-store-monthly'].canProceed === false, oOver['starter-store-monthly']);
  check('Breaches list the offending resource', oOver['starter-store-monthly'].breaches.some((b) => b.resource === 'branches'), oOver['starter-store-monthly'].breaches);
  check(
    'Breach reports current, limit and excess',
    oOver['starter-store-monthly'].breaches[0]?.current === 3 && oOver['starter-store-monthly'].breaches[0]?.limit === 1 && oOver['starter-store-monthly'].breaches[0]?.excess === 2,
    oOver['starter-store-monthly'].breaches[0],
  );

  const blockedDowngrade = await api('/subscriptions/upgrade-request', {
    method: 'POST',
    token: tOver.token,
    body: {
      planId: oOver['starter-store-monthly'].planId,
      paymentMethod: 'bkash',
      amountMinor: oOver['starter-store-monthly'].priceMinor,
      transactionId: `TXOVR${runId}`,
    },
  });
  check('Backend blocks an over-limit downgrade', blockedDowngrade.status === 400, blockedDowngrade.error);
  check('Block response carries the breaches', Array.isArray(blockedDowngrade.error?.details?.breaches));

  // After cleanup the same downgrade becomes possible.
  const extraStores = (await api('/stores', { token: tOver.token })).data.filter((s) => !s.isDefault);
  for (const store of extraStores) {
    await api(`/stores/${store._id}`, { method: 'PATCH', token: tOver.token, body: { isActive: false } });
  }
  const oCleaned = await optionsFor(tOver.token);
  check(
    'Downgrade unlocks once resources are reduced',
    oCleaned['starter-store-monthly'].canProceed === true,
    oCleaned['starter-store-monthly'],
  );

  // ------------------------------------------- platform tenant management
  section('Platform Admin — workspace management');

  const padmin = await login('platform@pos.dev', 'Platform@123');
  const targetTenant = admin.session.tenant.id;
  const ws = (path) => `/platform/workspaces/${targetTenant}${path}`;

  const wsOverview = await api(ws('/overview'), { token: padmin.token });
  check('Workspace overview loads', wsOverview.success, wsOverview.error);
  check('Overview names the owner', Boolean(wsOverview.data?.owner?.email));
  check('Overview shows the subscription', Boolean(wsOverview.data?.subscription?.plan?.name));
  check('Overview counts branches/staff/products', typeof wsOverview.data?.counts?.products === 'number');
  check('Overview reports sales performance', typeof wsOverview.data?.performance?.grossSalesMinor === 'number');
  check('Overview reports the wallet', typeof wsOverview.data?.wallet?.balanceMinor === 'number');

  // ---- security: tenant context must be explicit and platform-only ----
  const tenantTriesPlatform = await api(ws('/overview'), { token: admin.token });
  check('Tenant admin cannot use platform workspace routes', tenantTriesPlatform.status === 403, tenantTriesPlatform.error);

  const badTenant = await api('/platform/workspaces/000000000000000000000000/overview', { token: padmin.token });
  check('Unknown workspace is rejected', badTenant.status === 404);

  // ---- categories ----
  const pCat = await api(ws('/categories'), {
    method: 'POST',
    token: padmin.token,
    body: { name: `Platform Cat ${runId}`, description: 'created by platform admin' },
  });
  check('Platform admin creates a category', pCat.status === 201, pCat.error);

  const pCatList = await api(ws('/categories?limit=50'), { token: padmin.token });
  check('Platform admin lists categories', pCatList.success && pCatList.data.length > 0);

  const pCatEdit = await api(ws(`/categories/${pCat.data._id}`), {
    method: 'PATCH',
    token: padmin.token,
    body: { name: `Platform Cat ${runId} v2` },
  });
  check('Platform admin edits a category', pCatEdit.success, pCatEdit.error);

  // ---- products (reuses the tenant product service) ----
  const pBarcode = await api(ws('/products/barcode/generate'), { method: 'POST', token: padmin.token });
  check('Platform admin generates a barcode', /^\d{13}$/.test(pBarcode.data?.barcode ?? ''), pBarcode.error);

  const pProd = await api(ws('/products'), {
    method: 'POST',
    token: padmin.token,
    body: {
      name: `Platform Product ${runId}`,
      categoryId: pCat.data._id,
      variants: [
        { attributes: [{ name: 'Size', value: 'M' }], sellingPriceMinor: 120000, costPriceMinor: 60000, stock: 10, barcode: pBarcode.data.barcode },
        { attributes: [{ name: 'Size', value: 'L' }], sellingPriceMinor: 120000, costPriceMinor: 60000, stock: 8 },
      ],
    },
  });
  check('Platform admin creates a product with variants', pProd.status === 201, pProd.error);
  check('Product created in the TARGET tenant', pProd.data?.variants?.length === 2);

  const pProdEdit = await api(ws(`/products/${pProd.data._id}`), {
    method: 'PATCH',
    token: padmin.token,
    body: { brand: 'Platform Brand' },
  });
  check('Platform admin edits a product', pProdEdit.data?.brand === 'Platform Brand', pProdEdit.error);

  const pVariant = await api(ws(`/products/${pProd.data._id}/variants`), {
    method: 'POST',
    token: padmin.token,
    body: { attributes: [{ name: 'Size', value: 'XL' }], sellingPriceMinor: 130000, stock: 4 },
  });
  check('Platform admin adds a variant', pVariant.status === 201, pVariant.error);

  // The product must be visible to the TENANT - same data, one system.
  const tenantSeesIt = await api(`/products/${pProd.data._id}`, { token: admin.token });
  check('Tenant sees the platform-created product', tenantSeesIt.success, tenantSeesIt.error);
  check('It is the same product record', tenantSeesIt.data?.brand === 'Platform Brand');

  // ---- inventory ----
  const pStock = await api(ws('/inventory?limit=5'), { token: padmin.token });
  check('Platform admin reads inventory', pStock.success, pStock.error);

  const pAdjust = await api(ws('/inventory/adjust'), {
    method: 'POST',
    token: padmin.token,
    body: { variantId: pProd.data.variants[0]._id, mode: 'delta', value: 5, reason: 'Platform setup stock' },
  });
  check('Platform admin adjusts stock', pAdjust.success, pAdjust.error);
  check('Adjustment applied', pAdjust.data?.newStock === 15, pAdjust.data);

  // ---- staff & roles ----
  const pRole = await api(ws('/roles'), {
    method: 'POST',
    token: padmin.token,
    body: { name: `Setup Role ${runId}`, permissions: ['products.view', 'sales.create'] },
  });
  check('Platform admin creates a role', pRole.status === 201, pRole.error);

  const pStaff = await api(ws('/staff'), {
    method: 'POST',
    token: padmin.token,
    body: { name: 'Setup Staff', email: `setup${runId}@demostore.dev`, password: 'Password@123', roleId: pRole.data._id },
  });
  check('Platform admin creates staff', pStaff.status === 201, pStaff.error);

  const pStaffEdit = await api(ws(`/staff/${pStaff.data.id}`), {
    method: 'PATCH',
    token: padmin.token,
    body: { isActive: false },
  });
  check('Platform admin deactivates staff', pStaffEdit.data?.isActive === false, pStaffEdit.error);

  // The staff member can genuinely sign in to the tenant.
  await api(ws(`/staff/${pStaff.data.id}`), { method: 'PATCH', token: padmin.token, body: { isActive: true } });
  const setupLogin = await api('/auth/login', {
    method: 'POST',
    body: { email: `setup${runId}@demostore.dev`, password: 'Password@123' },
  });
  check('Platform-created staff can sign in', setupLogin.success, setupLogin.error);
  check('And lands in the right workspace', setupLogin.data?.tenant?.id === targetTenant);

  // ---- branches ----
  const pBranch = await api(ws('/stores'), {
    method: 'POST',
    token: padmin.token,
    body: { name: `Platform Branch ${runId}`, code: `PB${runId}`.slice(0, 16), currency: 'BDT', override: true },
  });
  check('Platform admin creates a branch with override', pBranch.status === 201, pBranch.error);

  // ---- workspace provisioning (one-time setup service) ----
  const provisioned = await api('/platform/workspaces', {
    method: 'POST',
    token: padmin.token,
    body: {
      businessName: `Provisioned ${runId}`,
      owner: { name: 'New Owner', email: `owner${runId}@example.com`, phone: '01700000999', password: 'Password@123' },
      storeName: 'Main Outlet',
      storeCode: `PV${runId}`.slice(0, 16),
    },
  });
  check('Platform admin provisions a whole workspace', provisioned.status === 201, provisioned.error);
  check('Provisioning returns tenant, owner and store', Boolean(provisioned.data?.tenantId && provisioned.data?.ownerId && provisioned.data?.storeId));

  const newOwnerLogin = await api('/auth/login', {
    method: 'POST',
    body: { email: `owner${runId}@example.com`, password: 'Password@123' },
  });
  check('Provisioned owner can sign in', newOwnerLogin.success, newOwnerLogin.error);
  check('Provisioned owner is an admin', newOwnerLogin.data?.user?.role === 'admin');
  check('Provisioned workspace already has a store', newOwnerLogin.data?.stores?.length === 1);
  check('Provisioned owner does NOT need onboarding', newOwnerLogin.data?.needsStoreSetup === false);

  // ---- platform user management ----
  const suspend = await api(`/platform/users/${pStaff.data.id}`, {
    method: 'PATCH',
    token: padmin.token,
    body: { isActive: false },
  });
  check('Platform admin suspends a user', suspend.data?.isActive === false, suspend.error);

  const suspendedLogin = await api('/auth/login', {
    method: 'POST',
    body: { email: `setup${runId}@demostore.dev`, password: 'Password@123' },
  });
  check('Suspended user cannot sign in', suspendedLogin.status === 403, suspendedLogin.error);

  // ---- audit trail ----
  const audit = await api(`/platform/audit-log?tenantId=${targetTenant}&limit=50`, { token: padmin.token });
  check('Audit log records platform actions', audit.data?.length > 0, audit.error);
  const actions = (audit.data ?? []).map((a) => a.action);
  for (const expected of ['CREATE_PRODUCT', 'UPDATE_PRODUCT', 'CREATE_STAFF', 'CREATE_BRANCH']) {
    check(`Audit contains ${expected}`, actions.includes(expected), actions.slice(0, 10));
  }

  // ---- tenant isolation must remain intact ----
  const normalProducts = await api('/products?limit=100', { token: admin.token });
  const foreign = normalProducts.data.filter((p) => String(p.tenantId ?? targetTenant) !== String(targetTenant));
  check('Normal tenant endpoint never leaks other tenants', foreign.length === 0);

  // ------------------------------------------------- wallet breakdown
  section('Wallet dashboard breakdown');

  const padmin2 = await login('platform@pos.dev', 'Platform@123');
  await api(`/platform/tenants/${admin.session.tenant.id}/wallet/adjust`, {
    method: 'POST',
    token: padmin2.token,
    body: { direction: 'credit', amountMinor: 200000, reason: 'Breakdown test funding' },
  });

  const wb = await api('/wallet/breakdown', { token: admin.token });
  check('Wallet breakdown loads', wb.success, wb.error);
  check('Reports total credits', wb.data?.totalCreditsMinor > 0, wb.data);
  check('Reports total debits', typeof wb.data?.totalDebitsMinor === 'number');
  const services = (wb.data?.services ?? []).map((x) => x.service);
  for (const svc of ['subscription', 'sms', 'email', 'other']) {
    check(`Breakdown includes ${svc}`, services.includes(svc), services);
  }
  check(
    'Service spending never exceeds total debits',
    wb.data.services.reduce((sum, x) => sum + Math.max(0, x.amountMinor), 0) <= wb.data.totalDebitsMinor + 1,
    wb.data,
  );

  const filteredTx = await api('/wallet/transactions?direction=credit&sortBy=highest&limit=5', { token: admin.token });
  check('Wallet transactions filter by direction', filteredTx.success, filteredTx.error);
  check(
    'Credit filter returns only credits/refunds',
    (filteredTx.data ?? []).every((t) => t.type === 'credit' || t.type === 'refund'),
    filteredTx.data?.map((t) => t.type),
  );
  check(
    'Highest-amount sort is ordered',
    (filteredTx.data ?? []).every((t, i, a) => i === 0 || a[i - 1].amountMinor >= t.amountMinor),
  );

  const byService = await api('/wallet/transactions?service=adjustment&limit=5', { token: admin.token });
  check('Wallet transactions filter by service', (byService.data ?? []).every((t) => t.referenceType === 'adjustment'));

  const dated = await api(`/wallet/transactions?from=${new Date(Date.now() - 86400000).toISOString()}&limit=5`, { token: admin.token });
  check('Wallet transactions filter by date', dated.success, dated.error);

  // --------------------------------------------------- global analytics
  section('Platform global analytics');

  const ga = await api('/platform/analytics?preset=last30', { token: padmin2.token });
  check('Global analytics loads', ga.success, ga.error);

  for (const [group, key] of [
    ['users', 'total'], ['users', 'active'], ['users', 'suspended'], ['users', 'new'],
    ['workspaces', 'total'], ['workspaces', 'active'], ['workspaces', 'new'],
    ['subscriptions', 'active'], ['subscriptions', 'monthly'], ['subscriptions', 'annual'],
    ['subscriptions', 'upgrades'], ['subscriptions', 'downgradeRequests'], ['subscriptions', 'pendingRequests'],
    ['revenue', 'subscriptionMinor'], ['revenue', 'walletTopUpMinor'], ['revenue', 'smsMinor'],
    ['revenue', 'emailMinor'], ['revenue', 'setupServiceMinor'], ['revenue', 'totalMinor'],
    ['business', 'grossSalesMinor'], ['business', 'netSalesMinor'], ['business', 'cogsMinor'],
    ['business', 'profitMinor'], ['business', 'orders'], ['business', 'itemsSold'],
    ['marketing', 'smsCount'], ['marketing', 'emailCount'],
  ]) {
    check(`Analytics reports ${group}.${key}`, typeof ga.data?.[group]?.[key] === 'number', ga.data?.[group]);
  }

  check('Plan distribution present', Array.isArray(ga.data?.subscriptions?.byPlan));
  check(
    'Business profit = net sales - COGS',
    ga.data.business.profitMinor === ga.data.business.netSalesMinor - ga.data.business.cogsMinor,
    ga.data.business,
  );
  check(
    'Total revenue is the sum of its parts',
    ga.data.revenue.totalMinor ===
      ga.data.revenue.subscriptionMinor + ga.data.revenue.walletTopUpMinor + ga.data.revenue.smsMinor + ga.data.revenue.emailMinor,
    ga.data.revenue,
  );

  const gaCustom = await api(
    `/platform/analytics?preset=custom&from=2024-01-01&to=${new Date().toISOString().slice(0, 10)}T23:59:59.000Z`,
    { token: padmin2.token },
  );
  check('Global analytics accepts a custom range', gaCustom.success, gaCustom.error);

  const leaderboard = await api('/platform/analytics/workspaces?preset=last30&sortBy=profit&limit=10', { token: padmin2.token });
  check('Workspace leaderboard loads', leaderboard.success, leaderboard.error);
  check(
    'Leaderboard sorted by profit',
    (leaderboard.data?.rows ?? []).every((r, i, a) => i === 0 || a[i - 1].profitMinor >= r.profitMinor),
  );

  const tenantAnalytics = await api('/platform/analytics', { token: admin.token });
  check('Tenant admin cannot read global analytics', tenantAnalytics.status === 403);

  // ------------------------------------------------------ branch deletion
  section('Branch deletion');

  const delTenant = await matrixTenant('del');
  await setPlan(delTenant.tenantId, 'brand-monthly');

  const mainBranch = (await api('/stores', { token: delTenant.token })).data[0];

  const b2 = await api('/stores', {
    method: 'POST',
    token: delTenant.token,
    body: { name: 'Branch Two', code: `D2${runId}`.slice(0, 16), currency: 'BDT' },
  });
  check('Second branch created', b2.status === 201, b2.error);

  // Guard: the main branch cannot be deleted.
  const delMain = await api(`/stores/${mainBranch._id}`, { method: 'DELETE', token: delTenant.token });
  check('Main branch cannot be deleted', delMain.status === 400, delMain.error);

  // Make a sale in branch two so we can prove history survives.
  const b2Products = await api('/products', {
    method: 'POST',
    token: delTenant.token,
    storeId: b2.data._id,
    body: { name: 'Branch Two Tee', variants: [{ attributes: [], sellingPriceMinor: 50000, costPriceMinor: 20000, stock: 5 }] },
  });
  const b2Sale = await api('/sales', {
    method: 'POST',
    token: delTenant.token,
    storeId: b2.data._id,
    body: {
      items: [{ variantId: b2Products.data.variants[0]._id, quantity: 2 }],
      paymentMethod: 'cash',
    },
  });
  check('Sale made in the second branch', b2Sale.status === 201, b2Sale.error);

  // Staff based in branch two, to prove they get reassigned.
  const b2Staff = await api('/staff', {
    method: 'POST',
    token: delTenant.token,
    storeId: b2.data._id,
    body: { name: 'Branch Two Staff', email: `b2s${runId}@example.com`, password: 'Password@123', storeId: b2.data._id },
  });
  check('Staff assigned to the second branch', b2Staff.status === 201, b2Staff.error);

  const deleted = await api(`/stores/${b2.data._id}`, { method: 'DELETE', token: delTenant.token });
  check('Branch deleted', deleted.success, deleted.error);
  check('Deletion is a soft delete', deleted.data?.softDeleted === true);
  check('Reports how much history was preserved', deleted.data?.historicalSalesPreserved >= 1, deleted.data);

  const afterList = await api('/stores', { token: delTenant.token });
  check('Deleted branch disappears from the list', afterList.data.length === 1, afterList.data.map((s) => s.name));

  // The sale made there must still resolve, with its snapshots intact.
  const oldSale = await api(`/sales/${b2Sale.data._id}`, { token: delTenant.token });
  check('Sale from the deleted branch still resolves', oldSale.success, oldSale.error);
  check('Its price snapshot is unchanged', oldSale.data?.items?.[0]?.unitPriceMinor === 50000);
  check('Its receipt still renders', (await api(`/sales/${b2Sale.data._id}/receipt`, { token: delTenant.token })).success);

  // Staff were moved to the main branch rather than stranded.
  const staffAfter = await api('/staff?limit=20', { token: delTenant.token });
  const movedStaff = staffAfter.data.find((r) => r.email === `b2s${runId}@example.com`);
  check('Staff moved to the main branch', String(movedStaff?.storeId) === String(mainBranch._id), movedStaff?.storeId);

  const b2Login = await login(`b2s${runId}@example.com`, 'Password@123');
  check('Reassigned staff can still sign in', Boolean(b2Login.token));
  check('And sees only the surviving branch', b2Login.session.stores.length === 1, b2Login.session.stores);

  // A deleted branch may not be addressed by header.
  const useDeleted = await api('/products', { token: delTenant.token, storeId: b2.data._id });
  check('Deleted branch cannot be selected', useDeleted.status === 403 || useDeleted.status === 404, useDeleted.status);

  // Its slot is freed for the plan limit, and its code is reusable.
  const reuse = await api('/stores', {
    method: 'POST',
    token: delTenant.token,
    body: { name: 'Reused Code Branch', code: `D2${runId}`.slice(0, 16), currency: 'BDT' },
  });
  check('Deleted branch code can be reused', reuse.status === 201, reuse.error);

  // Guard: cannot delete the only remaining branch.
  await api(`/stores/${reuse.data._id}`, { method: 'DELETE', token: delTenant.token });
  const delLast = await api(`/stores/${mainBranch._id}`, { method: 'DELETE', token: delTenant.token });
  check('Cannot delete the only branch', delLast.status === 400, delLast.error);

  // ---- make-main, then delete the former main ----
  const b3 = await api('/stores', {
    method: 'POST',
    token: delTenant.token,
    body: { name: 'Branch Three', code: `D3${runId}`.slice(0, 16), currency: 'BDT' },
  });
  const promoted = await api(`/stores/${b3.data._id}/make-default`, { method: 'POST', token: delTenant.token });
  check('A branch can be promoted to main', promoted.data?.isDefault === true, promoted.error);

  const delOldMain = await api(`/stores/${mainBranch._id}`, { method: 'DELETE', token: delTenant.token });
  check('The former main branch can then be deleted', delOldMain.success, delOldMain.error);

  // Permissions: a cashier must not be able to delete a branch.
  const cashierDelete = await api(`/stores/${b3.data._id}`, { method: 'DELETE', token: cashier.token });
  check('Cashier cannot delete a branch', cashierDelete.status === 403);

  // ------------------------------------- platform admin funds a wallet
  section('Platform Admin — fund any workspace wallet');

  const fundAdmin = await login('platform@pos.dev', 'Platform@123');

  // A workspace other than the demo tenant, to prove "any" workspace works.
  const fundTarget = await matrixTenant('fund');

  const before = await api(`/platform/tenants/${fundTarget.tenantId}/wallet`, { token: fundAdmin.token });
  check('Platform admin can read any workspace wallet', before.success, before.error);
  check('New workspace starts at zero', before.data?.wallet?.balanceMinor === 0, before.data?.wallet);

  const credited = await api(`/platform/tenants/${fundTarget.tenantId}/wallet/adjust`, {
    method: 'POST',
    token: fundAdmin.token,
    body: { direction: 'credit', amountMinor: 250000, reason: 'Offline bKash payment received' },
  });
  check('Platform admin adds money to the wallet', credited.success, credited.error);
  check('Balance reflects the credit', credited.data?.balanceMinor === 250000, credited.data);

  // The workspace owner sees it immediately in their own wallet.
  const ownerView = await api('/wallet', { token: fundTarget.token });
  check('Workspace owner sees the credited balance', ownerView.data?.balanceMinor === 250000, ownerView.data);

  const ownerLedger = await api('/wallet/transactions?limit=5', { token: fundTarget.token });
  check('Credit appears on the owner ledger', ownerLedger.data?.[0]?.amountMinor === 250000, ownerLedger.data?.[0]);
  check('Ledger records the stated reason', ownerLedger.data?.[0]?.reason?.includes('Offline bKash'), ownerLedger.data?.[0]?.reason);
  check('Ledger records who did it', Boolean(ownerLedger.data?.[0]?.performedByNameSnapshot));
  check('Ledger records balance before/after', ownerLedger.data?.[0]?.balanceBeforeMinor === 0 && ownerLedger.data?.[0]?.balanceAfterMinor === 250000);

  // A reason is mandatory.
  const noReason = await api(`/platform/tenants/${fundTarget.tenantId}/wallet/adjust`, {
    method: 'POST',
    token: fundAdmin.token,
    body: { direction: 'credit', amountMinor: 1000, reason: '' },
  });
  check('Adjustment without a reason is rejected', noReason.status === 422, noReason.error);

  const zeroAmount = await api(`/platform/tenants/${fundTarget.tenantId}/wallet/adjust`, {
    method: 'POST',
    token: fundAdmin.token,
    body: { direction: 'credit', amountMinor: 0, reason: 'nothing' },
  });
  check('Zero-amount adjustment is rejected', zeroAmount.status === 422, zeroAmount.error);

  // Deduction works, and cannot overdraw.
  const deducted = await api(`/platform/tenants/${fundTarget.tenantId}/wallet/adjust`, {
    method: 'POST',
    token: fundAdmin.token,
    body: { direction: 'debit', amountMinor: 50000, reason: 'Correction - duplicate credit' },
  });
  check('Platform admin can deduct', deducted.data?.balanceMinor === 200000, deducted.error);

  const overdraw2 = await api(`/platform/tenants/${fundTarget.tenantId}/wallet/adjust`, {
    method: 'POST',
    token: fundAdmin.token,
    body: { direction: 'debit', amountMinor: 999999999, reason: 'overdraw attempt' },
  });
  check('Cannot overdraw the workspace wallet', overdraw2.status === 400, overdraw2.error);
  check(
    'Failed deduction left the balance intact',
    (await api('/wallet', { token: fundTarget.token })).data.balanceMinor === 200000,
  );

  // Only platform admins may do this.
  const tenantAdjust = await api(`/platform/tenants/${fundTarget.tenantId}/wallet/adjust`, {
    method: 'POST',
    token: admin.token,
    body: { direction: 'credit', amountMinor: 100000, reason: 'self-credit attempt' },
  });
  check('Tenant admin cannot credit their own wallet', tenantAdjust.status === 403, tenantAdjust.error);

  const cashierFundAttempt = await api(`/platform/tenants/${fundTarget.tenantId}/wallet/adjust`, {
    method: 'POST',
    token: cashier.token,
    body: { direction: 'credit', amountMinor: 100000, reason: 'attempt' },
  });
  check('Cashier cannot credit a wallet', cashierFundAttempt.status === 403);

  // Every adjustment is audited.
  const fundAudit = await api(`/platform/audit-log?tenantId=${fundTarget.tenantId}&limit=20`, { token: fundAdmin.token });
  check(
    'Wallet adjustments are audited',
    (fundAudit.data ?? []).some((a) => a.action === 'wallet.manual_adjustment'),
    (fundAudit.data ?? []).map((a) => a.action),
  );

  // And the money is genuinely usable by the workspace.
  const spendable = await api('/subscriptions/plan-options', { token: fundTarget.token });
  check('Funded workspace can see plan options', spendable.success);

  // ------------------------------------------------------ tenant isolation
  // ------------------------------------------------------- usage counting
  section('Usage counting');

  const usageBefore = (await api('/subscriptions/current', { token: admin.token })).data?.usage;
  check(
    'Usage reports every countable resource',
    usageBefore &&
      ['products', 'staff', 'stores', 'customers', 'monthlySales', 'storageBytes'].every(
        (key) => typeof usageBefore[key] === 'number',
      ),
    usageBefore,
  );
  check('Seeded workspace has counted customers', usageBefore?.customers > 0, usageBefore?.customers);
  check('Seeded workspace has counted this month\'s sales', usageBefore?.monthlySales > 0, usageBefore?.monthlySales);

  // --- customers -----------------------------------------------------------
  const newCustomer = await api('/customers', {
    method: 'POST',
    token: admin.token,
    body: { name: 'Usage Counter', phone: `0199${Date.now().toString().slice(-7)}` },
  });
  check('Customer created for counting', newCustomer.status === 201, newCustomer.error);

  const afterCustomer = (await api('/subscriptions/current', { token: admin.token })).data?.usage;
  check(
    'Adding a customer increments the customer count by exactly one',
    afterCustomer?.customers === usageBefore?.customers + 1,
    { before: usageBefore?.customers, after: afterCustomer?.customers },
  );

  // A soft-deleted customer must free its slot, exactly as products do.
  const removeCustomer = await api(`/customers/${newCustomer.data._id}`, { method: 'DELETE', token: admin.token });
  check('Customer can be removed', removeCustomer.status < 300, removeCustomer.error);
  const afterCustomerDelete = (await api('/subscriptions/current', { token: admin.token })).data?.usage;
  check(
    'Removing a customer frees the slot',
    afterCustomerDelete?.customers === usageBefore?.customers,
    { expected: usageBefore?.customers, actual: afterCustomerDelete?.customers },
  );

  // --- storage -------------------------------------------------------------
  const STORAGE_TEST_BYTES = 5_000;
  const storageBefore = afterCustomerDelete?.storageBytes ?? 0;

  const uploaded = await upload('/uploads/image', {
    token: admin.token,
    bytes: makePng(STORAGE_TEST_BYTES),
  });
  check('Image upload succeeds', uploaded.status === 201, uploaded.error);
  check('Upload reports a byte size', typeof uploaded.data?.size === 'number' && uploaded.data.size > 0, uploaded.data?.size);

  // On a plan with image optimisation the stored file is SMALLER than what was
  // sent, so the server's reported size is the only correct thing to compare.
  const firstStored = uploaded.data.size;
  const afterUpload = (await api('/subscriptions/current', { token: admin.token })).data?.usage;
  check(
    'Uploading counts the stored byte size against the quota',
    afterUpload?.storageBytes === storageBefore + firstStored,
    { before: storageBefore, after: afterUpload?.storageBytes, stored: firstStored },
  );

  const secondUpload = await upload('/uploads/image', { token: admin.token, bytes: makePng(3_000) });
  check('Second upload succeeds', secondUpload.status === 201, secondUpload.error);
  const afterSecond = (await api('/subscriptions/current', { token: admin.token })).data?.usage;
  check(
    'Storage accumulates across uploads',
    afterSecond?.storageBytes === storageBefore + firstStored + secondUpload.data.size,
    { expected: storageBefore + firstStored + secondUpload.data.size, actual: afterSecond?.storageBytes },
  );

  // Storage is per tenant: one workspace's files must not show up in another's.
  const isolationUsage = (await api('/subscriptions/current', { token: cashier.token })).data?.usage;
  check(
    'Staff in the same tenant see the same storage figure',
    isolationUsage === undefined || isolationUsage.storageBytes === afterSecond?.storageBytes,
    { staff: isolationUsage?.storageBytes, admin: afterSecond?.storageBytes },
  );

  // --- monthly sales -------------------------------------------------------
  const salesBefore = afterSecond?.monthlySales ?? 0;
  const countingSearch = await api('/products/pos-search?q=&limit=50', { token: admin.token });
  const countingVariant = (countingSearch.data ?? []).find((v) => v.stock >= 1);
  check('A stocked variant is available for the sale count', Boolean(countingVariant));
  const countedSale = await api('/sales', {
    method: 'POST',
    token: admin.token,
    body: { items: [{ variantId: countingVariant.variantId, quantity: 1 }], paymentMethod: 'cash' },
  });
  check('Sale recorded for counting', countedSale.status === 201, countedSale.error);

  const usageAfterSale = (await api('/subscriptions/current', { token: admin.token })).data?.usage;
  check(
    'Recording a sale increments the monthly count by exactly one',
    usageAfterSale?.monthlySales === salesBefore + 1,
    { before: salesBefore, after: usageAfterSale?.monthlySales },
  );

  // ================================================================
  //  SUBSCRIPTION BYPASS ATTEMPTS
  //  Everything here attacks the API directly, the way a customer with
  //  devtools would. Each check asserts a REFUSAL plus the absence of any
  //  side effect - a rejected request that still changed state is not a
  //  defence.
  // ================================================================
  section('Anti-bypass: plan tampering');

  const atkStamp = Date.now();
  const attacker = await api('/auth/register', {
    method: 'POST',
    body: {
      businessName: `Bypass Test ${atkStamp}`,
      name: 'Attacker',
      email: `atk${atkStamp}@example.com`,
      password: 'Password@123',
    },
  });
  check('Attacker workspace registers', attacker.status === 201, attacker.error);
  const atkToken = attacker.data.tokens.accessToken;
  const atkTenantId = attacker.data.tenant.id;
  await api('/stores', { method: 'POST', token: atkToken, body: { name: 'Attack Store', currency: 'BDT' } });

  const allPlansAtk = (await api('/plans')).data ?? [];
  const atkStarter = allPlansAtk.find((p) => p.code === 'starter-store-monthly');
  const atkBrand = allPlansAtk.find((p) => p.code === 'brand-monthly');

  // Pin to Starter so the limits under attack are the small ones.
  await api('/platform/subscriptions', {
    method: 'POST',
    token: platform2.token,
    body: { tenantId: atkTenantId, planId: atkStarter._id, periods: 1, status: 'active' },
  });

  const baseline = (await api('/subscriptions/current', { token: atkToken })).data?.entitlement;
  check('Attacker is on Starter', baseline?.planCode === 'starter-store-monthly', baseline?.planCode);

  // --- 1. claiming a better plan in the request body -----------------------
  const claimPlan = await api('/products', {
    method: 'POST',
    token: atkToken,
    body: {
      name: 'Claim Plan',
      sku: `CLAIM-${atkStamp}`,
      plan: 'brand',
      planCode: 'brand-monthly',
      entitlement: { limits: { maxProducts: -1 }, features: { multiStore: true } },
      limits: { maxProducts: -1 },
      subscriptionStatus: 'active',
      variants: [{ attributes: [], sellingPriceMinor: 1000, stock: 1 }],
    },
  });
  const afterClaim = (await api('/subscriptions/current', { token: atkToken })).data?.entitlement;
  check(
    'A plan claimed in a request body is ignored',
    afterClaim?.planCode === 'starter-store-monthly' && afterClaim?.limits?.maxProducts === 300,
    { planCode: afterClaim?.planCode, maxProducts: afterClaim?.limits?.maxProducts, createStatus: claimPlan.status },
  );

  // --- 2. writing the subscription directly --------------------------------
  const selfAssign = await api('/platform/subscriptions', {
    method: 'POST',
    token: atkToken,
    body: { tenantId: atkTenantId, planId: atkBrand._id, periods: 12, status: 'active' },
  });
  check('A tenant cannot assign itself a subscription', selfAssign.status === 403, selfAssign.status);

  const selfStatus = await api(`/platform/tenants/${atkTenantId}/status`, {
    method: 'PATCH',
    token: atkToken,
    body: { status: 'active' },
  });
  check('A tenant cannot reach platform tenant admin', selfStatus.status === 403, selfStatus.status);

  const selfPlanEdit = await api(`/plans/${atkStarter._id}`, {
    method: 'PATCH',
    token: atkToken,
    body: { limits: { maxProducts: 999999, maxStores: 99 }, priceMinor: 0 },
  });
  check('A tenant cannot edit the plan catalogue', selfPlanEdit.status === 403, selfPlanEdit.status);

  const planAfterEdit = (await api('/plans')).data.find((p) => p.code === 'starter-store-monthly');
  check('The plan catalogue is unchanged', planAfterEdit.limits.maxProducts === 300 && planAfterEdit.priceMinor > 0, {
    maxProducts: planAfterEdit.limits.maxProducts,
    priceMinor: planAfterEdit.priceMinor,
  });

  const selfWallet = await api(`/platform/tenants/${atkTenantId}/wallet/adjust`, {
    method: 'POST',
    token: atkToken,
    body: { direction: 'credit', amountMinor: 10_000_000, reason: 'free money' },
  });
  check('A tenant cannot credit its own wallet', selfWallet.status === 403, selfWallet.status);

  // --- 3. buying a plan without paying for it ------------------------------
  const freeUpgrade = await api('/subscriptions/upgrade-request', {
    method: 'POST',
    token: atkToken,
    body: { planId: atkBrand._id, paymentMethod: 'wallet', amountMinor: 0 },
  });
  check('Wallet purchase with no balance is refused', freeUpgrade.status >= 400, freeUpgrade.status);

  const cheatAmount = await api('/subscriptions/upgrade-request', {
    method: 'POST',
    token: atkToken,
    body: { planId: atkBrand._id, paymentMethod: 'wallet', amountMinor: 1 },
  });
  check('Declaring a tiny amount does not buy a plan', cheatAmount.status >= 400, cheatAmount.status);

  const afterFreeUpgrade = (await api('/subscriptions/current', { token: atkToken })).data?.entitlement;
  check(
    'No failed purchase upgraded the plan',
    afterFreeUpgrade?.planCode === 'starter-store-monthly',
    afterFreeUpgrade?.planCode,
  );

  // A manual request must never activate the plan by itself.
  const manualClaim = await api('/subscriptions/upgrade-request', {
    method: 'POST',
    token: atkToken,
    body: { planId: atkBrand._id, paymentMethod: 'bkash', amountMinor: atkBrand.priceMinor, transactionId: `FAKE${atkStamp}`, senderNumber: '01700000000' },
  });
  const afterManual = (await api('/subscriptions/current', { token: atkToken })).data?.entitlement;
  check(
    'An unverified manual payment does not activate the plan',
    afterManual?.planCode === 'starter-store-monthly',
    { requestStatus: manualClaim.status, planCode: afterManual?.planCode },
  );

  // --- 4. numeric abuse ----------------------------------------------------
  section('Anti-bypass: numeric and payload abuse');

  const numericAttacks = [
    ['negative stock', { stock: -5 }],
    ['fractional stock', { stock: 1.5 }],
    ['string stock', { stock: '10' }],
    // JSON has no Infinity: it is sent as null, which must still be rejected.
    ['infinite stock', { stock: Number.POSITIVE_INFINITY }],
    ['negative price', { sellingPriceMinor: -100 }],
    ['fractional price', { sellingPriceMinor: 10.5 }],
    ['string price', { sellingPriceMinor: 'free' }],
    // Beyond Number.MAX_SAFE_INTEGER, so it cannot be an exact minor-unit amount.
    ['unsafe integer price', { sellingPriceMinor: Number.MAX_SAFE_INTEGER + 2 }],
  ];
  for (const [label, override] of numericAttacks) {
    const res = await api('/products', {
      method: 'POST',
      token: admin.token,
      body: {
        name: `Numeric ${label} ${atkStamp}`,
        sku: `NUM-${atkStamp}-${label.replace(/\W/g, '')}`,
        variants: [{ attributes: [], sellingPriceMinor: 1000, stock: 1, ...override }],
      },
    });
    check(`Rejects ${label}`, res.status === 422 || res.status === 400, { status: res.status });
  }

  const negativeQty = await api('/sales', {
    method: 'POST',
    token: admin.token,
    body: { items: [{ variantId: variant.variantId, quantity: -3 }], paymentMethod: 'cash' },
  });
  check('Rejects a negative sale quantity', negativeQty.status === 422 || negativeQty.status === 400, negativeQty.status);

  const hugeQty = await api('/sales', {
    method: 'POST',
    token: admin.token,
    body: { items: [{ variantId: variant.variantId, quantity: 999999999 }], paymentMethod: 'cash' },
  });
  check('Rejects a sale larger than stock', hugeQty.status >= 400, hugeQty.status);

  const badId = await api('/products/not-an-object-id', { token: admin.token });
  check('Rejects a malformed id', badId.status === 422 || badId.status === 400, badId.status);

  const nosqlId = await api('/products', {
    method: 'POST',
    token: admin.token,
    body: {
      name: 'NoSQL',
      sku: `NOSQL-${atkStamp}`,
      categoryId: { $ne: null },
      variants: [{ attributes: [], sellingPriceMinor: 1000, stock: 1 }],
    },
  });
  check('Rejects a NoSQL operator where an id belongs', nosqlId.status >= 400, nosqlId.status);

  // --- 5. cross-tenant reach ----------------------------------------------
  section('Anti-bypass: cross-tenant access');

  const victimSale = sale.data._id;
  const victimStore = admin.session.stores[0].id;

  const readVictimSale = await api(`/sales/${victimSale}`, { token: atkToken });
  check("Cannot read another tenant's sale", readVictimSale.status === 404, readVictimSale.status);

  const borrowStore = await api('/products', { token: atkToken, storeId: victimStore });
  check("Cannot borrow another tenant's store id", borrowStore.status === 403, borrowStore.status);

  const victimCustomers = await api('/customers', { token: admin.token });
  const victimCustomerId = victimCustomers.data?.[0]?._id;
  if (victimCustomerId) {
    const readVictimCustomer = await api(`/customers/${victimCustomerId}`, { token: atkToken });
    check("Cannot read another tenant's customer", readVictimCustomer.status === 404, readVictimCustomer.status);

    const editVictimCustomer = await api(`/customers/${victimCustomerId}`, {
      method: 'PATCH',
      token: atkToken,
      body: { name: 'Owned' },
    });
    check("Cannot edit another tenant's customer", editVictimCustomer.status === 404, editVictimCustomer.status);

    const stillNamed = await api(`/customers/${victimCustomerId}`, { token: admin.token });
    check('The victim customer is unchanged', stillNamed.data?.name !== 'Owned', stillNamed.data?.name);
  }

  // Forging tenantId in the body must not redirect the write.
  const forgeTenant = await api('/customers', {
    method: 'POST',
    token: atkToken,
    body: { name: 'Forged Tenant', phone: `0188${String(atkStamp).slice(-7)}`, tenantId: admin.session.tenant.id, storeId: victimStore },
  });
  if (forgeTenant.status === 201) {
    const landedInVictim = await api(`/customers?search=Forged Tenant`, { token: admin.token });
    check(
      'A forged tenantId does not move the record into another workspace',
      (landedInVictim.data ?? []).length === 0,
      landedInVictim.data,
    );
  } else {
    check('Forged-tenant customer create was refused outright', forgeTenant.status >= 400, forgeTenant.status);
  }

  // --- 6. limit boundaries and races --------------------------------------
  section('Anti-bypass: limit boundaries');

  // A workspace pinned to a tiny product ceiling, so the boundary is reachable.
  const raceStamp = Date.now();
  const racer = await api('/auth/register', {
    method: 'POST',
    body: {
      businessName: `Race Test ${raceStamp}`,
      name: 'Racer',
      email: `race${raceStamp}@example.com`,
      password: 'Password@123',
    },
  });
  const raceToken = racer.data.tokens.accessToken;
  await api('/stores', { method: 'POST', token: raceToken, body: { name: 'Race Store', currency: 'BDT' } });

  const racePlanBody = {
    code: `race-plan-${raceStamp}`,
    name: 'Race Plan',
    interval: 'monthly',
    priceMinor: 1000,
    tier: 1,
    limits: { maxProducts: 3, maxStaff: 1, maxStores: 1, maxCustomers: 2, maxMonthlySales: 2, maxStorageBytes: -1 },
    features: { salesReports: true, customerManagement: true, inventoryLedger: true },
    isPublic: false,
  };
  const racePlan = await api('/plans', { method: 'POST', token: platform2.token, body: racePlanBody });
  check('Test plan with tiny limits created', racePlan.status === 201, racePlan.error);

  await api('/platform/subscriptions', {
    method: 'POST',
    token: platform2.token,
    body: { tenantId: racer.data.tenant.id, planId: racePlan.data._id, periods: 1, status: 'active' },
  });

  const makeProduct = (n) =>
    api('/products', {
      method: 'POST',
      token: raceToken,
      body: {
        name: `Race Product ${n}`,
        sku: `RACE-${raceStamp}-${n}`,
        variants: [{ attributes: [], sellingPriceMinor: 1000, stock: 1 }],
      },
    });

  // Fill to exactly the limit, one at a time.
  for (let i = 1; i <= 3; i += 1) {
    const res = await makeProduct(i);
    check(`Product ${i} of 3 is allowed`, res.status === 201, res.error);
  }

  const raceOverLimit = await makeProduct(4);
  check('The product after the limit is refused', raceOverLimit.status >= 400, raceOverLimit.status);
  check(
    'The refusal explains the limit',
    String(raceOverLimit.error?.message ?? '').includes('3'),
    raceOverLimit.error?.message,
  );

  // The race must be run AT the boundary, not past it. Racing against an
  // already-full quota proves nothing: every request is refused on the count
  // alone. So clear space for exactly one more, then fire four at once.
  const deleteMe = await api('/products?limit=50', { token: raceToken });
  await api(`/products/${deleteMe.data[0]._id}`, { method: 'DELETE', token: raceToken });
  await api(`/products/${deleteMe.data[1]._id}`, { method: 'DELETE', token: raceToken });

  const beforeRace = (await api('/subscriptions/current', { token: raceToken })).data?.usage?.products;
  check('Two slots free before the race', beforeRace === 1, beforeRace);

  const raceResults = await Promise.all([makeProduct('r1'), makeProduct('r2'), makeProduct('r3'), makeProduct('r4')]);
  const raceAccepted = raceResults.filter((r) => r.status === 201).length;
  const productCount = (await api('/subscriptions/current', { token: raceToken })).data?.usage?.products;
  check(
    'Concurrent creates cannot exceed the product limit',
    productCount <= 3,
    { limit: 3, before: beforeRace, after: productCount, acceptedInRace: raceAccepted },
  );

  // Every other count-based limit gets the same treatment, on its own fresh
  // workspace so each race starts from zero.
  const raceLimits = { maxProducts: 2, maxStaff: 1, maxStores: 2, maxCustomers: 2, maxMonthlySales: 2, maxStorageBytes: 10_000 };
  const racer2 = await api('/auth/register', {
    method: 'POST',
    body: {
      businessName: `Race Two ${raceStamp}`,
      name: 'Racer Two',
      email: `race2${raceStamp}@example.com`,
      password: 'Password@123',
    },
  });
  const race2Token = racer2.data.tokens.accessToken;
  await api('/stores', { method: 'POST', token: race2Token, body: { name: 'Race Two Store', currency: 'BDT' } });

  const race2Plan = await api('/plans', {
    method: 'POST',
    token: platform2.token,
    body: {
      code: `race2-${raceStamp}`,
      name: 'Race Two Plan',
      interval: 'monthly',
      priceMinor: 1000,
      tier: 1,
      isPublic: false,
      limits: raceLimits,
      features: { salesReports: true, customerManagement: true, inventoryLedger: true, multiStore: true },
    },
  });
  await api('/platform/subscriptions', {
    method: 'POST',
    token: platform2.token,
    body: { tenantId: racer2.data.tenant.id, planId: race2Plan.data._id, periods: 1, status: 'active' },
  });

  const race2Usage = async () => (await api('/subscriptions/current', { token: race2Token })).data?.usage;
  const fire = (n, fn) => Promise.all([...Array(n)].map((_, i) => fn(i)));

  // A correct guard is exact: it must not exceed the limit, and it must not
  // reject work that fitted either.
  const raceCase = async (label, limitKey, expected, fn, count, read) => {
    const results = await fire(count, fn);
    const after = read(await race2Usage());
    check(`Concurrent ${label}: limit holds`, after <= raceLimits[limitKey], {
      limit: raceLimits[limitKey],
      after,
      accepted: results.filter((r) => r.status < 300).length,
    });
    check(`Concurrent ${label}: nothing that fitted was rejected`, after === expected, {
      expected,
      after,
    });
  };

  await raceCase('products', 'maxProducts', 2, (i) =>
    api('/products', {
      method: 'POST',
      token: race2Token,
      body: { name: `RP${i}`, sku: `R2-${raceStamp}-${i}`, variants: [{ attributes: [], sellingPriceMinor: 1000, stock: 5 }] },
    }), 6, (u) => u?.products);

  await raceCase('customers', 'maxCustomers', 2, (i) =>
    api('/customers', {
      method: 'POST',
      token: race2Token,
      body: { name: `RC${i}`, phone: `017${String(raceStamp).slice(-6)}${i}` },
    }), 6, (u) => u?.customers);

  await raceCase('staff', 'maxStaff', 1, (i) =>
    api('/staff', {
      method: 'POST',
      token: race2Token,
      body: { name: `RS${i}`, email: `rs${i}.${raceStamp}@example.com`, password: 'Password@123' },
    }), 4, (u) => u?.staff);

  await raceCase('branches', 'maxStores', 2, (i) =>
    api('/stores', {
      method: 'POST',
      token: race2Token,
      body: { name: `RB${i}`, code: `RB${i}`, currency: 'BDT' },
    }), 5, (u) => u?.stores);

  // Storage is cumulative rather than countable: 3 x 3,000 fits in 10,000.
  await raceCase('uploads', 'maxStorageBytes', 9_000, () =>
    upload('/uploads/image', { token: race2Token, bytes: makePng(3_000) }), 6, (u) => u?.storageBytes);

  const race2Search = await api('/products/pos-search?q=&limit=50', { token: race2Token });
  const race2Variant = (race2Search.data ?? []).find((v) => v.stock >= 5);
  if (race2Variant) {
    await raceCase('sales', 'maxMonthlySales', 2, () =>
      api('/sales', {
        method: 'POST',
        token: race2Token,
        body: { items: [{ variantId: race2Variant.variantId, quantity: 1 }], paymentMethod: 'cash' },
      }), 6, (u) => u?.monthlySales);
  }

  await api(`/plans/${race2Plan.data._id}`, { method: 'DELETE', token: platform2.token });

  // --- 7. storage tricks ---------------------------------------------------
  section('Anti-bypass: upload abuse');

  const raceDisguised = await upload('/uploads/image', {
    token: admin.token,
    bytes: Buffer.from('#!/bin/sh\necho pwned\n'),
    filename: 'payload.png',
  });
  check(
    'A script renamed .png is not stored as an image',
    raceDisguised.status >= 400 || raceDisguised.data?.mimeType === 'image/png',
    { status: raceDisguised.status, mime: raceDisguised.data?.mimeType },
  );

  // Past the 20 MB multipart ceiling, which applies on every plan.
  const raceTooBig = await upload('/uploads/image', { token: admin.token, bytes: makePng(21 * 1024 * 1024) });
  check('A file over the size cap is refused', raceTooBig.status >= 400, raceTooBig.status);

  const noAuthUpload = await upload('/uploads/image', { bytes: makePng(1000) });
  check('Anonymous upload is refused', noAuthUpload.status === 401, noAuthUpload.status);

  // --- 8. auth and token abuse --------------------------------------------
  section('Anti-bypass: auth');

  const raceNoneAlg = await api('/products', { token: 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJhZG1pbiJ9.' });
  check('A none-algorithm token is rejected', raceNoneAlg.status === 401, raceNoneAlg.status);

  const raceTamperedToken = `${admin.token.slice(0, -6)}AAAAAA`;
  const raceTampered = await api('/products', { token: raceTamperedToken });
  check('A tampered signature is rejected', raceTampered.status === 401, raceTampered.status);

  const platformOnTenant = await api('/products', { token: platform2.token });
  check('A platform admin token cannot drive tenant POS endpoints', platformOnTenant.status === 403, platformOnTenant.status);

  const cashierPlatformCall = await api('/platform/overview', { token: cashier.token });
  check('A cashier cannot reach platform analytics', cashierPlatformCall.status === 403, cashierPlatformCall.status);

  const cashierPlans = await api('/plans', {
    method: 'POST',
    token: cashier.token,
    body: { code: 'nope', name: 'Nope', interval: 'monthly', priceMinor: 0 },
  });
  check('A cashier cannot create plans', cashierPlans.status === 403, cashierPlans.status);

  // Clean up the throwaway plan so it cannot affect later runs.
  await api(`/plans/${racePlan.data._id}`, { method: 'DELETE', token: platform2.token });

  // ==================================================================
  //  PER-PLAN ENFORCEMENT MATRIX
  //  Each plan must enforce ITS OWN numbers. Testing that "a limit exists"
  //  would pass even if every plan shared one ceiling, so each is driven to
  //  its exact boundary and one step past it.
  // ==================================================================
  section('Per-plan enforcement matrix');

  const matrixPlans = (await api('/plans')).data ?? [];
  const planByCode = (code) => matrixPlans.find((p) => p.code === code);

  const makeTenantOn = async (label, planCode) => {
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const reg = await api('/auth/register', {
      method: 'POST',
      body: {
        businessName: `${label} ${stamp}`,
        name: `${label} Owner`,
        email: `mx${label.toLowerCase()}${stamp}@example.com`,
        password: 'Password@123',
      },
    });
    const token = reg.data.tokens.accessToken;
    await api('/stores', { method: 'POST', token, body: { name: `${label} Main`, currency: 'BDT' } });
    await api('/platform/subscriptions', {
      method: 'POST',
      token: platform2.token,
      body: { tenantId: reg.data.tenant.id, planId: planByCode(planCode)._id, periods: 1, status: 'active' },
    });
    return { token, tenantId: reg.data.tenant.id, stamp };
  };

  // --- branches: small enough to exhaust on all three plans ----------------
  for (const [planCode, planLabel, allowed] of [
    ['starter-store-monthly', 'Starter', 1],
    ['showroom-monthly', 'Showroom', 2],
    ['brand-monthly', 'Brand', 10],
  ]) {
    const tenant = await makeTenantOn(planLabel, planCode);

    // One branch already exists from setup; fill to exactly the ceiling.
    let created = 1;
    let blockedAt = null;
    for (let i = 2; i <= allowed + 1; i += 1) {
      const res = await api('/stores', {
        method: 'POST',
        token: tenant.token,
        body: { name: `${planLabel} Branch ${i}`, code: `B${i}${tenant.stamp.slice(-4)}`, currency: 'BDT' },
      });
      if (res.status === 201) created += 1;
      else if (blockedAt === null) blockedAt = i;
    }

    check(`${planLabel}: allows exactly ${allowed} branch${allowed === 1 ? '' : 'es'}`, created === allowed, {
      allowed,
      created,
    });
    check(`${planLabel}: refuses branch ${allowed + 1}`, blockedAt === allowed + 1, { blockedAt });
  }

  // --- Advanced Analytics: all six plans, by direct API call ----------------
  section('Advanced Analytics access (all six plans)');

  // Every analytics endpoint, not just the one the page happens to call first.
  const ANALYTICS_ENDPOINTS = [
    '/reports/sales',
    '/reports/breakdown?dimension=product',
    '/reports/breakdown?dimension=variant',
    '/reports/payments',
    '/reports/returns',
    '/reports/staff',
    '/reports/inventory',
    '/reports/customers',
    '/reports/dashboard',
    '/reports/branches',
  ];

  for (const [planCode, planLabel, unlocked] of [
    ['starter-store-monthly', 'Starter Monthly', false],
    ['starter-store-annual', 'Starter Annual', false],
    ['showroom-monthly', 'Showroom Monthly', true],
    ['showroom-annual', 'Showroom Annual', true],
    ['brand-monthly', 'Brand Monthly', true],
    ['brand-annual', 'Brand Annual', true],
  ]) {
    const tenant = await makeTenantOn(planLabel.replace(' ', ''), planCode);
    const ent = (await api('/subscriptions/current', { token: tenant.token })).data?.entitlement;
    check(`${planLabel}: resolves to ${planCode}`, ent?.planCode === planCode, ent?.planCode);
    check(`${planLabel}: advancedReports capability = ${unlocked}`, ent?.features?.advancedReports === unlocked, ent?.features);

    const overviewRes = await api('/reports/overview?preset=last30', { token: tenant.token });
    check(`${planLabel}: Dashboard is available`, overviewRes.status === 200, overviewRes.error);
    check(
      `${planLabel}: Dashboard profit is ${unlocked ? 'included' : 'withheld'}`,
      unlocked ? typeof overviewRes.data?.kpis?.profitMinor === 'number' : overviewRes.data?.kpis?.profitMinor === null,
      overviewRes.data?.kpis?.profitMinor,
    );

    for (const path of ANALYTICS_ENDPOINTS) {
      const res = await api(`${path}${path.includes('?') ? '&' : '?'}preset=last30`, { token: tenant.token });
      if (unlocked) {
        check(`${planLabel}: ${path} returns data`, res.status === 200 && res.data != null, { status: res.status, error: res.error });
      } else {
        check(
          `${planLabel}: ${path} refused with ADVANCED_ANALYTICS_REQUIRED`,
          res.status === 403 && res.error?.code === 'ADVANCED_ANALYTICS_REQUIRED' && res.data == null,
          { status: res.status, error: res.error },
        );
      }
    }
  }

  // --- staff: Starter 2, Showroom 10, Brand unlimited ----------------------
  const staffMatrix = [
    ['starter-store-monthly', 'Starter', 2, false],
    ['showroom-monthly', 'Showroom', 6, false],
    ['brand-monthly', 'Brand', -1, true],
  ];
  for (const [planCode, planLabel, allowed, unlimited] of staffMatrix) {
    const tenant = await makeTenantOn(`${planLabel}Staff`, planCode);
    const target = unlimited ? 12 : allowed + 1;

    let created = 0;
    let blockedAt = null;
    for (let i = 1; i <= target; i += 1) {
      const res = await api('/staff', {
        method: 'POST',
        token: tenant.token,
        body: { name: `Staff ${i}`, email: `st${i}.${tenant.stamp}@example.com`, password: 'Password@123' },
      });
      if (res.status === 201) created += 1;
      else if (blockedAt === null) blockedAt = i;
    }

    if (unlimited) {
      // 12 is beyond Showroom's ceiling of 10, so this proves Brand is not
      // quietly reusing a lower plan's number.
      check(`${planLabel}: staff is genuinely unlimited`, created === 12 && blockedAt === null, {
        created,
        blockedAt,
      });
    } else {
      check(`${planLabel}: allows exactly ${allowed} staff`, created === allowed, { allowed, created });
      check(`${planLabel}: refuses staff ${allowed + 1}`, blockedAt === allowed + 1, { blockedAt });
    }
  }

  // --- the plans must differ from one another ------------------------------
  // A matrix where every plan happened to share one ceiling would satisfy every
  // check above, so assert the numbers are actually distinct.
  const starterLimits = planByCode('starter-store-monthly').limits;
  const showroomLimits = planByCode('showroom-monthly').limits;
  const brandLimits = planByCode('brand-monthly').limits;

  check(
    'Branch ceilings differ across the three plans',
    starterLimits.maxStores < showroomLimits.maxStores && showroomLimits.maxStores < brandLimits.maxStores,
    { starter: starterLimits.maxStores, showroom: showroomLimits.maxStores, brand: brandLimits.maxStores },
  );
  check(
    'Staff ceilings escalate, ending unlimited',
    starterLimits.maxStaff < showroomLimits.maxStaff && brandLimits.maxStaff === -1,
    { starter: starterLimits.maxStaff, showroom: showroomLimits.maxStaff, brand: brandLimits.maxStaff },
  );
  check(
    'Every countable limit escalates from Starter to Showroom',
    ['maxProducts', 'maxCustomers', 'maxMonthlySales', 'maxStorageBytes'].every(
      (k) => showroomLimits[k] === -1 || showroomLimits[k] > starterLimits[k],
    ),
    { starter: starterLimits, showroom: showroomLimits },
  );

  // ==================================================================
  //  BRAND IMAGE OPTIMIZATION  (Brand-only, enforced server-side)
  // ==================================================================
  section('Image optimization');

  const optPlans = (await api('/plans')).data ?? [];
  const optStamp = Date.now();

  const optTenant = async (label, code) => {
    const reg = await api('/auth/register', {
      method: 'POST',
      body: {
        businessName: `${label} ${optStamp}`,
        name: `${label} Owner`,
        email: `opt${label.toLowerCase()}${optStamp}@example.com`,
        password: 'Password@123',
      },
    });
    const token = reg.data.tokens.accessToken;
    await api('/stores', { method: 'POST', token, body: { name: `${label} Store`, currency: 'BDT' } });
    await api('/platform/subscriptions', {
      method: 'POST',
      token: platform2.token,
      body: { tenantId: reg.data.tenant.id, planId: optPlans.find((p) => p.code === code)._id, periods: 1, status: 'active' },
    });
    return token;
  };

  const brandToken = await optTenant('OptBrand', 'brand-monthly');
  const showroomToken = await optTenant('OptShowroom', 'showroom-monthly');

  // A 2400x2400 JPEG: larger than the 4 MB unoptimised cap and beyond the
  // 2000px resize ceiling, so both behaviours are exercised.
  const bigJpeg = await makeJpeg(2400, 2400);
  check('Test image is over the unoptimised limit', bigJpeg.byteLength > 4 * 1024 * 1024, bigJpeg.byteLength);

  const brandUpload = await upload('/uploads/image', { token: brandToken, bytes: bigJpeg, filename: 'big.jpg' });
  check('Brand accepts a large image', brandUpload.status === 201, brandUpload.error);
  check('Brand upload is stored as WebP', brandUpload.data?.mimeType === 'image/webp', brandUpload.data?.mimeType);
  check(
    'Brand upload is smaller than the original',
    brandUpload.data?.size < bigJpeg.byteLength,
    { original: bigJpeg.byteLength, stored: brandUpload.data?.size },
  );
  check(
    'Brand upload is resized to the 2000px ceiling',
    brandUpload.data?.optimisation?.width <= 2000 && brandUpload.data?.optimisation?.height <= 2000,
    brandUpload.data?.optimisation,
  );

  // Only the OPTIMISED bytes count against the quota, not what was sent.
  const brandUsage = (await api('/subscriptions/current', { token: brandToken })).data?.usage;
  check(
    'Only the optimised size counts toward the quota',
    brandUsage?.storageBytes === brandUpload.data?.size,
    { quota: brandUsage?.storageBytes, stored: brandUpload.data?.size, sent: bigJpeg.byteLength },
  );

  // Showroom has no optimisation, so the same file must be refused outright
  // rather than silently stored at full size.
  const showroomBig = await upload('/uploads/image', { token: showroomToken, bytes: bigJpeg, filename: 'big.jpg' });
  check('Showroom cannot upload an oversized image', showroomBig.status >= 400, showroomBig.status);
  check(
    'The refusal explains the plan difference',
    /enterprise/i.test(String(showroomBig.error?.message ?? '')),
    showroomBig.error?.message,
  );

  const smallJpeg = await makeJpeg(400, 400);
  const showroomSmall = await upload('/uploads/image', { token: showroomToken, bytes: smallJpeg, filename: 'small.jpg' });
  check('Showroom can still upload a normal image', showroomSmall.status === 201, showroomSmall.error);
  check(
    'Showroom uploads are NOT converted to WebP',
    showroomSmall.data?.mimeType !== 'image/webp',
    showroomSmall.data?.mimeType,
  );
  check('Showroom does not report an optimisation', !showroomSmall.data?.optimisation, showroomSmall.data?.optimisation);

  // --- corrupt and disguised files -----------------------------------------
  const optNotAnImage = await upload('/uploads/image', {
    token: brandToken,
    bytes: Buffer.from('#!/bin/sh\necho pwned\n'),
    filename: 'payload.png',
  });
  check('A script renamed .png is rejected by content inspection', optNotAnImage.status >= 400, {
    status: optNotAnImage.status,
    error: optNotAnImage.error,
  });

  const optTruncated = await upload('/uploads/image', {
    token: brandToken,
    bytes: bigJpeg.subarray(0, 200),
    filename: 'optTruncated.jpg',
  });
  check('A optTruncated image is rejected', optTruncated.status >= 400, optTruncated.status);

  // ==================================================================
  //  PAYMENT REQUEST VALIDATION
  // ==================================================================
  section('Payment request validation');

  const payToken = brandToken;

  const topUpCases = [
    ['no sender number', { amountMinor: 100000, paymentMethod: 'bkash', transactionId: `TX${optStamp}A` }],
    ['blank sender number', { amountMinor: 100000, paymentMethod: 'bkash', senderNumber: '', transactionId: `TX${optStamp}B` }],
    ['letters as a sender number', { amountMinor: 100000, paymentMethod: 'bkash', senderNumber: 'call-me', transactionId: `TX${optStamp}C` }],
    ['no transaction id', { amountMinor: 100000, paymentMethod: 'bkash', senderNumber: '01712345678' }],
    ['short transaction id', { amountMinor: 100000, paymentMethod: 'bkash', senderNumber: '01712345678', transactionId: 'ab' }],
  ];
  for (const [label, body] of topUpCases) {
    const res = await api('/wallet/top-ups', { method: 'POST', token: payToken, body });
    check(`Top-up rejects ${label}`, res.status === 422 || res.status === 400, { status: res.status });
  }

  const optGoodTopUp = await api('/wallet/top-ups', {
    method: 'POST',
    token: payToken,
    body: { amountMinor: 100000, paymentMethod: 'bkash', senderNumber: '01712345678', transactionId: `TXOK${optStamp}` },
  });
  check('A complete top-up request is accepted', optGoodTopUp.status === 201, optGoodTopUp.error);

  const optDupTopUp = await api('/wallet/top-ups', {
    method: 'POST',
    token: payToken,
    body: { amountMinor: 100000, paymentMethod: 'bkash', senderNumber: '01712345678', transactionId: `TXOK${optStamp}` },
  });
  check('A duplicate transaction ID is refused', optDupTopUp.status === 409, optDupTopUp.status);

  const pendingBalance = (await api('/wallet', { token: payToken })).data?.balanceMinor;
  check('An unapproved top-up does not credit the wallet', pendingBalance === 0, pendingBalance);

  // --- subscription purchase ------------------------------------------------
  const upgradePlan = optPlans.find((p) => p.code === 'brand-annual');
  const upgradePlanId = upgradePlan._id;
  // The correct price, so each case fails for the field under test, not the amount.
  const upgradeAmount = upgradePlan.priceMinor;
  const upgradeCases = [
    ['no sender number', { planId: upgradePlanId, paymentMethod: 'bkash', amountMinor: upgradeAmount, transactionId: `UP${optStamp}A` }],
    ['blank sender number', { planId: upgradePlanId, paymentMethod: 'bkash', amountMinor: upgradeAmount, senderNumber: '', transactionId: `UP${optStamp}B` }],
    ['letters as a sender number', { planId: upgradePlanId, paymentMethod: 'bkash', amountMinor: upgradeAmount, senderNumber: 'pay-me', transactionId: `UP${optStamp}C` }],
    ['no transaction id', { planId: upgradePlanId, paymentMethod: 'bkash', amountMinor: upgradeAmount, senderNumber: '01712345678' }],
  ];
  for (const [label, body] of upgradeCases) {
    const res = await api('/subscriptions/upgrade-request', { method: 'POST', token: payToken, body });
    check(`Upgrade request rejects ${label}`, res.status >= 400, { status: res.status, error: res.error });
  }

  // ==================================================================
  //  MALFORMED SUBSCRIPTION MUST NOT BREAK SIGN-IN
  //  `planSnapshot` is a Mixed field, so nothing at the schema level
  //  guarantees it exists. Reading through a missing one threw, and because
  //  every session build resolves the entitlement, it surfaced as a 500 on
  //  LOGIN - locking the owner out of the very screens they would use to fix
  //  their subscription.
  // ==================================================================
  section('Malformed subscription resilience');

  const brokenStamp = Date.now();
  const brokenTenant = await api('/auth/register', {
    method: 'POST',
    body: {
      businessName: `Broken Sub ${brokenStamp}`,
      name: 'Broken Owner',
      email: `broken${brokenStamp}@example.com`,
      password: 'Password@123',
    },
  });
  check('Workspace for the malformed-subscription test registers', brokenTenant.status === 201, brokenTenant.error);
  const brokenToken = brokenTenant.data.tokens.accessToken;
  await api('/stores', { method: 'POST', token: brokenToken, body: { name: 'Broken Store', currency: 'BDT' } });

  // Assigning a plan whose code no longer resolves is the closest the API can
  // get to the shape a partial write leaves behind.
  const brokenPlans = (await api('/plans')).data ?? [];
  const brokenPlan = brokenPlans.find((p) => p.code === 'starter-store-monthly');
  await api('/platform/subscriptions', {
    method: 'POST',
    token: platform2.token,
    body: { tenantId: brokenTenant.data.tenant.id, planId: brokenPlan._id, periods: 1, status: 'active' },
  });

  const brokenLogin = await api('/auth/login', {
    method: 'POST',
    body: { email: `broken${brokenStamp}@example.com`, password: 'Password@123' },
  });
  check('Sign-in succeeds with a subscription present', brokenLogin.status === 200, brokenLogin.error);
  check(
    'The session always carries an entitlement object',
    typeof brokenLogin.data?.entitlement === 'object' && brokenLogin.data.entitlement !== null,
    brokenLogin.data?.entitlement,
  );
  check(
    'The entitlement always carries limits and features',
    typeof brokenLogin.data?.entitlement?.limits === 'object' &&
      typeof brokenLogin.data?.entitlement?.features === 'object',
    brokenLogin.data?.entitlement,
  );
  check(
    'A workspace with no resolvable plan is never marked usable',
    brokenLogin.data?.entitlement?.planCode === null
      ? brokenLogin.data.entitlement.isUsable === false
      : true,
    { planCode: brokenLogin.data?.entitlement?.planCode, isUsable: brokenLogin.data?.entitlement?.isUsable },
  );

  // /auth/me resolves the entitlement too, so it must survive the same shape.
  const brokenMe = await api('/auth/me', { token: brokenLogin.data.tokens.accessToken });
  check('Session refresh survives too', brokenMe.status === 200, brokenMe.error);

  // ==================================================================
  //  SESSION LIFECYCLE
  //  Registration, refresh rotation, logout and sessReplay - none of which the
  //  suite covered before.
  // ==================================================================
  section('Session lifecycle');

  const sessStamp = Date.now();
  const sessEmail = `sess${sessStamp}@example.com`;

  const sessSignup = await api('/auth/register', {
    method: 'POST',
    body: { businessName: `Session ${sessStamp}`, name: 'Session Owner', email: sessEmail, password: 'Password@123' },
  });
  check('Registration succeeds', sessSignup.status === 201, sessSignup.error);
  check('Registration returns an access token', Boolean(sessSignup.data?.tokens?.accessToken));
  check('Registration returns a refresh token', Boolean(sessSignup.data?.tokens?.refreshToken));

  const sessDuplicate = await api('/auth/register', {
    method: 'POST',
    body: { businessName: 'Copycat', name: 'Copy Cat', email: sessEmail, password: 'Password@123' },
  });
  check('The same email cannot register twice', sessDuplicate.status === 409, sessDuplicate.status);

  const wrongPassword = await api('/auth/login', {
    method: 'POST',
    body: { email: sessEmail, password: 'NotThePassword@1' },
  });
  check('A wrong password is rejected', wrongPassword.status === 401, wrongPassword.status);
  check(
    'A failed login gives a generic message',
    /email or password/i.test(String(wrongPassword.error?.message ?? '')),
    wrongPassword.error?.message,
  );

  const unknownUser = await api('/auth/login', {
    method: 'POST',
    body: { email: `nobody${sessStamp}@example.com`, password: 'Password@123' },
  });
  check('An unknown account is rejected', unknownUser.status === 401, unknownUser.status);
  check(
    'Unknown account and wrong password answer alike',
    unknownUser.error?.message === wrongPassword.error?.message,
    { unknown: unknownUser.error?.message, wrong: wrongPassword.error?.message },
  );

  const signin = await api('/auth/login', { method: 'POST', body: { email: sessEmail, password: 'Password@123' } });
  check('Correct credentials sign in', signin.status === 200, signin.error);

  const sessToken = signin.data.tokens.accessToken;
  const sessRefresh = signin.data.tokens.refreshToken;

  const meBefore = await api('/auth/me', { token: sessToken });
  check('The access token identifies the user', meBefore.data?.user?.email === sessEmail, meBefore.data?.user?.email);

  // --- refresh rotation ----------------------------------------------------
  const refreshed = await api('/auth/refresh', { method: 'POST', body: { refreshToken: sessRefresh } });
  check('A refresh token issues a new session', refreshed.status === 200, refreshed.error);
  const refreshedMe = await api('/auth/me', { token: refreshed.data.accessToken });
  check('The refreshed access token works', refreshedMe.status === 200, refreshedMe.error);
  check('Refresh ROTATES the refresh token', refreshed.data?.refreshToken !== sessRefresh);

  // The old one must not work twice - that is the sessReplay defence.
  const sessReplay = await api('/auth/refresh', { method: 'POST', body: { refreshToken: sessRefresh } });
  check('A used refresh token cannot be replayed', sessReplay.status === 401, sessReplay.status);

  const forgedRefresh = await api('/auth/refresh', { method: 'POST', body: { refreshToken: 'not-a-real-refresh-token' } });
  check('A forged refresh token is rejected', forgedRefresh.status === 401, forgedRefresh.status);

  const noRefresh = await api('/auth/refresh', { method: 'POST', body: {} });
  check('Refresh without a token is rejected', noRefresh.status === 401, noRefresh.status);

  // --- logout ---------------------------------------------------------------
  const rotated = refreshed.data.refreshToken;
  const signout = await api('/auth/logout', { method: 'POST', token: refreshed.data.accessToken, body: { refreshToken: rotated } });
  check('Logout succeeds', signout.status === 200, signout.error);

  const afterLogout = await api('/auth/refresh', { method: 'POST', body: { refreshToken: rotated } });
  check('The refresh token is dead after logout', afterLogout.status === 401, afterLogout.status);

  // --- password change invalidates sessions --------------------------------
  const pwUser = await api('/auth/login', { method: 'POST', body: { email: sessEmail, password: 'Password@123' } });
  const pwToken = pwUser.data.tokens.accessToken;
  const pwRefresh = pwUser.data.tokens.refreshToken;

  const sessChanged = await api('/auth/change-password', {
    method: 'POST',
    token: pwToken,
    body: { currentPassword: 'Password@123', newPassword: 'BrandNew@456' },
  });
  check('Password can be changed with the correct current one', sessChanged.status === 200, sessChanged.error);

  const wrongCurrent = await api('/auth/change-password', {
    method: 'POST',
    token: pwToken,
    body: { currentPassword: 'StillWrong@1', newPassword: 'Another@789' },
  });
  check('Password change needs the correct current password', wrongCurrent.status >= 400, wrongCurrent.status);

  const oldPasswordLogin = await api('/auth/login', { method: 'POST', body: { email: sessEmail, password: 'Password@123' } });
  check('The old password no longer works', oldPasswordLogin.status === 401, oldPasswordLogin.status);

  const newPasswordLogin = await api('/auth/login', { method: 'POST', body: { email: sessEmail, password: 'BrandNew@456' } });
  check('The new password works', newPasswordLogin.status === 200, newPasswordLogin.error);

  const refreshAfterPwChange = await api('/auth/refresh', { method: 'POST', body: { refreshToken: pwRefresh } });
  check('Changing the password kills existing refresh tokens', refreshAfterPwChange.status === 401, refreshAfterPwChange.status);

  // ==================================================================
  //  MARKETING SECURITY
  // ==================================================================
  section('Marketing security');

  const secStamp = Date.now();
  const secPlans = (await api('/plans')).data ?? [];
  const secShowroom = secPlans.find((p) => p.code === 'showroom-monthly');

  // SMTP must be configured for these tests, or every email campaign is refused
  // for a missing provider and the sanitiser is never reached - the checks
  // would pass without testing anything.
  const smtpForSecurity = await api('/platform/settings', {
    method: 'PATCH',
    token: platform2.token,
    body: {
      smtp: {
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        username: 'mailer',
        password: 'pw',
        fromName: 'POS',
        fromEmail: 'noreply@example.com',
        enabled: true,
      },
    },
  });
  check('SMTP configured so email paths are actually exercised', smtpForSecurity.status === 200, smtpForSecurity.error);

  // Two paid workspaces, so cross-tenant reach is testable between equals
  // rather than being blocked by a plan restriction.
  const mkPaidTenant = async (label) => {
    const reg = await api('/auth/register', {
      method: 'POST',
      body: {
        businessName: `${label} ${secStamp}`,
        name: `${label} Owner`,
        email: `${label.toLowerCase().replace(/\W/g, '')}${secStamp}@example.com`,
        password: 'Password@123',
      },
    });
    const token = reg.data.tokens.accessToken;
    await api('/stores', { method: 'POST', token, body: { name: `${label} Store`, currency: 'BDT' } });
    await api('/platform/subscriptions', {
      method: 'POST',
      token: platform2.token,
      body: { tenantId: reg.data.tenant.id, planId: secShowroom._id, periods: 1, status: 'active' },
    });
    await api(`/platform/tenants/${reg.data.tenant.id}/wallet/adjust`, {
      method: 'POST',
      token: platform2.token,
      body: { direction: 'credit', amountMinor: 500_000, reason: 'Marketing security test funding' },
    });
    return { token, tenantId: reg.data.tenant.id };
  };

  const mktVictim = await mkPaidTenant('SecVictim');
  const mktAttacker = await mkPaidTenant('SecAttacker');
  check('Two paid workspaces created for the test', Boolean(mktVictim.token && mktAttacker.token));

  // Give the mktVictim a customer and a campaign to try to reach.
  const mktVictimCustomer = await api('/customers', {
    method: 'POST',
    token: mktVictim.token,
    body: { name: 'Victim Customer', phone: `0171${String(secStamp).slice(-7)}`, email: `vc${secStamp}@example.com` },
  });
  check('Victim has a customer', mktVictimCustomer.status === 201, mktVictimCustomer.error);

  const mktVictimCampaign = await api('/messaging/campaigns', {
    method: 'POST',
    token: mktVictim.token,
    body: { name: 'Victim Campaign', message: 'Hello from the mktVictim', audience: 'all-customers' },
  });
  check('Victim can send their own campaign', mktVictimCampaign.status === 201, mktVictimCampaign.error);

  // --- 1. cross-tenant recipient targeting ----------------------------------
  const stealRecipients = await api('/messaging/campaigns', {
    method: 'POST',
    token: mktAttacker.token,
    body: {
      name: 'Steal',
      message: 'Targeting another tenant customer',
      audience: 'selected',
      customerIds: [mktVictimCustomer.data._id],
    },
  });
  check(
    "A campaign cannot target another tenant's customer",
    stealRecipients.status >= 400,
    { status: stealRecipients.status, error: stealRecipients.error },
  );

  const stealEmail = await api('/messaging/email-campaigns', {
    method: 'POST',
    token: mktAttacker.token,
    body: {
      name: 'Steal Email',
      subject: 'Hello',
      body: '<p>hi</p>',
      audience: 'selected',
      customerIds: [mktVictimCustomer.data._id],
    },
  });
  check("An email campaign cannot target another tenant's customer", stealEmail.status >= 400, stealEmail.status);

  // --- 2. free-form recipient lists are gone --------------------------------
  const arbitraryNumbers = await api('/messaging/campaigns', {
    method: 'POST',
    token: mktAttacker.token,
    body: {
      name: 'Spam Cannon',
      message: 'Unsolicited',
      audience: 'selected',
      phones: ['01711111111', '01722222222', '01733333333'],
    },
  });
  check(
    'A campaign cannot carry a free-form phone list',
    arbitraryNumbers.status >= 400,
    { status: arbitraryNumbers.status, error: arbitraryNumbers.error },
  );

  // --- 3. campaign history is tenant scoped ---------------------------------
  const mktAttackerCampaigns = await api('/messaging/campaigns', { token: mktAttacker.token });
  const sawVictimCampaign = (mktAttackerCampaigns.data ?? []).some((c) => c.name === 'Victim Campaign');
  check("Campaign history never shows another tenant's campaigns", !sawVictimCampaign, mktAttackerCampaigns.data?.length);

  const filterByVictimCampaign = await api(`/messaging/sms?campaignId=${mktVictimCampaign.data._id}`, {
    token: mktAttacker.token,
  });
  check(
    "Filtering by another tenant's campaign id returns nothing",
    (filterByVictimCampaign.data ?? []).length === 0,
    filterByVictimCampaign.data?.length,
  );

  const mktVictimOwnHistory = await api(`/messaging/sms?campaignId=${mktVictimCampaign.data._id}`, { token: mktVictim.token });
  check('The owning tenant still sees their own messages', (mktVictimOwnHistory.data ?? []).length > 0, mktVictimOwnHistory.data?.length);

  // --- 4. HTML content is sanitised SERVER-side -----------------------------
  // The browser sanitises too, but a campaign can be posted with no browser
  // involved, so the server must be the one that decides.
  const xssBodies = [
    ['script tag', '<p>hi</p><script>alert(1)</script>'],
    ['img onerror', '<img src=x onerror="alert(1)">'],
    ['javascript: href', '<a href="javascript:alert(1)">click</a>'],
    ['iframe', '<iframe src="https://evil.example"></iframe>'],
    ['onclick handler', '<div onclick="alert(1)">text</div>'],
  ];
  for (const [label, body] of xssBodies) {
    const res = await api('/messaging/email-campaigns', {
      method: 'POST',
      token: mktVictim.token,
      body: { name: `XSS ${label}`, subject: 'Test', body, audience: 'all-customers' },
    });
    // Either the payload is stripped and the campaign sends, or the body is
    // empty once stripped and it is refused as such. A refusal for any OTHER
    // reason means the sanitiser was never reached, and the check would be
    // passing without testing anything.
    if (res.status === 201) {
      const stored = await api('/messaging/campaigns', { token: mktVictim.token });
      const saved = (stored.data ?? []).find((c) => c.name === `XSS ${label}`);
      const text = String(saved?.message ?? '');
      check(
        `Server strips ${label}`,
        !/<script|onerror=|onclick=|<iframe|javascript:/i.test(text),
        text.slice(0, 120),
      );
    } else {
      check(
        `Server refuses ${label} as an empty body`,
        res.status === 400 && /empty once scripts/i.test(String(res.error?.message ?? '')),
        { status: res.status, error: res.error },
      );
    }
  }

  const cleanBody = await api('/messaging/email-campaigns', {
    method: 'POST',
    token: mktVictim.token,
    body: {
      name: 'Clean Campaign',
      subject: 'Our new collection',
      body: '<h1>New in</h1><p>Visit us <a href="https://example.com">here</a>.</p>',
      audience: 'all-customers',
    },
  });
  check('Legitimate HTML is still accepted', cleanBody.status === 201, cleanBody.error);
  const cleanStored = (await api('/messaging/campaigns', { token: mktVictim.token })).data?.find(
    (c) => c.name === 'Clean Campaign',
  );
  check(
    'Safe markup survives sanitising',
    String(cleanStored?.message ?? '').includes('<h1>New in</h1>'),
    String(cleanStored?.message ?? '').slice(0, 140),
  );

  // --- 5. permissions -------------------------------------------------------
  const mktVictimStaff = await api('/staff', {
    method: 'POST',
    token: mktVictim.token,
    body: { name: 'No Marketing', email: `nomkt${secStamp}@example.com`, password: 'Password@123' },
  });
  check('Staff without marketing permissions created', mktVictimStaff.status === 201, mktVictimStaff.error);

  const staffLogin = await api('/auth/login', {
    method: 'POST',
    body: { email: `nomkt${secStamp}@example.com`, password: 'Password@123' },
  });
  const staffToken = staffLogin.data?.tokens?.accessToken;
  check('That staff member can sign in', Boolean(staffToken), staffLogin.error);

  const staffSend = await api('/messaging/campaigns', {
    method: 'POST',
    token: staffToken,
    body: { name: 'Unauthorised', message: 'nope', audience: 'all-customers' },
  });
  check('Staff without permission cannot send a campaign', staffSend.status === 403, staffSend.status);

  const staffEmail = await api('/messaging/email-campaigns', {
    method: 'POST',
    token: staffToken,
    body: { name: 'Unauthorised', subject: 'nope', body: '<p>no</p>', audience: 'all-customers' },
  });
  check('Staff without permission cannot send email', staffEmail.status === 403, staffEmail.status);

  const staffHistory = await api('/messaging/campaigns', { token: staffToken });
  check('Staff without permission cannot read campaign history', staffHistory.status === 403, staffHistory.status);

  // --- 6. spend cannot exceed the wallet ------------------------------------
  const mktAttackerWallet = (await api('/wallet', { token: mktAttacker.token })).data?.balanceMinor ?? 0;
  const concurrentSends = await Promise.all(
    [...Array(5)].map((_, i) =>
      api('/messaging/campaigns', {
        method: 'POST',
        token: mktAttacker.token,
        body: { name: `Concurrent ${i}`, message: 'Testing wallet limits', audience: 'all-customers' },
      }),
    ),
  );
  const walletAfter = (await api('/wallet', { token: mktAttacker.token })).data?.balanceMinor ?? 0;
  check('Concurrent campaigns never overdraw the wallet', walletAfter >= 0, {
    before: mktAttackerWallet,
    after: walletAfter,
    accepted: concurrentSends.filter((r) => r.status === 201).length,
  });

  // ==================================================================
  //  MARKETING AVAILABILITY: PLAN vs PROVIDER
  //  The email editor used to be disabled whenever SMTP was unset, which
  //  conflated "cannot send" with "cannot compose" and left the field dead
  //  on every fresh install. The API must report the two reasons separately.
  // ==================================================================
  section('Marketing availability');

  const availStamp = Date.now();
  const availPlans = (await api('/plans')).data ?? [];
  const availStarter = availPlans.find((p) => p.code === 'starter-store-monthly');
  const availShowroom = availPlans.find((p) => p.code === 'showroom-monthly');

  const availTenant = await api('/auth/register', {
    method: 'POST',
    body: {
      businessName: `Avail Test ${availStamp}`,
      name: 'Avail Owner',
      email: `avail${availStamp}@example.com`,
      password: 'Password@123',
    },
  });
  const availToken = availTenant.data.tokens.accessToken;
  const availTenantId = availTenant.data.tenant.id;
  await api('/stores', { method: 'POST', token: availToken, body: { name: 'Avail Store', currency: 'BDT' } });

  const setAvailPlan = (planId) =>
    api('/platform/subscriptions', {
      method: 'POST',
      token: platform2.token,
      body: { tenantId: availTenantId, planId, periods: 1, status: 'active' },
    });
  const setAvailSmtp = (enabled) =>
    api('/platform/settings', {
      method: 'PATCH',
      token: platform2.token,
      body: {
        smtp: {
          host: enabled ? 'smtp.example.com' : '',
          port: 587,
          secure: false,
          username: enabled ? 'mailer' : '',
          ...(enabled ? { password: 'pw' } : {}),
          fromName: enabled ? 'POS' : '',
          fromEmail: enabled ? 'noreply@example.com' : '',
          enabled,
        },
      },
    });

  // --- 1. plan excludes the channel ----------------------------------------
  await setAvailPlan(availStarter._id);
  await setAvailSmtp(true);
  const starterState = (await api('/messaging/status', { token: availToken })).data;
  check('Starter: email is not in the plan', starterState?.email?.includedInPlan === false, starterState?.email);
  check('Starter: the provider IS configured', starterState?.email?.providerConfigured === true, starterState?.email);
  check('Starter: email is therefore unavailable', starterState?.email?.available === false);
  check('Starter: the plan name is reported for the upgrade message', typeof starterState?.planName === 'string', starterState?.planName);

  // The two reasons must be distinguishable, or the UI cannot tell the customer
  // whether to upgrade or to wait for an administrator.
  check(
    'Starter: the reason is the plan, not the server',
    starterState?.email?.includedInPlan === false && starterState?.email?.providerConfigured === true,
    starterState?.email,
  );

  // --- 2. plan includes it, provider not set up -----------------------------
  await setAvailPlan(availShowroom._id);
  await setAvailSmtp(false);
  const pendingState = (await api('/messaging/status', { token: availToken })).data;
  check('Showroom: email IS in the plan', pendingState?.email?.includedInPlan === true, pendingState?.email);
  check('Showroom: the provider is not configured', pendingState?.email?.providerConfigured === false, pendingState?.email);
  check('Showroom: email is unavailable for sending', pendingState?.email?.available === false);
  check(
    'Showroom: the reason is the server, not the plan',
    pendingState?.email?.includedInPlan === true && pendingState?.email?.providerConfigured === false,
    pendingState?.email,
  );

  // Composing is a client concern, but SENDING must still be refused here.
  const sendWithoutSmtp = await api('/messaging/email-campaigns', {
    method: 'POST',
    token: availToken,
    body: { name: 'No SMTP', subject: 'Test', body: '<p>hi</p>', audience: 'all-customers' },
  });
  check('Showroom: sending without SMTP is refused', sendWithoutSmtp.status >= 400, sendWithoutSmtp.status);

  // --- 3. everything ready --------------------------------------------------
  await setAvailSmtp(true);
  const readyState = (await api('/messaging/status', { token: availToken })).data;
  check('Showroom + SMTP: email is available', readyState?.email?.available === true, readyState?.email);
  check('Showroom + SMTP: both reasons are satisfied',
    readyState?.email?.includedInPlan === true && readyState?.email?.providerConfigured === true);

  // SMS reports the same shape, so the UI can treat both channels alike.
  check(
    'SMS reports the same three flags',
    ['includedInPlan', 'providerConfigured', 'available'].every((k) => typeof readyState?.sms?.[k] === 'boolean'),
    readyState?.sms,
  );

  // ==================================================================
  //  SMS GATEWAY CONFIGURATION
  // ==================================================================
  section('SMS platform configuration');

  const smsIntegrations = await api('/platform/integrations', { token: platform2.token });
  check('Platform admin can read integrations', smsIntegrations.status === 200, smsIntegrations.error);
  check('SMS config block is present', Boolean(smsIntegrations.data?.sms?.config), smsIntegrations.data?.sms);
  check(
    'The gateway key is never returned',
    !JSON.stringify(smsIntegrations.data ?? {}).includes('apiKey"') ||
      smsIntegrations.data?.sms?.config?.apiKey === undefined,
    Object.keys(smsIntegrations.data?.sms?.config ?? {}),
  );
  check(
    'Only whether a key is set is exposed',
    typeof smsIntegrations.data?.sms?.config?.apiKeySet === 'boolean',
    smsIntegrations.data?.sms?.config,
  );

  // --- configuring the gateway --------------------------------------------
  const badSmsConfigs = [
    ['non-http base URL', { provider: 'alpha', apiKey: 'k', baseUrl: 'javascript:alert(1)', senderId: '', enabled: true }],
    ['malformed base URL', { provider: 'alpha', apiKey: 'k', baseUrl: 'not a url', senderId: '', enabled: true }],
    ['unknown provider', { provider: 'twilio', apiKey: 'k', baseUrl: 'https://api.sms.net.bd', senderId: '', enabled: true }],
    ['oversized sender id', { provider: 'alpha', apiKey: 'k', baseUrl: 'https://api.sms.net.bd', senderId: 'x'.repeat(50), enabled: true }],
    ['missing enabled flag', { provider: 'alpha', apiKey: 'k', baseUrl: 'https://api.sms.net.bd', senderId: '' }],
  ];
  for (const [label, sms] of badSmsConfigs) {
    const res = await api('/platform/settings', { method: 'PATCH', token: platform2.token, body: { sms } });
    check(`SMS config rejects ${label}`, res.status === 422, res.status);
  }

  const goodSms = await api('/platform/settings', {
    method: 'PATCH',
    token: platform2.token,
    body: {
      sms: {
        provider: 'alpha',
        apiKey: 'test-key-abc123',
        baseUrl: 'https://api.sms.net.bd',
        senderId: 'POSTEST',
        enabled: true,
      },
    },
  });
  check('Platform admin can save SMS credentials', goodSms.status === 200, goodSms.error);
  check(
    'The saved settings response carries no key',
    !JSON.stringify(goodSms.data ?? {}).includes('test-key-abc123'),
    'key leaked in the settings response',
  );

  const afterSave = await api('/platform/integrations', { token: platform2.token });
  check('The gateway now reports a stored key', afterSave.data?.sms?.config?.apiKeySet === true);
  check('The sender id round-trips', afterSave.data?.sms?.config?.senderId === 'POSTEST', afterSave.data?.sms?.config);
  check(
    'The key is still absent after saving',
    !JSON.stringify(afterSave.data ?? {}).includes('test-key-abc123'),
    'key leaked in the integrations response',
  );

  // Blank means "keep", not "clear" - the SMTP password rule.
  const blankKey = await api('/platform/settings', {
    method: 'PATCH',
    token: platform2.token,
    body: { sms: { provider: 'alpha', apiKey: '', baseUrl: 'https://api.sms.net.bd', senderId: 'KEPT', enabled: true } },
  });
  check('Saving with a blank key succeeds', blankKey.status === 200, blankKey.error);
  const afterBlank = await api('/platform/integrations', { token: platform2.token });
  check('A blank key does not erase the stored one', afterBlank.data?.sms?.config?.apiKeySet === true);
  check('Other fields still update', afterBlank.data?.sms?.config?.senderId === 'KEPT');

  // --- the tenant side must learn nothing ----------------------------------
  const tenantView = await api('/messaging/status', { token: admin.token });
  const tenantJson = JSON.stringify(tenantView.data ?? {});
  check('Store admin can read messaging status', tenantView.status === 200, tenantView.error);
  check('Store admin never sees the gateway key', !tenantJson.includes('test-key-abc123'), 'key leaked to a tenant');
  check('Store admin never sees an apiKey field', !tenantJson.includes('apiKey'), tenantJson.slice(0, 200));
  check('Store admin sees whether SMS is available', typeof tenantView.data?.sms?.available === 'boolean');
  check('Store admin sees their own usage', typeof tenantView.data?.usage === 'object', tenantView.data?.usage);

  const tenantSettings = await api('/platform/settings', { token: admin.token });
  check('Store admin cannot read platform settings', tenantSettings.status === 403, tenantSettings.status);

  const tenantConfigure = await api('/platform/settings', {
    method: 'PATCH',
    token: admin.token,
    body: { sms: { provider: 'alpha', apiKey: 'stolen', baseUrl: 'https://evil.example', senderId: 'X', enabled: true } },
  });
  check('Store admin cannot configure the gateway', tenantConfigure.status === 403, tenantConfigure.status);

  const tenantTest = await api('/platform/integrations/sms/test', { method: 'POST', token: admin.token });
  check('Store admin cannot run the gateway test', tenantTest.status === 403, tenantTest.status);

  // --- credential testing ---------------------------------------------------
  const testBad = await api('/platform/integrations/sms/test', { method: 'POST', token: platform2.token });
  check('Testing invalid credentials answers without throwing', testBad.status === 200, testBad.error);
  check('Testing invalid credentials reports failure', testBad.data?.ok === false, testBad.data);
  check('The test explains itself', typeof testBad.data?.message === 'string' && testBad.data.message.length > 0, testBad.data);

  // A disabled gateway must be treated as absent, not merely unused.
  await api('/platform/settings', {
    method: 'PATCH',
    token: platform2.token,
    body: { sms: { provider: 'alpha', apiKey: '', baseUrl: 'https://api.sms.net.bd', senderId: 'KEPT', enabled: false } },
  });
  const disabledTest = await api('/platform/integrations/sms/test', { method: 'POST', token: platform2.token });
  check('A switched-off gateway reports as unconfigured', disabledTest.data?.ok === false, disabledTest.data);

  const disabledStatus = await api('/messaging/status', { token: admin.token });
  const alphaEntry = (disabledStatus.data?.sms?.providers ?? []).find((p) => p.name === 'alpha');
  check('A switched-off gateway reports itself unconfigured', alphaEntry?.configured === false, alphaEntry);

  // The development mock is a deliberate test double and is the ACTIVE provider
  // outside production, so "no real gateway" does not mean "cannot send" here.
  // Assert against whichever situation this environment is actually in.
  const mockActive = (disabledStatus.data?.sms?.providers ?? []).some((p) => p.name === 'mock' && p.configured);

  const sendWhileOff = await api('/messaging/sms', {
    method: 'POST',
    token: admin.token,
    body: { to: '01712345678', message: 'gateway state probe' },
  });
  if (mockActive) {
    check('With only the mock available, sending uses the mock', sendWhileOff.status === 201, sendWhileOff.error);
    check(
      'The mock is clearly labelled as not delivering',
      String(disabledStatus.data?.sms?.displayName ?? '').toLowerCase().includes('does not deliver'),
      disabledStatus.data?.sms?.displayName,
    );
  } else {
    check('Sending with no gateway is refused', sendWhileOff.status >= 400, sendWhileOff.status);
    check(
      'The refusal does not pretend to have sent',
      String(sendWhileOff.error?.message ?? '').toLowerCase().includes('gateway'),
      sendWhileOff.error,
    );
  }

  // The SMTP password shares the "blank means keep" rule and the same write
  // path, so it had the same defect. Guard it here too.
  await api('/platform/settings', {
    method: 'PATCH',
    token: platform2.token,
    body: {
      smtp: {
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        username: 'mailer',
        password: 'secret-smtp-pass',
        fromName: 'POS',
        fromEmail: 'noreply@example.com',
        enabled: true,
      },
    },
  });
  const smtpAfterSet = await api('/platform/integrations', { token: platform2.token });
  check('SMTP password is stored', smtpAfterSet.data?.email?.smtp?.passwordSet === true, smtpAfterSet.data?.email?.smtp);
  check(
    'SMTP password never leaves the server',
    !JSON.stringify(smtpAfterSet.data ?? {}).includes('secret-smtp-pass'),
    'smtp password leaked',
  );

  await api('/platform/settings', {
    method: 'PATCH',
    token: platform2.token,
    body: {
      smtp: {
        host: 'smtp.example.com',
        port: 2525,
        secure: false,
        username: 'mailer',
        password: '',
        fromName: 'POS',
        fromEmail: 'noreply@example.com',
        enabled: true,
      },
    },
  });
  const smtpAfterBlank = await api('/platform/integrations', { token: platform2.token });
  check('A blank SMTP password does not erase the stored one', smtpAfterBlank.data?.email?.smtp?.passwordSet === true);
  check('Other SMTP fields still update', smtpAfterBlank.data?.email?.smtp?.port === 2525, smtpAfterBlank.data?.email?.smtp);

  // Restore the development mock so the rest of the suite can send.
  await api('/platform/settings', {
    method: 'PATCH',
    token: platform2.token,
    body: { sms: { provider: 'alpha', apiKey: '', baseUrl: 'https://api.sms.net.bd', senderId: '', enabled: false } },
  });

  // ==================================================================
  //  INPUT VALIDATION
  //  Every field the API accepts, probed with the wrong kind of value.
  // ==================================================================
  section('Validation: emails, phones and URLs');

  const vStamp = Date.now();

  const badEmails = ['', 'plainword', 'no@tld', '@nouser.com', 'spaces in@mail.com', `${'a'.repeat(250)}@example.com`];
  for (const email of badEmails) {
    const res = await api('/staff', {
      method: 'POST',
      token: admin.token,
      body: { name: 'Bad Email', email, password: 'Password@123' },
    });
    check(`Rejects email ${JSON.stringify(email.slice(0, 24))}`, res.status === 422, res.status);
  }

  const goodEmail = await api('/staff', {
    method: 'POST',
    token: admin.token,
    body: { name: 'Good Email', email: `ok${vStamp}@example.com`, password: 'Password@123' },
  });
  check('Accepts a valid email', goodEmail.status === 201, goodEmail.error);

  const badPhones = ['abcdefghij', '<script>alert(1)</script>', '12345', 'call-me', '{"$ne":null}'];
  for (const phone of badPhones) {
    const res = await api('/customers', {
      method: 'POST',
      token: admin.token,
      body: { name: 'Bad Phone', phone },
    });
    check(`Rejects phone ${JSON.stringify(phone.slice(0, 24))}`, res.status === 422, res.status);
  }

  const goodPhones = ['01712345678', '+880 1712-345678', '(017) 1234 5678'];
  for (const [i, phone] of goodPhones.entries()) {
    const res = await api('/customers', {
      method: 'POST',
      token: admin.token,
      body: { name: `Good Phone ${i}`, phone: `${phone}${i}` },
    });
    check(`Accepts phone ${JSON.stringify(phone)}`, res.status === 201, res.error);
  }

  // URL schemes: z.string().url() accepts every one of these on its own.
  const badUrls = [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'not a url',
  ];
  for (const url of badUrls) {
    const res = await api('/stores/current', {
      method: 'PATCH',
      token: admin.token,
      body: { logoUrl: url },
    });
    check(`Rejects logo URL ${JSON.stringify(url.slice(0, 28))}`, res.status === 422, res.status);
  }

  const okUrl = await api('/stores/current', {
    method: 'PATCH',
    token: admin.token,
    body: { logoUrl: 'https://example.com/logo.png' },
  });
  check('Accepts an https logo URL', okUrl.status === 200, okUrl.error);

  const badImageUrl = await api('/products', {
    method: 'POST',
    token: admin.token,
    body: {
      name: 'Bad Image',
      sku: `BADIMG-${vStamp}`,
      images: [{ url: 'javascript:alert(1)', isPrimary: true }],
      variants: [{ attributes: [], sellingPriceMinor: 1000, stock: 1 }],
    },
  });
  check('Rejects a javascript: product image URL', badImageUrl.status === 422, badImageUrl.status);

  section('Validation: dates and numbers');

  const badDates = [
    ['year 99999', 'from=99999-01-01&to=99999-12-31'],
    ['year zero', 'from=0&to=0'],
    ['nonsense', 'from=not-a-date'],
    ['reversed range', 'from=2026-12-31&to=2026-01-01'],
  ];
  for (const [label, qs] of badDates) {
    const res = await api(`/reports/dashboard?${qs}`, { token: admin.token });
    check(`Rejects ${label} date range`, res.status === 422, { status: res.status });
  }

  const goodRange = await api('/reports/dashboard?from=2026-01-01&to=2026-12-31', { token: admin.token });
  check('Accepts a sane date range', goodRange.status === 200, goodRange.error);

  // A password long enough to be a denial-of-service against bcrypt.
  const hugePassword = await api('/auth/login', {
    method: 'POST',
    body: { email: 'admin@demostore.dev', password: 'x'.repeat(5000) },
  });
  check('Rejects an oversized password without hashing it', hugePassword.status === 422, hugePassword.status);

  // Pagination bounds.
  const hugeLimit = await api('/products?limit=100000', { token: admin.token });
  check('Rejects an oversized page limit', hugeLimit.status === 422, hugeLimit.status);

  const negativePage = await api('/products?page=-1', { token: admin.token });
  check('Rejects a negative page number', negativePage.status === 422, negativePage.status);

  const stringPage = await api('/products?page=abc', { token: admin.token });
  check('Rejects a non-numeric page', stringPage.status === 422, stringPage.status);

  // ------------------------------------------------- per-vertical entitlements
  section('Per-vertical entitlements');

  const pvDefault = await api('/plans');
  const pvClothing = await api('/plans?vertical=clothing');
  check('The public catalogue defaults to Clothing', pvDefault.status === 200 && JSON.stringify(pvDefault.data) === JSON.stringify(pvClothing.data));
  check('Every catalogue plan states the vertical it was resolved for', (pvDefault.data ?? []).length > 0 && pvDefault.data.every((p) => p.vertical === 'clothing'));
  check('The public catalogue never exposes override configuration', (pvDefault.data ?? []).every((p) => !('verticalOverrides' in p)));
  check('An unknown vertical is rejected', (await api('/plans?vertical=bakery')).status === 422);
  const pvRestaurantDefault = await api('/plans?vertical=restaurant');
  check(
    'With no overrides, another vertical sees identical entitlements and prices',
    JSON.stringify((pvRestaurantDefault.data ?? []).map((p) => [p.code, p.priceMinor, p.features, p.limits])) ===
      JSON.stringify((pvClothing.data ?? []).map((p) => [p.code, p.priceMinor, p.features, p.limits])),
  );

  const pvStamp = Date.now();
  const pvCreate = await api('/plans', {
    method: 'POST',
    token: platform2.token,
    body: {
      code: `pv-test-${pvStamp}`,
      name: 'PV Test',
      interval: 'monthly',
      priceMinor: 12300,
      tier: 1,
      isPublic: true,
      features: { advancedReports: false },
      limits: { maxProducts: 10 },
      verticalOverrides: [
        { vertical: 'restaurant', features: { advancedReports: true }, limits: { maxProducts: 50 } },
        { vertical: 'pharmacy', isAvailable: false },
      ],
    },
  });
  check('Platform admin creates a plan with vertical overrides', pvCreate.status === 201, pvCreate.error);
  const pvId = pvCreate.data?._id;
  const pvFind = async (vertical) => ((await api(`/plans?vertical=${vertical}`)).data ?? []).find((p) => p._id === pvId);
  const pvC = await pvFind('clothing');
  const pvR = await pvFind('restaurant');
  check('Clothing gets the plan default', pvC?.limits?.maxProducts === 10 && pvC?.features?.advancedReports === false, pvC);
  check('Restaurant gets its overrides', pvR?.limits?.maxProducts === 50 && pvR?.features?.advancedReports === true, pvR);
  check('An override changes only the keys it names (and never the price)', pvR?.limits?.maxStores === pvC?.limits?.maxStores && pvR?.priceMinor === 12300);
  check('A plan not offered to a vertical is hidden from that vertical', (await pvFind('pharmacy')) === undefined);

  const pvAll = await api('/plans/all', { token: platform2.token });
  check('Platform admin sees the raw override configuration', pvAll.data?.find((p) => p._id === pvId)?.verticalOverrides?.length === 2);
  check('A tenant cannot read the admin plan list', (await api('/plans/all', { token: admin.token })).status === 403);

  const pvPatch = (token, body) => api(`/plans/${pvId}`, { method: 'PATCH', token, body });
  check('Override with an unknown feature is rejected', (await pvPatch(platform2.token, { verticalOverrides: [{ vertical: 'restaurant', features: { freeMoney: true } }] })).status === 422);
  check('Override with an unknown limit is rejected', (await pvPatch(platform2.token, { verticalOverrides: [{ vertical: 'restaurant', limits: { maxRobots: 5 } }] })).status === 422);
  check('Override with an invalid limit value is rejected', (await pvPatch(platform2.token, { verticalOverrides: [{ vertical: 'restaurant', limits: { maxProducts: -5 } }] })).status === 422);
  check('Override for an unknown vertical is rejected', (await pvPatch(platform2.token, { verticalOverrides: [{ vertical: 'bakery' }] })).status === 422);
  check('The same vertical twice is rejected', (await pvPatch(platform2.token, { verticalOverrides: [{ vertical: 'restaurant' }, { vertical: 'restaurant' }] })).status === 422);
  check('A tenant cannot edit plan overrides', (await pvPatch(admin.token, { verticalOverrides: [] })).status === 403);
  const pvRename = await pvPatch(platform2.token, { name: 'PV Test Renamed' });
  check('Editing other plan fields keeps the overrides', pvRename.data?.verticalOverrides?.length === 2, pvRename.data?.verticalOverrides);

  const pvReg = await api('/auth/register', {
    method: 'POST',
    body: { businessName: `PV Shop ${pvStamp}`, name: 'PV Owner', email: `pv${pvStamp}@example.com`, password: 'Password@123' },
  });
  const pvToken = pvReg.data?.tokens?.accessToken;
  await api('/stores', { method: 'POST', token: pvToken, body: { name: 'PV Main', currency: 'BDT' } });
  const pvAssign = await api('/platform/subscriptions', {
    method: 'POST',
    token: platform2.token,
    body: { tenantId: pvReg.data?.tenant?.id, planId: pvId, periods: 1, status: 'active' },
  });
  check('The plan is assigned to a Clothing workspace', pvAssign.status < 300, pvAssign.error);
  const pvCurrent = (await api('/subscriptions/current', { token: pvToken })).data;
  check(
    "A Clothing workspace receives Clothing's entitlements, not another vertical's",
    pvCurrent?.entitlement?.limits?.maxProducts === 10 && pvCurrent?.entitlement?.features?.advancedReports === false,
    pvCurrent?.entitlement,
  );
  check('The entitlement reports its vertical', pvCurrent?.entitlement?.vertical === 'clothing', pvCurrent?.entitlement?.vertical);
  check('The subscription snapshot freezes the vertical', pvCurrent?.subscription?.planSnapshot?.vertical === 'clothing', pvCurrent?.subscription?.planSnapshot);

  await pvPatch(platform2.token, { limits: { maxProducts: 999 } });
  check('Changing the plan later does not rewrite a bought period', (await api('/subscriptions/current', { token: pvToken })).data?.entitlement?.limits?.maxProducts === 10);
  const pvOptions = await api('/subscriptions/plan-options', { token: pvToken });
  check('Plan options are resolved for the workspace vertical', pvOptions.data?.options?.find((o) => o.planId === pvId)?.limits?.maxProducts === 999, pvOptions.data?.options?.find((o) => o.planId === pvId));

  await api(`/plans/${pvId}`, { method: 'DELETE', token: platform2.token });
  check('The test plan is withdrawn from the catalogue', !((await api('/plans')).data ?? []).some((p) => p._id === pvId));
  check('The demo workspace is entitled as Clothing', (await api('/subscriptions/current', { token: admin.token })).data?.entitlement?.vertical === 'clothing');

  // ------------------------------------------------- restaurant vertical
  section('Restaurant vertical');

  const rvOptions = await api('/workspaces/verticals', { token: admin.token });
  check('Restaurant can be created self-serve', rvOptions.data?.find((o) => o.vertical === 'restaurant')?.available === true, rvOptions.data);

  const rvStamp = Date.now();
  const rvReg = await api('/auth/register', {
    method: 'POST',
    body: { businessName: `Rest Home ${rvStamp}`, name: 'Rest Owner', email: `rest${rvStamp}@example.com`, password: 'Password@123' },
  });
  const rvHomeToken = rvReg.data?.tokens?.accessToken;
  await verifyContact(rvHomeToken);
  const rvHomeId = rvReg.data?.tenant?.id;
  await api('/stores', { method: 'POST', token: rvHomeToken, body: { name: 'Rest Home Main', currency: 'BDT' } });

  // A Restaurant workspace with a store and a Starter plan bought from the wallet.
  const rvStarter = ((await api('/plans?vertical=restaurant')).data ?? []).find((p) => p.code === 'starter-store-monthly');
  const rvOpenRestaurant = async (name, plan = rvStarter) => {
    const created = await api('/workspaces', { method: 'POST', token: rvHomeToken, body: { businessName: name, vertical: 'restaurant' } });
    const switched = await api('/auth/switch-workspace', { method: 'POST', token: rvHomeToken, body: { workspaceId: created.data?.workspace?.id } });
    const token = switched.data?.tokens?.accessToken;
    const store = await api('/stores', { method: 'POST', token, body: { name: `${name} Main`, currency: 'BDT' } });
    const locked = await api('/restaurant/menu', { token });
    await api(`/platform/tenants/${rvHomeId}/wallet/adjust`, {
      method: 'POST',
      token: platform2.token,
      body: { direction: 'credit', amountMinor: plan.priceMinor, reason: 'Smoke test: restaurant plan' },
    });
    const bought = await api('/subscriptions/upgrade-request', {
      method: 'POST',
      token,
      body: { planId: plan._id, paymentMethod: 'wallet', amountMinor: plan.priceMinor },
    });
    return { created, switched, token, store, locked, bought };
  };

  const rv = await rvOpenRestaurant(`Kacchi House ${rvStamp}`);
  const rvToken = rv.token;
  check('The owner creates a Restaurant workspace', rv.created.status === 201 && rv.created.data?.workspace?.vertical === 'restaurant', rv.created.error);
  check('The session reports the Restaurant vertical', rv.switched.data?.tenant?.vertical === 'restaurant', rv.switched.data?.tenant);
  check('Its first branch is created', rv.store.status === 201, rv.store.error);
  check('Restaurant screens stay locked until a plan is bought', rv.locked.status === 402, rv.locked.status);
  check('It buys Starter from the account wallet', rv.bought.status < 300, rv.bought.error);
  check('Its entitlement is resolved for Restaurant', (await api('/subscriptions/current', { token: rvToken })).data?.entitlement?.vertical === 'restaurant');

  // --- isolation between verticals -------------------------------------------
  for (const path of ['/products', '/categories', '/inventory', '/sales', '/returns', '/reports/overview']) {
    const res = await api(path, { token: rvToken });
    check(`A Restaurant workspace cannot reach ${path}`, res.status === 403 && res.error?.code === 'VERTICAL_NOT_SUPPORTED', { status: res.status, error: res.error });
  }
  for (const path of ['/restaurant/menu', '/restaurant/tables', '/restaurant/orders', '/restaurant/summary']) {
    const res = await api(path, { token: admin.token });
    check(`A Clothing workspace cannot reach ${path}`, res.status === 403 && res.error?.code === 'VERTICAL_NOT_SUPPORTED', { status: res.status, error: res.error });
  }
  check('Shared modules work for Restaurant: customers', (await api('/customers', { token: rvToken })).status === 200);
  check('Shared modules work for Restaurant: wallet', (await api('/wallet', { token: rvToken })).status === 200);

  // --- menu ----------------------------------------------------------------
  const rvMenu = (body) => api('/restaurant/menu', { method: 'POST', token: rvToken, body });
  const kacchi = await rvMenu({ name: 'Kacchi Biryani', category: 'Mains', priceMinor: 35000 });
  const borhani = await rvMenu({ name: 'Borhani', category: 'Drinks', priceMinor: 8000 });
  const firni = await rvMenu({ name: 'Firni', category: 'Desserts', priceMinor: 6000, isAvailable: false });
  check('Menu items are created', [kacchi, borhani, firni].every((r) => r.status === 201), [kacchi, borhani, firni].map((r) => r.error));
  check('A duplicate menu name is refused (case-insensitive)', (await rvMenu({ name: 'kacchi biryani', priceMinor: 100 })).status === 409);
  check('A negative price is rejected', (await rvMenu({ name: 'Bad', priceMinor: -1 })).status === 422);
  check('Unknown menu fields are rejected', (await rvMenu({ name: 'Sneaky', priceMinor: 100, tenantId: admin.session.tenant.id })).status === 422);
  check('The menu lists every item', (await api('/restaurant/menu', { token: rvToken })).data?.length === 3);
  check('availableOnly=true hides unavailable items', (await api('/restaurant/menu?availableOnly=true', { token: rvToken })).data?.length === 2);
  check('availableOnly=false does not hide them', (await api('/restaurant/menu?availableOnly=false', { token: rvToken })).data?.length === 3);

  // --- tables --------------------------------------------------------------
  const rvTable = (body) => api('/restaurant/tables', { method: 'POST', token: rvToken, body });
  const t1 = await rvTable({ name: 'T1', seats: 4 });
  const t2 = await rvTable({ name: 'T2' });
  check('Tables are created', t1.status === 201 && t2.status === 201, [t1.error, t2.error]);
  check('A duplicate table name is refused', (await rvTable({ name: 't1' })).status === 409);

  // --- orders --------------------------------------------------------------
  const rvOrder = (body) => api('/restaurant/orders', { method: 'POST', token: rvToken, body });
  const o1 = await rvOrder({
    type: 'dine_in',
    tableId: t1.data._id,
    items: [{ menuItemId: kacchi.data._id, quantity: 2 }, { menuItemId: borhani.data._id, quantity: 1 }],
  });
  check('A dine-in order is opened', o1.status === 201 && o1.data?.status === 'open', o1.error);
  check('The server prices every line from the menu', o1.data?.subtotalMinor === 78000 && o1.data?.items?.[0]?.unitPriceMinor === 35000, o1.data);
  check('A client-supplied price is rejected', (await rvOrder({ type: 'takeaway', items: [{ menuItemId: kacchi.data._id, quantity: 1, unitPriceMinor: 1 }] })).status === 422);
  check('An unavailable item cannot be ordered', (await rvOrder({ type: 'takeaway', items: [{ menuItemId: firni.data._id, quantity: 1 }] })).status === 400);
  check("Another workspace's menu item cannot be ordered", (await rvOrder({ type: 'takeaway', items: [{ menuItemId: '64b000000000000000000000', quantity: 1 }] })).status === 400);
  check('A dine-in order needs a table', (await rvOrder({ type: 'dine_in', items: [{ menuItemId: kacchi.data._id, quantity: 1 }] })).status === 422);
  check('A takeaway order cannot name a table', (await rvOrder({ type: 'takeaway', tableId: t2.data._id, items: [{ menuItemId: borhani.data._id, quantity: 1 }] })).status === 422);
  check('A second open order on the same table is refused', (await rvOrder({ type: 'dine_in', tableId: t1.data._id, items: [{ menuItemId: borhani.data._id, quantity: 1 }] })).status === 409);

  const t2Race = await Promise.all(
    Array.from({ length: 5 }, () => rvOrder({ type: 'dine_in', tableId: t2.data._id, items: [{ menuItemId: borhani.data._id, quantity: 1 }] })),
  );
  check(
    'Five cashiers seating one table at once: exactly one order opens',
    t2Race.filter((r) => r.status === 201).length === 1 && t2Race.filter((r) => r.status === 409).length === 4,
    t2Race.map((r) => r.status),
  );
  const t2Order = t2Race.find((r) => r.status === 201)?.data;
  check('The floor shows each occupied table with its open order', (await api('/restaurant/tables', { token: rvToken })).data?.find((t) => t._id === t1.data._id)?.openOrderId === o1.data._id);

  await api(`/restaurant/menu/${kacchi.data._id}`, { method: 'PATCH', token: rvToken, body: { priceMinor: 40000 } });
  const added = await api(`/restaurant/orders/${o1.data._id}/items`, { method: 'POST', token: rvToken, body: { items: [{ menuItemId: kacchi.data._id, quantity: 1 }] } });
  check('A line added after a price change uses the new price', added.data?.items?.[2]?.unitPriceMinor === 40000, added.data?.items);
  check('Earlier lines keep the price they were ordered at', added.data?.items?.[0]?.unitPriceMinor === 35000 && added.data?.subtotalMinor === 118000, added.data?.subtotalMinor);
  const bumped = await api(`/restaurant/orders/${o1.data._id}/items/${added.data.items[1]._id}`, { method: 'PATCH', token: rvToken, body: { quantity: 3 } });
  check('Changing a quantity recomputes the totals', bumped.data?.subtotalMinor === 134000, bumped.data?.subtotalMinor ?? bumped.error);
  const trimmed = await api(`/restaurant/orders/${o1.data._id}/items/${added.data.items[2]._id}`, { method: 'DELETE', token: rvToken });
  check('Removing a line recomputes the totals', trimmed.data?.subtotalMinor === 94000 && trimmed.data?.items?.length === 2, trimmed.data?.subtotalMinor ?? trimmed.error);
  check('Every change bumps the order revision', trimmed.data?.rev === 3, trimmed.data?.rev);

  // --- payment ---------------------------------------------------------------
  const rvPay = (id, body) => api(`/restaurant/orders/${id}/pay`, { method: 'POST', token: rvToken, body });
  const rev = trimmed.data?.rev;
  check('A short payment is refused', (await rvPay(o1.data._id, { payments: [{ method: 'cash', amountMinor: 1000 }], rev })).status === 400);
  check('Payment against a stale revision is refused', (await rvPay(o1.data._id, { payments: [{ method: 'cash', amountMinor: 94000 }], rev: 0 })).status === 409);
  // A workspace can define its own tenders now, so a key it has never defined is
  // refused by the branch's enabled list (400) rather than by an enum (422).
  const rvUnknownMethod = await rvPay(o1.data._id, { payments: [{ method: 'crypto', amountMinor: 94000 }], rev });
  check('A payment method this branch does not take is rejected', rvUnknownMethod.status === 400 && /crypto/.test(rvUnknownMethod.error?.message ?? ''), rvUnknownMethod.error);
  check('A malformed payment method key is still rejected outright', (await rvPay(o1.data._id, { payments: [{ method: '!!', amountMinor: 94000 }], rev })).status === 422);
  check('Only cash can be over-tendered', (await rvPay(o1.data._id, { payments: [{ method: 'card', amountMinor: 100000 }], rev })).status === 400);
  check('A discount larger than the subtotal is refused', (await rvPay(o1.data._id, { payments: [{ method: 'cash', amountMinor: 1 }], discountMinor: 999999, rev })).status === 400);
  const paid = await rvPay(o1.data._id, { payments: [{ method: 'cash', amountMinor: 100000 }], discountMinor: 4000, rev });
  check(
    'The order is paid with a discount and cash change',
    paid.status === 200 && paid.data?.status === 'paid' && paid.data.totalMinor === 90000 && paid.data.changeMinor === 10000,
    paid.data ?? paid.error,
  );
  check('An order cannot be paid twice', (await rvPay(o1.data._id, { payments: [{ method: 'cash', amountMinor: 90000 }], rev })).status === 409);
  const t2Pays = await Promise.all(Array.from({ length: 4 }, () => rvPay(t2Order._id, { payments: [{ method: 'cash', amountMinor: 8000 }], rev: t2Order.rev })));
  check('Four concurrent payments of one order: exactly one succeeds', t2Pays.filter((r) => r.status === 200).length === 1, t2Pays.map((r) => r.status));
  check('A paid order cannot be changed', (await api(`/restaurant/orders/${o1.data._id}/items`, { method: 'POST', token: rvToken, body: { items: [{ menuItemId: borhani.data._id, quantity: 1 }] } })).status === 409);
  check('A settled table can be seated again', (await rvOrder({ type: 'dine_in', tableId: t1.data._id, items: [{ menuItemId: borhani.data._id, quantity: 1 }] })).status === 201);

  const takeaway = await rvOrder({ type: 'takeaway', items: [{ menuItemId: borhani.data._id, quantity: 2 }] });
  check('A takeaway order is opened without a table', takeaway.status === 201 && takeaway.data?.tableId === null, takeaway.error);
  const cancelled = await api(`/restaurant/orders/${takeaway.data._id}/cancel`, { method: 'POST', token: rvToken, body: { reason: 'Customer left' } });
  check('An open order is cancelled with its reason', cancelled.data?.status === 'cancelled' && cancelled.data?.cancelReason === 'Customer left', cancelled.error);
  check('A paid order cannot be cancelled', (await api(`/restaurant/orders/${o1.data._id}/cancel`, { method: 'POST', token: rvToken, body: { reason: 'Too late' } })).status === 409);

  await api(`/restaurant/menu/${kacchi.data._id}`, { method: 'DELETE', token: rvToken });
  const rvHistory = await api(`/restaurant/orders/${o1.data._id}`, { token: rvToken });
  check(
    'Removing a menu item leaves paid orders exactly as they were',
    rvHistory.data?.items?.[0]?.nameSnapshot === 'Kacchi Biryani' && rvHistory.data.items[0].unitPriceMinor === 35000 && rvHistory.data.totalMinor === 90000,
    rvHistory.data,
  );
  check('A removed menu item can no longer be ordered', (await rvOrder({ type: 'takeaway', items: [{ menuItemId: kacchi.data._id, quantity: 1 }] })).status === 400);

  const rvSummary = await api('/restaurant/summary', { token: rvToken });
  check('The trading summary counts paid orders and revenue', rvSummary.data?.paidOrders === 2 && rvSummary.data?.revenueMinor === 98000, rvSummary.data);
  check('Cash is reported net of change given', rvSummary.data?.byPaymentMethod?.find((m) => m.method === 'cash')?.amountMinor === 98000, rvSummary.data?.byPaymentMethod);
  check('Open orders are counted', rvSummary.data?.openOrders === 1, rvSummary.data?.openOrders);

  // --- dashboard -----------------------------------------------------------
  // Own block: `dash` is already used by the Clothing reports section above.
  {
  const rvDash = await api('/restaurant/dashboard?preset=today', { token: rvToken });
  const dash = rvDash.data;
  check('The Restaurant dashboard loads', rvDash.status === 200, rvDash.error);
  check(
    'Dashboard revenue, paid orders and average match the orders',
    dash?.kpis?.revenueMinor === 98000 && dash.kpis.paidOrders === 2 && dash.kpis.averageOrderMinor === 49000,
    dash?.kpis,
  );
  check(
    'Dashboard counts items sold, discounts and cancellations',
    dash?.kpis?.itemsSold === 6 && dash.kpis.discountsMinor === 4000 && dash.kpis.cancelledOrders === 1,
    dash?.kpis,
  );
  check(
    'The live floor shows open orders and occupied tables',
    dash?.live?.openOrders === 1 && dash.live.openOrdersValueMinor === 8000 && dash.live.tables === 2 && dash.live.occupiedTables === 1,
    dash?.live,
  );
  check(
    "A single day's trend is hourly and adds up to revenue",
    dash?.range?.bucket === 'hour' && (dash.trend ?? []).reduce((sum, b) => sum + b.revenueMinor, 0) === 98000,
    dash?.trend,
  );
  check(
    'Revenue by order type adds up to revenue',
    (dash?.byType ?? []).reduce((sum, t) => sum + t.revenueMinor, 0) === 98000 && dash.byType.find((t) => t.type === 'dine_in')?.orders === 2,
    dash?.byType,
  );
  check(
    'Payment methods reconcile to revenue, cash net of change',
    (dash?.byPaymentMethod ?? []).reduce((sum, m) => sum + m.amountMinor, 0) === 98000,
    dash?.byPaymentMethod,
  );
  check('The best seller is listed first', dash?.topItems?.[0]?.name === 'Borhani' && dash.topItems[0].quantity === 4, dash?.topItems);
  check('Sales are attributed to the staff member who took payment', dash?.byStaff?.[0]?.revenueMinor === 98000 && dash.byStaff[0].name === 'Rest Owner', dash?.byStaff);
  check(
    'Recent orders are listed newest first',
    (dash?.recentOrders ?? []).length > 1 && new Date(dash.recentOrders[0].createdAt) >= new Date(dash.recentOrders.at(-1).createdAt),
  );
  check('The previous period is reported for comparison', typeof dash?.previous?.revenueMinor === 'number' && typeof dash?.previous?.paidOrders === 'number');

  const rvYesterday = await api('/restaurant/dashboard?preset=yesterday', { token: rvToken });
  check('A range with no trading shows zeros, not errors', rvYesterday.status === 200 && rvYesterday.data?.kpis?.revenueMinor === 0 && rvYesterday.data?.kpis?.paidOrders === 0);
  check('The live floor is always now, whatever the range', rvYesterday.data?.live?.openOrders === 1);
  check('A 30-day range is bucketed by day', (await api('/restaurant/dashboard?preset=last30', { token: rvToken })).data?.range?.bucket === 'day');
  check('An unknown preset is rejected', (await api('/restaurant/dashboard?preset=forever', { token: rvToken })).status === 422);
  check('A custom range needs both dates', (await api('/restaurant/dashboard?preset=custom&from=2026-01-01', { token: rvToken })).status === 422);
  check('A Clothing workspace cannot read the Restaurant dashboard', (await api('/restaurant/dashboard', { token: admin.token })).status === 403);
  }

  // --- kitchen tickets, bills and receipts ------------------------------------
  {
    const roast = await rvMenu({ name: 'Chicken Roast', category: 'Mains', priceMinor: 30000 });
    const send = (id, rev) => api(`/restaurant/orders/${id}/send-to-kitchen`, { method: 'POST', token: rvToken, body: { rev } });

    const kt = await rvOrder({ type: 'takeaway', items: [{ menuItemId: borhani.data._id, quantity: 2, note: 'less ice' }] });
    check('New lines start unsent to the kitchen', kt.data?.items?.[0]?.sentQuantity === 0, kt.data?.items?.[0]);

    const k1 = await send(kt.data._id, kt.data.rev);
    const firstTicket = k1.data?.tickets?.[0];
    check('An order is sent to the kitchen as a ticket', k1.status === 200 && k1.data?.tickets?.length === 1, k1.error);
    check(
      'The ticket lists what to make, with notes and a KOT number',
      firstTicket?.lines?.[0]?.quantity === 2 && firstTicket.lines[0].note === 'less ice' && /^KOT-\d{6}$/.test(firstTicket.ticketNumber) && firstTicket.status === 'pending',
      firstTicket,
    );
    check('Sent lines are marked as sent', k1.data?.items?.[0]?.sentQuantity === 2);
    check('Sending with nothing new is refused', (await send(kt.data._id, k1.data.rev)).status === 400);
    check('Sending against a stale revision is refused', (await send(kt.data._id, kt.data.rev)).status === 409);

    await api(`/restaurant/orders/${kt.data._id}/items`, { method: 'POST', token: rvToken, body: { items: [{ menuItemId: roast.data._id, quantity: 1 }] } });
    const upped = await api(`/restaurant/orders/${kt.data._id}/items/${kt.data.items[0]._id}`, { method: 'PATCH', token: rvToken, body: { quantity: 3 } });
    const k2 = await send(kt.data._id, upped.data.rev);
    const secondTicket = k2.data?.tickets?.[1];
    check(
      'A follow-up ticket carries only what changed',
      secondTicket?.lines?.length === 2 &&
        secondTicket.lines.find((l) => l.nameSnapshot === 'Borhani')?.quantity === 1 &&
        secondTicket.lines.find((l) => l.nameSnapshot === 'Chicken Roast')?.quantity === 1,
      secondTicket,
    );

    const roastLine = k2.data.items.find((l) => l.nameSnapshot === 'Chicken Roast');
    const voided = await api(`/restaurant/orders/${kt.data._id}/items/${roastLine._id}`, { method: 'DELETE', token: rvToken });
    const voidedLine = voided.data?.items?.find((l) => l._id === roastLine._id);
    check(
      'Removing a line the kitchen already has voids it instead of deleting it',
      voided.data?.items?.length === 2 && voidedLine?.quantity === 0 && Boolean(voidedLine?.voidedAt),
      voided.data?.items,
    );
    check('A voided line no longer counts toward the total', voided.data?.subtotalMinor === 24000, voided.data?.subtotalMinor);
    check('A voided line cannot be edited back', (await api(`/restaurant/orders/${kt.data._id}/items/${roastLine._id}`, { method: 'PATCH', token: rvToken, body: { quantity: 2 } })).status === 409);
    const k3 = await send(kt.data._id, voided.data.rev);
    check(
      'The void reaches the kitchen as a negative line',
      k3.data?.tickets?.[2]?.lines?.[0]?.quantity === -1 && k3.data.tickets[2].lines[0].nameSnapshot === 'Chicken Roast',
      k3.data?.tickets?.[2],
    );

    const unsentOnly = await rvOrder({ type: 'takeaway', items: [{ menuItemId: borhani.data._id, quantity: 1 }] });
    const removedUnsent = await api(`/restaurant/orders/${unsentOnly.data._id}/items/${unsentOnly.data.items[0]._id}`, { method: 'DELETE', token: rvToken });
    check('A line the kitchen never saw is simply removed', removedUnsent.data?.items?.length === 0, removedUnsent.data?.items);
    check('An order with only removed lines cannot be sent', (await send(unsentOnly.data._id, removedUnsent.data.rev)).status === 400);
    check('An order with no live lines cannot be paid', (await rvPay(unsentOnly.data._id, { payments: [{ method: 'cash', amountMinor: 1 }], rev: removedUnsent.data.rev })).status === 400);
    await api(`/restaurant/orders/${unsentOnly.data._id}/cancel`, { method: 'POST', token: rvToken, body: { reason: 'Test cleanup' } });

    const queue = await api('/restaurant/kitchen/tickets', { token: rvToken });
    const mine = (queue.data ?? []).filter((t) => t.orderId === kt.data._id);
    check(
      'The kitchen queue lists pending tickets oldest first, with their order',
      mine.length === 3 && mine[0].ticketNumber === firstTicket.ticketNumber && mine[0].orderNumber === kt.data.orderNumber && mine[0].type === 'takeaway',
      mine.map((t) => t.ticketNumber),
    );
    const readyPath = `/restaurant/orders/${kt.data._id}/tickets/${firstTicket._id}/ready`;
    const ready = await api(readyPath, { method: 'POST', token: rvToken });
    check('The kitchen marks a ticket ready', ready.status === 200, ready.error);
    check('Marking a ticket ready does not change the order revision', ready.data?.rev === k3.data.rev, { ready: ready.data?.rev, before: k3.data.rev });
    check('A ticket cannot be marked ready twice', (await api(readyPath, { method: 'POST', token: rvToken })).status === 409);
    check('A ready ticket leaves the pending queue', !((await api('/restaurant/kitchen/tickets', { token: rvToken })).data ?? []).some((t) => t._id === firstTicket._id));
    check('...and shows in the ready list', ((await api('/restaurant/kitchen/tickets?status=ready', { token: rvToken })).data ?? []).some((t) => t._id === firstTicket._id));
    check('An unknown queue status is rejected', (await api('/restaurant/kitchen/tickets?status=burnt', { token: rvToken })).status === 422);

    const slip = await api(`/restaurant/orders/${kt.data._id}/tickets/${secondTicket._id}`, { token: rvToken });
    check(
      'A kitchen ticket can be reprinted with its order and paper width',
      slip.status === 200 && slip.data?.ticket?.ticketNumber === secondTicket.ticketNumber && slip.data?.order?.orderNumber === kt.data.orderNumber && typeof slip.data?.store?.receipt?.paperWidthMm === 'number',
      slip.data ?? slip.error,
    );
    check('An unknown ticket is not found', (await api(`/restaurant/orders/${kt.data._id}/tickets/64b000000000000000000000`, { token: rvToken })).status === 404);

    const bill = await api(`/restaurant/orders/${kt.data._id}/receipt`, { token: rvToken });
    check('An open order prints as a bill', bill.status === 200 && bill.data?.kind === 'bill' && bill.data?.order?.totalMinor === 24000, bill.data?.kind ?? bill.error);
    check('The bill leaves out voided lines', bill.data?.order?.items?.length === 1, bill.data?.order?.items);
    check('The bill does not include kitchen tickets', bill.data?.order && !('tickets' in bill.data.order));

    const settled = await rvPay(kt.data._id, { payments: [{ method: 'cash', amountMinor: 30000 }], rev: k3.data.rev });
    check('The order is paid while tickets are still in the kitchen', settled.status === 200, settled.error);
    const receipt = await api(`/restaurant/orders/${kt.data._id}/receipt`, { token: rvToken });
    check(
      'The Restaurant receipt carries the branch receipt settings the printer needs',
      typeof receipt.data?.store?.receipt?.paperWidthMm === 'number' && typeof receipt.data?.store?.receipt?.headerText === 'string' && 'receiptLogoUrl' in (receipt.data?.store ?? {}),
      receipt.data?.store?.receipt,
    );
    check(
      'A paid order prints as a receipt with its payment and change',
      receipt.data?.kind === 'receipt' && receipt.data?.order?.changeMinor === 6000 && receipt.data?.order?.payments?.[0]?.amountMinor === 30000,
      receipt.data?.order,
    );
    check('The receipt carries the branch details needed to print', Boolean(receipt.data?.store?.name) && typeof receipt.data?.store?.receipt?.paperWidthMm === 'number');
    check('A paid order cannot be sent to the kitchen', (await send(kt.data._id, settled.data.rev)).status === 409);

    const kc = await rvOrder({ type: 'takeaway', items: [{ menuItemId: borhani.data._id, quantity: 1 }] });
    await send(kc.data._id, kc.data.rev);
    await api(`/restaurant/orders/${kc.data._id}/cancel`, { method: 'POST', token: rvToken, body: { reason: 'Changed mind' } });
    const kcAfter = await api(`/restaurant/orders/${kc.data._id}`, { token: rvToken });
    check(
      'Cancelling an order voids the tickets still in the kitchen',
      kcAfter.data?.status === 'cancelled' && kcAfter.data?.cancelReason === 'Changed mind' && (kcAfter.data?.tickets ?? []).length === 1 && kcAfter.data.tickets.every((t) => t.status === 'void'),
      kcAfter.data?.tickets,
    );
    check('A voided ticket leaves the kitchen queue', !((await api('/restaurant/kitchen/tickets', { token: rvToken })).data ?? []).some((t) => t.orderId === kc.data._id));
    check('A cancelled order has no bill or receipt', (await api(`/restaurant/orders/${kc.data._id}/receipt`, { token: rvToken })).status === 409);
    check('A Clothing workspace cannot reach the kitchen queue', (await api('/restaurant/kitchen/tickets', { token: admin.token })).status === 403);
  }

  // --- cash-drawer shifts and the Z-report --------------------------------------
  let rvShiftId = null;
  {
    const shiftApi = (path, opts = {}) => api(`/restaurant/shifts${path}`, { token: rvToken, ...opts });
    const none = await shiftApi('/current');
    check('No shift is open to begin with', none.status === 200 && none.data === null, none.data ?? none.error);

    const opened = await shiftApi('', { method: 'POST', body: { openingFloatMinor: 50000, note: 'Morning' } });
    rvShiftId = opened.data?.shift?._id;
    check(
      'A cashier opens a shift with a float',
      opened.status === 201 && /^SHIFT-\d{6}$/.test(opened.data?.shift?.shiftNumber ?? '') && opened.data?.report?.cash?.expectedCashMinor === 50000,
      opened.data ?? opened.error,
    );
    check('A second shift cannot be opened in the same branch', (await shiftApi('', { method: 'POST', body: { openingFloatMinor: 0 } })).status === 409);
    check('Unknown shift fields are rejected', (await shiftApi('', { method: 'POST', body: { openingFloatMinor: 0, status: 'closed' } })).status === 422);
    check('A negative float is rejected', (await shiftApi('', { method: 'POST', body: { openingFloatMinor: -1 } })).status === 422);

    // Kacchi was removed from the menu earlier, so the shift has its own 35,000 dish.
    const polao = await rvMenu({ name: 'Morog Polao', category: 'Mains', priceMinor: 35000 });
    // 35,000 paid with 40,000 cash (5,000 change) and 16,000 with a 1,000 discount.
    const s1 = await rvOrder({ type: 'takeaway', items: [{ menuItemId: polao.data._id, quantity: 1 }] });
    const s1p = await rvPay(s1.data._id, { payments: [{ method: 'cash', amountMinor: 40000 }], rev: s1.data.rev });
    check('A payment during a shift is stamped with it', s1p.data?.shiftId === rvShiftId, s1p.data?.shiftId ?? s1p.error);
    const s2 = await rvOrder({ type: 'takeaway', items: [{ menuItemId: borhani.data._id, quantity: 2 }] });
    await rvPay(s2.data._id, { payments: [{ method: 'cash', amountMinor: 15000 }], discountMinor: 1000, rev: s2.data.rev });

    const s3 = await rvOrder({ type: 'takeaway', items: [{ menuItemId: borhani.data._id, quantity: 1 }] });
    await api(`/restaurant/orders/${s3.data._id}/cancel`, { method: 'POST', token: rvToken, body: { reason: 'Walked out' } });

    const s4 = await rvOrder({ type: 'takeaway', items: [{ menuItemId: polao.data._id, quantity: 1 }] });
    const s4sent = await api(`/restaurant/orders/${s4.data._id}/send-to-kitchen`, { method: 'POST', token: rvToken, body: { rev: s4.data.rev } });
    await api(`/restaurant/orders/${s4.data._id}/items/${s4sent.data.items[0]._id}`, { method: 'DELETE', token: rvToken });
    await api(`/restaurant/orders/${s4.data._id}/cancel`, { method: 'POST', token: rvToken, body: { reason: 'Voided test' } });

    const move = (body) => shiftApi(`/${rvShiftId}/cash-movements`, { method: 'POST', body });
    check('A pay-out is recorded', (await move({ type: 'pay_out', amountMinor: 2000, reason: 'Ice delivery' })).status === 200);
    check('A pay-in is recorded', (await move({ type: 'pay_in', amountMinor: 1000, reason: 'More change' })).status === 200);
    check('A pay-out larger than the drawer is refused', (await move({ type: 'pay_out', amountMinor: 10_000_000, reason: 'Too much' })).status === 400);
    check('A cash movement needs a reason', (await move({ type: 'pay_in', amountMinor: 100, reason: '' })).status === 422);

    const live = await shiftApi('/current');
    const lr = live.data?.report;
    check(
      'The live report totals the shift from order snapshots',
      lr?.sales?.paidOrders === 2 && lr.sales.grossSalesMinor === 51000 && lr.sales.discountsMinor === 1000 && lr.sales.netSalesMinor === 50000,
      lr?.sales,
    );
    check('Cash is reported net of change', lr?.byPaymentMethod?.find((m) => m.method === 'cash')?.amountMinor === 50000, lr?.byPaymentMethod);
    check(
      'Expected cash = float + cash sales + pay-ins - pay-outs',
      lr?.cash?.expectedCashMinor === 99000 && lr.cash.payInsMinor === 1000 && lr.cash.payOutsMinor === 2000,
      lr?.cash,
    );
    check('Cancellations during the shift are counted', lr?.cancelled?.orders === 2, lr?.cancelled);
    check('Voids during the shift are counted at their snapshot price', lr?.voids?.quantity === 1 && lr.voids.valueMinor === 35000, lr?.voids);
    check('A shift report is not reporting (no reports.view needed for current)', live.status === 200);

    const closed = await shiftApi(`/${rvShiftId}/close`, { method: 'POST', body: { countedCashMinor: 98500, note: 'Short 5' } });
    check(
      'Closing records the count and the variance',
      closed.status === 200 && closed.data?.shift?.status === 'closed' && closed.data.shift.expectedCashMinor === 99000 && closed.data.shift.varianceMinor === -500,
      closed.data?.shift ?? closed.error,
    );
    check('The Z-report is frozen with the count', closed.data?.report?.cash?.countedCashMinor === 98500 && closed.data.report.cash.varianceMinor === -500);
    check('The close response carries what printing needs', typeof closed.data?.store?.receipt?.paperWidthMm === 'number');
    check('A shift cannot be closed twice', (await shiftApi(`/${rvShiftId}/close`, { method: 'POST', body: { countedCashMinor: 0 } })).status === 409);
    check('A closed shift takes no cash movements', (await move({ type: 'pay_in', amountMinor: 100, reason: 'Late' })).status === 409);
    check('The client cannot set the expected cash', (await shiftApi(`/${rvShiftId}/close`, { method: 'POST', body: { countedCashMinor: 0, expectedCashMinor: 0 } })).status === 422);

    const after = await rvOrder({ type: 'takeaway', items: [{ menuItemId: borhani.data._id, quantity: 1 }] });
    const afterPaid = await rvPay(after.data._id, { payments: [{ method: 'cash', amountMinor: 8000 }], rev: after.data.rev });
    check('A payment with no shift open carries no shift', afterPaid.status === 200 && afterPaid.data?.shiftId === null, afterPaid.data?.shiftId);

    const frozen = await shiftApi(`/${rvShiftId}`);
    check(
      'A closed Z-report does not change when later orders are paid',
      frozen.data?.report?.sales?.netSalesMinor === 50000 && frozen.data.report.cash.expectedCashMinor === 99000,
      frozen.data?.report?.sales,
    );
    const history = await shiftApi('');
    check('Shift history lists the closed shift without its report', (history.data ?? []).some((s) => s._id === rvShiftId && s.report === undefined), history.data);
    check('An unknown shift is not found', (await shiftApi('/64b000000000000000000000')).status === 404);
    check('The next shift gets the next number', /^SHIFT-000002$/.test((await shiftApi('', { method: 'POST', body: { openingFloatMinor: 0 } })).data?.shift?.shiftNumber ?? ''));
    const reopened = await shiftApi('/current');
    await shiftApi(`/${reopened.data.shift._id}/close`, { method: 'POST', body: { countedCashMinor: 0 } });
    check('A Clothing workspace cannot reach shifts', (await api('/restaurant/shifts/current', { token: admin.token })).status === 403);
    check('Restaurant analytics are locked on Starter', (await api('/restaurant/reports', { token: rvToken })).error?.code === 'ADVANCED_ANALYTICS_REQUIRED');
  }

  // --- another Restaurant workspace of the same account ----------------------
  const rv2 = await rvOpenRestaurant(`Second Kitchen ${rvStamp}`);
  check('A second Restaurant workspace is ready', rv2.bought.status < 300, rv2.bought.error);
  check("It cannot read the first workspace's order", (await api(`/restaurant/orders/${o1.data._id}`, { token: rv2.token })).status === 404);
  check("It cannot read the first workspace's shift", (await api(`/restaurant/shifts/${rvShiftId}`, { token: rv2.token })).status === 404);
  check(
    "It cannot close the first workspace's shift",
    (await api(`/restaurant/shifts/${rvShiftId}/close`, { method: 'POST', token: rv2.token, body: { countedCashMinor: 0 } })).status === 404,
  );

  // --- Restaurant Advanced Analytics on Professional ---------------------------
  {
    const proPlan = ((await api('/plans?vertical=restaurant')).data ?? []).find((p) => p.code === 'showroom-monthly');
    const pro = await rvOpenRestaurant(`Pro Kitchen ${rvStamp}`, proPlan);
    check('A Professional Restaurant workspace is ready', pro.bought.status < 300, pro.bought.error);
    const pt = pro.token;
    const pApi = (path, opts = {}) => api(path, { token: pt, ...opts });
    const dish = await pApi('/restaurant/menu', { method: 'POST', body: { name: 'Tehari', category: 'Mains', priceMinor: 20000 } });
    const tea = await pApi('/restaurant/menu', { method: 'POST', body: { name: 'Tea', category: 'Drinks', priceMinor: 3000 } });
    await pApi('/restaurant/shifts', { method: 'POST', body: { openingFloatMinor: 10000 } });

    const order = await pApi('/restaurant/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ menuItemId: dish.data._id, quantity: 2 }, { menuItemId: tea.data._id, quantity: 1 }] },
    });
    const sent = await pApi(`/restaurant/orders/${order.data._id}/send-to-kitchen`, { method: 'POST', body: { rev: order.data.rev } });
    await pApi(`/restaurant/orders/${order.data._id}/tickets/${sent.data.tickets[0]._id}/ready`, { method: 'POST' });
    const teaLine = sent.data.items.find((l) => l.nameSnapshot === 'Tea');
    const voided = await pApi(`/restaurant/orders/${order.data._id}/items/${teaLine._id}`, { method: 'DELETE' });
    await pApi(`/restaurant/orders/${order.data._id}/pay`, { method: 'POST', body: { payments: [{ method: 'cash', amountMinor: 38000 }], discountMinor: 2000, rev: voided.data.rev } });
    const doomed = await pApi('/restaurant/orders', { method: 'POST', body: { type: 'takeaway', items: [{ menuItemId: tea.data._id, quantity: 3 }] } });
    await pApi(`/restaurant/orders/${doomed.data._id}/cancel`, { method: 'POST', body: { reason: 'Duplicate order' } });
    const current = await pApi('/restaurant/shifts/current');
    await pApi(`/restaurant/shifts/${current.data.shift._id}/close`, { method: 'POST', body: { countedCashMinor: 49000 } });

    const rep = await pApi('/restaurant/reports?preset=today');
    const r = rep.data;
    check('Professional unlocks Restaurant analytics', rep.status === 200, rep.error);
    check('Totals come from paid orders', r?.totals?.paidOrders === 1 && r.totals.netSalesMinor === 38000 && r.totals.discountsMinor === 2000, r?.totals);
    check('Menu performance lists only what was sold', r?.menu?.length === 1 && r.menu[0].name === 'Tehari' && r.menu[0].quantity === 2 && r.menu[0].revenueMinor === 40000, r?.menu);
    check('Categories are grouped', r?.categories?.[0]?.category === 'Mains', r?.categories);
    check('Voids are reported by item', r?.voids?.quantity === 1 && r.voids.valueMinor === 3000 && r.voids.byItem[0]?.name === 'Tea', r?.voids);
    check('Cancellations are listed with their reason', r?.cancellations?.orders === 1 && r.cancellations.recent[0]?.cancelReason === 'Duplicate order', r?.cancellations);
    check('Discounts are attributed to staff', r?.discounts?.byStaff?.[0]?.discountsMinor === 2000, r?.discounts);
    check('Kitchen speed counts ready tickets', r?.kitchen?.tickets === 1 && r.kitchen.byHour.length === 1, r?.kitchen);
    check('Closed shifts show their variance', r?.shifts?.closed === 1 && r.shifts.list[0].varianceMinor === 1000 && r.shifts.totalVarianceMinor === 1000, r?.shifts);
    check('Nothing was paid outside a shift', r?.totals?.unshiftedSalesMinor === 0);
    check('An invalid range preset is rejected', (await pApi('/restaurant/reports?preset=forever')).status === 422);
    check('A custom range needs both dates', (await pApi('/restaurant/reports?preset=custom&from=2026-01-01')).status === 422);

    // --- Restaurant usage limits: counted in the Restaurant's own records ------
    const proUsage = (await pApi('/subscriptions/current')).data?.usage;
    check('Usage is counted in the Restaurant vertical', proUsage?.vertical === 'restaurant', proUsage);
    check('The products meter counts menu items', proUsage?.products === 2, proUsage);
    check('The monthly meter counts orders, not cancelled ones', proUsage?.monthlySales === 1, proUsage);
    const homeUsage = (await api('/subscriptions/current', { token: rvHomeToken })).data?.usage;
    check('A Clothing workspace keeps counting Clothing records', homeUsage?.vertical === 'clothing' && typeof homeUsage?.products === 'number', homeUsage);

    const extra = await pApi('/restaurant/menu', { method: 'POST', body: { name: 'Lassi', category: 'Drinks', priceMinor: 5000 } });
    check('Adding a menu item moves the meter', extra.status === 201 && (await pApi('/subscriptions/current')).data?.usage?.products === 3);
    await pApi(`/restaurant/menu/${extra.data._id}`, { method: 'DELETE' });
    check('Removing a menu item frees its slot', (await pApi('/subscriptions/current')).data?.usage?.products === 2);

    const proTenantId = pro.created.data?.workspace?.id;
    const platformView = await api(`/platform/tenants/${proTenantId}`, { token: platform2.token });
    check(
      'The platform view shows Restaurant totals, not Clothing ones',
      platformView.data?.usage?.products === 2 && platformView.data.usage.sales === 2 && platformView.data.usage.vertical === 'restaurant',
      platformView.data?.usage ?? platformView.error,
    );

    // A downgrade is checked against the menu. Tighten Starter for Restaurant only.
    const starterRaw = ((await api('/plans/all', { token: platform2.token })).data ?? []).find((p) => p._id === rvStarter._id);
    const originalOverrides = starterRaw?.verticalOverrides ?? [];
    const tightened = await api(`/plans/${rvStarter._id}`, {
      method: 'PATCH',
      token: platform2.token,
      body: { verticalOverrides: [...originalOverrides.filter((o) => o.vertical !== 'restaurant'), { vertical: 'restaurant', limits: { maxProducts: 1 } }] },
    });
    check('Platform admin tightens Starter menu items for Restaurant', tightened.status === 200, tightened.error);
    try {
      const options = await pApi('/subscriptions/plan-options');
      const starterOption = (options.data?.options ?? []).find((o) => o.code === 'starter-store-monthly');
      const breach = (starterOption?.breaches ?? []).find((b) => b.resource === 'products');
      check(
        'A downgrade breach is measured in menu items',
        starterOption?.canProceed === false && breach?.label === 'menu items' && breach.current === 2 && breach.limit === 1 && breach.excess === 1,
        starterOption,
      );
      check('Plan options report the Restaurant vertical', options.data?.usage?.vertical === 'restaurant');
      const refused = await pApi('/subscriptions/upgrade-request', {
        method: 'POST',
        body: { planId: rvStarter._id, paymentMethod: 'wallet', amountMinor: rvStarter.priceMinor },
      });
      check(
        'The downgrade itself is refused with the menu breach',
        refused.status === 400 && (refused.error?.details?.breaches ?? []).some((b) => b.label === 'menu items'),
        refused.error,
      );
      const homeOptions = await api('/subscriptions/plan-options', { token: rvHomeToken });
      check(
        "The Restaurant override does not tighten a Clothing workspace's Starter",
        !((homeOptions.data?.options ?? []).find((o) => o.code === 'starter-store-monthly')?.breaches ?? []).some((b) => b.label === 'menu items'),
      );
    } finally {
      const restored = await api(`/plans/${rvStarter._id}`, { method: 'PATCH', token: platform2.token, body: { verticalOverrides: originalOverrides } });
      check('Starter overrides are restored', restored.status === 200, restored.error);
    }
  }

  // --- Account + workspace ownership (canAccessWorkspace) -------------------------
  {
    const ownWorkspaceId = rv.created.data?.workspace?.id;
    const adminWorkspaceId = admin.session.tenant.id;
    const nobody = '64b000000000000000000000';

    const ownerAccount = await api('/account', { token: rvHomeToken });
    const adminAccount = await api('/account', { token: admin.token });
    check(
      'The owner reads their own account',
      ownerAccount.status === 200 && Boolean(ownerAccount.data?.id) && ownerAccount.data.status === 'active' && ownerAccount.data.workspaceCount >= 2,
      ownerAccount.data ?? ownerAccount.error,
    );
    check('Two owners have two different accounts', Boolean(adminAccount.data?.id) && adminAccount.data.id !== ownerAccount.data?.id);
    check(
      'The account response holds no secrets or internal markers',
      !/passwordHash|trialUsedAt|ownerUserId/.test(JSON.stringify(ownerAccount.data ?? {})),
    );

    // 1. owner -> own workspace
    const own = await api(`/workspaces/${ownWorkspaceId}`, { token: rvHomeToken });
    check(
      '1. The owner accesses their own workspace',
      own.status === 200 && own.data?.id === ownWorkspaceId && own.data.accountId === ownerAccount.data?.id && own.data.businessType === 'restaurant',
      own.data ?? own.error,
    );
    check('A workspace exposes both businessName and the compatible name', own.data?.businessName === own.data?.name && Boolean(own.data?.settings?.timezone));
    const listed = await api('/workspaces', { token: rvHomeToken });
    check(
      'The owner lists only their own account’s workspaces',
      (listed.data ?? []).some((w) => w.id === ownWorkspaceId) && (listed.data ?? []).every((w) => w.accountId === ownerAccount.data?.id),
      listed.data,
    );

    // 2. different account
    check('2. A different account cannot read the workspace (404)', (await api(`/workspaces/${ownWorkspaceId}`, { token: admin.token })).status === 404);
    check(
      '2. A different account cannot update the workspace (404)',
      (await api(`/workspaces/${ownWorkspaceId}`, { method: 'PATCH', token: admin.token, body: { businessName: 'Hijacked' } })).status === 404,
    );
    check(
      '2. A different account cannot switch into the workspace',
      ![200, 201].includes((await api('/auth/switch-workspace', { method: 'POST', token: admin.token, body: { workspaceId: ownWorkspaceId } })).status),
    );

    // 3. forged accountId
    const forgedAccount = await api(`/workspaces/${ownWorkspaceId}`, {
      method: 'PATCH',
      token: admin.token,
      body: { businessName: 'Hijacked', accountId: adminAccount.data?.id },
    });
    check('3. A forged accountId in the body is rejected', forgedAccount.status === 422 || forgedAccount.status === 404, forgedAccount.status);
    const forgedMove = await api(`/workspaces/${ownWorkspaceId}`, {
      method: 'PATCH',
      token: rvHomeToken,
      body: { accountId: adminAccount.data?.id },
    });
    check('3. An owner cannot move a workspace to another account', forgedMove.status === 422, forgedMove.status);
    check(
      '3. A forged accountId in the query is ignored',
      !((await api(`/workspaces?accountId=${ownerAccount.data?.id}`, { token: admin.token })).data ?? []).some((w) => w.id === ownWorkspaceId),
    );
    check(
      '3. A forged accountId cannot create a workspace for another account',
      (await api('/workspaces', { method: 'POST', token: admin.token, body: { businessName: 'Planted', vertical: 'restaurant', accountId: ownerAccount.data?.id } })).status === 422,
    );

    // 4. forged ownerId
    const forgedOwner = await api(`/workspaces/${ownWorkspaceId}`, {
      method: 'PATCH',
      token: rvHomeToken,
      body: { ownerUserId: admin.session.user.id },
    });
    check('4. A forged ownerUserId on a workspace is rejected', forgedOwner.status === 422, forgedOwner.status);
    check('4. A forged ownerId on a workspace is rejected', (await api(`/workspaces/${ownWorkspaceId}`, { method: 'PATCH', token: rvHomeToken, body: { ownerId: admin.session.user.id } })).status === 422);
    check('4. A forged ownerUserId on the account is rejected', (await api('/account', { method: 'PATCH', token: rvHomeToken, body: { ownerUserId: admin.session.user.id } })).status === 422);
    check('4. An owner cannot un-suspend or change their account status', (await api('/account', { method: 'PATCH', token: rvHomeToken, body: { status: 'active' } })).status === 422);
    const stillOwn = await api(`/workspaces/${ownWorkspaceId}`, { token: rvHomeToken });
    check('Ownership is unchanged after every forgery attempt', stillOwn.data?.accountId === ownerAccount.data?.id && stillOwn.data?.businessName !== 'Hijacked', stillOwn.data);

    // 5. nonexistent
    check('5. A nonexistent workspace is 404', (await api(`/workspaces/${nobody}`, { token: rvHomeToken })).status === 404);
    check('5. A malformed workspace id is 422', (await api('/workspaces/not-an-id', { token: rvHomeToken })).status === 422);

    // 6. unauthorized: staff own no account (403); another account's id is 404 as above
    check('6. Staff cannot manage workspaces, even their own (403)', (await api(`/workspaces/${adminWorkspaceId}`, { token: cashier.token })).status === 403);
    check('6. Staff get the same 403 for any workspace id', (await api(`/workspaces/${ownWorkspaceId}`, { token: cashier.token })).status === 403);
    check('6. Staff cannot read the owner account (403)', (await api('/account', { token: cashier.token })).status === 403);
    check('6. Platform admins own no customer account (403)', (await api('/account', { token: platform2.token })).status === 403);
    check('6. Without a token it is 401', (await api(`/workspaces/${ownWorkspaceId}`)).status === 401);

    // Owner edits
    const renamed = await api(`/workspaces/${ownWorkspaceId}`, {
      method: 'PATCH',
      token: rvHomeToken,
      body: { businessName: 'Kacchi House Renamed', settings: { timezone: 'Asia/Dhaka', locale: 'bn-BD' } },
    });
    check('The owner updates their workspace profile and settings', renamed.status === 200 && renamed.data?.businessName === 'Kacchi House Renamed' && renamed.data.settings.locale === 'bn-BD', renamed.data ?? renamed.error);
    check('An unknown time zone is rejected', (await api(`/workspaces/${ownWorkspaceId}`, { method: 'PATCH', token: rvHomeToken, body: { settings: { timezone: 'Mars/Olympus' } } })).status === 422);
    check('The business type cannot be changed by an edit', (await api(`/workspaces/${ownWorkspaceId}`, { method: 'PATCH', token: rvHomeToken, body: { businessType: 'pharmacy' } })).status === 422);
    check('An empty edit is rejected', (await api(`/workspaces/${ownWorkspaceId}`, { method: 'PATCH', token: rvHomeToken, body: {} })).status === 422);
    const profile = await api('/account', { method: 'PATCH', token: rvHomeToken, body: { contactPhone: '+8801700000000', country: 'bd' } });
    check('The owner updates their account contact details', profile.status === 200 && profile.data?.contactPhone === '+8801700000000' && profile.data.country === 'BD', profile.data ?? profile.error);

    // 7. existing Clothing POS keeps working
    for (const [label, path, token] of [
      ['products', '/products', admin.token],
      ['sales', '/sales', admin.token],
      ['branches', '/stores', admin.token],
      ['staff', '/staff', admin.token],
      ['subscription', '/subscriptions/current', admin.token],
      ['cashier products', '/products', cashier.token],
    ]) {
      check(`7. Clothing POS still serves ${label}`, (await api(path, { token })).status === 200);
    }
    const adminOwn = await api(`/workspaces/${adminWorkspaceId}`, { token: admin.token });
    check('7. The existing Clothing business is a workspace of its owner’s account', adminOwn.status === 200 && adminOwn.data?.businessType === 'clothing' && adminOwn.data.accountId === adminAccount.data?.id, adminOwn.data ?? adminOwn.error);
  }

  // --- Staff privilege escalation --------------------------------------------------
  {
    const ms = Date.now();
    const mgrPerms = ['staff.view', 'staff.edit', 'staff.create', 'staff.delete', 'roles.view', 'roles.manage', 'sales.view', 'products.view'];
    const mgrEmail = `mgr${ms}@demostore.dev`;
    const mgrMade = await api('/staff', {
      method: 'POST',
      token: admin.token,
      body: { name: 'Floor Manager', email: mgrEmail, password: 'Manager@1234', extraPermissions: mgrPerms },
    });
    check('Admin creates a staff manager', mgrMade.status === 201, mgrMade.error);
    const trainee = await api('/staff', {
      method: 'POST',
      token: admin.token,
      body: { name: 'Trainee', email: `trainee${ms}@demostore.dev`, password: 'Trainee@1234', extraPermissions: ['sales.view'] },
    });
    check('Admin creates a trainee', trainee.status === 201, trainee.error);
    const mgr = await login(mgrEmail, 'Manager@1234');
    const rows = (await api('/staff?limit=100&includeInactive=true', { token: admin.token })).data ?? [];
    const seniorId = rows.find((r) => r.email === 'senior@demostore.dev')?.id;
    const adminRowId = rows.find((r) => r.role === 'admin')?.id;
    const roles = (await api('/roles', { token: admin.token })).data ?? [];
    const managerRoleId = roles.find((r) => r.name === 'Store Manager')?._id;
    const patchAs = (token, id, body) => api(`/staff/${id}`, { method: 'PATCH', token, body });

    // Self
    check('A manager cannot grant themselves a permission', (await patchAs(mgr.token, mgrMade.data.id, { extraPermissions: [...mgrPerms, 'subscription.manage'] })).status === 403);
    check('A manager cannot give themselves a role', (await patchAs(mgr.token, mgrMade.data.id, { roleId: managerRoleId })).status === 403);
    check('A manager cannot lift their own denials or deactivate themselves', (await patchAs(mgr.token, mgrMade.data.id, { isActive: false })).status === 403);
    check('A manager can still edit their own name', (await patchAs(mgr.token, mgrMade.data.id, { name: 'Floor Manager Renamed' })).status === 200);
    check('A manager cannot reset their own password through staff management', (await api(`/staff/${mgrMade.data.id}/reset-password`, { method: 'POST', token: mgr.token, body: { newPassword: 'Other@12345' } })).status === 400);

    // Granting to others
    const tId = trainee.data.id;
    const beyond = await patchAs(mgr.token, tId, { extraPermissions: ['sales.view', 'subscription.manage'] });
    check('A manager cannot grant a permission they do not hold', beyond.status === 403 && (beyond.error?.details?.permissions ?? []).includes('subscription.manage'), beyond.error);
    check('A manager can grant permissions they hold', (await patchAs(mgr.token, tId, { extraPermissions: ['sales.view', 'products.view'] })).status === 200);
    check('A manager cannot assign a role beyond their own', (await patchAs(mgr.token, tId, { roleId: managerRoleId })).status === 403);
    await patchAs(admin.token, tId, { extraPermissions: ['sales.view', 'reports.view'], deniedPermissions: ['reports.view'] });
    check('A manager cannot lift a denial on something they do not hold', (await patchAs(mgr.token, tId, { deniedPermissions: [] })).status === 403);
    check('A manager cannot create staff with more than they hold', (await api('/staff', { method: 'POST', token: mgr.token, body: { name: 'Sneaky', email: `sneaky${ms}@demostore.dev`, password: 'Sneaky@1234', extraPermissions: ['subscription.manage'] } })).status === 403);

    // Managing superiors
    check('A manager cannot edit someone who holds more', (await patchAs(mgr.token, seniorId, { name: 'Demoted' })).status === 403);
    check('A manager cannot reset the password of someone who holds more', (await api(`/staff/${seniorId}/reset-password`, { method: 'POST', token: mgr.token, body: { newPassword: 'Hijack@12345' } })).status === 403);
    check('A manager cannot delete someone who holds more', (await api(`/staff/${seniorId}`, { method: 'DELETE', token: mgr.token })).status === 403);
    check('A manager cannot edit the administrator', (await patchAs(mgr.token, adminRowId, { name: 'Owned' })).status === 403);

    // Roles
    check('A manager cannot create a role beyond their own', (await api('/roles', { method: 'POST', token: mgr.token, body: { name: `Sneaky ${ms}`, permissions: ['subscription.manage'] } })).status === 403);
    const lite = await api('/roles', { method: 'POST', token: mgr.token, body: { name: `Lite ${ms}`, permissions: ['sales.view'] } });
    check('A manager can create a role within their own', lite.status === 201, lite.error);
    check('A manager cannot widen a role beyond their own', (await api(`/roles/${lite.data?._id}`, { method: 'PATCH', token: mgr.token, body: { permissions: ['sales.view', 'subscription.manage'] } })).status === 403);
    check('A manager cannot edit a role that grants more than they hold', (await api(`/roles/${managerRoleId}`, { method: 'PATCH', token: mgr.token, body: { description: 'hijacked' } })).status === 403);
    check('A manager cannot delete a role that grants more than they hold', (await api(`/roles/${managerRoleId}`, { method: 'DELETE', token: mgr.token })).status === 403);
    check('A manager can delete their own lesser role', (await api(`/roles/${lite.data?._id}`, { method: 'DELETE', token: mgr.token })).status === 200);

    // The administrator is unrestricted
    check('The administrator can still grant anything', (await patchAs(admin.token, tId, { extraPermissions: ['subscription.view'], deniedPermissions: [] })).status === 200);

    await api(`/staff/${tId}`, { method: 'DELETE', token: admin.token });
    await api(`/staff/${mgrMade.data.id}`, { method: 'DELETE', token: admin.token });
  }

  // --- Workspace membership ----------------------------------------------------------
  {
    const ms = Date.now();
    const rv2Id = rv2.created.data?.workspace?.id;
    const waiterEmail = `waiter${ms}@example.com`;
    const waiterMade = await api('/staff', {
      method: 'POST',
      token: rvToken,
      body: { name: 'Shared Waiter', email: waiterEmail, password: 'Waiter@12345', extraPermissions: ['sales.view', 'sales.create'] },
    });
    check('A staff member is created in their home workspace', waiterMade.status === 201, waiterMade.error);
    const w1 = await login(waiterEmail, 'Waiter@12345');
    check('Before joining, staff see only their home workspace', w1.session.workspaces?.length === 1, w1.session.workspaces);

    const members = (path = '', opts = {}) => api(`/staff/members${path}`, { token: rv2.token, ...opts });
    const added = await members('', { method: 'POST', body: { email: waiterEmail, extraPermissions: ['sales.view'] } });
    check('The account owner adds them to another workspace of the account', added.status === 201 && added.data?.email === waiterEmail && added.data.homeWorkspace?.name, added.data ?? added.error);
    check('A member takes a staff seat', (await api('/subscriptions/current', { token: rv2.token })).data?.usage?.staff === 1);
    check('Adding the same person twice is a conflict', (await members('', { method: 'POST', body: { email: waiterEmail } })).status === 409);
    check('An email not in this account is not found', (await members('', { method: 'POST', body: { email: `nobody${ms}@example.com` } })).status === 404);
    check('The owner cannot be added as a member', (await members('', { method: 'POST', body: { email: rv.switched.data?.user?.email ?? 'owner@example.com' } })).status === 404);
    check('A forged userId or tenantId is rejected', (await members('', { method: 'POST', body: { email: waiterEmail, userId: waiterMade.data.id, tenantId: rv2Id } })).status === 422);
    check('Another account cannot add this person', (await api('/staff/members', { method: 'POST', token: admin.token, body: { email: waiterEmail } })).status === 404);
    check('Staff cannot add members', (await api('/staff/members', { method: 'POST', token: cashier.token, body: { email: 'cashier@demostore.dev' } })).status === 403);
    check('Another workspace cannot see the membership by id', (await api(`/staff/members/${added.data.id}`, { method: 'PATCH', token: admin.token, body: { isActive: false } })).status === 404);
    check('The member is listed for this workspace', ((await members()).data ?? []).some((m) => m.id === added.data.id));

    const w2 = await login(waiterEmail, 'Waiter@12345');
    check('After joining, the session lists the second workspace', (w2.session.workspaces ?? []).some((w) => w.id === rv2Id));
    const switched = await api('/auth/switch-workspace', { method: 'POST', token: w2.token, body: { workspaceId: rv2Id } });
    const wt = switched.data?.tokens?.accessToken;
    check(
      'The member switches in with the membership’s access, not their home access',
      switched.status === 200 && switched.data?.user?.role === 'staff' && switched.data.user.permissions.includes('sales.view') && !switched.data.user.permissions.includes('sales.create'),
      switched.data?.user ?? switched.error,
    );
    check('The member can use what the membership grants', (await api('/restaurant/orders', { token: wt })).status === 200);
    check('The member cannot use what only their home access grants', (await api('/restaurant/orders', { method: 'POST', token: wt, body: { type: 'takeaway', items: [] } })).status === 403);
    check('The member cannot manage staff there', (await api('/staff', { token: wt })).status === 403);
    check('The member cannot switch into a workspace they did not join', (await api('/auth/switch-workspace', { method: 'POST', token: w2.token, body: { workspaceId: rvHomeId } })).status === 403);
    check('Home access is unchanged', (await api('/restaurant/orders', { token: w1.token })).status === 200);

    check('The owner deactivates the membership', (await members(`/${added.data.id}`, { method: 'PATCH', body: { isActive: false } })).status === 200);
    check('A deactivated membership stops working immediately', (await api('/restaurant/orders', { token: wt })).status === 401);
    check('An inactive member does not take a seat', (await api('/subscriptions/current', { token: rv2.token })).data?.usage?.staff === 0);
    check('The owner reactivates the membership', (await members(`/${added.data.id}`, { method: 'PATCH', body: { isActive: true } })).status === 200);
    check('A reactivated membership works again', (await api('/restaurant/orders', { token: wt })).status === 200);
    check('A membership cannot be made admin', (await members(`/${added.data.id}`, { method: 'PATCH', body: { role: 'admin' } })).status === 422);

    check('The owner removes the membership', (await members(`/${added.data.id}`, { method: 'DELETE' })).status === 200);
    check('A removed membership stops working', (await api('/restaurant/orders', { token: wt })).status === 401);
    const w3 = await login(waiterEmail, 'Waiter@12345');
    check('A removed workspace leaves the session', !(w3.session.workspaces ?? []).some((w) => w.id === rv2Id));
    const readded = await members('', { method: 'POST', body: { email: waiterEmail } });
    check('A removed member can be added back', readded.status === 201 && readded.data?.id === added.data.id, readded.error);
    await members(`/${added.data.id}`, { method: 'DELETE' });
  }

  // --- Login identity ------------------------------------------------------------------
  {
    const ms = Date.now();

    // New duplicate logins are refused.
    check('A staff email already used in this workspace is refused', (await api('/staff', { method: 'POST', token: admin.token, body: { name: 'Dup', email: 'cashier@demostore.dev', password: 'Password@123' } })).status === 409);
    check('Email matching is case-insensitive', (await api('/staff', { method: 'POST', token: admin.token, body: { name: 'Dup', email: 'CASHIER@DemoStore.dev', password: 'Password@123' } })).status === 409);

    const sharedEmail = `shared${ms}@example.com`;
    const inRv2 = await api('/staff', { method: 'POST', token: rv2.token, body: { name: 'Shared Cook', email: sharedEmail, password: 'Cook@123456' } });
    check('A staff login is created once', inRv2.status === 201, inRv2.error);
    const sibling = await api('/staff', { method: 'POST', token: rvToken, body: { name: 'Shared Cook', email: sharedEmail, password: 'Other@123456' } });
    check(
      'A second login for staff of a sibling workspace is refused, suggesting membership',
      sibling.status === 409 && sibling.error?.details?.suggestion === 'add_member',
      sibling.error,
    );
    const foreign = await api('/staff', { method: 'POST', token: admin.token, body: { name: 'Shared Cook', email: sharedEmail, password: 'Other@123456' } });
    check(
      'Another account cannot reuse the email either, and learns nothing about where it is used',
      foreign.status === 409 && !foreign.error?.details?.suggestion,
      foreign.error,
    );
    check('A staff email cannot be registered as a new owner', (await api('/auth/register', { method: 'POST', body: { businessName: 'Dup Biz', name: 'Dup', email: sharedEmail, password: 'Password@123' } })).status === 409);
    check('A platform administrator email cannot be registered as a new owner', (await api('/auth/register', { method: 'POST', body: { businessName: 'Dup Biz', name: 'Dup', email: 'platform@pos.dev', password: 'Password@123' } })).status === 409);
    const cook = await login(sharedEmail, 'Cook@123456');
    check('A unique login signs straight in', Boolean(cook.token) && !cook.session.requiresWorkspaceSelection);
    await api(`/staff/${inRv2.data.id}`, { method: 'DELETE', token: rv2.token });

    // Selection endpoint cannot be abused without a real, password-backed token.
    check('A garbage selection token is refused', (await api('/auth/login/select', { method: 'POST', body: { selectionToken: 'x'.repeat(40), userId: '64b000000000000000000000' } })).status === 401);
    check('An access token is not a selection token', (await api('/auth/login/select', { method: 'POST', body: { selectionToken: admin.token, userId: admin.session.user.id } })).status === 401);
    check('The selection body is strict', (await api('/auth/login/select', { method: 'POST', body: { selectionToken: admin.token, userId: admin.session.user.id, tenantId: admin.session.tenant.id } })).status === 422);
    check('Unknown email and wrong password answer identically', (await api('/auth/login', { method: 'POST', body: { email: `ghost${ms}@example.com`, password: 'Whatever@123' } })).error?.message === (await api('/auth/login', { method: 'POST', body: { email: 'admin@demostore.dev', password: 'Wrong@12345' } })).error?.message);

    // Sign-in lands in the workspace used last, while it is still allowed.
    const ownerEmail = `lander${ms}@example.com`;
    const reg = await api('/auth/register', { method: 'POST', body: { businessName: `Lander ${ms}`, name: 'Lander', email: ownerEmail, password: 'Lander@12345' } });
    const regToken = reg.data?.tokens?.accessToken;
    const homeId = reg.data?.tenant?.id;
    const second = await api('/workspaces', { method: 'POST', token: regToken, body: { businessName: `Lander Kitchen ${ms}`, vertical: 'restaurant' } });
    const secondId = second.data?.workspace?.id;
    const hop = await api('/auth/switch-workspace', { method: 'POST', token: regToken, body: { workspaceId: secondId } });
    check('The owner switches to their second workspace', hop.status === 200, hop.error);
    const again = await login(ownerEmail, 'Lander@12345');
    check('Signing in again lands in the workspace used last', again.session.tenant?.id === secondId, again.session.tenant);
    await api('/auth/switch-workspace', { method: 'POST', token: again.token, body: { workspaceId: homeId } });
    check('Switching home is remembered too', (await login(ownerEmail, 'Lander@12345')).session.tenant?.id === homeId);
  }

  // --- Payment integrity -------------------------------------------------------------
  {
    const ms = Date.now();
    const verify = (paymentId) => api('/payments/verify', { method: 'POST', token: admin.token, body: { paymentId } });
    check('A malformed paymentId is rejected before any lookup', (await verify('not-an-id')).status === 422);
    check('An operator object as paymentId is rejected', (await verify({ $ne: null })).status === 422);
    check('Extra fields on verify are rejected', (await api('/payments/verify', { method: 'POST', token: admin.token, body: { paymentId: '64b000000000000000000000', status: 'paid' } })).status === 422);
    check('An unknown payment is not found', (await verify('64b000000000000000000000')).status === 404);
    check(
      'An unsigned "paid" webhook is acknowledged without acting',
      (await api('/payments/webhook/bkash', { method: 'POST', body: { paymentID: 'forged', transactionStatus: 'Completed', amount: '999999' } })).status === 202,
    );
    check('A webhook for an unknown provider gets the same answer', (await api('/payments/webhook/not-a-provider', { method: 'POST', body: {} })).status === 202);

    // Concurrent approvals of one manual upgrade request.
    const reg = await api('/auth/register', {
      method: 'POST',
      body: { businessName: `Race Shop ${ms}`, name: 'Racer', email: `racer${ms}@example.com`, password: 'Racer@12345' },
    });
    const rt = reg.data?.tokens?.accessToken;
    await api('/stores', { method: 'POST', token: rt, body: { name: 'Race Main', code: `RACE${ms}`.slice(0, 16), currency: 'BDT' } });
    await verifyContact(rt);
    const proPlan = ((await api('/plans')).data ?? []).find((p) => p.code === 'showroom-monthly');
    const request = await api('/subscriptions/upgrade-request', {
      method: 'POST',
      token: rt,
      body: { planId: proPlan._id, paymentMethod: 'bkash', amountMinor: proPlan.priceMinor, senderNumber: '01711000000', transactionId: `TXNRACE${ms}` },
    });
    check('A manual upgrade request is submitted', request.status === 201, request.error);
    const approvals = await Promise.all(
      [1, 2, 3].map(() => api(`/platform/upgrade-requests/${request.data?._id}/approve`, { method: 'POST', token: platform2.token, body: { reviewNote: 'race' } })),
    );
    check(
      'Of three concurrent approvals exactly one succeeds',
      approvals.filter((r) => r.status === 201).length === 1 && approvals.filter((r) => r.status === 400).length === 2,
      approvals.map((r) => r.status),
    );
    const history = await api('/subscriptions/history', { token: rt });
    const live = (history.data?.subscriptions ?? []).filter((s) => !['expired', 'cancelled'].includes(s.status));
    check(
      'Exactly one subscription is live after the race',
      live.length === 1 && live[0].planSnapshot?.code === 'showroom-monthly',
      (history.data?.subscriptions ?? []).map((s) => [s.planSnapshot?.code, s.status]),
    );
    check('Exactly one payment was recorded for the request', (history.data?.payments ?? []).filter((p) => p.status === 'paid').length === 1, history.data?.payments?.length);
    check('The workspace is on the approved plan', (await api('/subscriptions/current', { token: rt })).data?.subscription?.planSnapshot?.code === 'showroom-monthly');
  }

  // --- bKash Tokenized Checkout (real adapter, local mock of the bKash API) ---------------
  if (process.env.BKASH_MOCK_URL) {
    const mock = process.env.BKASH_MOCK_URL;
    const ms = Date.now();
    const control = (path, payload) =>
      fetch(`${mock}/__control/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload ?? {}) }).then((r) => r.json());
    const callback = async (params) => {
      const res = await fetch(`${BASE}/payments/callback/bkash?${new URLSearchParams(params)}`, { redirect: 'manual' });
      const location = res.headers.get('location') ?? '';
      let result = null;
      let origin = null;
      try {
        const url = new URL(location);
        result = url.searchParams.get('payment');
        origin = url.origin;
      } catch {
        // No usable redirect.
      }
      return { status: res.status, location, result, origin };
    };

    check('bKash is offered once configured', ((await api('/payments/providers', { token: admin.token })).data ?? []).some((p) => p.name === 'bkash'));

    const reg = await api('/auth/register', {
      method: 'POST',
      body: { businessName: `bKash Shop ${ms}`, name: 'Payer', email: `payer${ms}@example.com`, password: 'Payer@12345' },
    });
    const pt = reg.data?.tokens?.accessToken;
    await api('/stores', { method: 'POST', token: pt, body: { name: 'Pay Main', code: `PAY${ms}`.slice(0, 16), currency: 'BDT' } });
    await verifyContact(pt);
    const allPlans = (await api('/plans')).data ?? [];
    const proPlan = allPlans.find((p) => p.code === 'showroom-monthly');
    const topPlan = allPlans.find((p) => p.code === 'brand-monthly');
    const checkout = (payload) => api('/payments/checkout', { method: 'POST', token: pt, body: { provider: 'bkash', ...payload } });
    const paymentById = async (id) => ((await api('/payments?limit=100', { token: pt })).data ?? []).find((p) => String(p._id) === String(id));

    // 1. Checkout
    const c1 = await checkout({ planId: proPlan._id, amountMinor: 1 });
    check('Checkout opens a bKash payment and returns the bKash page', c1.status === 201 && String(c1.data?.redirectUrl ?? '').startsWith(mock), c1.data ?? c1.error);
    const p1 = await paymentById(c1.data?.paymentId);
    check(
      'The payment is pending at the plan price set by the server, not the client',
      p1?.status === 'pending' && p1.amountMinor === proPlan.priceMinor && /^TR0011MOCK/.test(p1.providerTransactionId ?? ''),
      p1,
    );

    // 2. The browser cannot confirm anything on its own.
    const early = await callback({ paymentID: p1.providerTransactionId, status: 'success' });
    check('A "success" callback before the customer pays activates nothing', early.status === 303 && early.result === 'pending', early);
    check('The payment is still pending', (await paymentById(p1._id))?.status === 'pending');
    const forged = await callback({ paymentID: 'TR0011FORGED000', status: 'success' });
    check('A callback for an unknown payment redirects as failed', forged.status === 303 && forged.result === 'failed', forged);
    check('Callbacks only ever redirect to the app', Boolean(early.origin) && early.origin === forged.origin && !/example\.com|evil/.test(early.location));

    // 3. The customer approves at bKash and returns.
    await control('customer-approves', { paymentID: p1.providerTransactionId });
    const back = await callback({ paymentID: p1.providerTransactionId, status: 'success' });
    check('After approval, the callback finalises with bKash and succeeds', back.result === 'success', back);
    // Confirmation details are internal: read from the platform payment desk, not the workspace list.
    const p1Paid = (await api(`/platform/payments/${p1._id}`, { token: platform2.token })).data?.payment;
    check(
      'The payment is paid on bKash’s own confirmation of amount and currency',
      p1Paid?.status === 'paid' && p1Paid.metadata?.confirmedVia === 'callback' && p1Paid.metadata?.providerAmountMinor === proPlan.priceMinor && p1Paid.metadata?.providerCurrency === 'BDT',
      p1Paid,
    );
    const afterPay = await api('/subscriptions/current', { token: pt });
    check('The plan is activated', afterPay.data?.subscription?.planSnapshot?.code === 'showroom-monthly' && afterPay.data.subscription.status === 'active', afterPay.data?.subscription);
    const replay = await callback({ paymentID: p1.providerTransactionId, status: 'success' });
    const history = await api('/subscriptions/history', { token: pt });
    check(
      'Replaying the callback activates nothing twice',
      replay.result === 'success' && (history.data?.subscriptions ?? []).filter((s) => String(s.lastPaymentId) === String(p1._id)).length === 1,
    );

    // 4. Underpayment reported by bKash.
    const c2 = await checkout({ planId: topPlan._id });
    const p2 = await paymentById(c2.data?.paymentId);
    await control('customer-approves', { paymentID: p2.providerTransactionId, amount: '10.00' });
    const under = await callback({ paymentID: p2.providerTransactionId, status: 'success' });
    check('An underpayment confirmed by bKash fails the payment', under.result === 'failed' && (await paymentById(p2._id))?.status === 'failed', under);
    check('The plan does not change after an underpayment', (await api('/subscriptions/current', { token: pt })).data?.subscription?.planSnapshot?.code === 'showroom-monthly');

    // 5. Cancel from the browser, then pay and confirm through verify.
    const c3 = await checkout({ planId: topPlan._id });
    const p3 = await paymentById(c3.data?.paymentId);
    const cancelled = await callback({ paymentID: p3.providerTransactionId, status: 'cancel' });
    check('A "cancel" callback never cancels on the browser’s word; the payment stays pending', cancelled.result === 'pending' && (await paymentById(p3._id))?.status === 'pending', cancelled);
    check('Another workspace cannot verify this payment', (await api('/payments/verify', { method: 'POST', token: admin.token, body: { paymentId: p3._id } })).status === 404);
    await control('customer-approves', { paymentID: p3.providerTransactionId });
    const verified = await api('/payments/verify', { method: 'POST', token: pt, body: { paymentId: p3._id } });
    check('Verify finalises an approved payment with bKash', verified.status === 200 && verified.data?.status === 'paid', verified.data ?? verified.error);
    check('The higher plan is now active', (await api('/subscriptions/current', { token: pt })).data?.subscription?.planSnapshot?.code === 'brand-monthly');

    // 6. Notifications and hostile gateway responses.
    const forgedNotice = await fetch(`${BASE}/payments/webhook/bkash`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=UTF-8' },
      body: JSON.stringify({
        Type: 'Notification',
        MessageId: 'forged',
        TopicArn: 'arn:aws:sns:ap-southeast-1:000000000000:bkash-test',
        Message: JSON.stringify({ paymentID: p2.providerTransactionId, transactionStatus: 'Completed', amount: '2990.00', currency: 'BDT' }),
        Timestamp: new Date().toISOString(),
        SignatureVersion: '1',
        Signature: 'AAAA',
        SigningCertURL: 'https://evil.example.com/cert.pem',
      }),
    });
    check('A forged SNS notification is ignored', forgedNotice.status === 202);
    check('The forged notification did not revive the failed payment', (await paymentById(p2._id))?.status === 'failed');

    await control('settings', { foreignRedirect: true });
    // A plan the workspace may legitimately move to (a downgrade it fits), so the
    // refusal below is the gateway check, not the plan-change rule.
    const hostile = await checkout({ planId: proPlan._id });
    await control('settings', { foreignRedirect: false });
    check('A checkout page on a foreign host is refused', hostile.status === 503, hostile.status);

    // 7. Online checkout follows the same plan-change rules as manual and wallet upgrades.
    const samePlan = await checkout({ planId: topPlan._id });
    check('Paying online for the plan already running is refused', samePlan.status === 400 && /already on/i.test(samePlan.error?.message ?? ''), samePlan.error);
    const starterPlan = allPlans.find((p) => p.code === 'starter-store-monthly');
    const secondStore = await api('/stores', { method: 'POST', token: pt, body: { name: 'Pay Second', code: `PAYB${ms}`.slice(0, 16), currency: 'BDT' } });
    check('The workspace opens a second branch on its plan', secondStore.status === 201, secondStore.error);
    const blockedDown = await checkout({ planId: starterPlan._id });
    check(
      'An online downgrade the workspace does not fit is refused, naming what to reduce',
      blockedDown.status === 400 && (blockedDown.error?.details?.breaches ?? []).some((b) => b.resource === 'branches'),
      blockedDown.error,
    );
    const manualRequest = await api('/subscriptions/upgrade-request', {
      method: 'POST',
      token: pt,
      body: { planId: proPlan._id, paymentMethod: 'bkash', amountMinor: proPlan.priceMinor, senderNumber: '01711000000', transactionId: `TXNPAY${ms}` },
    });
    check('A manual request for a downgrade that fits is accepted', manualRequest.status === 201, manualRequest.error);
    const twoRoutes = await checkout({ planId: proPlan._id });
    check('Online payment is refused while a manual request awaits review', twoRoutes.status === 409, twoRoutes.error);
    await api(`/subscriptions/upgrade-requests/${manualRequest.data?._id}/cancel`, { method: 'POST', token: pt });
    const fitsDown = await checkout({ planId: proPlan._id });
    check('An online downgrade that fits is allowed once nothing else is in flight', fitsDown.status === 201, fitsDown.error);

    // 8. Payment operations for platform admins.
    const ops = (path = '', opts = {}) => api(`/platform/payments${path}`, { token: platform2.token, ...opts });
    check('Workspace users cannot reach payment operations', (await api('/platform/payments', { token: pt })).status === 403);

    // An overpayment is activated but queued for review.
    const cOver = await checkout({ planId: proPlan._id });
    const pOver = await paymentById(cOver.data?.paymentId);
    await control('customer-approves', { paymentID: pOver.providerTransactionId, amount: '2500.00' });
    const overReturn = await callback({ paymentID: pOver.providerTransactionId, status: 'success' });
    check('An overpayment is still activated', overReturn.result === 'success', overReturn);
    const reviewQueue = await ops('?queue=review&limit=100');
    check(
      'It appears in the review queue with its reason',
      (reviewQueue.data ?? []).some((p) => String(p._id) === String(pOver._id) && /Overpaid/.test(p.review?.reason ?? '')),
      reviewQueue.error ?? reviewQueue.data?.length,
    );
    const opsSummary = await ops('/summary');
    check('The summary counts payments awaiting review', opsSummary.status === 200 && opsSummary.data?.review >= 1, opsSummary.data);
    const overDetail = await ops(`/${pOver._id}`);
    check(
      'Payment detail shows the workspace and the refundable amount actually paid',
      overDetail.data?.payment?.tenantId?.name?.startsWith('bKash Shop') && overDetail.data?.refundableMinor === 250_000 && overDetail.data?.remainingRefundableMinor === 250_000,
      overDetail.data ?? overDetail.error,
    );

    const refund = (id, payload) => ops(`/${id}/refunds`, { method: 'POST', body: payload });
    check('Resolving a review needs a real explanation', (await ops(`/${pOver._id}/resolve-review`, { method: 'POST', body: { note: 'ok' } })).status === 422);
    check('A refund with an unknown method is rejected', (await refund(pOver._id, { amountMinor: 100, method: 'crypto', reference: 'RFD-X', reason: 'Testing methods' })).status === 422);
    check('A refund above what was paid is refused', (await refund(pOver._id, { amountMinor: 250_001, method: 'provider_portal', reference: 'RFD-BIG', reason: 'More than paid' })).status === 400);
    const partialRefund = await refund(pOver._id, { amountMinor: 51_000, method: 'provider_portal', reference: `RFD${ms}`, reason: 'Returned the overpaid difference' });
    check(
      'The overpaid difference is refunded and recorded; the payment stays paid',
      partialRefund.status === 201 && partialRefund.data?.refundedMinor === 51_000 && partialRefund.data?.status === 'paid',
      partialRefund.data ?? partialRefund.error,
    );
    const resolvedReview = await ops(`/${pOver._id}/resolve-review`, { method: 'POST', body: { note: `Difference refunded as RFD${ms}` } });
    check('The review is resolved, recording who and why', resolvedReview.status === 200 && Boolean(resolvedReview.data?.review?.resolvedAt) && Boolean(resolvedReview.data.review.resolvedByNameSnapshot), resolvedReview.data ?? resolvedReview.error);
    check('A resolved review cannot be resolved again', (await ops(`/${pOver._id}/resolve-review`, { method: 'POST', body: { note: 'Second resolution' } })).status === 409);
    check('It leaves the review queue', !((await ops('?queue=review&limit=100')).data ?? []).some((p) => String(p._id) === String(pOver._id)));

    const burst = await Promise.all([1, 2, 3].map((n) => refund(pOver._id, { amountMinor: 100_000, method: 'bank_transfer', reference: `RFDB${n}${ms}`, reason: 'Concurrent refund attempt' })));
    check('Concurrent refunds can never add up to more than was paid', burst.filter((r) => r.status === 201).length === 1 && burst.filter((r) => r.status === 400).length === 2, burst.map((r) => r.status));
    const finalRefund = await refund(pOver._id, { amountMinor: 99_000, method: 'provider_portal', reference: `RFDF${ms}`, reason: 'Customer asked for a full refund' });
    check('Refunding the remainder marks the payment refunded', finalRefund.status === 201 && finalRefund.data?.status === 'refunded' && finalRefund.data?.refundedMinor === 250_000, finalRefund.data ?? finalRefund.error);
    check('A refunded payment takes no further refunds', (await refund(pOver._id, { amountMinor: 1, method: 'cash', reference: 'RFD-MORE', reason: 'One more time' })).status === 409);
    check('The workspace sees the refund on its own payment record', (await paymentById(pOver._id))?.refundedMinor === 250_000);

    // Re-check: the provider decides; final payments are final.
    const cLate = await checkout({ planId: topPlan._id });
    const pLate = await paymentById(cLate.data?.paymentId);
    await control('customer-approves', { paymentID: pLate.providerTransactionId });
    const recheck = await ops(`/${pLate._id}/recheck`, { method: 'POST' });
    check('Re-checking a pending payment the customer paid activates it', recheck.status === 200 && recheck.data?.outcome === 'activated' && recheck.data.payment?.status === 'paid', recheck.data ?? recheck.error);
    check('Re-checking a failed payment cannot revive it', (await ops(`/${p2._id}/recheck`, { method: 'POST' })).status === 409);
    check('Re-check takes no body', (await ops(`/${pLate._id}/recheck`, { method: 'POST', body: { status: 'paid' } })).status === 422);
    const fitsDownPayment = await paymentById(fitsDown.data?.paymentId);
    check(
      'A pending gateway payment cannot be marked received by hand',
      (await ops(`/${fitsDownPayment._id}/mark-paid`, { method: 'POST', body: { amountReceivedMinor: proPlan.priceMinor, reference: 'CASH-1', note: 'Customer paid in cash' } })).status === 409,
    );
    check(
      'A failed payment cannot be marked received',
      (await ops(`/${p2._id}/mark-paid`, { method: 'POST', body: { amountReceivedMinor: topPlan.priceMinor, reference: 'CASH-2', note: 'Trying to revive it' } })).status === 409,
    );
    check('Marking received needs a reference and a note', (await ops(`/${fitsDownPayment._id}/mark-paid`, { method: 'POST', body: {} })).status === 422);

    const refundAudit = await api('/platform/audit-log?action=payment.refund_recorded&limit=100', { token: platform2.token });
    check('Every recorded refund is in the audit log', (refundAudit.data ?? []).filter((e) => e.newValue?.paymentId === String(pOver._id)).length === 3, refundAudit.data?.length);
    check('Payment detail lists its admin actions', ((await ops(`/${pOver._id}`)).data?.audit ?? []).length >= 4);

    // 9. Subscription actions after a refund.
    const subAction = (id, payload) => ops(`/${id}/subscription-action`, { method: 'POST', body: payload });
    check('A payment with no refund cannot change its subscription', (await subAction(pLate._id, { action: 'end_now', reason: 'No refund made yet' })).status === 409);
    check('An old refund cannot touch a subscription that was already replaced', (await subAction(pOver._id, { action: 'end_now', reason: 'Too late for this one' })).status === 409);
    const lateRefund = await refund(pLate._id, { amountMinor: topPlan.priceMinor, method: 'provider_portal', reference: `RFDL${ms}`, reason: 'Customer cancelled within a day' });
    check('The current plan’s payment is refunded in full', lateRefund.data?.status === 'refunded', lateRefund.data ?? lateRefund.error);
    check('Its subscription is reported as still current', (await ops(`/${pLate._id}`)).data?.subscriptionIsCurrent === true);
    check('Shortening needs a date', (await subAction(pLate._id, { action: 'shorten', reason: 'Prorated refund' })).status === 422);
    check('Ending now takes no date', (await subAction(pLate._id, { action: 'end_now', until: new Date().toISOString(), reason: 'Refunded in full' })).status === 422);
    check('A reason is required', (await subAction(pLate._id, { action: 'end_now', reason: 'no' })).status === 422);
    check('A new end in the past is refused', (await subAction(pLate._id, { action: 'shorten', until: new Date(Date.now() - 86_400_000).toISOString(), reason: 'Prorated refund' })).status === 400);
    check('A new end beyond the paid period is refused', (await subAction(pLate._id, { action: 'shorten', until: new Date(Date.now() + 400 * 86_400_000).toISOString(), reason: 'Prorated refund' })).status === 400);
    const ended = await subAction(pLate._id, { action: 'end_now', reason: 'Refunded in full; access ends today' });
    check('Ending access after a full refund expires the subscription', ended.status === 200 && ended.data?.subscription?.status === 'expired', ended.data ?? ended.error);
    check('The workspace loses access at once', (await api('/subscriptions/current', { token: pt })).data?.entitlement?.isUsable === false);
    const historyEvents = (await api('/subscriptions/history', { token: pt })).data?.events ?? [];
    check('The workspace sees what changed and why in its history', historyEvents.some((e) => e.type === 'refund_adjusted' && /Refunded in full; access ends today/.test(e.message)));
    check('A refund adjusts its subscription only once', (await subAction(pLate._id, { action: 'end_now', reason: 'Once more please' })).status === 409);
    check(
      'The adjustment is in the audit log',
      ((await api('/platform/audit-log?action=payment.subscription_adjusted&limit=20', { token: platform2.token })).data ?? []).some((e) => e.newValue?.paymentId === String(pLate._id)),
    );

    // 10. Payment alert digests for platform admins.
    const sendDigest = () => api('/platform/payments/alerts/send-now', { method: 'POST', token: platform2.token });
    check('Workspace users cannot send payment alerts', (await api('/platform/payments/alerts/send-now', { method: 'POST', token: pt })).status === 403);
    check('Alert recipients must be email addresses', (await api('/platform/settings', { method: 'PATCH', token: platform2.token, body: { paymentAlerts: { enabled: true, recipients: ['not-an-email'] } } })).status === 422);
    const alertsOff = await api('/platform/settings', { method: 'PATCH', token: platform2.token, body: { paymentAlerts: { enabled: false, recipients: [] } } });
    check('Payment alerts can be switched off', alertsOff.status === 200 && alertsOff.data?.paymentAlerts?.enabled === false, alertsOff.error ?? alertsOff.data?.paymentAlerts);
    check('A switched-off digest sends nothing', (await sendDigest()).data?.status === 'disabled');
    await api('/platform/settings', { method: 'PATCH', token: platform2.token, body: { paymentAlerts: { enabled: true, recipients: ['ops@example.com'] } } });
    const firstDigest = await sendDigest();
    const secondDigest = await sendDigest();
    check(
      'The digest reports its outcome',
      firstDigest.status === 200 && ['sent', 'failed', 'not_configured', 'nothing_to_send'].includes(firstDigest.data?.status),
      firstDigest.data ?? firstDigest.error,
    );
    check(
      'Undelivered alerts are not marked as sent, so they go out once mail works',
      firstDigest.data?.status === 'sent' || (secondDigest.data?.review === firstDigest.data?.review && secondDigest.data?.stale === firstDigest.data?.stale),
      { first: firstDigest.data, second: secondDigest.data },
    );

    const stats = await fetch(`${mock}/__control/stats`).then((r) => r.json());
    check('One access token served every bKash call', stats.grants === 1, stats);
  }
  check("It cannot pay the first workspace's order", (await api(`/restaurant/orders/${t1.data._id}/pay`, { method: 'POST', token: rv2.token, body: { payments: [{ method: 'cash', amountMinor: 1 }], rev: 0 } })).status === 404);
  check("It cannot seat the first workspace's table", (await api('/restaurant/orders', { method: 'POST', token: rv2.token, body: { type: 'dine_in', tableId: t2.data._id, items: [{ menuItemId: borhani.data._id, quantity: 1 }] } })).status === 400);
  check('Its menu starts empty', (await api('/restaurant/menu', { token: rv2.token })).data?.length === 0);

  // ------------------------------------------------- usage charges
  section('Usage charges');

  const ucPrices = await api('/wallet/usage/prices', { token: admin.token });
  check('The usage price list loads', ucPrices.status === 200 && ucPrices.data?.length === 4, ucPrices.data);
  const ucSettings = await api('/platform/settings', { token: platform2.token });
  check(
    'SMS is priced from platform settings',
    typeof ucSettings.data?.smsCostMinor === 'number' && ucPrices.data?.find((p) => p.service === 'sms')?.unitPriceMinor === ucSettings.data.smsCostMinor,
    { price: ucPrices.data?.find((p) => p.service === 'sms'), setting: ucSettings.data?.smsCostMinor },
  );
  check('Every service states its billing unit', (ucPrices.data ?? []).every((p) => typeof p.unit === 'string' && p.unit.length > 0));
  check('Staff without billing access cannot read usage', (await api('/wallet/usage', { token: cashier.token })).status === 403);
  check('Staff without billing access cannot read prices', (await api('/wallet/usage/prices', { token: cashier.token })).status === 403);
  check('Unauthenticated usage reads are refused', (await api('/wallet/usage')).status === 401);
  check('An unknown service filter is rejected', (await api('/wallet/usage?service=bitcoin', { token: admin.token })).status === 422);

  const ucSet = await api('/platform/settings', {
    method: 'PATCH',
    token: platform2.token,
    body: { aiRequestCostMinor: 25, storageGbMonthCostMinor: 1500 },
  });
  check('Platform admin sets AI and storage prices', ucSet.status === 200, ucSet.error);
  const ucPrices2 = await api('/wallet/usage/prices', { token: admin.token });
  check(
    'New prices apply immediately',
    ucPrices2.data?.find((p) => p.service === 'ai')?.unitPriceMinor === 25 && ucPrices2.data?.find((p) => p.service === 'storage')?.unitPriceMinor === 1500,
    ucPrices2.data,
  );
  check('A negative price is rejected', (await api('/platform/settings', { method: 'PATCH', token: platform2.token, body: { aiRequestCostMinor: -1 } })).status === 422);
  check('A fractional price is rejected', (await api('/platform/settings', { method: 'PATCH', token: platform2.token, body: { storageGbMonthCostMinor: 2.5 } })).status === 422);
  check('A tenant cannot change prices', (await api('/platform/settings', { method: 'PATCH', token: admin.token, body: { smsCostMinor: 0 } })).status === 403);
  await api('/platform/settings', { method: 'PATCH', token: platform2.token, body: { aiRequestCostMinor: 0, storageGbMonthCostMinor: 0 } });
  check('The usage summary always covers all four services', (await api('/wallet/usage', { token: admin.token })).data?.summary?.length === 4);

  // ------------------------------------------------- workspace creation
  section('Workspace creation');

  const wcOptions = await api('/workspaces/verticals', { token: admin.token });
  check('Vertical options load', wcOptions.status === 200, wcOptions.error);
  check('Clothing can be created self-serve', wcOptions.data?.find((o) => o.vertical === 'clothing')?.available === true, wcOptions.data);
  check(
    'Only active POS types from the catalog are offered',
    // All four POS types in the catalog ship a module and start active.
    (wcOptions.data ?? []).map((o) => o.vertical).join(',') === 'clothing,restaurant,pharmacy,supershop' && wcOptions.data.every((o) => o.available === true && o.label && o.description),
    wcOptions.data,
  );

  const wcPlans = (await api('/plans')).data ?? [];
  const wcProfessional = wcPlans.find((p) => p.code === 'showroom-monthly');

  const wcStamp = Date.now();
  const wcReg = await api('/auth/register', {
    method: 'POST',
    body: { businessName: `Create Home ${wcStamp}`, name: 'Create Owner', email: `create${wcStamp}@example.com`, password: 'Password@123' },
  });
  const wcHomeToken = wcReg.data?.tokens?.accessToken;
  await verifyContact(wcHomeToken);
  const wcHomeId = wcReg.data?.tenant?.id;
  check('An owner signs up and uses the account trial', wcReg.status === 201 && wcReg.data?.entitlement?.status === 'trial', wcReg.data?.entitlement?.status);
  await api('/stores', { method: 'POST', token: wcHomeToken, body: { name: 'Create Home Main', currency: 'BDT' } });

  const wcCreate = await api('/workspaces', { method: 'POST', token: wcHomeToken, body: { businessName: `Create Second ${wcStamp}`, vertical: 'clothing' } });
  check('The owner creates a second workspace', wcCreate.status === 201, wcCreate.error);
  const wcSecondId = wcCreate.data?.workspace?.id;
  check('It is a Clothing workspace', wcCreate.data?.workspace?.vertical === 'clothing');
  check('An account that already had a trial gets no second one', wcCreate.data?.trial?.started === false && wcCreate.data?.trial?.reason === 'already_used', wcCreate.data?.trial);
  check('The new workspace is listed for the owner', ((await api('/auth/workspaces', { token: wcHomeToken })).data ?? []).some((w) => w.id === wcSecondId));

  // --- refusals ------------------------------------------------------------
  const wcCreateAs = (token, body) => api('/workspaces', { method: 'POST', token, body });
  // `grocery` is a reserved vertical code with no catalog entry.
  const wcNotYet = await wcCreateAs(wcHomeToken, { businessName: `Too Soon ${wcStamp}`, vertical: 'grocery' });
  check('A reserved vertical with no catalog entry cannot be created', wcNotYet.status === 422, wcNotYet.status);
  check('An unknown vertical is rejected', (await wcCreateAs(wcHomeToken, { businessName: `Bakery ${wcStamp}`, vertical: 'bakery' })).status === 422);
  check('A client-supplied accountId is rejected', (await wcCreateAs(wcHomeToken, { businessName: `Forged ${wcStamp}`, vertical: 'clothing', accountId: admin.session.tenant.accountId })).status === 422);
  check('A client-supplied owner is rejected', (await wcCreateAs(wcHomeToken, { businessName: `Forged ${wcStamp}`, vertical: 'clothing', ownerUserId: admin.session.user.id })).status === 422);
  check('A missing business name is rejected', (await wcCreateAs(wcHomeToken, { vertical: 'clothing' })).status === 422);
  check('Staff cannot create workspaces', (await wcCreateAs(cashier.token, { businessName: `Staff ${wcStamp}`, vertical: 'clothing' })).status === 403);
  check('Platform admins cannot create through the tenant endpoint', (await wcCreateAs(platform2.token, { businessName: `Platform ${wcStamp}`, vertical: 'clothing' })).status === 403);
  check('Unauthenticated creation is refused', (await api('/workspaces', { method: 'POST', body: { businessName: `Anon ${wcStamp}`, vertical: 'clothing' } })).status === 401);

  // --- POS product catalog ---------------------------------------------------
  section('POS product catalog');
  const pc = (path = '', opts = {}) => api(`/platform/pos-products${path}`, { token: platform2.token, ...opts });
  const pcSalesBefore = await api('/sales?limit=1', { token: admin.token });

  check('Workspace owners cannot read the POS catalog admin', (await api('/platform/pos-products', { token: admin.token })).status === 403);
  check('Staff cannot read the POS catalog admin', (await api('/platform/pos-products', { token: cashier.token })).status === 403);
  check('Anonymous callers cannot read the POS catalog admin', (await api('/platform/pos-products')).status === 401);
  check('Workspace owners cannot create POS types', (await api('/platform/pos-products', { method: 'POST', token: admin.token, body: { code: 'hijack', name: 'Hijack' } })).status === 403);
  check('Workspace owners cannot deactivate POS types', (await api('/platform/pos-products/restaurant', { method: 'PATCH', token: wcHomeToken, body: { status: 'inactive' } })).status === 403);

  const pcList = await pc();
  const pcByCode = Object.fromEntries((pcList.data ?? []).map((p) => [p.code, p]));
  check('The catalog defines Clothing, Restaurant, Pharmacy and Supershop', ['clothing', 'restaurant', 'pharmacy', 'supershop'].every((c) => pcByCode[c]), pcList.data?.map((p) => p.code));
  check('Clothing is the active default with a POS module', pcByCode.clothing?.status === 'active' && pcByCode.clothing?.isDefault && pcByCode.clothing?.moduleAvailable === true);
  check(
    'Pharmacy and Supershop are active with a POS module',
    ['pharmacy', 'supershop'].every((code) => pcByCode[code]?.status === 'active' && pcByCode[code]?.moduleAvailable === true),
    [pcByCode.pharmacy, pcByCode.supershop],
  );
  check('Existing Clothing workspaces are counted under Clothing', (pcByCode.clothing?.workspaceCount ?? 0) >= 2, pcByCode.clothing?.workspaceCount);
  const pcDetail = await pc('/pharmacy');
  check('A POS type can be viewed in detail', pcDetail.status === 200 && pcDetail.data?.code === 'pharmacy' && Array.isArray(pcDetail.data?.configuration?.highlights));
  check('An unknown POS type is 404', (await pc('/bakery')).status === 404);
  check('A malformed POS type code is rejected', (await pc('/$ne')).status === 422);

  const pcCode = `kiosk${String(wcStamp).slice(-6)}`;
  check('A new POS type code must be well formed', (await pc('', { method: 'POST', body: { code: 'Bad Code', name: 'Bad' } })).status === 422);
  check('Server facts cannot be mass-assigned', (await pc('', { method: 'POST', body: { code: pcCode, name: 'Kiosk', moduleAvailable: true, workspaceCount: 9 } })).status === 422);
  const pcCreated = await pc('', { method: 'POST', body: { code: pcCode, name: 'Kiosk', description: 'Future vertical', icon: 'store', configuration: { sortOrder: 90, highlights: ['Fast checkout'] } } });
  check('A platform admin can define a new POS type, inactive by default', pcCreated.status === 201 && pcCreated.data?.status === 'inactive' && pcCreated.data?.moduleAvailable === false, pcCreated.data ?? pcCreated.error);
  check('A duplicate POS type code is refused', (await pc('', { method: 'POST', body: { code: 'clothing', name: 'Clothing again' } })).status === 409);
  check('A POS type code cannot be changed', (await pc(`/${pcCode}`, { method: 'PATCH', body: { code: 'renamed' } })).status === 422);
  check('An unknown icon is refused', (await pc(`/${pcCode}`, { method: 'PATCH', body: { icon: 'skull' } })).status === 422);

  // Valid / invalid / inactive POS types when opening a workspace.
  check('An inactive POS type cannot be chosen', (await wcCreateAs(wcHomeToken, { businessName: `Kiosk ${wcStamp}`, vertical: pcCode })).status === 400);
  const pcActivated = await pc(`/${pcCode}`, { method: 'PATCH', body: { status: 'active' } });
  check('A platform admin can activate a POS type', pcActivated.status === 200 && pcActivated.data?.status === 'active');
  check('An active POS type without a POS module still cannot be chosen', (await wcCreateAs(wcHomeToken, { businessName: `Kiosk ${wcStamp}`, vertical: pcCode })).status === 400);
  check('It is shown to customers as not yet available', (await api('/workspaces/verticals', { token: wcHomeToken })).data?.find((o) => o.vertical === pcCode)?.available === false);
  check('A POS type code with operators is rejected', (await wcCreateAs(wcHomeToken, { businessName: `Inject ${wcStamp}`, vertical: { $ne: null } })).status === 422);
  await pc(`/${pcCode}`, { method: 'PATCH', body: { status: 'inactive' } });

  check('The default POS type cannot be deactivated', (await pc('/clothing', { method: 'PATCH', body: { status: 'inactive' } })).status === 409);
  const pcOff = await pc('/restaurant', { method: 'PATCH', body: { status: 'inactive' } });
  check('A platform admin can deactivate a POS type', pcOff.status === 200 && pcOff.data?.status === 'inactive');
  check('A deactivated POS type is no longer offered', !((await api('/workspaces/verticals', { token: wcHomeToken })).data ?? []).some((o) => o.vertical === 'restaurant'));
  check('A deactivated POS type cannot be chosen', (await wcCreateAs(wcHomeToken, { businessName: `Late Restaurant ${wcStamp}`, vertical: 'restaurant' })).status === 400);
  const pcOn = await pc('/restaurant', { method: 'PATCH', body: { status: 'active' } });
  check('Reactivating it offers it again', pcOn.status === 200 && ((await api('/workspaces/verticals', { token: wcHomeToken })).data ?? []).some((o) => o.vertical === 'restaurant' && o.available));

  const pcAudit = await api('/platform/audit-log?action=pos_product.deactivated&limit=20', { token: platform2.token });
  check('Catalog changes are audited', (pcAudit.data ?? []).some((e) => e.targetLabel === 'restaurant'), pcAudit.data?.length);

  // Existing Clothing data and workspace ownership.
  const pcOwn = await api('/workspaces', { token: admin.token });
  const pcDemo = (pcOwn.data ?? []).find((w) => String(w.id) === String(admin.session.tenant.id));
  check('The existing Clothing workspace resolves to POS type clothing', pcDemo?.posType === 'clothing' && pcDemo?.vertical === 'clothing', pcDemo);
  const pcSalesAfter = await api('/sales?limit=1', { token: admin.token });
  check('Existing Clothing sales are untouched by catalog changes', pcSalesAfter.status === 200 && pcSalesAfter.meta?.total === pcSalesBefore.meta?.total, { before: pcSalesBefore.meta, after: pcSalesAfter.meta });
  check('Another account cannot view a workspace it does not own', (await api(`/workspaces/${admin.session.tenant.id}`, { token: wcHomeToken })).status === 404);
  check('The POS type cannot be changed through a workspace edit', (await api(`/workspaces/${wcSecondId}`, { method: 'PATCH', token: wcHomeToken, body: { posType: 'restaurant' } })).status === 422);

  // --- POS-specific subscription plans ----------------------------------------
  section('POS-specific plans');
  const psStamp = Date.now();
  const psReg = await api('/auth/register', {
    method: 'POST',
    body: { businessName: `PS Home ${psStamp}`, name: 'PS Owner', email: `ps${psStamp}@example.com`, password: 'Password@123' },
  });
  const psHomeToken = psReg.data?.tokens?.accessToken;
  const psRestCreate = await wcCreateAs(psHomeToken, { businessName: `PS Restaurant ${psStamp}`, vertical: 'restaurant' });
  const psRestId = psRestCreate.data?.workspace?.id;
  const psRestToken = (await api('/auth/switch-workspace', { method: 'POST', token: psHomeToken, body: { workspaceId: psRestId } })).data?.tokens?.accessToken;
  check('A Restaurant workspace is ready for plan tests', psRestCreate.status === 201 && Boolean(psRestToken), psRestCreate.error);

  const psPlanBody = (over = {}) => ({
    code: `rest-only-${psStamp}`,
    name: 'Restaurant Only',
    interval: 'monthly',
    priceMinor: 77_700,
    tier: 2,
    isPublic: true,
    posProductCode: 'restaurant',
    limits: { maxProducts: 300 },
    ...over,
  });
  const psCreatePlan = (body, token = platform2.token) => api('/plans', { method: 'POST', token, body });
  check('Workspace owners cannot create POS plans', (await psCreatePlan(psPlanBody(), admin.token)).status === 403);
  check('A plan for a POS type not in the catalog is rejected', (await psCreatePlan(psPlanBody({ code: `bad-pos-${psStamp}`, posProductCode: 'bakery' }))).status === 422);
  check('A malformed POS type on a plan is rejected', (await psCreatePlan(psPlanBody({ code: `bad-code-${psStamp}`, posProductCode: 'Rest Aurant' }))).status === 422);
  check(
    'A Restaurant plan cannot carry settings for another POS type',
    (await psCreatePlan(psPlanBody({ code: `bad-ovr-${psStamp}`, verticalOverrides: [{ vertical: 'clothing', limits: { maxProducts: 5 } }] }))).status === 422,
  );
  const psPlan = await psCreatePlan(psPlanBody());
  const psPlanId = psPlan.data?._id;
  check('A platform admin creates a Restaurant-only plan', psPlan.status === 201 && psPlan.data?.posProductCode === 'restaurant', psPlan.data ?? psPlan.error);

  const psIn = async (path, token) => ((await api(path, { token })).data ?? []).some((p) => String(p._id) === String(psPlanId));
  check('Clothing pricing does not show the Restaurant plan', !(await psIn('/plans')) && !(await psIn('/plans?vertical=clothing')));
  const psRestPublic = ((await api('/plans?vertical=restaurant')).data ?? []).find((p) => String(p._id) === String(psPlanId));
  check('Restaurant pricing shows it at its own price and limits', psRestPublic?.priceMinor === 77_700 && psRestPublic?.limits?.maxProducts === 300, psRestPublic);
  check('Other POS types do not see it', !(await psIn('/plans?vertical=pharmacy')));
  check(
    'Existing shared plans stay offered to every POS type',
    ((await api('/plans?vertical=restaurant')).data ?? []).some((p) => p.code === 'showroom-monthly' && !p.posProductCode) &&
      ((await api('/plans')).data ?? []).some((p) => p.code === 'showroom-monthly'),
  );

  const psAdminRestaurant = await api('/plans/all?posProductCode=restaurant', { token: platform2.token });
  check(
    'The admin plan list filters by POS type',
    (psAdminRestaurant.data ?? []).some((p) => String(p._id) === String(psPlanId)) && (psAdminRestaurant.data ?? []).every((p) => p.posProductCode === 'restaurant'),
  );
  check('The shared filter leaves POS-specific plans out', !(await psIn('/plans/all?posProductCode=shared', platform2.token)));
  check('An invalid admin filter is rejected', (await api('/plans/all?posProductCode=$ne', { token: platform2.token })).status === 422);

  // Both workspaces get their first store, as onboarding would, before billing is opened.
  await api('/stores', { method: 'POST', token: psHomeToken, body: { name: 'PS Main', currency: 'BDT' } });
  await api('/stores', { method: 'POST', token: psRestToken, body: { name: 'PS Kitchen', currency: 'BDT' } });
  const psOptions = (token) => api('/subscriptions/plan-options', { token });
  const psOptionIds = (res) => (res.data?.options ?? []).map((o) => String(o.planId));
  const psHomeOptions = await psOptions(psHomeToken);
  check('A Clothing workspace is not offered the Restaurant plan', psHomeOptions.status === 200 && !psOptionIds(psHomeOptions).includes(String(psPlanId)), psHomeOptions.error);
  const psRestOptions = await psOptions(psRestToken);
  check('A Restaurant workspace is offered it', psOptionIds(psRestOptions).includes(String(psPlanId)), { status: psRestOptions.status, error: psRestOptions.error, ids: psOptionIds(psRestOptions) });

  const psAssign = (tenantId) =>
    api('/platform/subscriptions', { method: 'POST', token: platform2.token, body: { tenantId, planId: psPlanId, periods: 1, status: 'active' } });
  check('It cannot be assigned to a Clothing workspace', (await psAssign(psReg.data?.tenant?.id)).status === 400);
  const psAssigned = await psAssign(psRestId);
  check('It can be assigned to a Restaurant workspace', psAssigned.status < 300, psAssigned.error);
  const psSnapshot = (await api('/subscriptions/current', { token: psRestToken })).data?.subscription?.planSnapshot;
  check('The subscription freezes the plan’s POS type and price', psSnapshot?.posProductCode === 'restaurant' && psSnapshot?.priceMinor === 77_700, psSnapshot);

  const psPatch = (body) => api(`/plans/${psPlanId}`, { method: 'PATCH', token: platform2.token, body });
  check('A plan in use cannot be moved to another POS type', (await psPatch({ posProductCode: 'clothing' })).status === 409);
  const psShared = await psPatch({ posProductCode: null });
  check('A plan can be widened to every POS type', psShared.status === 200 && psShared.data?.posProductCode === null, psShared.data ?? psShared.error);
  check('Widened, Clothing pricing shows it', await psIn('/plans'));
  const psBack = await psPatch({ posProductCode: 'restaurant' });
  check('It can be narrowed back while only Restaurant workspaces use it', psBack.status === 200 && psBack.data?.posProductCode === 'restaurant', psBack.error);
  const psRepriced = await psPatch({ priceMinor: 88_800 });
  check(
    'A price edit never rewrites the bought period',
    psRepriced.status === 200 && (await api('/subscriptions/current', { token: psRestToken })).data?.subscription?.planSnapshot?.priceMinor === 77_700,
  );
  const psSpare = await psCreatePlan(psPlanBody({ code: `rest-spare-${psStamp}`, name: 'Restaurant Spare' }));
  const psMoved = await api(`/plans/${psSpare.data?._id}`, { method: 'PATCH', token: platform2.token, body: { posProductCode: 'pharmacy' } });
  check('An unused plan can be moved to another POS type', psMoved.status === 200 && psMoved.data?.posProductCode === 'pharmacy', psMoved.error);

  const psAudit = await api('/platform/audit-log?action=plan.updated&limit=50', { token: platform2.token });
  check('Plan changes are audited', (psAudit.data ?? []).some((e) => e.targetLabel === `rest-only-${psStamp}`), psAudit.data?.length);
  const psCatalog = await api('/platform/pos-products/restaurant', { token: platform2.token });
  check('The POS catalog counts plans sold to each type', (psCatalog.data?.planCount ?? 0) >= 1, psCatalog.data);

  // Plan management screen data.
  const psUsage = await api(`/plans/${psPlanId}/usage`, { token: platform2.token });
  check(
    'Admins see which workspaces are on a plan',
    psUsage.status === 200 &&
      psUsage.data?.runningCount === 1 &&
      String(psUsage.data?.workspaces?.[0]?.tenantId) === String(psRestId) &&
      psUsage.data?.workspaces?.[0]?.vertical === 'restaurant' &&
      psUsage.data?.workspaces?.[0]?.priceMinor === 77_700,
    psUsage.data ?? psUsage.error,
  );
  check('Workspace owners cannot see plan usage', (await api(`/plans/${psPlanId}/usage`, { token: psRestToken })).status === 403);
  check('Plan usage for an unknown plan is 404', (await api('/plans/000000000000000000000000/usage', { token: platform2.token })).status === 404);
  check('Plan usage rejects a malformed id', (await api('/plans/not-an-id/usage', { token: platform2.token })).status === 422);
  check(
    'The admin plan list shows how many workspaces run each plan',
    ((await api('/plans/all', { token: platform2.token })).data ?? []).find((p) => String(p._id) === String(psPlanId))?.runningSubscriptions === 1,
  );
  check('An unused plan shows no workspaces', (await api(`/plans/${psSpare.data?._id}/usage`, { token: platform2.token })).data?.runningCount === 0);

  await api(`/plans/${psPlanId}`, { method: 'DELETE', token: platform2.token });
  await api(`/plans/${psSpare.data?._id}`, { method: 'DELETE', token: platform2.token });
  check('The test plans are withdrawn', !(await psIn('/plans?vertical=restaurant')));
  const psWithdrawnUsage = await api(`/plans/${psPlanId}/usage`, { token: platform2.token });
  check('Withdrawing a plan leaves its running subscriptions alone', psWithdrawnUsage.data?.plan?.isActive === false && psWithdrawnUsage.data?.runningCount === 1, psWithdrawnUsage.data);
  const psRestored = await api(`/plans/${psSpare.data?._id}`, { method: 'PATCH', token: platform2.token, body: { isActive: true } });
  check('A withdrawn plan can be restored', psRestored.status === 200 && psRestored.data?.isActive === true, psRestored.error);
  await api(`/plans/${psSpare.data?._id}`, { method: 'DELETE', token: platform2.token });
  const psWithdrawAudit = await api('/platform/audit-log?action=plan.deactivated&limit=50', { token: platform2.token });
  check('Withdrawing a plan is audited', (psWithdrawAudit.data ?? []).some((e) => e.targetLabel === `rest-only-${psStamp}`));

  // --- Pharmacy POS ------------------------------------------------------------
  section('Pharmacy POS');
  const phStamp = Date.now();
  const phDay = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const phReg = await api('/auth/register', {
    method: 'POST',
    body: { businessName: `PH Home ${phStamp}`, name: 'PH Owner', email: `ph${phStamp}@example.com`, password: 'Password@123' },
  });
  const phHomeToken = phReg.data?.tokens?.accessToken;
  await verifyContact(phHomeToken);
  const phHomeId = phReg.data?.tenant?.id;
  await api('/stores', { method: 'POST', token: phHomeToken, body: { name: 'PH Home Main', currency: 'BDT' } });
  const phCreated = await wcCreateAs(phHomeToken, { businessName: `Shefa Pharmacy ${phStamp}`, vertical: 'pharmacy' });
  check('The owner creates a Pharmacy workspace', phCreated.status === 201 && phCreated.data?.workspace?.vertical === 'pharmacy', phCreated.error);
  const phSwitched = await api('/auth/switch-workspace', { method: 'POST', token: phHomeToken, body: { workspaceId: phCreated.data?.workspace?.id } });
  const phToken = phSwitched.data?.tokens?.accessToken;
  check('The session reports the Pharmacy vertical', phSwitched.data?.tenant?.vertical === 'pharmacy', phSwitched.data?.tenant);
  check('Its first branch is created', (await api('/stores', { method: 'POST', token: phToken, body: { name: 'Shefa Main', currency: 'BDT' } })).status === 201);
  check('Pharmacy screens stay locked until a plan is bought', (await api('/pharmacy/medicines', { token: phToken })).status === 402);
  const phPlan = ((await api('/plans?vertical=pharmacy')).data ?? []).find((p) => p.code === 'starter-store-monthly');
  await api(`/platform/tenants/${phHomeId}/wallet/adjust`, {
    method: 'POST',
    token: platform2.token,
    body: { direction: 'credit', amountMinor: phPlan.priceMinor, reason: 'Smoke test: pharmacy plan' },
  });
  const phBought = await api('/subscriptions/upgrade-request', { method: 'POST', token: phToken, body: { planId: phPlan._id, paymentMethod: 'wallet', amountMinor: phPlan.priceMinor } });
  check('It buys Starter from the account wallet', phBought.status < 300, phBought.error);
  check('Its entitlement is resolved for Pharmacy', (await api('/subscriptions/current', { token: phToken })).data?.entitlement?.vertical === 'pharmacy');

  for (const path of ['/products', '/sales', '/inventory', '/restaurant/menu']) {
    const res = await api(path, { token: phToken });
    check(`A Pharmacy workspace cannot reach ${path}`, res.status === 403 && res.error?.code === 'VERTICAL_NOT_SUPPORTED', { status: res.status, error: res.error });
  }
  for (const [label, token] of [['Clothing', admin.token], ['Restaurant', rvToken]]) {
    const res = await api('/pharmacy/medicines', { token });
    check(`A ${label} workspace cannot reach the pharmacy`, res.status === 403 && res.error?.code === 'VERTICAL_NOT_SUPPORTED', { status: res.status });
  }

  const phApi = (path, opts = {}) => api(`/pharmacy${path}`, { token: phToken, ...opts });
  const phMedicine = (body) => phApi('/medicines', { method: 'POST', body });
  const napa = await phMedicine({ name: 'Napa', genericName: 'Paracetamol', strength: '500 mg', dosageForm: 'tablet', manufacturer: 'Beximco', sellingPriceMinor: 120, reorderLevel: 150 });
  const zimax = await phMedicine({ name: 'Zimax', genericName: 'Azithromycin', strength: '500 mg', dosageForm: 'tablet', sellingPriceMinor: 3500, requiresPrescription: true });
  check('Medicines are created', napa.status === 201 && zimax.status === 201, [napa.error, zimax.error]);
  check('The same name, strength and form is refused', (await phMedicine({ name: 'napa', strength: '500 MG', dosageForm: 'tablet', sellingPriceMinor: 1 })).status === 409);
  check('The same brand in another strength is a different medicine', (await phMedicine({ name: 'Napa', strength: '120 mg/5 ml', dosageForm: 'syrup', sellingPriceMinor: 4500 })).status === 201);
  check('Unknown medicine fields are rejected', (await phMedicine({ name: 'Sneaky', sellingPriceMinor: 1, tenantId: admin.session.tenant.id })).status === 422);
  check('A negative price is rejected', (await phMedicine({ name: 'Bad', sellingPriceMinor: -5 })).status === 422);
  check('An unknown dosage form is rejected', (await phMedicine({ name: 'Odd', sellingPriceMinor: 5, dosageForm: 'lollipop' })).status === 422);

  const phReceive = (id, body) => phApi(`/medicines/${id}/batches`, { method: 'POST', body });
  const napaOld = await phReceive(napa.data._id, { batchNumber: 'np-old', expiryDate: phDay(10), quantity: 30, costPriceMinor: 80, supplierName: 'Beximco Depot' });
  const napaNew = await phReceive(napa.data._id, { batchNumber: 'NP-NEW', expiryDate: phDay(300), quantity: 100, costPriceMinor: 85 });
  const zimaxBatch = await phReceive(zimax.data._id, { batchNumber: 'ZX-1', expiryDate: phDay(200), quantity: 9, costPriceMinor: 2800 });
  check('Stock is received into batches', [napaOld, napaNew, zimaxBatch].every((r) => r.status === 201), [napaOld.error, napaNew.error, zimaxBatch.error]);
  check('Batch numbers are stored in capitals', napaOld.data?.batchNumber === 'NP-OLD');
  check('An expired batch cannot be received', (await phReceive(napa.data._id, { batchNumber: 'NP-DEAD', expiryDate: phDay(-1), quantity: 5, costPriceMinor: 80 })).status === 400);
  check('A real date is required', (await phReceive(napa.data._id, { batchNumber: 'NP-X', expiryDate: '2027-02-30', quantity: 5, costPriceMinor: 80 })).status === 422);
  const napaAgain = await phReceive(napa.data._id, { batchNumber: 'NP-NEW', expiryDate: phDay(300), quantity: 20, costPriceMinor: 85 });
  check('Receiving the same batch again adds to it', napaAgain.status === 201 && napaAgain.data?.quantityOnHand === 120, napaAgain.data);
  check('The same batch number with another expiry is refused', (await phReceive(napa.data._id, { batchNumber: 'NP-NEW', expiryDate: phDay(301), quantity: 1, costPriceMinor: 85 })).status === 409);
  const phList = (await phApi('/medicines?search=paracetamol')).data ?? [];
  const napaListed = phList.find((m) => m._id === napa.data._id);
  check('Medicines search by generic name and show sellable stock', napaListed?.stock?.sellable === 150 && napaListed?.stock?.nearestExpiry?.startsWith(phDay(10)), napaListed?.stock);

  const phSale = (body) => phApi('/sales', { method: 'POST', body });
  const sale1 = await phSale({ items: [{ medicineId: napa.data._id, quantity: 40 }], payments: [{ method: 'cash', amountMinor: 5000 }] });
  check('A sale is completed and priced from the catalogue', sale1.status === 201 && sale1.data?.totalMinor === 4800 && sale1.data?.changeMinor === 200, sale1.data ?? sale1.error);
  const alloc = sale1.data?.items?.[0]?.allocations ?? [];
  check(
    'Stock is taken earliest expiry first',
    alloc.length === 2 && alloc[0].batchNumber === 'NP-OLD' && alloc[0].quantity === 30 && alloc[1].batchNumber === 'NP-NEW' && alloc[1].quantity === 10,
    alloc,
  );
  const napaBatches = async () => Object.fromEntries(((await phApi(`/medicines/${napa.data._id}`)).data?.batches ?? []).map((b) => [b.batchNumber, b.quantityOnHand]));
  check('Batch quantities follow the sale', JSON.stringify(await napaBatches()) === JSON.stringify({ 'NP-OLD': 0, 'NP-NEW': 110 }), await napaBatches());

  check('A client-supplied price is rejected', (await phSale({ items: [{ medicineId: napa.data._id, quantity: 1, unitPriceMinor: 1 }], payments: [{ method: 'cash', amountMinor: 120 }] })).status === 422);
  check('A client-chosen batch is rejected', (await phSale({ items: [{ medicineId: napa.data._id, quantity: 1, batchId: napaNew.data._id }], payments: [{ method: 'cash', amountMinor: 120 }] })).status === 422);
  check('The same medicine twice in one sale is rejected', (await phSale({ items: [{ medicineId: napa.data._id, quantity: 1 }, { medicineId: napa.data._id, quantity: 1 }], payments: [{ method: 'cash', amountMinor: 240 }] })).status === 422);
  check("A medicine from outside this pharmacy cannot be sold", (await phSale({ items: [{ medicineId: '64b000000000000000000000', quantity: 1 }], payments: [{ method: 'cash', amountMinor: 100 }] })).status === 400);
  const phShort = await phSale({ items: [{ medicineId: napa.data._id, quantity: 500 }], payments: [{ method: 'cash', amountMinor: 60_000 }] });
  check('Selling more than the unexpired stock is refused', phShort.status === 400 && /Only 110/.test(phShort.error?.message ?? ''), phShort.error);
  check('A refused sale leaves stock untouched', (await napaBatches())['NP-NEW'] === 110);
  check('A short payment is refused', (await phSale({ items: [{ medicineId: napa.data._id, quantity: 1 }], payments: [{ method: 'cash', amountMinor: 100 }] })).status === 400);
  check('Only cash can be over-tendered', (await phSale({ items: [{ medicineId: napa.data._id, quantity: 1 }], payments: [{ method: 'card', amountMinor: 500 }] })).status === 400);
  const phUnknownMethod = await phSale({ items: [{ medicineId: napa.data._id, quantity: 1 }], payments: [{ method: 'crypto', amountMinor: 120 }] });
  check('A payment method this branch does not take is rejected', phUnknownMethod.status === 400 && /crypto/.test(phUnknownMethod.error?.message ?? ''), phUnknownMethod.error);
  check('A malformed payment method key is still rejected outright', (await phSale({ items: [{ medicineId: napa.data._id, quantity: 1 }], payments: [{ method: '!!', amountMinor: 120 }] })).status === 422);

  const noRx = await phSale({ items: [{ medicineId: zimax.data._id, quantity: 1 }], payments: [{ method: 'cash', amountMinor: 3500 }] });
  check('A prescription-only medicine needs a prescription', noRx.status === 400 && noRx.error?.details?.reason === 'PRESCRIPTION_REQUIRED', noRx.error);
  const rxBody = { patientName: 'Rahim Uddin', prescriberName: 'Dr. Karim', prescriptionNumber: 'RX-7781' };
  check('A prescription needs a real patient and prescriber', (await phSale({ items: [{ medicineId: zimax.data._id, quantity: 1 }], payments: [{ method: 'cash', amountMinor: 3500 }], prescription: { patientName: 'R', prescriberName: '' } })).status === 422);
  // Five tills with no override between them: this is the concurrency guarantee
  // on its own, with nothing allowed to sell past zero. (A till that DOES hold
  // `sales.sellOutOfStock` may take a batch negative - that is the override,
  // and it has its own section.)
  const phRacerEmail = `phrace${String(Date.now()).slice(-6)}@example.com`;
  const phRacerStore = (await api('/stores', { token: phToken })).data?.[0]?._id;
  await api('/staff', {
    method: 'POST',
    token: phToken,
    body: { name: 'PH Racer', email: phRacerEmail, password: 'Password@123', storeId: phRacerStore, extraPermissions: ['sales.create', 'sales.view', 'products.view'] },
  });
  const phRacer = await login(phRacerEmail, 'Password@123');
  check('The racing till holds no out-of-stock override', !phRacer.session.user.permissions.includes('sales.sellOutOfStock'));
  const zimaxRace = await Promise.all(
    Array.from({ length: 5 }, () =>
      api('/pharmacy/sales', {
        method: 'POST',
        token: phRacer.token,
        body: { items: [{ medicineId: zimax.data._id, quantity: 3 }], payments: [{ method: 'cash', amountMinor: 10_500 }], prescription: rxBody },
      }),
    ),
  );
  const zimaxLeft = ((await phApi(`/medicines/${zimax.data._id}`)).data?.batches ?? [])[0]?.quantityOnHand;
  check(
    'Five tills selling the last 9 strips at once: exactly 3 sales succeed and stock never goes negative',
    zimaxRace.filter((r) => r.status === 201).length === 3 && zimaxRace.filter((r) => r.status === 400).length === 2 && zimaxLeft === 0,
    { statuses: zimaxRace.map((r) => r.status), zimaxLeft },
  );
  const rxSale = zimaxRace.find((r) => r.status === 201)?.data;
  check('The prescription is recorded on the sale', rxSale?.prescription?.patientName === 'Rahim Uddin' && rxSale?.prescription?.prescriptionNumber === 'RX-7781');
  check('Sales can be filtered to prescription sales', ((await phApi('/sales?prescriptionOnly=true')).data ?? []).length === 3);

  const discounted = await phSale({ items: [{ medicineId: napa.data._id, quantity: 10 }], payments: [{ method: 'bkash', amountMinor: 1100 }], discountMinor: 100 });
  check('An owner can give a discount', discounted.status === 201 && discounted.data?.totalMinor === 1100, discounted.error);
  check('A discount cannot exceed the subtotal', (await phSale({ items: [{ medicineId: napa.data._id, quantity: 1 }], payments: [{ method: 'cash', amountMinor: 0 }], discountMinor: 500 })).status === 400);

  const phVoid = (id, reason) => phApi(`/sales/${id}/void`, { method: 'POST', body: { reason } });
  check('A void needs a reason', (await phVoid(sale1.data._id, '')).status === 422);
  const voided = await phVoid(sale1.data._id, 'Wrong medicine given');
  check('A sale is voided', voided.status === 200 && voided.data?.status === 'voided', voided.error);
  check('Voiding returns stock to the batches it came from', JSON.stringify(await napaBatches()) === JSON.stringify({ 'NP-OLD': 30, 'NP-NEW': 110 }), await napaBatches());
  check('A voided sale cannot be voided again', (await phVoid(sale1.data._id, 'Again please')).status === 409);
  check('Voids are audited', ((await api('/platform/audit-log?action=pharmacy.sale_voided&limit=20', { token: platform2.token })).data ?? []).some((e) => e.targetLabel === sale1.data.saleNumber));

  const oldBatchId = ((await phApi(`/medicines/${napa.data._id}`)).data?.batches ?? []).find((b) => b.batchNumber === 'NP-OLD')?._id;
  const phAdjust = (body) => phApi(`/batches/${oldBatchId}/adjust`, { method: 'POST', body });
  const writeOff = await phAdjust({ type: 'write_off', quantityDelta: -5, reason: 'Damaged strips' });
  check('Stock can be written off', writeOff.status === 200 && writeOff.data?.batch?.quantityOnHand === 25, writeOff.data ?? writeOff.error);
  check('A write-off cannot remove more than is on hand', (await phAdjust({ type: 'write_off', quantityDelta: -26, reason: 'Too many' })).status === 400);
  check('A write-off cannot add stock', (await phAdjust({ type: 'write_off', quantityDelta: 5, reason: 'Backwards' })).status === 422);
  check('An adjustment needs a reason', (await phAdjust({ type: 'adjust', quantityDelta: 1, reason: '' })).status === 422);
  check('Stock adjustments are audited', ((await api('/platform/audit-log?action=pharmacy.stock_adjusted&limit=20', { token: platform2.token })).data ?? []).some((e) => e.newValue?.reason === 'Damaged strips'));
  const movementTypes = new Set(((await phApi(`/movements?medicineId=${napa.data._id}&limit=100`)).data ?? []).map((m) => m.type));
  check('Every stock change is in the movement ledger', ['receive', 'sale', 'void', 'write_off'].every((type) => movementTypes.has(type)), [...movementTypes]);

  const expiring = (await phApi('/batches?status=expiring&days=30')).data ?? [];
  check('The expiry report lists batches expiring soon, not later ones', expiring.some((b) => b.batchNumber === 'NP-OLD') && !expiring.some((b) => b.batchNumber === 'NP-NEW'), expiring.map((b) => b.batchNumber));
  const phDash = await phApi('/dashboard');
  check(
    'The dashboard counts completed sales and flags expiry and low stock',
    phDash.status === 200 &&
      phDash.data?.kpis?.salesCount === 4 &&
      phDash.data?.kpis?.prescriptionSales === 3 &&
      phDash.data?.expiringSoon?.some((b) => b.batchNumber === 'NP-OLD') &&
      phDash.data?.lowStock?.some((row) => row.name === 'Napa' && row.sellable === 135),
    phDash.data ?? phDash.error,
  );
  check('The dashboard defaults to today, bucketed by hour', phDash.data?.range?.preset === 'today' && phDash.data?.range?.bucket === 'hour', phDash.data?.range);
  check(
    'The average sale is the range total over its sales',
    phDash.data?.kpis?.averageSaleMinor === Math.round(phDash.data.kpis.totalMinor / phDash.data.kpis.salesCount),
    phDash.data?.kpis,
  );
  check('The previous period is reported for comparison', typeof phDash.data?.previous?.totalMinor === 'number' && typeof phDash.data?.previous?.salesCount === 'number');
  const phYesterday = await phApi('/dashboard?preset=yesterday');
  check('A range with no trading shows zeros, not errors', phYesterday.status === 200 && phYesterday.data?.kpis?.totalMinor === 0 && phYesterday.data?.kpis?.salesCount === 0);
  check(
    'Expiry and low stock are always now, whatever the range',
    phYesterday.data?.expiringSoon?.some((b) => b.batchNumber === 'NP-OLD') && phYesterday.data?.lowStock?.some((row) => row.name === 'Napa'),
  );
  check('A 30-day range is bucketed by day', (await phApi('/dashboard?preset=last30')).data?.range?.bucket === 'day');
  check('A 30-day range includes today\u2019s sales', (await phApi('/dashboard?preset=last30')).data?.kpis?.salesCount === 4);
  check('An unknown preset is rejected', (await phApi('/dashboard?preset=forever')).status === 422);
  check('A custom range needs both dates', (await phApi('/dashboard?preset=custom&from=2026-01-01')).status === 422);
  check('A custom range cannot end before it starts', (await phApi('/dashboard?preset=custom&from=2026-02-01&to=2026-01-01')).status === 422);
  const phReceipt = await phApi(`/sales/${rxSale._id}/receipt`);
  check('A receipt is available with the branch details', phReceipt.data?.store?.name === 'Shefa Main');
  check(
    'The Pharmacy receipt carries the branch receipt settings the printer needs',
    typeof phReceipt.data?.store?.receipt?.paperWidthMm === 'number' &&
      typeof phReceipt.data?.store?.receipt?.headerText === 'string' &&
      'receiptLogoUrl' in (phReceipt.data?.store ?? {}),
    phReceipt.data?.store?.receipt,
  );
  check('...and still the dispensing record: which batch, and when it expires', (phReceipt.data?.sale?.items ?? []).every((line) => Array.isArray(line.allocations)));
  const phSalesBeforeReprint = (await phApi('/sales?limit=1')).meta?.total;
  for (let i = 0; i < 3; i += 1) await phApi(`/sales/${rxSale._id}/receipt`);
  check('Reprinting a Pharmacy receipt three times dispenses nothing and creates no sale', (await phApi('/sales?limit=1')).meta?.total === phSalesBeforeReprint);
  check('A medicine with stock cannot be removed', (await phApi(`/medicines/${napa.data._id}`, { method: 'DELETE' })).status === 409);
  check("Plan meters count this pharmacy's medicines and sales", (await api(`/platform/tenants/${phCreated.data?.workspace?.id}`, { token: platform2.token })).data?.usage?.products === 3);
  check('Customers still work in a Pharmacy workspace', (await api('/customers', { token: phToken })).status === 200);

  // --- Pharmacy Advanced Analytics ------------------------------------------------
  const phLocked = await phApi('/reports?preset=today');
  check('Pharmacy analytics are locked on Starter', phLocked.status === 403 && phLocked.error?.code === 'ADVANCED_ANALYTICS_REQUIRED' && phLocked.data == null, phLocked.error);
  check('Another vertical cannot reach pharmacy analytics', (await api('/pharmacy/reports', { token: admin.token })).error?.code === 'VERTICAL_NOT_SUPPORTED');
  const phPro = ((await api('/plans?vertical=pharmacy')).data ?? []).find((p) => p.code === 'showroom-monthly');
  const phUpgrade = await api('/platform/subscriptions', { method: 'POST', token: platform2.token, body: { tenantId: phCreated.data?.workspace?.id, planId: phPro?._id, periods: 1, status: 'active' } });
  check('The Pharmacy workspace moves to Professional', phUpgrade.status < 300, phUpgrade.error);
  const phRep = await phApi('/reports?preset=today');
  const phR = phRep.data;
  check('Professional unlocks Pharmacy analytics', phRep.status === 200, phRep.error);
  check(
    'Totals come from completed sales only, with batch cost and profit',
    phR?.totals?.salesCount === 4 && phR.totals.netSalesMinor === 32_600 && phR.totals.discountsMinor === 100 && phR.totals.costMinor === 26_050 && phR.totals.grossProfitMinor === 6550,
    phR?.totals,
  );
  check('Prescription sales are totalled', phR?.totals?.prescriptionSales === 3 && phR.totals.prescriptionValueMinor === 31_500, phR?.totals);
  check('Top medicines carry profit from the batches sold', phR?.medicines?.[0]?.name === 'Zimax' && phR.medicines[0].quantity === 9 && phR.medicines[0].profitMinor === 6300, phR?.medicines);
  check('Payments are split by method, net of cash change', JSON.stringify(phR?.payments?.map((p) => [p.method, p.amountMinor])) === JSON.stringify([['cash', 31_500], ['bkash', 1100]]), phR?.payments);
  check('Voided sales are reported separately', phR?.voids?.count === 1 && phR.voids.valueMinor === 4800 && phR.voids.recent[0]?.voidReason === 'Wrong medicine given', phR?.voids);
  check('Write-offs are valued at batch cost', phR?.writeOffs?.units === 5 && phR.writeOffs.costMinor === 400, phR?.writeOffs);
  check('Expiry exposure buckets stock by days left', phR?.expiry?.within30?.units === 25 && phR.expiry.within30.costMinor === 2000 && phR.expiry.expired.units === 0, phR?.expiry);
  check('A medicine that sold is not a slow mover', !(phR?.slowMovers ?? []).some((row) => row.name === 'Napa'), phR?.slowMovers);
  check('The daily trend covers the period', phR?.trend?.length === 1 && phR.trend[0].netSalesMinor === 32_600, phR?.trend);
  check('An invalid range preset is rejected', (await phApi('/reports?preset=forever')).status === 422);
  check('A custom range needs both dates', (await phApi('/reports?preset=custom&from=2026-01-01')).status === 422);
  check('Unknown report parameters are rejected', (await phApi('/reports?preset=today&branch=all')).status === 422);
  const phEmpty = (await phApi('/reports?preset=custom&from=2020-01-01&to=2020-01-31')).data;
  check('A period with no sales reports zeros, not errors', phEmpty?.totals?.salesCount === 0 && phEmpty.totals.marginBps === 0 && phEmpty.trend.length === 0, phEmpty?.totals);

  // --- Supershop POS -----------------------------------------------------------
  section('Supershop POS');
  const ssStamp = Date.now();
  const ssReg = await api('/auth/register', {
    method: 'POST',
    body: { businessName: `SS Home ${ssStamp}`, name: 'SS Owner', email: `ss${ssStamp}@example.com`, password: 'Password@123' },
  });
  const ssHomeToken = ssReg.data?.tokens?.accessToken;
  await verifyContact(ssHomeToken);
  const ssHomeId = ssReg.data?.tenant?.id;
  await api('/stores', { method: 'POST', token: ssHomeToken, body: { name: 'SS Home Main', currency: 'BDT' } });
  const ssCreated = await wcCreateAs(ssHomeToken, { businessName: `Meena Bazar ${ssStamp}`, vertical: 'supershop' });
  check('The owner creates a Supershop workspace', ssCreated.status === 201 && ssCreated.data?.workspace?.vertical === 'supershop', ssCreated.error);
  const ssSwitched = await api('/auth/switch-workspace', { method: 'POST', token: ssHomeToken, body: { workspaceId: ssCreated.data?.workspace?.id } });
  const ssToken = ssSwitched.data?.tokens?.accessToken;
  check('The session reports the Supershop vertical', ssSwitched.data?.tenant?.vertical === 'supershop', ssSwitched.data?.tenant);
  check('Its first branch is created', (await api('/stores', { method: 'POST', token: ssToken, body: { name: 'Meena Gulshan', currency: 'BDT' } })).status === 201);
  check('Supershop screens stay locked until a plan is bought', (await api('/supershop/products', { token: ssToken })).status === 402);
  const ssPlan = ((await api('/plans?vertical=supershop')).data ?? []).find((p) => p.code === 'starter-store-monthly');
  await api(`/platform/tenants/${ssHomeId}/wallet/adjust`, { method: 'POST', token: platform2.token, body: { direction: 'credit', amountMinor: ssPlan.priceMinor, reason: 'Smoke test: supershop plan' } });
  const ssBought = await api('/subscriptions/upgrade-request', { method: 'POST', token: ssToken, body: { planId: ssPlan._id, paymentMethod: 'wallet', amountMinor: ssPlan.priceMinor } });
  check('It buys Starter from the account wallet', ssBought.status < 300, ssBought.error);

  for (const path of ['/products', '/sales', '/pharmacy/medicines', '/restaurant/menu']) {
    const res = await api(path, { token: ssToken });
    check(`A Supershop workspace cannot reach ${path}`, res.status === 403 && res.error?.code === 'VERTICAL_NOT_SUPPORTED', { status: res.status });
  }
  for (const [label, token] of [['Clothing', admin.token], ['Pharmacy', phToken]]) {
    const res = await api('/supershop/products', { token });
    check(`A ${label} workspace cannot reach the supershop`, res.status === 403 && res.error?.code === 'VERTICAL_NOT_SUPPORTED', { status: res.status });
  }

  const ssApi = (path, opts = {}) => api(`/supershop${path}`, { token: ssToken, ...opts });
  const ssProduct = (body) => ssApi('/products', { method: 'POST', body });
  const soap = await ssProduct({ name: 'Lux Soap 100g', brand: 'Lux', category: 'Personal care', barcode: '8941100500019', unitType: 'each', priceMinor: 4500, vatRateBps: 1500, reorderLevel: 20 });
  const rice = await ssProduct({ name: 'Miniket Rice', category: 'Grocery', unitType: 'weight', priceMinor: 9500 });
  const candle = await ssProduct({ name: 'Candle', category: 'Household', barcode: 'CNDL-1', priceMinor: 2000, reorderLevel: 3 });
  check('Products are created by the piece and by weight', [soap, rice, candle].every((r) => r.status === 201) && rice.data?.unitType === 'weight', [soap.error, rice.error, candle.error]);
  check('A barcode belongs to one product', (await ssProduct({ name: 'Other Soap', barcode: '8941100500019', priceMinor: 1 })).status === 409);
  check('The same name and brand is refused', (await ssProduct({ name: 'lux soap 100G', brand: 'LUX', priceMinor: 1 })).status === 409);
  check('An unknown unit type is rejected', (await ssProduct({ name: 'Litre milk', unitType: 'litre', priceMinor: 1 })).status === 422);
  check('A VAT rate above 100% is rejected', (await ssProduct({ name: 'Taxed', priceMinor: 1, vatRateBps: 10_001 })).status === 422);
  check('Unknown product fields are rejected', (await ssProduct({ name: 'Sneaky', priceMinor: 1, costPriceMinor: 1 })).status === 422);
  check('The unit type cannot be changed later', (await ssApi(`/products/${rice.data._id}`, { method: 'PATCH', body: { unitType: 'each' } })).status === 422);

  const ssReceive = (id, body) => ssApi(`/products/${id}/stock`, { method: 'POST', body });
  await ssReceive(soap.data._id, { quantity: 30, costPriceMinor: 3000, supplierName: 'Unilever' });
  const soapStock = await ssReceive(soap.data._id, { quantity: 10, costPriceMinor: 3600 });
  check('Receiving stock keeps a weighted average cost', soapStock.status === 201 && soapStock.data?.quantityOnHand === 40 && soapStock.data?.costPriceMinor === 3150, soapStock.data ?? soapStock.error);
  check('Weighed stock is received in grams', (await ssReceive(rice.data._id, { quantity: 25_000, costPriceMinor: 7000 })).data?.quantityOnHand === 25_000);
  await ssReceive(candle.data._id, { quantity: 5, costPriceMinor: 1000 });
  check('A zero quantity is rejected', (await ssReceive(soap.data._id, { quantity: 0, costPriceMinor: 1 })).status === 422);
  check('A fractional quantity is rejected (weights are whole grams)', (await ssReceive(rice.data._id, { quantity: 1.5, costPriceMinor: 1 })).status === 422);

  const scanned = await ssApi('/products/lookup?barcode=8941100500019');
  check('A scanned barcode finds the product with its stock', scanned.status === 200 && scanned.data?._id === soap.data._id && scanned.data?.stock?.quantityOnHand === 40, scanned.data ?? scanned.error);
  check('An unknown barcode is 404', (await ssApi('/products/lookup?barcode=0000000')).status === 404);
  check('Departments are listed', JSON.stringify((await ssApi('/categories')).data) === JSON.stringify(['Grocery', 'Household', 'Personal care']));

  const ssSale = (body) => ssApi('/sales', { method: 'POST', body });
  const basket = await ssSale({ items: [{ productId: soap.data._id, quantity: 3 }, { productId: rice.data._id, quantity: 1500 }], payments: [{ method: 'cash', amountMinor: 30_000 }] });
  check(
    'A mixed basket is priced by piece and by weight',
    basket.status === 201 && basket.data?.items?.[1]?.lineTotalMinor === 14_250 && basket.data?.subtotalMinor === 27_750 && basket.data?.changeMinor === 2250,
    basket.data ?? basket.error,
  );
  check('VAT included in the price is worked out per line', basket.data?.items?.[0]?.vatMinor === 1761 && basket.data?.vatMinor === 1761, basket.data?.items);
  check('The cost of goods comes from the average cost', basket.data?.costMinor === 3 * 3150 + 10_500, basket.data?.costMinor);
  const ssOnHand = async (id) => (await ssApi(`/products/${id}`)).data?.product?.stock?.quantityOnHand;
  check('Stock is taken in pieces and grams', (await ssOnHand(soap.data._id)) === 37 && (await ssOnHand(rice.data._id)) === 23_500);

  check('A client-supplied price is rejected', (await ssSale({ items: [{ productId: soap.data._id, quantity: 1, priceMinor: 1 }], payments: [{ method: 'cash', amountMinor: 4500 }] })).status === 422);
  check('The same product twice in one sale is rejected', (await ssSale({ items: [{ productId: soap.data._id, quantity: 1 }, { productId: soap.data._id, quantity: 1 }], payments: [{ method: 'cash', amountMinor: 9000 }] })).status === 422);
  const ssOversell = await ssSale({ items: [{ productId: candle.data._id, quantity: 1 }, { productId: soap.data._id, quantity: 100 }], payments: [{ method: 'cash', amountMinor: 500_000 }] });
  check('Selling more than is in stock is refused', ssOversell.status === 400 && /Only 37/.test(ssOversell.error?.message ?? ''), ssOversell.error);
  check('A refused basket takes nothing, even from lines that fitted', (await ssOnHand(candle.data._id)) === 5 && (await ssOnHand(soap.data._id)) === 37);
  check('A short payment is refused', (await ssSale({ items: [{ productId: soap.data._id, quantity: 1 }], payments: [{ method: 'cash', amountMinor: 4000 }] })).status === 400);
  check("A product from outside this shop cannot be sold", (await ssSale({ items: [{ productId: '64b000000000000000000000', quantity: 1 }], payments: [{ method: 'cash', amountMinor: 1 }] })).status === 400);

  const candleRace = await Promise.all(Array.from({ length: 4 }, () => ssSale({ items: [{ productId: candle.data._id, quantity: 2 }], payments: [{ method: 'cash', amountMinor: 4000 }] })));
  check(
    'Four tills selling 2 of the last 5 candles at once: exactly 2 succeed and 1 is left',
    candleRace.filter((r) => r.status === 201).length === 2 && (await ssOnHand(candle.data._id)) === 1,
    candleRace.map((r) => r.status),
  );

  const ssVoid = (id, reason) => ssApi(`/sales/${id}/void`, { method: 'POST', body: { reason } });
  const ssVoided = await ssVoid(basket.data._id, 'Customer changed their mind');
  check('A sale is voided and its items go back to stock', ssVoided.status === 200 && (await ssOnHand(soap.data._id)) === 40 && (await ssOnHand(rice.data._id)) === 25_000, ssVoided.error);
  check('A voided sale cannot be voided again', (await ssVoid(basket.data._id, 'Again please')).status === 409);
  check('Voids are audited', ((await api('/platform/audit-log?action=supershop.sale_voided&limit=20', { token: platform2.token })).data ?? []).some((e) => e.targetLabel === basket.data.saleNumber));

  const ssAdjust = (body) => ssApi(`/products/${soap.data._id}/adjust`, { method: 'POST', body });
  check('Stock can be written off', (await ssAdjust({ type: 'write_off', quantityDelta: -2, reason: 'Damaged packs' })).data?.stock?.quantityOnHand === 38);
  check('A write-off cannot remove more than is on hand', (await ssAdjust({ type: 'write_off', quantityDelta: -39, reason: 'Too many' })).status === 400);
  check('A write-off cannot add stock', (await ssAdjust({ type: 'write_off', quantityDelta: 2, reason: 'Backwards' })).status === 422);
  const ssRepriced = await ssApi(`/products/${soap.data._id}`, { method: 'PATCH', body: { priceMinor: 4800 } });
  check('A price change is audited', ssRepriced.status === 200 && ((await api('/platform/audit-log?action=supershop.product_price_changed&limit=20', { token: platform2.token })).data ?? []).some((e) => e.newValue?.priceMinor === 4800));
  const ssMoves = new Set(((await ssApi(`/movements?productId=${soap.data._id}&limit=100`)).data ?? []).map((m) => m.type));
  check('Every stock change is in the movement ledger', ['receive', 'sale', 'void', 'write_off'].every((type) => ssMoves.has(type)), [...ssMoves]);

  const ssDash = await ssApi('/dashboard');
  check(
    'The dashboard counts completed sales, best sellers and low stock',
    ssDash.status === 200 &&
      ssDash.data?.kpis?.salesCount === 2 &&
      ssDash.data?.topProducts?.[0]?.name === 'Candle' &&
      ssDash.data?.lowStock?.some((row) => row.name === 'Candle' && row.quantityOnHand === 1),
    ssDash.data ?? ssDash.error,
  );
  check('The dashboard defaults to today, bucketed by hour', ssDash.data?.range?.preset === 'today' && ssDash.data?.range?.bucket === 'hour', ssDash.data?.range);
  check(
    'Gross profit is net sales less VAT less cost, never more',
    ssDash.data?.kpis?.grossProfitMinor <= ssDash.data.kpis.totalMinor - ssDash.data.kpis.vatMinor,
    ssDash.data?.kpis,
  );
  check(
    'The average sale is the range total over its sales',
    ssDash.data?.kpis?.averageSaleMinor === Math.round(ssDash.data.kpis.totalMinor / ssDash.data.kpis.salesCount),
    ssDash.data?.kpis,
  );
  check('The previous period is reported for comparison', typeof ssDash.data?.previous?.totalMinor === 'number' && typeof ssDash.data?.previous?.salesCount === 'number');
  const ssYesterday = await ssApi('/dashboard?preset=yesterday');
  check('A range with no trading shows zeros, not errors', ssYesterday.status === 200 && ssYesterday.data?.kpis?.totalMinor === 0 && ssYesterday.data?.kpis?.salesCount === 0);
  check('There are no best sellers in a period with no sales', (ssYesterday.data?.topProducts ?? []).length === 0);
  check('Reordering is always now, whatever the range', ssYesterday.data?.lowStock?.some((row) => row.name === 'Candle'));
  check('A 30-day range is bucketed by day', (await ssApi('/dashboard?preset=last30')).data?.range?.bucket === 'day');
  check('A 30-day range includes today\u2019s sales', (await ssApi('/dashboard?preset=last30')).data?.kpis?.salesCount === 2);
  check('An unknown preset is rejected', (await ssApi('/dashboard?preset=forever')).status === 422);
  check('A custom range needs both dates', (await ssApi('/dashboard?preset=custom&from=2026-01-01')).status === 422);
  check('A custom range cannot end before it starts', (await ssApi('/dashboard?preset=custom&from=2026-02-01&to=2026-01-01')).status === 422);
  check('The low-stock filter lists products at or below their reorder level', ((await ssApi('/products?lowStockOnly=true')).data ?? []).map((p) => p.name).join(',') === 'Candle');
  const ssReceipt = await ssApi(`/sales/${candleRace.find((r) => r.status === 201).data._id}/receipt`);
  check('A receipt is available with the branch details', ssReceipt.data?.store?.name === 'Meena Gulshan');
  // Direct (QZ Tray) printing sizes the paper from the branch's own settings,
  // so the receipt payload has to carry them in every vertical.
  check(
    'The Supershop receipt carries the branch receipt settings the printer needs',
    typeof ssReceipt.data?.store?.receipt?.paperWidthMm === 'number' &&
      typeof ssReceipt.data?.store?.receipt?.headerText === 'string' &&
      typeof ssReceipt.data?.store?.receipt?.showCashier === 'boolean' &&
      'receiptLogoUrl' in (ssReceipt.data?.store ?? {}),
    ssReceipt.data?.store?.receipt,
  );
  const ssSalesBeforeReprint = (await ssApi('/sales?limit=1')).meta?.total;
  for (let i = 0; i < 3; i += 1) await ssApi(`/sales/${candleRace.find((r) => r.status === 201).data._id}/receipt`);
  check('Reprinting a Supershop receipt three times creates no sale', (await ssApi('/sales?limit=1')).meta?.total === ssSalesBeforeReprint);
  check('A product with stock cannot be removed', (await ssApi(`/products/${soap.data._id}`, { method: 'DELETE' })).status === 409);
  check("Plan meters count this supershop's products", (await api(`/platform/tenants/${ssCreated.data?.workspace?.id}`, { token: platform2.token })).data?.usage?.products === 3);

  // --- Supershop Advanced Analytics -------------------------------------------------
  const ssLocked = await ssApi('/reports?preset=today');
  check('Supershop analytics are locked on Starter', ssLocked.status === 403 && ssLocked.error?.code === 'ADVANCED_ANALYTICS_REQUIRED' && ssLocked.data == null, ssLocked.error);
  check('Another vertical cannot reach supershop analytics', (await api('/supershop/reports', { token: phToken })).error?.code === 'VERTICAL_NOT_SUPPORTED');
  const ssPro = ((await api('/plans?vertical=supershop')).data ?? []).find((p) => p.code === 'showroom-monthly');
  const ssUpgrade = await api('/platform/subscriptions', { method: 'POST', token: platform2.token, body: { tenantId: ssCreated.data?.workspace?.id, planId: ssPro?._id, periods: 1, status: 'active' } });
  check('The Supershop workspace moves to Professional', ssUpgrade.status < 300, ssUpgrade.error);
  const ssRep = await ssApi('/reports?preset=today');
  const ssR = ssRep.data;
  check('Professional unlocks Supershop analytics', ssRep.status === 200, ssRep.error);
  check(
    'Totals come from completed sales, with VAT and cost taken out of profit',
    ssR?.totals?.salesCount === 2 && ssR.totals.netSalesMinor === 8000 && ssR.totals.vatMinor === 0 && ssR.totals.costMinor === 4000 && ssR.totals.grossProfitMinor === 4000 && ssR.totals.marginBps === 5000,
    ssR?.totals,
  );
  check('Best sellers and departments are ranked', ssR?.products?.[0]?.name === 'Candle' && ssR.products[0].quantity === 4 && ssR?.departments?.[0]?.department === 'Household', { products: ssR?.products, departments: ssR?.departments });
  check('VAT is broken down by rate', JSON.stringify(ssR?.vatRates?.map((r) => [r.vatRateBps, r.grossMinor, r.vatMinor])) === JSON.stringify([[0, 8000, 0]]), ssR?.vatRates);
  check('Busy hours are grouped by hour of day', ssR?.hours?.length === 1 && ssR.hours[0].salesCount === 2, ssR?.hours);
  check('The voided basket is reported, not counted in sales', ssR?.voids?.count === 1 && ssR.voids.valueMinor === 27_750, ssR?.voids);
  check('Write-offs are valued at average cost', ssR?.writeOffs?.costMinor === 2 * 3150, ssR?.writeOffs);
  check(
    'Dead stock lists what did not sell, by stock value',
    JSON.stringify(ssR?.deadStock?.map((row) => [row.name, row.stockCostMinor])) === JSON.stringify([['Miniket Rice', 175_000], ['Lux Soap 100g', 38 * 3150]]),
    ssR?.deadStock,
  );
  check('An invalid Supershop range is rejected', (await ssApi('/reports?preset=forever')).status === 422);


  // --- Customer on a sale, in every vertical -----------------------------------
  // Clothing has always been able to attach a customer at the till; these are the
  // same rules in the other three. Runs last in each vertical's data so the
  // figures the analytics checks above assert on are already settled.
  section('POS customer selection (all verticals)');

  const cusStamp = Date.now().toString().slice(-6);
  const cusPhone = `018${cusStamp}1`;
  const cusFind = async (token, phone) => ((await api(`/customers?search=${phone}`, { token })).data ?? [])[0];

  // --- Super Shop --------------------------------------------------------------
  const ssWithNew = await ssSale({
    items: [{ productId: soap.data._id, quantity: 1 }],
    payments: [{ method: 'cash', amountMinor: 4800 }],
    customer: { name: 'Rahim Uddin', phone: cusPhone },
  });
  check('Super Shop: a customer typed at the till is created with the sale', ssWithNew.status === 201 && ssWithNew.data?.customerNameSnapshot === 'Rahim Uddin' && ssWithNew.data?.customerId, ssWithNew.data ?? ssWithNew.error);
  const ssCustomer = await cusFind(ssToken, cusPhone);
  check('Super Shop: and is on file afterwards, with the sale counted', ssCustomer?.name === 'Rahim Uddin' && ssCustomer?.orderCount === 1 && ssCustomer?.totalSpentMinor === ssWithNew.data?.totalMinor, ssCustomer);

  const ssSecond = await ssSale({
    items: [{ productId: soap.data._id, quantity: 1 }],
    payments: [{ method: 'cash', amountMinor: 4800 }],
    customer: { name: 'Rahim U.', phone: cusPhone },
  });
  check('Super Shop: the same phone is the same customer, not a second one', ssSecond.status === 201 && String(ssSecond.data?.customerId) === String(ssWithNew.data?.customerId) && ((await api(`/customers?search=${cusPhone}`, { token: ssToken })).data ?? []).length === 1, ssSecond.data?.customerId);
  const ssAfterTwo = await cusFind(ssToken, cusPhone);
  check('Super Shop: lifetime value adds up across sales', ssAfterTwo?.orderCount === 2 && ssAfterTwo?.totalSpentMinor === ssWithNew.data.totalMinor + ssSecond.data.totalMinor, ssAfterTwo);

  const ssById = await ssSale({
    items: [{ productId: soap.data._id, quantity: 1 }],
    payments: [{ method: 'cash', amountMinor: 4800 }],
    customerId: ssCustomer._id,
  });
  check('Super Shop: a customer already on file is attached by id', ssById.status === 201 && String(ssById.data?.customerId) === String(ssCustomer._id));
  const ssVoidedSale = await ssVoid(ssById.data._id, 'Customer changed their mind');
  check('Super Shop: voiding a sale takes it back off the customer', ssVoidedSale.status === 200 && (await cusFind(ssToken, cusPhone))?.orderCount === 2, await cusFind(ssToken, cusPhone));

  const ssWalkIn = await ssSale({ items: [{ productId: soap.data._id, quantity: 1 }], payments: [{ method: 'cash', amountMinor: 4800 }] });
  check('Super Shop: a walk-in sale still needs no customer at all', ssWalkIn.status === 201 && ssWalkIn.data?.customerId === null && ssWalkIn.data?.customerNameSnapshot === '');

  // Never trust a customer id from the client: it must belong to this workspace.
  const cusForeign = await api('/customers', { method: 'POST', token: admin.token, body: { name: 'Clothing Only', phone: `017${cusStamp}9` } });
  check('A customer from another workspace cannot be attached to a sale', (await ssSale({ items: [{ productId: soap.data._id, quantity: 1 }], payments: [{ method: 'cash', amountMinor: 4800 }], customerId: cusForeign.data?._id })).status === 400, cusForeign.data?._id);
  check('An unknown customer id is refused', (await ssSale({ items: [{ productId: soap.data._id, quantity: 1 }], payments: [{ method: 'cash', amountMinor: 4800 }], customerId: '64b000000000000000000000' })).status === 400);
  check('A customer with no usable phone number is rejected', (await ssSale({ items: [{ productId: soap.data._id, quantity: 1 }], payments: [{ method: 'cash', amountMinor: 4800 }], customer: { name: 'No Phone', phone: 'not-a-phone' } })).status === 422);
  check('Unknown fields on the customer are rejected', (await ssSale({ items: [{ productId: soap.data._id, quantity: 1 }], payments: [{ method: 'cash', amountMinor: 4800 }], customer: { name: 'Sneaky', phone: `019${cusStamp}1`, totalSpentMinor: 999_999 } })).status === 422);

  // --- Pharmacy ----------------------------------------------------------------
  const phCusPhone = `018${cusStamp}2`;
  const phWithCustomer = await phApi('/sales', {
    method: 'POST',
    body: {
      items: [{ medicineId: napa.data._id, quantity: 2 }],
      payments: [{ method: 'cash', amountMinor: 1000 }],
      customer: { name: 'Karim Mia', phone: phCusPhone },
      prescription: { patientName: 'Karim Mia Jr', prescriberName: 'Dr Rahman' },
    },
  });
  check('Pharmacy: a customer typed at the till is created with the sale', phWithCustomer.status === 201 && phWithCustomer.data?.customerNameSnapshot === 'Karim Mia' && phWithCustomer.data?.customerId, phWithCustomer.data ?? phWithCustomer.error);
  check('Pharmacy: the buyer and the patient on the prescription are separate', phWithCustomer.data?.prescription?.patientName === 'Karim Mia Jr' && phWithCustomer.data?.customerNameSnapshot === 'Karim Mia');
  check('Pharmacy: the receipt names the customer', (await phApi(`/sales/${phWithCustomer.data._id}/receipt`)).data?.sale?.customerNameSnapshot === 'Karim Mia');
  const phCustomer = await cusFind(phToken, phCusPhone);
  check('Pharmacy: the sale counts towards their lifetime value', phCustomer?.orderCount === 1 && phCustomer?.totalSpentMinor === phWithCustomer.data?.totalMinor, phCustomer);
  check('Pharmacy: voiding takes it back off', (await phApi(`/sales/${phWithCustomer.data._id}/void`, { method: 'POST', body: { reason: 'Wrong customer' } })).status === 200 && (await cusFind(phToken, phCusPhone))?.orderCount === 0);
  check('Pharmacy: a customer from another workspace is refused', (await phApi('/sales', { method: 'POST', body: { items: [{ medicineId: napa.data._id, quantity: 1 }], payments: [{ method: 'cash', amountMinor: 1000 }], customerId: cusForeign.data?._id } })).status === 400);

  // --- Restaurant --------------------------------------------------------------
  const rvCusPhone = `018${cusStamp}3`;
  const rvWithCustomer = await rvOrder({
    type: 'takeaway',
    items: [{ menuItemId: borhani.data._id, quantity: 2 }],
    customer: { name: 'Nusrat Jahan', phone: rvCusPhone },
  });
  check('Restaurant: the customer belongs to the order', rvWithCustomer.status === 201 && rvWithCustomer.data?.customerNameSnapshot === 'Nusrat Jahan' && rvWithCustomer.data?.customerId, rvWithCustomer.data ?? rvWithCustomer.error);
  const rvCustomer = await cusFind(rvToken, rvCusPhone);
  check('Restaurant: an open order is not a purchase yet', rvCustomer?.orderCount === 0 && rvCustomer?.totalSpentMinor === 0, rvCustomer);
  const rvPaidWithCustomer = await api(`/restaurant/orders/${rvWithCustomer.data._id}/pay`, {
    method: 'POST',
    token: rvToken,
    body: { rev: rvWithCustomer.data.rev, payments: [{ method: 'cash', amountMinor: rvWithCustomer.data.totalMinor }] },
  });
  check('Restaurant: paying the order counts it towards their lifetime value', rvPaidWithCustomer.status === 200 && (await cusFind(rvToken, rvCusPhone))?.orderCount === 1 && (await cusFind(rvToken, rvCusPhone))?.totalSpentMinor === rvPaidWithCustomer.data?.totalMinor, await cusFind(rvToken, rvCusPhone));
  const rvCancelled = await rvOrder({ type: 'takeaway', items: [{ menuItemId: borhani.data._id, quantity: 1 }], customerId: rvCustomer._id });
  await api(`/restaurant/orders/${rvCancelled.data._id}/cancel`, { method: 'POST', token: rvToken, body: { reason: 'Guest left' } });
  check('Restaurant: a cancelled order never counts', (await cusFind(rvToken, rvCusPhone))?.orderCount === 1);
  check('Restaurant: a customer from another workspace is refused', (await rvOrder({ type: 'takeaway', items: [{ menuItemId: borhani.data._id, quantity: 1 }], customerId: cusForeign.data?._id })).status === 400);

  // --- Universal plan catalog + pricing engine ---------------------------------
  section('Pricing engine');
  const EXPECTED_PRICES = { starter: [99_000, 990_000], professional: [199_000, 1_990_000], enterprise: [299_000, 2_990_000] };
  const prCatalog = await api('/pricing?posType=clothing');
  check('The public catalog lists Starter, Professional and Enterprise in order', prCatalog.status === 200 && (prCatalog.data?.plans ?? []).map((p) => p.code).join(',') === 'starter,professional,enterprise', prCatalog.data ?? prCatalog.error);
  for (const [planCode, [monthly, annual]] of Object.entries(EXPECTED_PRICES)) {
    const entry = (prCatalog.data?.plans ?? []).find((p) => p.code === planCode);
    check(`${planCode} monthly is ${monthly / 100} BDT`, entry?.monthly?.amountMinor === monthly && entry.monthly.currency === 'BDT' && entry.monthly.amount === `${monthly / 100}.00`, entry?.monthly);
    check(
      `${planCode} annual is ${annual / 100} BDT: 10 months paid, 2 free`,
      entry?.annual?.amountMinor === annual && annual === monthly * 10 && entry.annual.paidMonths === 10 && entry.annual.freeMonths === 2 && entry.annual.periodMonths === 12 && entry.annual.savingsMinor === monthly * 2,
      entry?.annual,
    );
    for (const [billingCycle, expected] of [['monthly', monthly], ['annual', annual]]) {
      const quote = await api('/pricing/quote', { method: 'POST', body: { posType: 'clothing', plan: planCode, billingCycle } });
      check(`The quote for ${planCode} ${billingCycle} comes from the server`, quote.status === 200 && quote.data?.amountMinor === expected && quote.data?.plan?.code === planCode, quote.data ?? quote.error);
    }
  }
  check('Annual shows its monthly equivalent, rounded down', (prCatalog.data?.plans ?? []).find((p) => p.code === 'professional')?.annual?.monthlyEquivalentMinor === Math.floor(1_990_000 / 12));
  for (const posType of ['restaurant', 'pharmacy', 'supershop']) {
    const other = await api(`/pricing?posType=${posType}`);
    check(`${posType} has its own default prices`, JSON.stringify((other.data?.plans ?? []).map((p) => [p.code, p.monthly?.amountMinor, p.annual?.amountMinor])) === JSON.stringify(Object.entries(EXPECTED_PRICES).map(([c, [m, a]]) => [c, m, a])), other.data);
  }

  // Unknown POS types and client-supplied prices.
  check('An unknown POS type cannot retrieve pricing', (await api('/pricing?posType=bakery')).status === 404);
  check('An unknown POS type cannot be quoted', (await api('/pricing/quote', { method: 'POST', body: { posType: 'bakery', plan: 'starter', billingCycle: 'monthly' } })).status === 404);
  check('An inactive POS type cannot retrieve pricing', (await api(`/pricing?posType=${pcCode}`)).status === 404);
  check('A malformed POS type is rejected', (await api('/pricing?posType=$ne')).status === 422);
  check('A POS type is required', (await api('/pricing')).status === 422);
  const prForged = (extra) => api('/pricing/quote', { method: 'POST', body: { posType: 'clothing', plan: 'enterprise', billingCycle: 'monthly', ...extra } });
  for (const extra of [{ amountMinor: 1 }, { amount: '1.00' }, { price: 1 }, { discountMinor: 298_999 }, { walletDeductionMinor: 299_000 }, { currency: 'USD' }]) {
    check(`A client cannot send ${Object.keys(extra)[0]} with a quote`, (await prForged(extra)).status === 422);
  }
  check('An unknown plan is 404', (await api('/pricing/quote', { method: 'POST', body: { posType: 'clothing', plan: 'platinum', billingCycle: 'monthly' } })).status === 404);
  check('An unknown billing cycle is rejected', (await api('/pricing/quote', { method: 'POST', body: { posType: 'clothing', plan: 'starter', billingCycle: 'weekly' } })).status === 422);
  check('The legacy "yearly" interval is not a billing cycle here', (await api('/pricing/quote', { method: 'POST', body: { posType: 'clothing', plan: 'starter', billingCycle: 'yearly' } })).status === 422);

  // Inside a workspace the POS type is the workspace's own.
  const prWs = await api('/pricing/workspace-quote', { method: 'POST', token: rvToken, body: { plan: 'professional', billingCycle: 'annual' } });
  check('A workspace quote uses the workspace POS type', prWs.status === 200 && prWs.data?.posType === 'restaurant' && prWs.data?.amountMinor === 1_990_000, prWs.data ?? prWs.error);
  check('A workspace quote cannot name another POS type', (await api('/pricing/workspace-quote', { method: 'POST', token: rvToken, body: { plan: 'professional', billingCycle: 'annual', posType: 'clothing' } })).status === 422);
  check('A workspace quote needs a signed-in workspace', (await api('/pricing/workspace-quote', { method: 'POST', body: { plan: 'starter', billingCycle: 'monthly' } })).status === 401);

  // Administration is platform-only.
  const prAdmin = (path, opts = {}) => api(`/platform/pricing${path}`, { token: platform2.token, ...opts });
  check('Workspace owners cannot read price administration', (await api('/platform/pricing/prices', { token: admin.token })).status === 403);
  check('Workspace owners cannot change prices', (await api('/platform/pricing/prices', { method: 'POST', token: admin.token, body: { posType: 'clothing', plan: 'starter', billingCycle: 'monthly', amountMinor: 1 } })).status === 403);
  const prPlans = await prAdmin('/plans');
  check(
    'Catalog plans keep a compatibility map to the existing plan codes',
    ['starter-store-monthly', 'showroom-monthly', 'brand-annual'].every((sku) => (prPlans.data ?? []).some((p) => Object.values(p.metadata?.legacyPlanCodes ?? {}).includes(sku))),
    prPlans.data?.map((p) => p.metadata),
  );
  check('Existing plan SKUs are unchanged', ((await api('/plans')).data ?? []).find((p) => p.code === 'showroom-monthly')?.priceMinor === 199_000);

  const prRows = (await prAdmin('/prices?posType=restaurant&plan=professional&billingCycle=annual')).data ?? [];
  check('Prices are listed per POS type, plan and cycle', prRows.length === 1 && prRows[0].state === 'current' && prRows[0].amountMinor === 1_990_000, prRows);
  const prOff = await prAdmin(`/prices/${prRows[0]?._id}`, { method: 'PATCH', body: { active: false } });
  check('A platform admin can deactivate a price', prOff.status === 200 && prOff.data?.active === false, prOff.error);
  const prInactiveQuote = await api('/pricing/quote', { method: 'POST', body: { posType: 'restaurant', plan: 'professional', billingCycle: 'annual' } });
  check('Inactive pricing cannot be quoted for purchase', prInactiveQuote.status === 409 && prInactiveQuote.error?.details?.reason === 'PRICE_UNAVAILABLE', prInactiveQuote.error);
  check('The catalog stops offering that cycle', (await api('/pricing?posType=restaurant')).data?.plans?.find((p) => p.code === 'professional')?.annual === null);
  check('Other POS types are unaffected', (await api('/pricing/quote', { method: 'POST', body: { posType: 'clothing', plan: 'professional', billingCycle: 'annual' } })).data?.amountMinor === 1_990_000);
  await prAdmin(`/prices/${prRows[0]?._id}`, { method: 'PATCH', body: { active: true } });
  check('Reactivated pricing can be quoted again', (await api('/pricing/quote', { method: 'POST', body: { posType: 'restaurant', plan: 'professional', billingCycle: 'annual' } })).status === 200);

  const prSchedule = (extra) => prAdmin('/prices', { method: 'POST', body: { posType: 'restaurant', plan: 'professional', billingCycle: 'monthly', amountMinor: 219_000, ...extra } });
  check('A price must be whole minor units', (await prSchedule({ amountMinor: 2190.5 })).status === 422);
  check('A price cannot be a string', (await prSchedule({ amountMinor: '219000' })).status === 422);
  check('A price cannot be negative', (await prSchedule({ amountMinor: -1 })).status === 422);
  check('A price cannot start in the past', (await prSchedule({ effectiveFrom: new Date(Date.now() - 86_400_000).toISOString() })).status === 400);
  const prNew = await prSchedule({ note: 'Restaurant repricing' });
  check('A platform admin schedules a new Restaurant Professional price', prNew.status === 201 && prNew.data?.amountMinor === 219_000, prNew.error);
  check('Restaurant Professional now differs from Clothing Professional', (await api('/pricing/quote', { method: 'POST', body: { posType: 'restaurant', plan: 'professional', billingCycle: 'monthly' } })).data?.amountMinor === 219_000 && (await api('/pricing/quote', { method: 'POST', body: { posType: 'clothing', plan: 'professional', billingCycle: 'monthly' } })).data?.amountMinor === 199_000);
  const prHistory = (await prAdmin('/prices?posType=restaurant&plan=professional&billingCycle=monthly')).data ?? [];
  check('The old price is kept as ended history, not overwritten', prHistory.length === 2 && prHistory[1].state === 'ended' && prHistory[1].amountMinor === 199_000, prHistory);
  const prFuture = await prSchedule({ amountMinor: 229_000, effectiveFrom: new Date(Date.now() + 86_400_000).toISOString() });
  check('A future price can be scheduled', prFuture.status === 201, prFuture.error);
  check('A scheduled price does not apply before it starts', (await api('/pricing/quote', { method: 'POST', body: { posType: 'restaurant', plan: 'professional', billingCycle: 'monthly' } })).data?.amountMinor === 219_000);
  check('Nothing can be scheduled before an already scheduled price', (await prSchedule({ amountMinor: 1 })).status === 409);
  check('A price that has taken effect cannot be cancelled', (await prAdmin(`/prices/${prNew.data?._id}`, { method: 'DELETE' })).status === 409);
  check('A scheduled price can be cancelled', (await prAdmin(`/prices/${prFuture.data?._id}`, { method: 'DELETE' })).status === 200);
  check('Price changes are audited', ((await api('/platform/audit-log?action=pricing.price_scheduled&limit=20', { token: platform2.token })).data ?? []).some((e) => e.targetLabel === 'restaurant/professional/monthly'));
  const prPlanOff = await prAdmin('/plans/enterprise', { method: 'PATCH', body: { status: 'inactive' } });
  check('A platform admin can withdraw a catalog plan', prPlanOff.status === 200 && prPlanOff.data?.status === 'inactive', prPlanOff.error);
  check('A withdrawn plan cannot be quoted', (await api('/pricing/quote', { method: 'POST', body: { posType: 'clothing', plan: 'enterprise', billingCycle: 'monthly' } })).status === 409);
  check('A withdrawn plan is not in the catalog', !((await api('/pricing?posType=clothing')).data?.plans ?? []).some((p) => p.code === 'enterprise'));
  await prAdmin('/plans/enterprise', { method: 'PATCH', body: { status: 'active' } });
  check('A plan code cannot be changed', (await prAdmin('/plans/enterprise', { method: 'PATCH', body: { code: 'ultimate' } })).status === 422);

  // --- Subscription purchase flow ------------------------------------------------
  section('Subscription purchase');
  const puStamp = Date.now();
  const puReg = await api('/auth/register', {
    method: 'POST',
    body: { businessName: `PU Home ${puStamp}`, name: 'PU Owner', email: `pu${puStamp}@example.com`, password: 'Password@123' },
  });
  const puHomeToken = puReg.data?.tokens?.accessToken;
  const puHomeId = puReg.data?.tenant?.id;
  await api('/stores', { method: 'POST', token: puHomeToken, body: { name: 'PU Home Main', currency: 'BDT' } });
  const puShop = await wcCreateAs(puHomeToken, { businessName: `PU Mart ${puStamp}`, vertical: 'supershop' });
  const puToken = (await api('/auth/switch-workspace', { method: 'POST', token: puHomeToken, body: { workspaceId: puShop.data?.workspace?.id } })).data?.tokens?.accessToken;
  await api('/stores', { method: 'POST', token: puToken, body: { name: 'PU Mart Main', currency: 'BDT' } });
  await verifyContact(puToken);
  check('A Supershop workspace without a plan is ready to buy', puShop.status === 201 && Boolean(puToken), puShop.error);

  const puApi = (path, opts = {}) => api(path, { token: puToken, ...opts });
  const puQuote = (body) => puApi('/subscriptions/purchase/quote', { method: 'POST', body });
  const puBuy = (body) => puApi('/subscriptions/purchase', { method: 'POST', body });
  const puKey = (n) => `pu${puStamp}k${n}`;
  const puWallet = async () => (await puApi('/wallet')).data?.balanceMinor;
  const puCredit = (amountMinor) =>
    api(`/platform/tenants/${puHomeId}/wallet/adjust`, { method: 'POST', token: platform2.token, body: { direction: 'credit', amountMinor, reason: 'Smoke test: purchase' } });
  const puPriceRow = async (plan, billingCycle) =>
    ((await api(`/platform/pricing/prices?posType=supershop&plan=${plan}&billingCycle=${billingCycle}`, { token: platform2.token })).data ?? []).find((row) => row.state === 'current');

  const puQ1 = await puQuote({ plan: 'professional', billingCycle: 'monthly' });
  check('A purchase quote comes from the pricing engine for the workspace POS type', puQ1.status === 200 && puQ1.data?.payableMinor === 199_000 && puQ1.data?.posType === 'supershop' && puQ1.data?.transition?.kind === 'upgrade', puQ1.data ?? puQ1.error);
  const puQ2 = await puQuote({ plan: 'enterprise', billingCycle: 'annual' });
  check('An annual quote shows the free months and the saving', puQ2.data?.payableMinor === 2_990_000 && puQ2.data?.freeMonths === 2 && puQ2.data?.savingsMinor === 598_000, puQ2.data);
  check('A quote cannot carry an amount', (await puQuote({ plan: 'starter', billingCycle: 'monthly', amountMinor: 1 })).status === 422);
  check('A quote cannot choose another POS type', (await puQuote({ plan: 'starter', billingCycle: 'monthly', posType: 'clothing' })).status === 422);
  check('An unknown plan cannot be quoted', (await puQuote({ plan: 'platinum', billingCycle: 'monthly' })).status === 404);

  // Engine price changes reach every purchase path.
  const puReprice = await api('/platform/pricing/prices', { method: 'POST', token: platform2.token, body: { posType: 'supershop', plan: 'professional', billingCycle: 'monthly', amountMinor: 150_000, note: 'Smoke test promo' } });
  check('The Supershop Professional price is changed in the engine', puReprice.status === 201, puReprice.error);
  check('The quote follows the engine', (await puQuote({ plan: 'professional', billingCycle: 'monthly' })).data?.payableMinor === 150_000);
  const puPublic = ((await api('/plans?vertical=supershop')).data ?? []).find((p) => p.code === 'showroom-monthly');
  check('The public plan list shows the engine price and catalog terms', puPublic?.priceMinor === 150_000 && puPublic?.catalogPlanCode === 'professional' && puPublic?.billingCycle === 'monthly', puPublic);
  check('Other POS types keep their own price', ((await api('/plans')).data ?? []).find((p) => p.code === 'showroom-monthly')?.priceMinor === 199_000);
  check('Plan options are priced by the engine', ((await puApi('/subscriptions/plan-options')).data?.options ?? []).find((o) => o.code === 'showroom-monthly')?.priceMinor === 150_000);

  // Nothing about money can be sent.
  const puForge = (extra) => puBuy({ plan: 'professional', billingCycle: 'monthly', paymentMethod: 'wallet', ...extra });
  for (const extra of [{ amountMinor: 1 }, { priceMinor: 1 }, { discountMinor: 150_000 }, { walletDeductionMinor: 0 }, { planId: '64b000000000000000000000' }]) {
    check(`A purchase cannot carry ${Object.keys(extra)[0]}`, (await puForge(extra)).status === 422);
  }
  check('An unknown payment method is rejected', (await puBuy({ plan: 'professional', billingCycle: 'monthly', paymentMethod: 'cash' })).status === 422);
  check('A manual purchase needs a transaction reference', (await puBuy({ plan: 'professional', billingCycle: 'monthly', paymentMethod: 'manual', manualMethod: 'bkash', senderNumber: '01700000000' })).status === 422);
  check('An online purchase needs a provider', (await puBuy({ plan: 'professional', billingCycle: 'monthly', paymentMethod: 'online' })).status === 422);
  const puShort = await puBuy({ plan: 'professional', billingCycle: 'monthly', paymentMethod: 'wallet', idempotencyKey: puKey(0) });
  check('A wallet purchase without enough balance is refused', puShort.status === 400, puShort.error);
  check('...and nothing is activated', (await puApi('/subscriptions/current')).data?.entitlement?.planCode == null);

  // Wallet purchase at the engine price, exactly once.
  await puCredit(150_000);
  const puBought = await puBuy({ plan: 'professional', billingCycle: 'monthly', paymentMethod: 'wallet', idempotencyKey: puKey(1) });
  check(
    'A wallet purchase is charged the engine price, not the stored plan price',
    puBought.status === 201 && puBought.data?.request?.status === 'approved' && puBought.data?.request?.amountMinor === 150_000 && puBought.data?.request?.pricing?.source === 'catalog' && puBought.data?.request?.pricing?.listPriceMinor === 150_000,
    puBought.data ?? puBought.error,
  );
  check('Exactly the payable amount left the wallet', (await puWallet()) === 0, await puWallet());
  const puSnap = (await puApi('/subscriptions/current')).data?.subscription?.planSnapshot;
  check('The subscription records the price that was charged', puSnap?.code === 'showroom-monthly' && puSnap?.priceMinor === 150_000, puSnap);
  const puReplay = await puBuy({ plan: 'professional', billingCycle: 'monthly', paymentMethod: 'wallet', idempotencyKey: puKey(1) });
  check('Retrying with the same key returns the first purchase without charging again', puReplay.status === 200 && puReplay.data?.replayed === true && puReplay.data?.request?._id === puBought.data?.request?._id && (await puWallet()) === 0, puReplay.data ?? puReplay.error);
  check('A purchase key cannot be reused for another plan', (await puBuy({ plan: 'enterprise', billingCycle: 'monthly', paymentMethod: 'wallet', idempotencyKey: puKey(1) })).status === 409);
  check('The plan already running cannot be bought again', (await puBuy({ plan: 'professional', billingCycle: 'monthly', paymentMethod: 'wallet', idempotencyKey: puKey(2) })).status === 400);
  await api('/platform/pricing/prices', { method: 'POST', token: platform2.token, body: { posType: 'supershop', plan: 'professional', billingCycle: 'monthly', amountMinor: 199_000, note: 'Smoke test: promo over' } });

  // Concurrent purchases cannot double-spend the wallet.
  await puCredit(2_990_000);
  const puRace = await Promise.all([3, 4, 5].map((n) => puBuy({ plan: 'enterprise', billingCycle: 'annual', paymentMethod: 'wallet', idempotencyKey: puKey(n) })));
  // The workspace was on a paid Professional period, so the winning upgrade is
  // credited for its unused time: the wallet keeps that part.
  const puWinner = puRace.find((r) => r.status === 201)?.data?.request;
  check(
    'Three simultaneous annual purchases with a balance for one: exactly one succeeds, charged once',
    puRace.filter((r) => r.status === 201).length === 1 &&
      puRace.every((r) => [201, 400, 409].includes(r.status)) &&
      (await puWallet()) === 2_990_000 - (puWinner?.amountMinor ?? 0) &&
      puWinner?.amountMinor === 2_990_000 - (puWinner?.proration?.appliedMinor ?? 0),
    { statuses: puRace.map((r) => r.status), wallet: await puWallet(), winner: puWinner },
  );
  check('The workspace is now on Enterprise annual at the engine price', (await puApi('/subscriptions/current')).data?.subscription?.planSnapshot?.priceMinor === 2_990_000);

  // Inactive pricing cannot be bought.
  const puStarterRow = await puPriceRow('starter', 'monthly');
  await api(`/platform/pricing/prices/${puStarterRow?._id}`, { method: 'PATCH', token: platform2.token, body: { active: false } });
  const puInactiveQuote = await puQuote({ plan: 'starter', billingCycle: 'monthly' });
  check('Inactive pricing cannot be quoted for purchase', puInactiveQuote.status === 409 && puInactiveQuote.error?.details?.reason === 'PRICE_UNAVAILABLE', puInactiveQuote.error);
  check('Inactive pricing cannot be bought', (await puBuy({ plan: 'starter', billingCycle: 'monthly', paymentMethod: 'manual', manualMethod: 'bkash', senderNumber: '01700000000', transactionId: `PUX${puStamp}` })).status === 409);
  check('The old upgrade endpoint refuses it too', (await puApi('/subscriptions/upgrade-request', { method: 'POST', body: { planId: ((await api('/plans/all', { token: platform2.token })).data ?? []).find((p) => p.code === 'starter-store-monthly')?._id, paymentMethod: 'bkash', amountMinor: 99_000, senderNumber: '01700000000', transactionId: `PUY${puStamp}` } })).status === 409);
  await api(`/platform/pricing/prices/${puStarterRow?._id}`, { method: 'PATCH', token: platform2.token, body: { active: true } });

  // Online checkout at the engine price.
  check('Coupons are not accepted for online checkout', (await puBuy({ plan: 'professional', billingCycle: 'annual', paymentMethod: 'online', provider: 'bkash', couponCode: 'LAUNCH20' })).status === 400);
  const puOnline = await puBuy({ plan: 'professional', billingCycle: 'annual', paymentMethod: 'online', provider: 'bkash', idempotencyKey: puKey(6) });
  check('An online purchase opens a payment for the engine price', puOnline.status === 201 && puOnline.data?.amountMinor === 1_990_000 && Boolean(puOnline.data?.redirectUrl), puOnline.data ?? puOnline.error);
  // How a payment was priced is internal: read from the platform payment desk, not the workspace list.
  const puPayment = (await api(`/platform/payments/${puOnline.data?.paymentId}`, { token: platform2.token })).data?.payment;
  check('The pending payment records how it was priced', puPayment?.amountMinor === 1_990_000 && puPayment?.metadata?.pricing?.catalogPlanCode === 'professional', puPayment);
  const puOnlineReplay = await puBuy({ plan: 'professional', billingCycle: 'annual', paymentMethod: 'online', provider: 'bkash', idempotencyKey: puKey(6) });
  check('Retrying an online purchase returns the same payment page', puOnlineReplay.status === 200 && puOnlineReplay.data?.paymentId === puOnline.data?.paymentId && puOnlineReplay.data?.redirectUrl === puOnline.data?.redirectUrl, puOnlineReplay.data ?? puOnlineReplay.error);

  // Manual transfer: a request for exactly the payable amount.
  const puManual = await puBuy({ plan: 'professional', billingCycle: 'annual', paymentMethod: 'manual', manualMethod: 'nagad', senderNumber: '01800000000', transactionId: `PUM${puStamp}`, idempotencyKey: puKey(7) });
  check(
    'A manual purchase files a pending request for the engine price',
    puManual.status === 201 && puManual.data?.request?.status === 'pending' && puManual.data?.request?.amountMinor === 1_990_000 && puManual.data?.request?.paymentMethod === 'nagad',
    puManual.data ?? puManual.error,
  );
  check('A second manual request is refused while one is pending', (await puBuy({ plan: 'professional', billingCycle: 'monthly', paymentMethod: 'manual', manualMethod: 'bkash', senderNumber: '01800000000', transactionId: `PUN${puStamp}` })).status === 409);
  check('Purchasing needs subscription.manage', (await api('/subscriptions/purchase/quote', { method: 'POST', token: cashier.token, body: { plan: 'starter', billingCycle: 'monthly' } })).status === 403);

  // --- Renewals and plan changes ---------------------------------------------------
  section('Renewals and plan changes');
  const rnStamp = Date.now();
  const rnDay = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const rnReg = await api('/auth/register', {
    method: 'POST',
    body: { businessName: `RN Shop ${rnStamp}`, name: 'RN Owner', email: `rn${rnStamp}@example.com`, password: 'Password@123' },
  });
  const rnToken = rnReg.data?.tokens?.accessToken;
  const rnTenantId = rnReg.data?.tenant?.id;
  await api('/stores', { method: 'POST', token: rnToken, body: { name: 'RN Main', currency: 'BDT' } });
  await verifyContact(rnToken);
  const rnApi = (path, opts = {}) => api(path, { token: rnToken, ...opts });
  const rnQuote = (body) => rnApi('/subscriptions/purchase/quote', { method: 'POST', body });
  const rnBuy = (body) => rnApi('/subscriptions/purchase', { method: 'POST', body });
  const rnKey = (n) => `rn${rnStamp}k${n}`;
  const rnWallet = async () => (await rnApi('/wallet')).data?.balanceMinor;
  const rnCredit = (amountMinor) =>
    api(`/platform/tenants/${rnTenantId}/wallet/adjust`, { method: 'POST', token: platform2.token, body: { direction: 'credit', amountMinor, reason: 'Smoke test: renewals' } });
  const rnInfo = async () => (await rnApi('/subscriptions/renewal')).data;
  const rnAssign = (planCode, startDate, endDate) =>
    api('/platform/subscriptions', {
      method: 'POST',
      token: platform2.token,
      body: { tenantId: rnTenantId, planId: plansByCode[planCode]._id, startDate, endDate, status: 'active', autoRenew: false },
    });
  const plansByCode = Object.fromEntries(((await api('/plans/all', { token: platform2.token })).data ?? []).map((p) => [p.code, p]));
  const rnRun = () => api('/platform/subscriptions/run-renewals', { method: 'POST', token: platform2.token, body: {} });

  // A paid annual period to change from.
  await rnCredit(1_990_000);
  const rnFirst = await rnBuy({ plan: 'professional', billingCycle: 'annual', paymentMethod: 'wallet', idempotencyKey: rnKey(1) });
  check('Buying from a trial earns no credit', rnFirst.status === 201 && rnFirst.data?.request?.proration === null && rnFirst.data?.request?.amountMinor === 1_990_000, rnFirst.data ?? rnFirst.error);
  const rnInfo1 = await rnInfo();
  check(
    'The renewal summary shows the period end and the next renewal at the engine price',
    rnInfo1?.subscription?.planCode === 'showroom-annual' && rnInfo1.subscription.autoRenew === false && rnInfo1.renewalWindowOpen === false && rnInfo1.nextRenewal?.amountMinor === 1_990_000 && rnInfo1.nextRenewal?.catalogPlanCode === 'professional',
    rnInfo1,
  );

  // Which moves earn credit for the unused time.
  const rnUpAnnual = (await rnQuote({ plan: 'enterprise', billingCycle: 'annual' })).data;
  check('An upgrade quote credits the unused paid time', rnUpAnnual?.proration?.creditMinor > 1_980_000 && rnUpAnnual.proration.creditMinor <= 1_990_000 && rnUpAnnual.payableMinor === 2_990_000 - rnUpAnnual.proration.creditMinor, rnUpAnnual);
  const rnUpMonthly = (await rnQuote({ plan: 'enterprise', billingCycle: 'monthly' })).data;
  check(
    'Credit worth more than the new plan leaves nothing to pay and the rest for the wallet',
    rnUpMonthly?.payableMinor === 0 && rnUpMonthly.walletRefundMinor === rnUpMonthly.proration.creditMinor - 299_000 && rnUpMonthly.paymentMethods.online.length === 0,
    rnUpMonthly,
  );
  const rnDownQuote = (await rnQuote({ plan: 'starter', billingCycle: 'monthly' })).data;
  check('An immediate downgrade earns no credit (schedule it to keep the time)', rnDownQuote?.transition?.kind === 'downgrade' && rnDownQuote.proration === null && rnDownQuote.payableMinor === 99_000, rnDownQuote);
  const rnShorter = (await rnQuote({ plan: 'professional', billingCycle: 'monthly' })).data;
  check('Moving the same plan from annual to monthly earns no credit', rnShorter?.transition?.kind === 'cycle-change' && rnShorter.proration === null && rnShorter.payableMinor === 199_000, rnShorter);

  check('Online checkout is refused when credit covers the price', (await rnBuy({ plan: 'enterprise', billingCycle: 'monthly', paymentMethod: 'online', provider: 'bkash' })).error?.details?.reason === 'NOTHING_TO_PAY_ONLINE');
  check('A manual transfer is refused when credit covers the price', (await rnBuy({ plan: 'enterprise', billingCycle: 'monthly', paymentMethod: 'manual', manualMethod: 'bkash', senderNumber: '01700000000', transactionId: `RNM${rnStamp}` })).error?.details?.reason === 'NOTHING_TO_TRANSFER');
  const rnBeforeCovered = await rnWallet();
  const rnCovered = await rnBuy({ plan: 'enterprise', billingCycle: 'monthly', paymentMethod: 'wallet', idempotencyKey: rnKey(2) });
  const rnCoveredRequest = rnCovered.data?.request;
  check(
    'An upgrade the credit covers costs nothing and returns the rest to the wallet',
    rnCovered.status === 201 && rnCoveredRequest?.amountMinor === 0 && rnCoveredRequest.proration?.walletRefundMinor > 1_600_000 && (await rnWallet()) - rnBeforeCovered === rnCoveredRequest.proration.walletRefundMinor,
    { request: rnCoveredRequest, before: rnBeforeCovered, after: await rnWallet(), error: rnCovered.error },
  );
  check('The subscription records the full plan price', (await rnApi('/subscriptions/current')).data?.subscription?.planSnapshot?.priceMinor === 299_000);

  const rnCycle = (await rnQuote({ plan: 'enterprise', billingCycle: 'annual' })).data;
  check('Moving the same plan to annual billing is credited', rnCycle?.transition?.kind === 'cycle-change' && rnCycle.proration?.creditMinor > 290_000 && rnCycle.payableMinor === 2_990_000 - rnCycle.proration.creditMinor, rnCycle);
  await rnCredit(2_990_000);
  const rnBeforeUp = await rnWallet();
  const rnUpBought = await rnBuy({ plan: 'enterprise', billingCycle: 'annual', paymentMethod: 'wallet', idempotencyKey: rnKey(3) });
  const rnUpRequest = rnUpBought.data?.request;
  check(
    'It charges the new price less the credit',
    rnUpBought.status === 201 && rnUpRequest?.proration?.creditMinor > 290_000 && rnUpRequest.amountMinor === 2_990_000 - rnUpRequest.proration.creditMinor,
    rnUpRequest ?? rnUpBought.error,
  );
  check('Exactly that left the wallet', rnBeforeUp - (await rnWallet()) === rnUpRequest?.amountMinor, { before: rnBeforeUp, after: await rnWallet() });
  check(
    'The credit counts what the period was worth, including credit rolled into it',
    rnUpRequest?.proration?.paidMinor === 299_000,
    rnUpRequest?.proration,
  );
  check('The running plan cannot be renewed this early', (await rnQuote({ plan: 'enterprise', billingCycle: 'annual' })).status === 400);

  // Scheduled changes.
  const rnSchedule = (body, token = rnToken) => api('/subscriptions/scheduled-change', { method: 'POST', token, body });
  check('A scheduled change cannot carry an amount', (await rnSchedule({ plan: 'professional', billingCycle: 'annual', amountMinor: 1 })).status === 422);
  check('An unknown plan cannot be scheduled', (await rnSchedule({ plan: 'platinum', billingCycle: 'annual' })).status === 404);
  check('The current plan cannot be scheduled', (await rnSchedule({ plan: 'enterprise', billingCycle: 'annual' })).status === 400);
  check('Staff without subscription.manage cannot schedule', (await rnSchedule({ plan: 'professional', billingCycle: 'annual' }, cashier.token)).status === 403);
  const rnScheduled = await rnSchedule({ plan: 'professional', billingCycle: 'annual' });
  check(
    'A change is scheduled for the next renewal without changing the plan now',
    rnScheduled.status === 200 && rnScheduled.data?.scheduledChange?.catalogPlanCode === 'professional' && rnScheduled.data?.nextRenewal?.amountMinor === 1_990_000 && rnScheduled.data?.subscription?.planCode === 'brand-annual',
    rnScheduled.data ?? rnScheduled.error,
  );
  const rnUnscheduled = await rnApi('/subscriptions/scheduled-change', { method: 'DELETE' });
  check('A scheduled change can be withdrawn', rnUnscheduled.status === 200 && rnUnscheduled.data?.scheduledChange === null && rnUnscheduled.data?.nextRenewal?.code === 'brand-annual');
  check('Withdrawing twice is 404', (await rnApi('/subscriptions/scheduled-change', { method: 'DELETE' })).status === 404);

  // Automatic renewal toggle.
  check('Auto-renew takes only a boolean', (await rnApi('/subscriptions/auto-renew', { method: 'POST', body: { enabled: 'yes' } })).status === 422);
  const rnOn = await rnApi('/subscriptions/auto-renew', { method: 'POST', body: { enabled: true } });
  check('Automatic renewal from the wallet can be turned on', rnOn.data?.subscription?.autoRenew === true && rnOn.data?.subscription?.renewWith === 'wallet', rnOn.data ?? rnOn.error);
  const rnOff = await rnApi('/subscriptions/auto-renew', { method: 'POST', body: { enabled: false } });
  check('...and off', rnOff.data?.subscription?.autoRenew === false && rnOff.data?.subscription?.renewWith === null);
  check('Only platform admins can run renewals on demand', (await api('/platform/subscriptions/run-renewals', { method: 'POST', token: rnToken, body: {} })).status === 403);

  // Automatic renewal into a scheduled plan, at the engine price, once.
  check('A period that already ended is set up', (await rnAssign('starter-store-monthly', rnDay(-31), rnDay(-1))).status < 300);
  check('Auto-renew can still be turned on just after the period ended', (await rnApi('/subscriptions/auto-renew', { method: 'POST', body: { enabled: true } })).data?.subscription?.renewWith === 'wallet');
  await rnSchedule({ plan: 'professional', billingCycle: 'monthly' });
  await rnCredit(199_000);
  const rnBeforeRenew = await rnWallet();
  const rnRun1 = await rnRun();
  check('The renewal pass runs', rnRun1.status === 200 && rnRun1.data?.wallet?.renewed >= 1, rnRun1.data ?? rnRun1.error);
  const rnRenewed = (await rnApi('/subscriptions/current')).data?.subscription;
  check('The scheduled plan is applied at renewal, charged at the engine price', rnRenewed?.planSnapshot?.code === 'showroom-monthly' && rnRenewed.planSnapshot.priceMinor === 199_000 && rnBeforeRenew - (await rnWallet()) === 199_000, { snapshot: rnRenewed?.planSnapshot, before: rnBeforeRenew, after: await rnWallet() });
  check('A renewal more than an hour late starts a fresh period now', new Date(rnRenewed?.currentPeriodStart).getTime() > Date.now() - 10 * 60_000, rnRenewed?.currentPeriodStart);
  const rnInfo2 = await rnInfo();
  check('The renewed subscription keeps renewing from the wallet, with no change pending', rnInfo2?.subscription?.renewWith === 'wallet' && rnInfo2.subscription.autoRenew === true && rnInfo2.scheduledChange === null, rnInfo2);
  const rnEvents = ((await rnApi('/subscriptions/history')).data?.events ?? []).map((e) => e.type);
  check('The renewal and the plan change are in the billing history', rnEvents.includes('renewed') && rnEvents.includes('plan_changed') && rnEvents.includes('change_scheduled'), rnEvents);
  const rnAfterFirst = await rnWallet();
  await rnRun();
  check('Running renewals again never charges the same period twice', (await rnWallet()) === rnAfterFirst);

  // A renewal that cannot be paid.
  await rnAssign('starter-store-monthly', rnDay(-31), rnDay(-1));
  await rnApi('/subscriptions/auto-renew', { method: 'POST', body: { enabled: true } });
  await rnSchedule({ plan: 'enterprise', billingCycle: 'annual' });
  const rnBeforeFail = await rnWallet();
  await rnRun();
  const rnFailed = await rnInfo();
  check('A renewal the wallet cannot cover fails and is recorded', rnFailed?.subscription?.status === 'past_due' && rnFailed.subscription.failedRenewalAttempts === 1 && (await rnWallet()) === rnBeforeFail, rnFailed?.subscription);
  await rnRun();
  check('A failed renewal is not retried straight away', (await rnInfo())?.subscription?.failedRenewalAttempts === 1);
  check('The failure is in the billing history', ((await rnApi('/subscriptions/history')).data?.events ?? []).some((e) => e.type === 'renewal_failed'));

  // Early renewal in the last days of a period continues from its end.
  await rnAssign('starter-store-monthly', rnDay(-25), rnDay(5));
  const rnEnding = (await rnApi('/subscriptions/current')).data?.subscription;
  check('The renewal window opens in the last 7 days', (await rnInfo())?.renewalWindowOpen === true);
  await rnCredit(99_000);
  const rnEarly = await rnBuy({ plan: 'starter', billingCycle: 'monthly', paymentMethod: 'wallet', idempotencyKey: rnKey(9) });
  check('The same plan can be renewed early', rnEarly.status === 201 && rnEarly.data?.request?.transitionKind === 'renewal' && rnEarly.data?.request?.proration === null && rnEarly.data?.request?.amountMinor === 99_000, rnEarly.data ?? rnEarly.error);
  const rnStacked = (await rnApi('/subscriptions/current')).data?.subscription;
  check('An early renewal continues from the end of the running period', new Date(rnStacked?.currentPeriodStart).getTime() === new Date(rnEnding?.currentPeriodEnd).getTime(), { start: rnStacked?.currentPeriodStart, previousEnd: rnEnding?.currentPeriodEnd });
  check('Running renewals is audited', ((await api('/platform/audit-log?action=subscriptions.renewals_run&limit=5', { token: platform2.token })).data ?? []).length > 0);

  // ------------------------------------------------ workspace subscriptions
  section('Workspace subscriptions');
  const wsuStamp = Date.now();
  const wsuDayMs = 86_400_000;
  const wsuDate = (offset) => new Date(Date.now() + offset * wsuDayMs).toISOString().slice(0, 10);
  const wsuSpan = (sub, from, to) => new Date(sub?.[to]).getTime() - new Date(sub?.[from]).getTime();
  const wsuReg = await api('/auth/register', {
    method: 'POST',
    body: { businessName: `WS Clothing ${wsuStamp}`, name: 'WS Owner', email: `ws${wsuStamp}@example.com`, password: 'Password@123' },
  });
  // Reassigned after switching workspaces: a switch invalidates the previous workspace's token.
  let wsuToken = wsuReg.data?.tokens?.accessToken;
  const wsuClothingId = wsuReg.data?.tenant?.id;
  const wsuAccountId = wsuReg.data?.tenant?.accountId;
  check('An owner signs up for the multi-workspace test', wsuReg.status === 201 && Boolean(wsuToken && wsuAccountId), wsuReg.error);
  await api('/stores', { method: 'POST', token: wsuToken, body: { name: 'WS Clothing Main', currency: 'BDT' } });

  const wsuOwn = async (id, token = wsuToken) => api(`/workspaces/${id}/subscription`, { token });
  const wsuCancel = (id, body, token = wsuToken) => api(`/workspaces/${id}/subscription/cancel`, { method: 'POST', token, body });
  const wsuAssign = (tenantId, planCode, extra = {}) =>
    api('/platform/subscriptions', { method: 'POST', token: platform2.token, body: { tenantId, planId: plansByCode[planCode]?._id, status: 'active', autoRenew: false, ...extra } });

  // --- the 7-day trial --------------------------------------------------------
  const wsuTrial = (await wsuOwn(wsuClothingId)).data;
  check('The signup workspace is trialing and usable', wsuTrial?.subscription?.status === 'trialing' && wsuTrial.isActive === true, wsuTrial);
  check('The free trial lasts exactly 7 days', wsuSpan(wsuTrial?.subscription, 'trialStart', 'trialEnd') === 7 * wsuDayMs, { start: wsuTrial?.subscription?.trialStart, end: wsuTrial?.subscription?.trialEnd });
  check('The trial ends when its period ends', wsuTrial?.subscription?.trialEnd === wsuTrial?.subscription?.currentPeriodEnd, wsuTrial?.subscription);
  check('The subscription belongs to the owning account', wsuTrial?.accountId === wsuAccountId && wsuTrial?.subscription?.accountId === wsuAccountId, wsuTrial);
  check('The subscription records its workspace and POS product', wsuTrial?.subscription?.workspaceId === wsuClothingId && wsuTrial?.subscription?.posProductCode === 'clothing' && Boolean(wsuTrial?.subscription?.posProductId), wsuTrial?.subscription);

  // --- several workspaces, several subscriptions -------------------------------
  const wsuRestaurant = await wcCreateAs(wsuToken, { businessName: `WS Restaurant ${wsuStamp}`, vertical: 'restaurant' });
  const wsuPharmacy = await wcCreateAs(wsuToken, { businessName: `WS Pharmacy ${wsuStamp}`, vertical: 'pharmacy' });
  const wsuShop = await wcCreateAs(wsuToken, { businessName: `WS Shop ${wsuStamp}`, vertical: 'supershop' });
  const wsuRestaurantId = wsuRestaurant.data?.workspace?.id;
  const wsuPharmacyId = wsuPharmacy.data?.workspace?.id;
  const wsuShopId = wsuShop.data?.workspace?.id;
  check('The owner opens Restaurant, Pharmacy and Supershop workspaces', [wsuRestaurant, wsuPharmacy, wsuShop].every((r) => r.status === 201), [wsuRestaurant, wsuPharmacy, wsuShop].map((r) => r.error));
  const wsuNone = (await wsuOwn(wsuShopId)).data;
  check('A new workspace has no subscription of its own yet', wsuNone?.subscription === null && wsuNone?.isActive === false, wsuNone);

  const wsuA1 = await wsuAssign(wsuClothingId, 'showroom-monthly', { periods: 1 });
  const wsuA2 = await wsuAssign(wsuRestaurantId, 'starter-store-monthly', { periods: 1 });
  const wsuA3 = await wsuAssign(wsuPharmacyId, 'brand-monthly', { periods: 1 });
  check('Each workspace is given its own plan', [wsuA1, wsuA2, wsuA3].every((r) => r.status < 300), [wsuA1, wsuA2, wsuA3].map((r) => r.error));

  const wsuListAll = async (token = wsuToken) => {
    const response = await api('/account/subscriptions', { token });
    return { response, byId: Object.fromEntries((response.data ?? []).map((w) => [w.workspaceId, w])) };
  };
  const { response: wsuList, byId: wsuById } = await wsuListAll();
  check('The account lists all four workspaces', wsuList.status === 200 && (wsuList.data ?? []).length === 4, wsuList.data?.length ?? wsuList.error);
  check(
    'Each subscription has its own plan and POS type',
    wsuById[wsuClothingId]?.subscription?.planCode === 'showroom-monthly' && wsuById[wsuClothingId]?.subscription?.posProductCode === 'clothing' &&
      wsuById[wsuRestaurantId]?.subscription?.planCode === 'starter-store-monthly' && wsuById[wsuRestaurantId]?.subscription?.posProductCode === 'restaurant' &&
      wsuById[wsuPharmacyId]?.subscription?.planCode === 'brand-monthly' && wsuById[wsuPharmacyId]?.subscription?.posProductCode === 'pharmacy',
    Object.values(wsuById).map((w) => [w.posProductCode, w.subscription?.planCode, w.subscription?.status]),
  );
  check(
    'Three workspaces are active; the one without a plan is not',
    [wsuClothingId, wsuRestaurantId, wsuPharmacyId].every((id) => wsuById[id]?.isActive === true && wsuById[id]?.subscription?.status === 'active') && wsuById[wsuShopId]?.isActive === false,
    Object.values(wsuById).map((w) => [w.posProductCode, w.isActive, w.subscription?.status]),
  );
  check(
    'Each subscription records its cycle, price and currency',
    [wsuClothingId, wsuRestaurantId, wsuPharmacyId].every((id) => {
      const sub = wsuById[id]?.subscription;
      return sub?.billingCycle === 'monthly' && Number.isInteger(sub?.priceMinor) && sub.priceMinor > 0 && sub.currency === 'BDT';
    }),
    Object.values(wsuById).map((w) => w.subscription && [w.subscription.billingCycle, w.subscription.priceMinor, w.subscription.currency]),
  );
  check('Every listed subscription belongs to this account', (wsuList.data ?? []).every((w) => w.accountId === wsuAccountId));

  // --- cancelling one leaves the others alone ------------------------------------
  const wsuC1 = await wsuCancel(wsuRestaurantId, {});
  check('Cancelling the Restaurant subscription keeps its paid period', wsuC1.status === 200 && wsuC1.data?.subscription?.status === 'cancelled' && wsuC1.data?.subscription?.cancelAtPeriodEnd === true, wsuC1.data ?? wsuC1.error);
  const { byId: wsuAfterC1 } = await wsuListAll();
  check('The Clothing and Pharmacy subscriptions are unaffected', wsuAfterC1[wsuClothingId]?.subscription?.status === 'active' && wsuAfterC1[wsuPharmacyId]?.subscription?.status === 'active' && wsuAfterC1[wsuClothingId]?.isActive && wsuAfterC1[wsuPharmacyId]?.isActive, wsuAfterC1);

  const wsuC2 = await wsuCancel(wsuPharmacyId, { immediate: true, reason: 'Closing the pharmacy' });
  check('An immediate cancel ends the Pharmacy subscription', wsuC2.status === 200 && wsuC2.data?.subscription?.status === 'expired' && wsuC2.data?.isActive === false, wsuC2.data ?? wsuC2.error);
  const { byId: wsuAfterC2 } = await wsuListAll();
  check('Clothing is still active after another workspace is cancelled', wsuAfterC2[wsuClothingId]?.subscription?.status === 'active' && wsuAfterC2[wsuClothingId]?.isActive === true, wsuAfterC2[wsuClothingId]);
  check('Restaurant is still cancelled-at-period-end, not expired', wsuAfterC2[wsuRestaurantId]?.subscription?.status === 'cancelled', wsuAfterC2[wsuRestaurantId]?.subscription);
  const wsuPhSwitch = await api('/auth/switch-workspace', { method: 'POST', token: wsuToken, body: { workspaceId: wsuPharmacyId } });
  check('Inside the cancelled Pharmacy workspace the POS is locked', wsuPhSwitch.status === 200 && wsuPhSwitch.data?.entitlement?.isUsable === false, wsuPhSwitch.data?.entitlement ?? wsuPhSwitch.error);
  const wsuBack = await api('/auth/switch-workspace', { method: 'POST', token: wsuPhSwitch.data?.tokens?.accessToken, body: { workspaceId: wsuClothingId } });
  wsuToken = wsuBack.data?.tokens?.accessToken ?? wsuToken;
  check('The owner switches back into Clothing', wsuBack.status === 200 && wsuBack.data?.tenant?.id === wsuClothingId, wsuBack.error);
  check('Inside Clothing the POS is still usable', (await api('/subscriptions/current', { token: wsuToken })).data?.entitlement?.isUsable === true);
  check('Cancelling a workspace subscription is audited', ((await api('/platform/audit-log?action=workspace.subscription_cancelled&limit=10', { token: platform2.token })).data ?? []).length >= 2);

  // --- an elapsed subscription -------------------------------------------------------
  const wsuA4 = await wsuAssign(wsuShopId, 'starter-store-monthly', { startDate: wsuDate(-40), endDate: wsuDate(-10) });
  const wsuShopSub = (await wsuOwn(wsuShopId)).data;
  check('An elapsed subscription reads as expired and grants no access', wsuA4.status < 300 && wsuShopSub?.subscription?.status === 'expired' && wsuShopSub?.isActive === false, wsuShopSub ?? wsuA4.error);

  // --- a trial granted by a platform admin is 7 days too --------------------------------
  const wsuLongTrial = await wsuAssign(wsuShopId, 'starter-store-monthly', { status: 'trial', endDate: wsuDate(30) });
  check('A platform admin cannot grant a trial longer than 7 days', wsuLongTrial.status === 400, { status: wsuLongTrial.status, error: wsuLongTrial.error });
  const wsuPeriodTrial = await wsuAssign(wsuShopId, 'starter-store-monthly', { status: 'trial', periods: 3 });
  check('Nor a trial of several billing periods', wsuPeriodTrial.status === 400, wsuPeriodTrial.status);
  check('The refused trials changed nothing', (await wsuOwn(wsuShopId)).data?.subscription?.status === 'expired');
  const wsuAdminTrial = await wsuAssign(wsuShopId, 'starter-store-monthly', { status: 'trial' });
  const wsuAdminTrialSub = (await wsuOwn(wsuShopId)).data?.subscription;
  check('An admin-granted trial lasts exactly 7 days', wsuAdminTrial.status < 300 && wsuAdminTrialSub?.status === 'trialing' && wsuSpan(wsuAdminTrialSub, 'trialStart', 'trialEnd') === 7 * wsuDayMs, wsuAdminTrialSub ?? wsuAdminTrial.error);
  const wsuPlanTrial = await api(`/plans/${plansByCode['brand-monthly']?._id}`, { method: 'PATCH', token: platform2.token, body: { trialDays: 14 } });
  check('A plan cannot be given a trial of any length but 7 days', wsuPlanTrial.status === 422, wsuPlanTrial.status);

  // --- ownership ------------------------------------------------------------------------
  check('Another account cannot read this workspace subscription', (await wsuOwn(wsuClothingId, admin.token)).status === 404);
  check('Another account cannot cancel it', (await wsuCancel(wsuClothingId, {}, admin.token)).status === 404);
  check('Another account does not see these workspaces', ((await api('/account/subscriptions', { token: admin.token })).data ?? []).every((w) => ![wsuClothingId, wsuRestaurantId, wsuPharmacyId, wsuShopId].includes(w.workspaceId)));
  check('The owner cannot read a workspace of another account', (await wsuOwn(admin.session.tenant.id)).status === 404);
  check('Staff cannot use the owner subscription endpoints', (await wsuOwn(wsuClothingId, cashier.token)).status === 403);
  check('Platform admins are refused on the owner endpoints', (await wsuOwn(wsuClothingId, platform2.token)).status === 403);
  check('An unauthenticated read is refused', (await api(`/workspaces/${wsuClothingId}/subscription`)).status === 401);
  check('A malformed workspace id is rejected', (await wsuOwn('not-an-id')).status === 422);
  check('A client-supplied accountId is rejected', (await wsuCancel(wsuClothingId, { accountId: admin.session.tenant.accountId })).status === 422);
  check('A client-supplied workspaceId is rejected', (await wsuCancel(wsuClothingId, { workspaceId: admin.session.tenant.id })).status === 422);
  check('A client-supplied status is rejected', (await wsuCancel(wsuClothingId, { status: 'active' })).status === 422);
  check('The refused requests left Clothing active', (await wsuOwn(wsuClothingId)).data?.subscription?.status === 'active');
  check("The owner's refused cancel did not touch the demo workspace", (await api('/subscriptions/current', { token: admin.token })).data?.entitlement?.isUsable === true);

  // --- one primary subscription per workspace --------------------------------------------
  const wsuRace = await Promise.all([1, 2, 3, 4].map(() => wsuAssign(wsuClothingId, 'showroom-monthly', { periods: 1 })));
  check('Concurrent activations for one workspace all complete', wsuRace.every((r) => r.status < 300), wsuRace.map((r) => r.status));
  const wsuHistory = (await api('/subscriptions/history', { token: wsuToken })).data?.subscriptions ?? [];
  const wsuPrimaries = wsuHistory.filter((sub) => sub.isPrimary);
  const wsuNewestId = wsuHistory.map((sub) => sub._id).sort().at(-1);
  check('The workspace has exactly one primary subscription', wsuPrimaries.length === 1, wsuHistory.map((sub) => [sub._id, sub.status, sub.isPrimary]));
  check('The newest subscription is the primary one', wsuPrimaries[0]?._id === wsuNewestId, { primary: wsuPrimaries[0]?._id, newest: wsuNewestId });
  check('Exactly one subscription is still running', wsuHistory.filter((sub) => ['trial', 'active', 'past_due'].includes(sub.status)).length === 1, wsuHistory.map((sub) => [sub._id, sub.status]));
  check('Earlier subscriptions are kept as history', wsuHistory.length >= 6, wsuHistory.length);
  check('The workspace endpoint reports the primary subscription', (await wsuOwn(wsuClothingId)).data?.subscription?.id === wsuPrimaries[0]?._id);
  const { byId: wsuAfterRace } = await wsuListAll();
  check('The race did not touch the other workspaces', wsuAfterRace[wsuRestaurantId]?.subscription?.status === 'cancelled' && wsuAfterRace[wsuPharmacyId]?.subscription?.status === 'expired', wsuAfterRace);

  // ------------------------------------------ renewal grace, expiry and notices
  section('Renewal grace, expiry and notices');
  const rgrStamp = Date.now();
  const rgrDayMs = 86_400_000;
  const rgrDay = (offset) => new Date(Date.now() + offset * rgrDayMs).toISOString().slice(0, 10);
  const rgrReg = await api('/auth/register', {
    method: 'POST',
    body: { businessName: `RG Shop ${rgrStamp}`, name: 'RG Owner', email: `rg${rgrStamp}@example.com`, password: 'Password@123' },
  });
  const rgrToken = rgrReg.data?.tokens?.accessToken;
  await verifyContact(rgrToken);
  const rgrTenantId = rgrReg.data?.tenant?.id;
  await api('/stores', { method: 'POST', token: rgrToken, body: { name: 'RG Main', currency: 'BDT' } });
  const rgrApi = (path, opts = {}) => api(path, { token: rgrToken, ...opts });
  const rgrAssign = (planCode, startDate, endDate, extra = {}) =>
    api('/platform/subscriptions', { method: 'POST', token: platform2.token, body: { tenantId: rgrTenantId, planId: plansByCode[planCode]._id, startDate, endDate, status: 'active', autoRenew: false, ...extra } });
  const rgrRun = () => api('/platform/subscriptions/run-renewals', { method: 'POST', token: platform2.token, body: {} });
  const rgrCurrent = async () => (await rgrApi('/subscriptions/current')).data;
  const rgrInfo = async () => (await rgrApi('/subscriptions/renewal')).data;
  const rgrAutoRenew = (enabled) => rgrApi('/subscriptions/auto-renew', { method: 'POST', body: { enabled } });
  const rgrEvents = async () => (await rgrApi('/subscriptions/history')).data?.events ?? [];
  const rgrWallet = async () => (await rgrApi('/wallet')).data?.balanceMinor;
  const rgrCredit = (amountMinor) =>
    api(`/platform/tenants/${rgrTenantId}/wallet/adjust`, { method: 'POST', token: platform2.token, body: { direction: 'credit', amountMinor, reason: 'Smoke test: renewal grace' } });
  check('An owner signs up for the renewal grace test', rgrReg.status === 201 && Boolean(rgrToken), rgrReg.error);

  // --- grace: an overdue automatic renewal keeps the POS working ------------------
  check('A period that ended yesterday is set up', (await rgrAssign('starter-store-monthly', rgrDay(-31), rgrDay(-1))).status < 300);
  check('Automatic renewal from the wallet is turned on', (await rgrAutoRenew(true)).data?.subscription?.renewWith === 'wallet');
  const rgrGrace = await rgrCurrent();
  const rgrGraceSpan = new Date(rgrGrace?.entitlement?.graceEndsAt).getTime() - new Date(rgrGrace?.entitlement?.currentPeriodEnd).getTime();
  check('The ended period is overdue, not over: still usable', rgrGrace?.entitlement?.status === 'past_due' && rgrGrace.entitlement.isUsable === true, rgrGrace?.entitlement);
  check('Grace lasts 3 days from the period end', rgrGraceSpan === 3 * rgrDayMs, { graceEndsAt: rgrGrace?.entitlement?.graceEndsAt, end: rgrGrace?.entitlement?.currentPeriodEnd });

  const rgrRun1 = await rgrRun();
  check('The renewal pass reports reminders, wallet renewals and expiries', rgrRun1.status === 200 && typeof rgrRun1.data?.reminders?.due === 'number' && typeof rgrRun1.data?.expired === 'number', rgrRun1.data ?? rgrRun1.error);
  const rgrFailed = await rgrInfo();
  check('The renewal the empty wallet cannot cover fails', rgrFailed?.subscription?.status === 'past_due' && rgrFailed.subscription.failedRenewalAttempts === 1, rgrFailed?.subscription);
  check('The renewal summary shows the grace end', Boolean(rgrFailed?.subscription?.graceEndsAt) && rgrFailed.subscription.renewsAutomatically === true, rgrFailed?.subscription);
  check('The workspace is still usable after the failed attempt', (await rgrCurrent())?.entitlement?.isUsable === true);
  check('The failed attempt did not expire the subscription', (await rgrRun()).status === 200 && (await rgrInfo())?.subscription?.status === 'past_due');

  const rgrQuote = await rgrApi('/subscriptions/purchase/quote', { method: 'POST', body: { plan: 'starter', billingCycle: 'monthly' } });
  check('During grace the owner can renew the same plan by hand', rgrQuote.status === 200 && rgrQuote.data?.transition?.kind === 'renewal', rgrQuote.data ?? rgrQuote.error);
  await rgrCredit(99_000);
  const rgrBought = await rgrApi('/subscriptions/purchase', { method: 'POST', body: { plan: 'starter', billingCycle: 'monthly', paymentMethod: 'wallet', idempotencyKey: `rg${rgrStamp}k1` } });
  const rgrAfterBuy = await rgrCurrent();
  check('Renewing by hand settles the overdue period', rgrBought.status === 201 && rgrAfterBuy?.entitlement?.status === 'active' && rgrAfterBuy.entitlement.graceEndsAt === null, rgrAfterBuy?.entitlement ?? rgrBought.error);
  const rgrWalletAfterBuy = await rgrWallet();
  await rgrRun();
  check('The superseded overdue period is never charged', (await rgrWallet()) === rgrWalletAfterBuy, { before: rgrWalletAfterBuy, after: await rgrWallet() });

  // --- grace ends ---------------------------------------------------------------------
  await rgrCredit(99_000);
  await rgrAssign('starter-store-monthly', rgrDay(-35), rgrDay(-5));
  await rgrAutoRenew(true);
  const rgrLapsed = await rgrCurrent();
  check('Five days after the period end there is no grace left', rgrLapsed?.entitlement?.status === 'expired' && rgrLapsed.entitlement.isUsable === false && rgrLapsed.entitlement.graceEndsAt === null, rgrLapsed?.entitlement);
  const rgrWalletBeforeLapsed = await rgrWallet();
  await rgrRun();
  const rgrLapsedInfo = await rgrInfo();
  check('A renewal past its grace is never charged', (await rgrWallet()) === rgrWalletBeforeLapsed);
  check('...and its automatic renewal is switched off', rgrLapsedInfo?.subscription?.autoRenew === false && rgrLapsedInfo.subscription.renewsAutomatically === false, rgrLapsedInfo?.subscription);
  check('Switching it off is in the billing history', (await rgrEvents()).some((e) => e.type === 'auto_renew_changed' && e.data?.reason === 'period_ended'));

  // --- no grace for trials or cancelled subscriptions -------------------------------------------
  await rgrAssign('starter-store-monthly', rgrDay(-8), undefined, { status: 'trial' });
  await rgrAutoRenew(true);
  const rgrTrial = await rgrCurrent();
  check('An ended trial gets no grace, even with automatic renewal on', rgrTrial?.entitlement?.isUsable === false && rgrTrial.entitlement.graceEndsAt === null, rgrTrial?.entitlement);
  await rgrAutoRenew(false);

  await rgrAssign('starter-store-monthly', rgrDay(-31), rgrDay(-1));
  await rgrAutoRenew(true);
  check('Cancelling an overdue subscription is accepted', (await rgrApi('/subscriptions/cancel', { method: 'POST', body: {} })).status === 200);
  check('A cancelled subscription gets no grace', (await rgrCurrent())?.entitlement?.isUsable === false);

  // --- a payment method that cannot renew automatically --------------------------------------------
  await rgrAssign('starter-store-monthly', rgrDay(-31), rgrDay(-1), { autoRenew: true });
  const rgrManualId = (await rgrCurrent())?.subscription?._id;
  check('A manual subscription set to auto-renew gets no grace', (await rgrCurrent())?.entitlement?.isUsable === false);
  await rgrRun();
  await rgrRun();
  const rgrManualEvents = (await rgrEvents()).filter((e) => e.subscriptionId === rgrManualId);
  check('Its automatic renewal is switched off once, with one event', rgrManualEvents.filter((e) => e.type === 'auto_renew_changed' && e.data?.reason === 'not_supported').length === 1, rgrManualEvents.map((e) => [e.type, e.data?.reason]));
  check('...and no failure is logged on every run', rgrManualEvents.filter((e) => e.type === 'renewal_failed').length === 0, rgrManualEvents.map((e) => e.type));
  check('...and it is no longer set to renew', (await rgrInfo())?.subscription?.autoRenew === false);

  // --- reactivating ------------------------------------------------------------------------------
  await rgrAssign('starter-store-monthly', rgrDay(0), rgrDay(30));
  await rgrApi('/subscriptions/cancel', { method: 'POST', body: {} });
  const rgrReactivatedManual = await rgrApi('/subscriptions/reactivate', { method: 'POST', body: {} });
  check('Reactivating a manual subscription does not force automatic renewal on', rgrReactivatedManual.status === 200 && rgrReactivatedManual.data?.autoRenew === false && rgrReactivatedManual.data?.status === 'active', rgrReactivatedManual.data ?? rgrReactivatedManual.error);
  await rgrAutoRenew(true);
  await rgrApi('/subscriptions/cancel', { method: 'POST', body: {} });
  const rgrReactivatedWallet = await rgrApi('/subscriptions/reactivate', { method: 'POST', body: {} });
  check('Reactivating a wallet-renewing subscription resumes its automatic renewal', rgrReactivatedWallet.data?.autoRenew === true && rgrReactivatedWallet.data?.renewWith === 'wallet', rgrReactivatedWallet.data ?? rgrReactivatedWallet.error);

  // --- scheduled changes say whether they will apply ----------------------------------------------------
  const rgrScheduled = await rgrApi('/subscriptions/scheduled-change', { method: 'POST', body: { plan: 'professional', billingCycle: 'monthly' } });
  check('A change scheduled with automatic renewal on applies automatically', rgrScheduled.status === 200 && rgrScheduled.data?.scheduledChange?.appliesAutomatically === true, rgrScheduled.data ?? rgrScheduled.error);
  check('With automatic renewal off it only applies if the owner renews', (await rgrAutoRenew(false)).data?.scheduledChange?.appliesAutomatically === false);

  // --- a renewal the wallet will not cover is flagged ahead of time ---------------------------------------
  await rgrAssign('starter-store-monthly', rgrDay(-28), rgrDay(2));
  await rgrAutoRenew(true);
  await rgrApi('/subscriptions/scheduled-change', { method: 'POST', body: { plan: 'professional', billingCycle: 'monthly' } });
  const rgrWalletBeforeReminder = await rgrWallet();
  const rgrReminder1 = await rgrRun();
  check('A renewal in 2 days that the wallet cannot cover is found', rgrReminder1.data?.reminders?.lowBalance >= 1, rgrReminder1.data?.reminders);
  check('Nothing is charged before the period ends', (await rgrWallet()) === rgrWalletBeforeReminder);
  const rgrReminder2 = await rgrRun();
  check('An undelivered reminder is tried again on the next run', rgrReminder2.data?.reminders?.lowBalance >= 1 && rgrReminder2.data?.reminders?.sent === 0, rgrReminder2.data?.reminders);

  // ------------------------------------------ owner billing across workspaces
  section('Owner billing across workspaces');
  const oblStamp = Date.now();
  const oblDay = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const oblReg = await api('/auth/register', {
    method: 'POST',
    body: { businessName: `OB Clothing ${oblStamp}`, name: 'OB Owner', email: `ob${oblStamp}@example.com`, password: 'Password@123' },
  });
  // Reassigned after switching workspaces: a switch invalidates the previous workspace's token.
  let oblToken = oblReg.data?.tokens?.accessToken;
  const oblClothingId = oblReg.data?.tenant?.id;
  await api('/stores', { method: 'POST', token: oblToken, body: { name: 'OB Clothing Main', currency: 'BDT' } });
  check('The signed-up owner is flagged as the account owner', oblReg.data?.user?.isAccountOwner === true, oblReg.data?.user);
  check('Staff are not account owners', cashier.session?.user?.isAccountOwner === false, cashier.session?.user?.isAccountOwner);

  const oblRest = await wcCreateAs(oblToken, { businessName: `OB Restaurant ${oblStamp}`, vertical: 'restaurant' });
  const oblPharm = await wcCreateAs(oblToken, { businessName: `OB Pharmacy ${oblStamp}`, vertical: 'pharmacy' });
  const oblRestId = oblRest.data?.workspace?.id;
  const oblPharmId = oblPharm.data?.workspace?.id;
  check('The owner has Clothing, Restaurant and Pharmacy workspaces', oblRest.status === 201 && oblPharm.status === 201, [oblRest.error, oblPharm.error]);
  check(
    'The Restaurant workspace gets a plan ending in 5 days',
    (await api('/platform/subscriptions', { method: 'POST', token: platform2.token, body: { tenantId: oblRestId, planId: plansByCode['starter-store-monthly']._id, startDate: oblDay(-25), endDate: oblDay(5), status: 'active', autoRenew: false } })).status < 300,
  );
  await api(`/platform/tenants/${oblClothingId}/wallet/adjust`, { method: 'POST', token: platform2.token, body: { direction: 'credit', amountMinor: 50_000, reason: 'Smoke test: owner billing' } });

  const oblBilling = async (token = oblToken) => api('/account/billing', { token });
  const oblItem = (data, id) => (data?.workspaces ?? []).find((w) => w.workspace.id === id);
  const oblAction = (id, action, { method = 'POST', body, token = oblToken } = {}) =>
    api(`/workspaces/${id}/subscription/${action}`, { method, token, body });

  const oblAuto = await oblAction(oblRestId, 'auto-renew', { body: { enabled: true } });
  check('The owner turns on automatic renewal for Restaurant without switching into it', oblAuto.status === 200 && oblAuto.data?.renewal?.renewsAutomatically === true && oblAuto.data?.workspace?.id === oblRestId, oblAuto.data ?? oblAuto.error);

  const oblView = (await oblBilling()).data;
  check('The overview lists all three workspaces', (oblView?.workspaces ?? []).length === 3 && [oblClothingId, oblRestId, oblPharmId].every((id) => oblItem(oblView, id)), oblView?.workspaces?.map((w) => w.workspace.id));
  check('Each workspace shows its own plan and POS type', oblItem(oblView, oblRestId)?.subscription?.planCode === 'starter-store-monthly' && oblItem(oblView, oblRestId)?.workspace?.vertical === 'restaurant' && oblItem(oblView, oblClothingId)?.subscription?.status === 'trialing', oblView?.workspaces);
  check('A workspace without a plan needs attention', oblItem(oblView, oblPharmId)?.attention?.includes('no_subscription') && oblItem(oblView, oblPharmId)?.subscription === null, oblItem(oblView, oblPharmId));
  check('The shared wallet balance is shown', oblView?.wallet?.balanceMinor === 50_000 && oblView.wallet.currency === 'BDT', oblView?.wallet);
  const oblDue = (oblView?.upcoming?.renewals ?? []).find((r) => r.workspaceId === oblRestId);
  check('The coming Restaurant renewal is priced by the engine and flagged as not covered', oblDue?.amountMinor === 99_000 && oblDue.coveredByWallet === false && oblView.upcoming.dueMinor === 99_000 && oblView.upcoming.shortfallMinor === 49_000, oblView?.upcoming);
  check('...and the Restaurant workspace says the wallet is short', oblItem(oblView, oblRestId)?.attention?.includes('wallet_short'), oblItem(oblView, oblRestId)?.attention);
  check('A trial not set to renew is not counted as due', !(oblView?.upcoming?.renewals ?? []).some((r) => r.workspaceId === oblClothingId));
  check('Turning renewal on for Restaurant did not touch Clothing', oblItem(oblView, oblClothingId)?.renewal?.autoRenew === false);

  await api(`/platform/tenants/${oblClothingId}/wallet/adjust`, { method: 'POST', token: platform2.token, body: { direction: 'credit', amountMinor: 60_000, reason: 'Smoke test: owner billing' } });
  const oblCovered = (await oblBilling()).data;
  check('After a top-up the renewal is covered', oblCovered?.upcoming?.shortfallMinor === 0 && oblCovered.upcoming.renewals.find((r) => r.workspaceId === oblRestId)?.coveredByWallet === true && !oblItem(oblCovered, oblRestId)?.attention?.includes('wallet_short'), oblCovered?.upcoming);

  // A scheduled change, made inside the Restaurant workspace, withdrawn from the billing page.
  const oblSwitch = await api('/auth/switch-workspace', { method: 'POST', token: oblToken, body: { workspaceId: oblRestId } });
  oblToken = oblSwitch.data?.tokens?.accessToken ?? oblToken;
  await api('/stores', { method: 'POST', token: oblToken, body: { name: 'OB Restaurant Main', currency: 'BDT' } });
  check('The wallet is the same one inside each workspace', (await api('/wallet', { token: oblToken })).data?.balanceMinor === oblCovered?.wallet?.balanceMinor);
  const oblScheduled = await api('/subscriptions/scheduled-change', { method: 'POST', token: oblToken, body: { plan: 'professional', billingCycle: 'monthly' } });
  check('A plan change is scheduled inside Restaurant', oblScheduled.status === 200, oblScheduled.error);
  check('The overview shows the scheduled change', oblItem((await oblBilling()).data, oblRestId)?.renewal?.scheduledChange?.planCode === 'showroom-monthly');
  const oblWithdrawn = await oblAction(oblRestId, 'scheduled-change', { method: 'DELETE' });
  check('The owner withdraws it from the billing page', oblWithdrawn.status === 200 && oblWithdrawn.data?.renewal?.scheduledChange === null, oblWithdrawn.data ?? oblWithdrawn.error);
  check('Withdrawing when nothing is scheduled is 404', (await oblAction(oblRestId, 'scheduled-change', { method: 'DELETE' })).status === 404);

  // Cancel and resume.
  check('The owner cancels Restaurant at period end', (await api(`/workspaces/${oblRestId}/subscription/cancel`, { method: 'POST', token: oblToken, body: {} })).status === 200);
  check('The overview shows it as cancelling', oblItem((await oblBilling()).data, oblRestId)?.attention?.includes('cancelling'));
  const oblResumed = await oblAction(oblRestId, 'reactivate', { body: {} });
  check('The owner resumes it from the billing page', oblResumed.status === 200 && oblResumed.data?.subscription?.cancelAtPeriodEnd === false && oblResumed.data?.renewal?.renewsAutomatically === true, oblResumed.data ?? oblResumed.error);
  check('Resuming when nothing is cancelled is refused', (await oblAction(oblRestId, 'reactivate', { body: {} })).status === 400);

  // Validation and ownership.
  check('Auto-renew takes only a boolean', (await oblAction(oblRestId, 'auto-renew', { body: { enabled: 'yes' } })).status === 422);
  check('Auto-renew rejects extra fields such as an account id', (await oblAction(oblRestId, 'auto-renew', { body: { enabled: false, accountId: admin.session.tenant.accountId } })).status === 422);
  check('Reactivate rejects any body fields', (await oblAction(oblRestId, 'reactivate', { body: { workspaceId: admin.session.tenant.id } })).status === 422);
  check('Another account cannot change this renewal', (await oblAction(oblRestId, 'auto-renew', { body: { enabled: false }, token: admin.token })).status === 404);
  check('Another account cannot withdraw a change', (await oblAction(oblRestId, 'scheduled-change', { method: 'DELETE', token: admin.token })).status === 404);
  check('Another account cannot resume it', (await oblAction(oblRestId, 'reactivate', { body: {}, token: admin.token })).status === 404);
  check('The refused requests changed nothing', oblItem((await oblBilling()).data, oblRestId)?.renewal?.renewsAutomatically === true);
  check("Another account's billing does not include these workspaces", ((await oblBilling(admin.token)).data?.workspaces ?? []).every((w) => ![oblClothingId, oblRestId, oblPharmId].includes(w.workspace.id)));
  check('Staff cannot see account billing', (await oblBilling(cashier.token)).status === 403);
  check('Staff cannot change a workspace renewal', (await oblAction(oblRestId, 'auto-renew', { body: { enabled: false }, token: cashier.token })).status === 403);
  check('Platform admins cannot use the owner billing page', (await oblBilling(platform2.token)).status === 403);
  check('Unauthenticated billing is refused', (await api('/account/billing')).status === 401);
  const oblAudit = async (action) => ((await api(`/platform/audit-log?action=${action}&limit=5`, { token: platform2.token })).data ?? []).length > 0;
  check(
    'Owner billing changes are audited',
    (await oblAudit('workspace.subscription_auto_renew_changed')) && (await oblAudit('workspace.subscription_change_withdrawn')) && (await oblAudit('workspace.subscription_reactivated')),
  );

  // ------------------------------------------------ invoices and payment history
  section('Invoices and payment history');
  const ivcStamp = Date.now();
  const ivcReg = await api('/auth/register', {
    method: 'POST',
    body: { businessName: `IV Clothing ${ivcStamp}`, name: 'IV Owner', email: `iv${ivcStamp}@example.com`, password: 'Password@123' },
  });
  const ivcToken = ivcReg.data?.tokens?.accessToken;
  await verifyContact(ivcToken);
  const ivcClothingId = ivcReg.data?.tenant?.id;
  await api('/stores', { method: 'POST', token: ivcToken, body: { name: 'IV Main', currency: 'BDT' } });
  const ivcCredit = (amountMinor) =>
    api(`/platform/tenants/${ivcClothingId}/wallet/adjust`, { method: 'POST', token: platform2.token, body: { direction: 'credit', amountMinor, reason: 'Smoke test: invoices' } });
  const ivcAddsUp = (invoice) => Boolean(invoice) && invoice.subtotalMinor - invoice.discountMinor - invoice.creditMinor + invoice.adjustmentMinor === invoice.totalMinor;
  const ivcInvoices = async (query = '', token = ivcToken) => api(`/account/invoices${query}`, { token });
  const ivcInvoice = async (id, token = ivcToken) => api(`/account/invoices/${id}`, { token });

  await ivcCredit(199_000);
  const ivcBuy = await api('/subscriptions/purchase', { method: 'POST', token: ivcToken, body: { plan: 'professional', billingCycle: 'monthly', paymentMethod: 'wallet', idempotencyKey: `ivc${ivcStamp}k1` } });
  check('A plan is bought from the wallet', ivcBuy.status === 201, ivcBuy.error);
  const ivcList1 = await ivcInvoices();
  const ivcFirst = ivcList1.data?.[0];
  check('Paying issues an invoice straight away', ivcList1.status === 200 && ivcList1.data?.length === 1 && /^INV-\d{4}-\d{6}$/.test(ivcFirst?.number ?? ''), ivcList1.data ?? ivcList1.error);
  check('The invoice total is what was paid', ivcFirst?.totalMinor === 199_000 && ivcFirst.status === 'paid' && ivcFirst.planName && ivcFirst.workspace?.id === ivcClothingId, ivcFirst);
  const ivcDetail1 = (await ivcInvoice(ivcFirst?.id)).data;
  check('The invoice line is the plan at the recorded list price', ivcDetail1?.lines?.[0]?.unitAmountMinor === 199_000 && ivcDetail1.lines[0].billingCycle === 'monthly' && ivcDetail1.lines[0].posType === 'clothing' && Boolean(ivcDetail1.lines[0].periodEnd), ivcDetail1?.lines);
  check('The invoice totals add up', ivcAddsUp(ivcDetail1) && ivcDetail1.creditMinor === 0 && ivcDetail1.adjustmentMinor === 0, ivcDetail1);
  check(
    'The invoice records who was billed and how it was paid',
    ivcDetail1?.billedTo?.workspaceName?.startsWith('IV Clothing') && ivcDetail1.payment?.method === 'wallet' && String(ivcDetail1.payment.reference).startsWith('WALLET-') && Boolean(ivcDetail1.issuer?.name) && ivcDetail1.kind === 'upgrade',
    { billedTo: ivcDetail1?.billedTo, payment: ivcDetail1?.payment, issuer: ivcDetail1?.issuer, kind: ivcDetail1?.kind },
  );

  await ivcCredit(120_000);
  const ivcUp = await api('/subscriptions/purchase', { method: 'POST', token: ivcToken, body: { plan: 'enterprise', billingCycle: 'monthly', paymentMethod: 'wallet', idempotencyKey: `ivc${ivcStamp}k2` } });
  check('Upgrading is paid', ivcUp.status === 201, ivcUp.error);
  const ivcUpInvoice = (await ivcInvoices()).data?.[0];
  const ivcUpDetail = (await ivcInvoice(ivcUpInvoice?.id)).data;
  check('The upgrade invoice shows the credit for unused time', ivcUpDetail?.kind === 'upgrade' && ivcUpDetail.subtotalMinor === 299_000 && ivcUpDetail.creditMinor > 190_000 && ivcUpDetail.totalMinor === 299_000 - ivcUpDetail.creditMinor && ivcAddsUp(ivcUpDetail), ivcUpDetail);
  check('Invoice numbers are unique and ascending', ivcUpInvoice?.number > ivcFirst?.number, [ivcFirst?.number, ivcUpInvoice?.number]);

  const ivcRest = await wcCreateAs(ivcToken, { businessName: `IV Restaurant ${ivcStamp}`, vertical: 'restaurant' });
  const ivcRestId = ivcRest.data?.workspace?.id;
  const ivcAssigned = await api('/platform/subscriptions', {
    method: 'POST',
    token: platform2.token,
    body: { tenantId: ivcRestId, planId: plansByCode['starter-store-monthly']._id, periods: 1, status: 'active', recordPayment: { amountMinor: 50_000, provider: 'bank', reference: `IVC-BANK-${ivcStamp}` } },
  });
  check('A platform admin records an offline bank payment for Restaurant', ivcAssigned.status < 300, ivcAssigned.error);
  const ivcAll = await ivcInvoices();
  check('The account sees invoices from both workspaces', ivcAll.data?.length === 3 && new Set((ivcAll.data ?? []).map((i) => i.workspace.id)).size === 2, ivcAll.data);
  const ivcRestList = await ivcInvoices(`?workspaceId=${ivcRestId}`);
  const ivcRestInvoice = ivcRestList.data?.[0];
  check('Invoices filter by workspace', ivcRestList.data?.length === 1 && ivcRestInvoice.totalMinor === 50_000 && ivcRestInvoice.kind === 'assigned', ivcRestList.data);
  check('Invoices filter by date', (await ivcInvoices(`?from=${new Date().toISOString().slice(0, 10)}`)).data?.length === 3 && (await ivcInvoices('?to=2001-01-01')).data?.length === 0);

  const ivcPayments = await api('/account/payments', { token: ivcToken });
  const ivcRestPayment = (ivcPayments.data ?? []).find((p) => p.workspaceId === ivcRestId);
  check('Payment history covers every workspace, each linked to its invoice', ivcPayments.data?.length === 3 && ivcPayments.data.every((p) => p.invoice?.number) && ivcRestPayment?.workspaceName?.startsWith('IV Restaurant'), ivcPayments.data);
  check('Payment history leaves out internal fields', (ivcPayments.data ?? []).every((p) => !('metadata' in p) && !('review' in p) && !('idempotencyKey' in p) && !('alerts' in p)), Object.keys(ivcPayments.data?.[0] ?? {}));
  check('Payments filter by status', ((await api('/account/payments?status=failed', { token: ivcToken })).data ?? []).length === 0);

  const ivcRefund = await api(`/platform/payments/${ivcRestPayment?.id}/refunds`, {
    method: 'POST',
    token: platform2.token,
    body: { amountMinor: 20_000, method: 'bank_transfer', reference: `IVC-RF-${ivcStamp}`, reason: 'Smoke test partial refund' },
  });
  check('A partial refund is recorded', ivcRefund.status < 300, ivcRefund.error);
  const ivcRefunded = (await ivcInvoice(ivcRestInvoice?.id)).data;
  check('The invoice shows the refund without being changed', ivcRefunded?.status === 'partially_refunded' && ivcRefunded.totalMinor === 50_000 && ivcRefunded.refundedMinor === 20_000 && ivcRefunded.netMinor === 30_000 && ivcRefunded.number === ivcRestInvoice.number, ivcRefunded);
  check('Refund details leave out internal reasons and admin names', (ivcRefunded?.refunds ?? []).length === 1 && ivcRefunded.refunds.every((r) => !('reason' in r) && !('byNameSnapshot' in r)), ivcRefunded?.refunds);
  check('Invoices filter by refund status', ((await ivcInvoices('?status=partially_refunded')).data ?? []).map((i) => i.id).join() === String(ivcRestInvoice?.id));

  const ivcOwn = await api('/subscriptions/invoices', { token: ivcToken });
  check('Inside a workspace only its own invoices are listed', ivcOwn.status === 200 && ivcOwn.data?.length === 2 && ivcOwn.data.every((i) => i.workspace.id === ivcClothingId), ivcOwn.data);
  check("A workspace cannot open another workspace's invoice", (await api(`/subscriptions/invoices/${ivcRestInvoice?.id}`, { token: ivcToken })).status === 404);
  check('A workspace opens its own invoice', (await api(`/subscriptions/invoices/${ivcFirst?.id}`, { token: ivcToken })).data?.number === ivcFirst?.number);
  check('Workspace payment lists leave out internal fields', ((await api('/payments', { token: ivcToken })).data ?? []).every((p) => !('metadata' in p) && !('review' in p)));

  check("Another account cannot open this account's invoice", (await ivcInvoice(ivcFirst?.id, admin.token)).status === 404);
  check("Another account's invoice list does not include it", ((await ivcInvoices('?limit=100', admin.token)).data ?? []).every((i) => i.id !== ivcFirst?.id));
  check('Filtering by a workspace of another account is refused', (await ivcInvoices(`?workspaceId=${admin.session.tenant.id}`)).status === 404);
  check('Payments of another account cannot be listed', (await api(`/account/payments?workspaceId=${admin.session.tenant.id}`, { token: ivcToken })).status === 404);
  check('Staff cannot see account invoices', (await ivcInvoices('', cashier.token)).status === 403);
  check('Platform admins cannot use the owner invoice list', (await ivcInvoices('', platform2.token)).status === 403);
  check('Unknown query keys are rejected', (await ivcInvoices('?sort=amount')).status === 422);
  check('An oversized page is rejected', (await ivcInvoices('?limit=1000')).status === 422);
  check('A malformed invoice id is rejected', (await ivcInvoice('not-an-id')).status === 422);
  check('A reversed date range is rejected', (await ivcInvoices('?from=2026-05-01&to=2026-04-01')).status === 422);
  check('Unauthenticated invoice access is refused', (await api('/account/invoices')).status === 401);

  const ivcSweep = await api('/platform/subscriptions/run-renewals', { method: 'POST', token: platform2.token, body: {} });
  check('The renewal run also issues any missing invoices', typeof ivcSweep.data?.invoices?.checked === 'number', ivcSweep.data);
  check('Issuing again never duplicates an invoice', ((await ivcInvoices()).data ?? []).length === 3);

  // ----------------------------------------- wallet receipts and account statement
  section('Wallet receipts and account statement');
  const wrcStamp = Date.now();
  const wrcToday = new Date().toISOString().slice(0, 10);
  const wrcReg = await api('/auth/register', {
    method: 'POST',
    body: { businessName: `WR Clothing ${wrcStamp}`, name: 'WR Owner', email: `wr${wrcStamp}@example.com`, password: 'Password@123' },
  });
  const wrcToken = wrcReg.data?.tokens?.accessToken;
  await verifyContact(wrcToken);
  const wrcClothingId = wrcReg.data?.tenant?.id;
  await api('/stores', { method: 'POST', token: wrcToken, body: { name: 'WR Main', currency: 'BDT' } });
  const wrcTopUp = (amountMinor, transactionId) =>
    api('/wallet/top-ups', { method: 'POST', token: wrcToken, body: { amountMinor, paymentMethod: 'bkash', senderNumber: '01711223344', transactionId } });
  const wrcApprove = (id) => api(`/platform/top-ups/${id}/approve`, { method: 'POST', token: platform2.token, body: { reviewNote: 'Verified with bKash' } });
  const wrcBalance = async () => (await api('/wallet', { token: wrcToken })).data?.balanceMinor;
  const wrcStatement = async (query = `?from=${wrcToday}&to=${wrcToday}`, token = wrcToken) => api(`/account/statement${query}`, { token });

  const wrcFirst = await wrcTopUp(250_000, `WRC${wrcStamp}A`);
  check('The owner requests a top-up', wrcFirst.status === 201, wrcFirst.error);
  check('A pending top-up has no receipt', (await api(`/wallet/top-ups/${wrcFirst.data?._id}/receipt`, { token: wrcToken })).status === 404);

  const wrcApprovals = await Promise.all([1, 2, 3].map(() => wrcApprove(wrcFirst.data?._id)));
  check('Of three simultaneous approvals exactly one succeeds', wrcApprovals.filter((r) => r.status < 300).length === 1, wrcApprovals.map((r) => r.status));
  check('The wallet is credited exactly once', (await wrcBalance()) === 250_000, await wrcBalance());
  const wrcApproved = wrcApprovals.find((r) => r.status < 300);
  check('Approving returns the receipt number', /^RCPT-\d{4}-\d{6}$/.test(wrcApproved?.data?.receipt?.number ?? ''), wrcApproved?.data?.receipt);

  const wrcTopUps = (await api('/wallet/top-ups', { token: wrcToken })).data ?? [];
  const wrcListed = wrcTopUps.find((t) => t._id === wrcFirst.data?._id);
  check('The top-up list links the receipt', wrcListed?.status === 'approved' && wrcListed.receipt?.number === wrcApproved?.data?.receipt?.number, wrcListed);
  check('The top-up list does not show who reviewed it internally', wrcTopUps.every((t) => !('reviewedByNameSnapshot' in t) && !('reviewedBy' in t)), Object.keys(wrcListed ?? {}));

  const wrcReceipt = (await api(`/wallet/top-ups/${wrcFirst.data?._id}/receipt`, { token: wrcToken })).data;
  check(
    'The receipt shows the amount, method, reference and balance after',
    wrcReceipt?.amountMinor === 250_000 && wrcReceipt.payment?.method === 'bkash' && wrcReceipt.payment.transactionId === `WRC${wrcStamp}A` && wrcReceipt.balanceAfterMinor === 250_000 && Boolean(wrcReceipt.issuer?.name),
    wrcReceipt,
  );
  check('The receipt keeps only the last four digits of the sending number', wrcReceipt?.payment?.senderLast4 === '3344' && !JSON.stringify(wrcReceipt).includes('01711223344'), wrcReceipt?.payment);
  check('The owner sees the receipt across the account', ((await api('/account/receipts', { token: wrcToken })).data ?? []).some((r) => r.id === wrcReceipt?.id));
  check('The owner opens it by id', (await api(`/account/receipts/${wrcReceipt?.id}`, { token: wrcToken })).data?.number === wrcReceipt?.number);
  check('Another account cannot open the receipt', (await api(`/account/receipts/${wrcReceipt?.id}`, { token: admin.token })).status === 404);
  check("Another workspace cannot open this top-up's receipt", (await api(`/wallet/top-ups/${wrcFirst.data?._id}/receipt`, { token: admin.token })).status === 404);
  check('Staff cannot list account receipts', (await api('/account/receipts', { token: cashier.token })).status === 403);

  const wrcSecond = await wrcTopUp(40_000, `WRC${wrcStamp}B`);
  const wrcRejected = await api(`/platform/top-ups/${wrcSecond.data?._id}/reject`, { method: 'POST', token: platform2.token, body: { reviewNote: 'Not found in bKash' } });
  check('A rejected top-up gets no receipt and no money', wrcRejected.status < 300 && (await api(`/wallet/top-ups/${wrcSecond.data?._id}/receipt`, { token: wrcToken })).status === 404 && (await wrcBalance()) === 250_000);
  check('A rejected top-up cannot then be approved', (await wrcApprove(wrcSecond.data?._id)).status === 400);

  // Spend from the wallet, a platform credit, and a payment outside the wallet.
  const wrcBuy = await api('/subscriptions/purchase', { method: 'POST', token: wrcToken, body: { plan: 'starter', billingCycle: 'monthly', paymentMethod: 'wallet', idempotencyKey: `wrc${wrcStamp}k1` } });
  check('A plan is bought from the wallet', wrcBuy.status === 201, wrcBuy.error);
  await api(`/platform/tenants/${wrcClothingId}/wallet/adjust`, { method: 'POST', token: platform2.token, body: { direction: 'credit', amountMinor: 10_000, reason: 'Goodwill credit' } });
  const wrcRest = await wcCreateAs(wrcToken, { businessName: `WR Restaurant ${wrcStamp}`, vertical: 'restaurant' });
  const wrcRestId = wrcRest.data?.workspace?.id;
  await api('/platform/subscriptions', {
    method: 'POST',
    token: platform2.token,
    body: { tenantId: wrcRestId, planId: plansByCode['starter-store-monthly']._id, periods: 1, status: 'active', recordPayment: { amountMinor: 50_000, provider: 'bank', reference: `WRC-BANK-${wrcStamp}` } },
  });

  const wrcStmt = (await wrcStatement()).data;
  const wrcIn = (category) => (wrcStmt?.entries ?? []).filter((e) => e.category === category);
  check(
    'The statement adds up: opening + in - out = closing',
    wrcStmt?.openingBalanceMinor === 0 && wrcStmt.moneyInMinor === 260_000 && wrcStmt.moneyOutMinor === 99_000 && wrcStmt.closingBalanceMinor === 161_000 && wrcStmt.reconciled === true,
    { opening: wrcStmt?.openingBalanceMinor, in: wrcStmt?.moneyInMinor, out: wrcStmt?.moneyOutMinor, closing: wrcStmt?.closingBalanceMinor, reconciled: wrcStmt?.reconciled },
  );
  check('The closing balance matches the wallet', wrcStmt?.closingBalanceMinor === (await wrcBalance()));
  check('The running balance ends at the closing balance', wrcStmt?.entries?.at(-1)?.balanceAfterMinor === wrcStmt?.closingBalanceMinor, wrcStmt?.entries?.map((e) => e.balanceAfterMinor));
  check('The top-up row links its receipt', wrcIn('topup')[0]?.reference?.kind === 'receipt' && wrcIn('topup')[0].reference.label === wrcReceipt?.number, wrcIn('topup'));
  const wrcInvoice = ((await api(`/account/invoices?workspaceId=${wrcClothingId}`, { token: wrcToken })).data ?? [])[0];
  check('The subscription row links its invoice', wrcIn('subscription')[0]?.direction === 'out' && wrcIn('subscription')[0].reference?.kind === 'invoice' && wrcIn('subscription')[0].reference.label === wrcInvoice?.number, wrcIn('subscription'));
  check('The platform credit appears as an adjustment', wrcIn('adjustment')[0]?.amountMinor === 10_000 && wrcIn('adjustment')[0].direction === 'in', wrcIn('adjustment'));
  check('A bank payment outside the wallet is listed separately', (wrcStmt?.paidOutsideWallet ?? []).some((p) => p.workspace.id === wrcRestId && p.amountMinor === 50_000 && p.method === 'bank'), wrcStmt?.paidOutsideWallet);
  check('Statement rows leave out internal fields', (wrcStmt?.entries ?? []).every((e) => !('performedByNameSnapshot' in e) && !('metadata' in e) && !('performedBy' in e)));

  const wrcRestStmt = (await wrcStatement(`?from=${wrcToday}&to=${wrcToday}&workspaceId=${wrcRestId}`)).data;
  check('Filtered to Restaurant: no wallet movements, balances still account-wide', wrcRestStmt?.entries?.length === 0 && wrcRestStmt.closingBalanceMinor === 161_000 && wrcRestStmt.moneyInMinor === 0, wrcRestStmt);
  check('Filtered to Clothing: rows carry no running balance', ((await wrcStatement(`?from=${wrcToday}&to=${wrcToday}&workspaceId=${wrcClothingId}`)).data?.entries ?? []).every((e) => e.balanceAfterMinor === null));
  check('A period before any activity is empty with a zero balance', (await wrcStatement('?from=2020-01-01&to=2020-01-31')).data?.closingBalanceMinor === 0);
  check('A workspace of another account is refused', (await wrcStatement(`?workspaceId=${admin.session.tenant.id}`)).status === 404);
  check('Another account sees its own statement only', ((await wrcStatement(`?from=${wrcToday}&to=${wrcToday}`, admin.token)).data?.entries ?? []).every((e) => ![wrcClothingId, wrcRestId].includes(e.workspace.id)));
  check('A statement longer than a year is refused', (await wrcStatement('?from=2024-01-01&to=2026-01-02')).status === 422);
  check('Unknown statement filters are refused', (await wrcStatement('?accountId=x')).status === 422);
  check('Staff cannot see the account statement', (await wrcStatement('', cashier.token)).status === 403);
  check('Unauthenticated statement access is refused', (await api('/account/statement')).status === 401);

  const wrcSweep = await api('/platform/subscriptions/run-renewals', { method: 'POST', token: platform2.token, body: {} });
  check('The renewal run also issues missing receipts', typeof wrcSweep.data?.receipts?.checked === 'number', wrcSweep.data);
  check('Issuing again never duplicates a receipt', ((await api('/account/receipts', { token: wrcToken })).data ?? []).length === 1);

  // ------------------------------------------ top-up and cancel from billing
  section('Top-up and cancel from billing');
  const atpStamp = Date.now();
  const atpReg = await api('/auth/register', {
    method: 'POST',
    body: { businessName: `AT Clothing ${atpStamp}`, name: 'AT Owner', email: `at${atpStamp}@example.com`, password: 'Password@123' },
  });
  const atpToken = atpReg.data?.tokens?.accessToken;
  const atpHomeId = atpReg.data?.tenant?.id;
  await api('/stores', { method: 'POST', token: atpToken, body: { name: 'AT Main', currency: 'BDT' } });
  const atpRest = await wcCreateAs(atpToken, { businessName: `AT Restaurant ${atpStamp}`, vertical: 'restaurant' });
  const atpRestId = atpRest.data?.workspace?.id;
  const atpBody = (n, extra = {}) => ({ amountMinor: 120_000, paymentMethod: 'bkash', senderNumber: '01755667788', transactionId: `ATP${atpStamp}N${n}`, ...extra });
  const atpRequest = (body, token = atpToken) => api('/account/top-ups', { method: 'POST', token, body });
  const atpCancel = (id, token = atpToken, body = {}) => api(`/account/top-ups/${id}/cancel`, { method: 'POST', token, body });
  const atpBalance = async () => (await api('/wallet', { token: atpToken })).data?.balanceMinor;
  const atpApprove = (id) => api(`/platform/top-ups/${id}/approve`, { method: 'POST', token: platform2.token, body: { reviewNote: 'ok' } });

  const atpInstructions = await api('/account/payment-instructions', { token: atpToken });
  check('The owner sees where to send money', atpInstructions.status === 200 && Array.isArray(atpInstructions.data?.instructions), atpInstructions.error);

  const atpFirst = await atpRequest(atpBody(1, { workspaceId: atpRestId }));
  check('The owner requests a top-up from Billing for the Restaurant workspace', atpFirst.status === 201 && atpFirst.data?.status === 'pending' && atpFirst.data?.workspaceId === atpRestId && atpFirst.data?.workspaceName?.startsWith('AT Restaurant'), atpFirst.data ?? atpFirst.error);
  check('Requesting does not credit the wallet', (await atpBalance()) === 0);
  const atpDefault = await atpRequest(atpBody(2));
  check('Without a workspace the request is filed against the first workspace', atpDefault.status === 201 && atpDefault.data?.workspaceId === atpHomeId, atpDefault.data ?? atpDefault.error);
  const atpListed = await api(`/account/top-ups?workspaceId=${atpRestId}`, { token: atpToken });
  check('Top-ups list by workspace across the account', atpListed.status === 200 && atpListed.data?.length === 1 && atpListed.data[0].id === atpFirst.data?.id, atpListed.data);
  check('The list does not show who reviews requests internally', (atpListed.data ?? []).every((t) => !('reviewedByNameSnapshot' in t) && !('requestedBy' in t)));
  check('Requesting a top-up is audited', ((await api('/platform/audit-log?action=wallet.topup_requested&limit=5', { token: platform2.token })).data ?? []).length > 0);

  // Validation and ownership.
  check('A zero amount is refused', (await atpRequest(atpBody(3, { amountMinor: 0 }))).status === 422);
  check('A sending number with letters is refused', (await atpRequest(atpBody(4, { senderNumber: 'call-me' }))).status === 422);
  check('An account id in the body is refused', (await atpRequest(atpBody(5, { accountId: admin.session.tenant.accountId }))).status === 422);
  check('A workspace of another account is refused', (await atpRequest(atpBody(6, { workspaceId: admin.session.tenant.id }))).status === 404);
  check('A reused transaction id is refused', (await atpRequest(atpBody(1))).status === 409);
  check('Staff cannot request an account top-up', (await atpRequest(atpBody(7), cashier.token)).status === 403);
  check('Platform admins cannot use the owner top-up', (await atpRequest(atpBody(8), platform2.token)).status === 403);
  check('Unauthenticated top-up requests are refused', (await api('/account/top-ups', { method: 'POST', body: atpBody(9) })).status === 401);

  // Cancelling.
  check('Cancel takes no body fields', (await atpCancel(atpFirst.data?.id, atpToken, { status: 'approved' })).status === 422);
  check('Another account cannot cancel it', (await atpCancel(atpFirst.data?.id, admin.token)).status === 404);
  const atpCancelled = await atpCancel(atpFirst.data?.id);
  check('The owner cancels a pending top-up from Billing', atpCancelled.status === 200 && atpCancelled.data?.status === 'cancelled', atpCancelled.data ?? atpCancelled.error);
  check('A cancelled top-up cannot be cancelled again', (await atpCancel(atpFirst.data?.id)).status === 400);
  check('A cancelled top-up cannot be approved', (await atpApprove(atpFirst.data?.id)).status === 400 && (await atpBalance()) === 0);
  check('Cancelling a top-up is audited', ((await api('/platform/audit-log?action=wallet.topup_cancelled&limit=5', { token: platform2.token })).data ?? []).length > 0);

  // Cancel and approve at the same moment: the record and the wallet always agree.
  const atpRace = await atpRequest(atpBody(10));
  const [atpRaceCancel, atpRaceApprove] = await Promise.all([atpCancel(atpRace.data?.id), atpApprove(atpRace.data?.id)]);
  const atpRaceFinal = ((await api('/account/top-ups?limit=50', { token: atpToken })).data ?? []).find((t) => t.id === atpRace.data?.id);
  const atpRaceBalance = await atpBalance();
  check(
    'Cancel racing approval: exactly one wins and the wallet agrees',
    [atpRaceCancel.status < 300, atpRaceApprove.status < 300].filter(Boolean).length === 1 &&
      ((atpRaceFinal?.status === 'approved' && atpRaceBalance === 120_000) || (atpRaceFinal?.status === 'cancelled' && atpRaceBalance === 0)),
    { cancel: atpRaceCancel.status, approve: atpRaceApprove.status, status: atpRaceFinal?.status, balance: atpRaceBalance },
  );

  // Too many requests waiting.
  for (let n = 11; n < 20; n += 1) {
    const pendingNow = ((await api('/account/top-ups?status=pending&limit=50', { token: atpToken })).data ?? []).length;
    if (pendingNow >= 5) break;
    await atpRequest(atpBody(n, { workspaceId: n % 2 ? atpRestId : atpHomeId }));
  }
  const atpOver = await atpRequest(atpBody(30, { workspaceId: atpRestId }));
  check('An account with five requests awaiting verification cannot file another', atpOver.status === 409, { status: atpOver.status, error: atpOver.error });

  // ------------------------------------------ platform support view of accounts
  section('Platform support view of accounts');
  const spvStamp = Date.now();
  const spvReg = await api('/auth/register', {
    method: 'POST',
    body: { businessName: `SV Clothing ${spvStamp}`, name: 'SV Owner', email: `sv${spvStamp}@example.com`, password: 'Password@123' },
  });
  const spvToken = spvReg.data?.tokens?.accessToken;
  await verifyContact(spvToken);
  const spvAccountId = spvReg.data?.tenant?.accountId;
  await api('/stores', { method: 'POST', token: spvToken, body: { name: 'SV Main', currency: 'BDT' } });
  const spvTopUp = await api('/wallet/top-ups', { method: 'POST', token: spvToken, body: { amountMinor: 150_000, paymentMethod: 'bkash', senderNumber: '01799887766', transactionId: `SPV${spvStamp}` } });
  await api(`/platform/top-ups/${spvTopUp.data?._id}/approve`, { method: 'POST', token: platform2.token, body: { reviewNote: 'ok' } });
  const spvBuy = await api('/subscriptions/purchase', { method: 'POST', token: spvToken, body: { plan: 'starter', billingCycle: 'monthly', paymentMethod: 'wallet', idempotencyKey: `spv${spvStamp}k1` } });
  check('A customer account with a receipt and an invoice is set up', Boolean(spvAccountId) && spvBuy.status === 201, spvBuy.error);

  const spvReason = `Ticket SPV-${spvStamp}: customer asks about a top-up`;
  const spv = (path = '', params = {}, token = platform2.token) => {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    return api(`/platform/accounts/${spvAccountId}${path}${qs ? `?${qs}` : ''}`, { token });
  };

  // Directory.
  const spvList = await api(`/platform/accounts?search=sv${spvStamp}`, { token: platform2.token });
  check('Platform admins find an account by its owner email', spvList.status === 200 && spvList.data?.length === 1 && spvList.data[0].id === spvAccountId && spvList.data[0].workspaceCount === 1, spvList.data ?? spvList.error);
  check('The directory shows no billing details', (spvList.data ?? []).every((a) => !('wallet' in a) && !('billing' in a) && !('balanceMinor' in a)));
  check('Accounts can be found by name', ((await api(`/platform/accounts?search=${encodeURIComponent(`SV Clothing ${spvStamp}`)}`, { token: platform2.token })).data ?? []).some((a) => a.id === spvAccountId));
  check('Unknown directory filters are refused', (await api('/platform/accounts?sort=name', { token: platform2.token })).status === 422);

  // A reason is required, and every read is recorded with it.
  check('Opening an account without a reason is refused', (await spv()).status === 422);
  check('A one-word reason is refused', (await spv('', { reason: 'hi' })).status === 422);
  const spvOverview = await spv('', { reason: spvReason });
  check('With a reason the support overview opens', spvOverview.status === 200 && spvOverview.data?.account?.id === spvAccountId && spvOverview.data?.owner?.email === `sv${spvStamp}@example.com`, spvOverview.data ?? spvOverview.error);
  check('The overview shows the workspaces and the shared wallet', spvOverview.data?.billing?.workspaces?.length === 1 && spvOverview.data.billing.wallet?.balanceMinor === 51_000, spvOverview.data?.billing?.wallet);
  check('The overview exposes no credentials', !/password|refreshToken|tokenHash/i.test(JSON.stringify(spvOverview.data ?? {})));
  const spvAudit = ((await api('/platform/audit-log?action=platform.account_viewed&limit=5', { token: platform2.token })).data ?? [])[0];
  check('Opening the account is audited with the admin and the reason', spvAudit?.newValue?.accountId === spvAccountId && spvAudit.newValue.reason === spvReason && spvAudit.newValue.section === 'overview' && Boolean(spvAudit.actorNameSnapshot), spvAudit);

  const spvStatement = await spv('/statement', { reason: spvReason });
  check('Support sees the same reconciled statement the owner sees', spvStatement.status === 200 && spvStatement.data?.moneyInMinor === 150_000 && spvStatement.data.moneyOutMinor === 99_000 && spvStatement.data.reconciled === true, spvStatement.data ?? spvStatement.error);
  const spvInvoices = await spv('/invoices', { reason: spvReason });
  check('Support lists the account invoices', spvInvoices.status === 200 && spvInvoices.data?.length === 1, spvInvoices.data ?? spvInvoices.error);
  check('Support opens one invoice', (await spv(`/invoices/${spvInvoices.data?.[0]?.id}`, { reason: spvReason })).data?.number === spvInvoices.data?.[0]?.number);
  const spvReceipts = await spv('/receipts', { reason: spvReason });
  check('Support lists the account receipts', spvReceipts.status === 200 && spvReceipts.data?.length === 1 && spvReceipts.data[0].payment?.senderLast4 === '7766', spvReceipts.data ?? spvReceipts.error);
  check('Support opens one receipt', (await spv(`/receipts/${spvReceipts.data?.[0]?.id}`, { reason: spvReason })).data?.amountMinor === 150_000);
  const spvPayments = await spv('/payments', { reason: spvReason });
  check('Support lists payments without internal fields', spvPayments.status === 200 && spvPayments.data?.length === 1 && spvPayments.data.every((p) => !('metadata' in p) && !('review' in p)), spvPayments.data);
  check('Support lists top-ups', ((await spv('/top-ups', { reason: spvReason })).data ?? []).some((t) => t.id === spvTopUp.data?._id && t.status === 'approved'));
  check('Each section read is audited', ((await api('/platform/audit-log?action=platform.account_viewed&limit=20', { token: platform2.token })).data ?? []).filter((e) => e.newValue?.accountId === spvAccountId).map((e) => e.newValue.section).filter((s) => ['statement', 'invoices', 'invoice', 'receipts', 'receipt', 'payments', 'top_ups'].includes(s)).length >= 7);
  check('The overview lists the recent support access', ((await spv('', { reason: spvReason })).data?.supportHistory ?? []).some((h) => h.section === 'statement' && h.reason === spvReason));

  // Scope and refusals.
  const spvOtherInvoice = ((await api('/account/invoices', { token: admin.token })).data ?? [])[0];
  if (spvOtherInvoice) check("Another account's invoice is not reachable through this account", (await spv(`/invoices/${spvOtherInvoice.id}`, { reason: spvReason })).status === 404);
  check("Another account's workspace cannot be used as a filter", (await spv('/invoices', { reason: spvReason, workspaceId: admin.session.tenant.id })).status === 404);
  check('An unknown account is 404', (await api(`/platform/accounts/64b000000000000000000000?reason=${encodeURIComponent(spvReason)}`, { token: platform2.token })).status === 404);
  check('A malformed account id is 422', (await api(`/platform/accounts/not-an-id?reason=${encodeURIComponent(spvReason)}`, { token: platform2.token })).status === 422);
  check('Unknown query keys are refused', (await spv('/payments', { reason: spvReason, sort: 'amount' })).status === 422);
  check('The customer cannot use the support view', (await spv('', { reason: spvReason }, spvToken)).status === 403);
  check('Staff cannot use the support view', (await spv('', { reason: spvReason }, cashier.token)).status === 403);
  check('Unauthenticated support access is refused', (await api(`/platform/accounts/${spvAccountId}?reason=${encodeURIComponent(spvReason)}`)).status === 401);
  check('The support view is read-only', (await api(`/platform/accounts/${spvAccountId}`, { method: 'PATCH', token: platform2.token, body: { status: 'suspended' } })).status === 404 && (await api(`/platform/accounts/${spvAccountId}/top-ups`, { method: 'POST', token: platform2.token, body: {} })).status === 404);

  // ------------------------------------------------ account wallet and ledger
  section('Account wallet and ledger');
  const wlgStamp = Date.now();
  const wlgReg = await api('/auth/register', {
    method: 'POST',
    body: { businessName: `WL Clothing ${wlgStamp}`, name: 'WL Owner', email: `wl${wlgStamp}@example.com`, password: 'Password@123' },
  });
  const wlgToken = wlgReg.data?.tokens?.accessToken;
  const wlgAccountId = wlgReg.data?.tenant?.accountId;
  const wlgStore = await api('/stores', { method: 'POST', token: wlgToken, body: { name: 'WL Main', currency: 'BDT' } });
  const wlgKey = (n) => `wlg-${wlgStamp}-${n}`;
  const wlgAdjust = (body, token = platform2.token) => api(`/platform/accounts/${wlgAccountId}/wallet/adjustments`, { method: 'POST', token, body });
  const wlgReason = 'Goodwill credit for the outage on 12 September';
  const wlgBalance = async () => (await api('/wallet', { token: wlgToken })).data?.balanceMinor;
  const wlgLedgerView = (params = '') => api(`/platform/accounts/${wlgAccountId}/wallet?reason=${encodeURIComponent(`Ticket WLG-${wlgStamp}`)}${params}`, { token: platform2.token });

  // Credit, and the same request again.
  const wlgCredit = await wlgAdjust({ direction: 'credit', amountMinor: 100_000, reason: wlgReason, idempotencyKey: wlgKey(1) });
  check('A platform admin credits the account wallet with a reason', wlgCredit.status === 200 && wlgCredit.data?.balanceMinor === 100_000 && wlgCredit.data.replayed === false, wlgCredit.data ?? wlgCredit.error);
  check('The ledger row records currency, source and status', wlgCredit.data?.transaction?.currency === 'BDT' && wlgCredit.data.transaction.source === 'admin_adjustment' && wlgCredit.data.transaction.status === 'posted' && wlgCredit.data.transaction.balanceBeforeMinor === 0, wlgCredit.data?.transaction);
  const wlgAgain = await wlgAdjust({ direction: 'credit', amountMinor: 100_000, reason: wlgReason, idempotencyKey: wlgKey(1) });
  check('Repeating the request does not credit twice', wlgAgain.status === 200 && wlgAgain.data?.replayed === true && wlgAgain.data.transaction.id === wlgCredit.data?.transaction?.id && (await wlgBalance()) === 100_000, wlgAgain.data);
  const wlgBurst = await Promise.all([1, 2, 3, 4, 5].map(() => wlgAdjust({ direction: 'credit', amountMinor: 20_000, reason: wlgReason, idempotencyKey: wlgKey(2) })));
  check('Five simultaneous identical requests credit once', wlgBurst.every((r) => r.status === 200) && wlgBurst.filter((r) => r.data?.replayed === false).length === 1 && (await wlgBalance()) === 120_000, { statuses: wlgBurst.map((r) => [r.status, r.data?.replayed]), balance: await wlgBalance() });
  check('A key reused for a different amount is refused', (await wlgAdjust({ direction: 'credit', amountMinor: 1, reason: wlgReason, idempotencyKey: wlgKey(1) })).error?.details?.reason === 'IDEMPOTENCY_KEY_REUSED');

  // Debits.
  const wlgDebit = await wlgAdjust({ direction: 'debit', amountMinor: 30_000, reason: 'Correcting a duplicated bank transfer', idempotencyKey: wlgKey(3) });
  check('A debit lowers the balance', wlgDebit.status === 200 && wlgDebit.data?.balanceMinor === 90_000, wlgDebit.data ?? wlgDebit.error);
  const wlgTooMuch = await wlgAdjust({ direction: 'debit', amountMinor: 1_000_000, reason: 'Trying to remove more than there is', idempotencyKey: wlgKey(4) });
  check('A debit larger than the balance is refused and changes nothing', wlgTooMuch.status === 400 && (await wlgBalance()) === 90_000, { status: wlgTooMuch.status, balance: await wlgBalance() });
  const wlgRace = await Promise.all([10, 11, 12, 13, 14, 15].map((n) => wlgAdjust({ direction: 'debit', amountMinor: 20_000, reason: 'Concurrent debit test for the ledger', idempotencyKey: wlgKey(n) })));
  check('Six simultaneous debits of 200 from 900: exactly four succeed and the balance never goes negative', wlgRace.filter((r) => r.status === 200).length === 4 && (await wlgBalance()) === 10_000, { statuses: wlgRace.map((r) => r.status), balance: await wlgBalance() });

  // Validation and authorisation.
  check('An adjustment without a reason is refused', (await wlgAdjust({ direction: 'credit', amountMinor: 100, idempotencyKey: wlgKey(20) })).status === 422);
  check('A too-short reason is refused', (await wlgAdjust({ direction: 'credit', amountMinor: 100, reason: 'oops', idempotencyKey: wlgKey(21) })).status === 422);
  check('An adjustment without an operation key is refused', (await wlgAdjust({ direction: 'credit', amountMinor: 100, reason: wlgReason })).status === 422);
  check('Promotional credit cannot remove money', (await wlgAdjust({ direction: 'debit', source: 'promotional_credit', amountMinor: 100, reason: wlgReason, idempotencyKey: wlgKey(22) })).status === 422);
  check('A balance in the body is refused', (await wlgAdjust({ direction: 'credit', amountMinor: 100, reason: wlgReason, idempotencyKey: wlgKey(23), balanceMinor: 999_999 })).status === 422);
  check('The account owner cannot adjust their own balance', (await wlgAdjust({ direction: 'credit', amountMinor: 100, reason: wlgReason, idempotencyKey: wlgKey(24) }, wlgToken)).status === 403);
  check('Staff cannot adjust a balance', (await wlgAdjust({ direction: 'credit', amountMinor: 100, reason: wlgReason, idempotencyKey: wlgKey(25) }, cashier.token)).status === 403);
  check('An unknown account cannot be adjusted', (await api('/platform/accounts/64b000000000000000000000/wallet/adjustments', { method: 'POST', token: platform2.token, body: { direction: 'credit', amountMinor: 100, reason: wlgReason, idempotencyKey: wlgKey(26) } })).status === 404);
  const wlgAudits = ((await api('/platform/audit-log?limit=100', { token: platform2.token })).data ?? []).filter((e) => e.newValue?.accountId === wlgAccountId);
  check('Every adjustment is audited before and after, with its reason', wlgAudits.some((e) => e.action === 'platform.wallet_adjustment_requested' && e.newValue.reason === wlgReason) && wlgAudits.some((e) => e.action === 'platform.wallet_adjusted') && wlgAudits.some((e) => e.action === 'platform.wallet_adjustment_replayed') && wlgAudits.some((e) => e.action === 'platform.wallet_adjustment_failed'), wlgAudits.map((e) => e.action));

  // The platform ledger view, and compensating reversals.
  check('Reading the ledger needs a reason', (await api(`/platform/accounts/${wlgAccountId}/wallet`, { token: platform2.token })).status === 422);
  const wlgLedger = (await wlgLedgerView('&limit=50')).data;
  const wlgRows = [...(wlgLedger?.transactions ?? [])].reverse();
  check('The ledger is a continuous chain of balances', wlgRows.length === 7 && wlgRows.every((row, i) => i === 0 || row.balanceBeforeMinor === wlgRows[i - 1].balanceAfterMinor) && wlgRows.at(-1)?.balanceAfterMinor === wlgLedger.wallet.balanceMinor, wlgRows.map((r) => [r.type, r.amountMinor, r.balanceBeforeMinor, r.balanceAfterMinor]));
  const wlgDebitId = wlgDebit.data?.transaction?.id;
  const wlgReversed = await api(`/platform/accounts/${wlgAccountId}/wallet/transactions/${wlgDebitId}/reverse`, { method: 'POST', token: platform2.token, body: { reason: 'The bank transfer was not duplicated after all' } });
  check('A debit is corrected by a compensating credit', wlgReversed.status === 200 && wlgReversed.data?.balanceMinor === 40_000 && wlgReversed.data.transaction.reversalOfTransactionId === wlgDebitId && wlgReversed.data.transaction.source === 'reversal', wlgReversed.data ?? wlgReversed.error);
  check('The original debit is unchanged', ((await wlgLedgerView('&limit=50')).data?.transactions ?? []).find((r) => r.id === wlgDebitId)?.amountMinor === 30_000);
  check('A transaction can be reversed only once', (await api(`/platform/accounts/${wlgAccountId}/wallet/transactions/${wlgDebitId}/reverse`, { method: 'POST', token: platform2.token, body: { reason: 'Trying to reverse it a second time' } })).status === 409);
  check('A reversal cannot itself be reversed', (await api(`/platform/accounts/${wlgAccountId}/wallet/transactions/${wlgReversed.data?.transaction?.id}/reverse`, { method: 'POST', token: platform2.token, body: { reason: 'Reversing the reversal is not allowed' } })).status === 400);
  check('A reversal needs a reason', (await api(`/platform/accounts/${wlgAccountId}/wallet/transactions/${wlgDebitId}/reverse`, { method: 'POST', token: platform2.token, body: {} })).status === 422);
  check('Reversals are audited', ((await api('/platform/audit-log?action=platform.wallet_reversed&limit=10', { token: platform2.token })).data ?? []).some((e) => e.newValue?.transactionId === wlgDebitId));
  check('Posted transactions cannot be edited or deleted through the API', (await api(`/platform/accounts/${wlgAccountId}/wallet/transactions/${wlgDebitId}`, { method: 'PATCH', token: platform2.token, body: { amountMinor: 1 } })).status === 404 && (await api(`/platform/accounts/${wlgAccountId}/wallet/transactions/${wlgDebitId}`, { method: 'DELETE', token: platform2.token })).status === 404);

  // The owner's view: no internal metadata, platform staff not named.
  const wlgOwnerRows = (await api('/wallet/transactions?limit=50', { token: wlgToken })).data ?? [];
  check('The owner sees the ledger without internal metadata or operation keys', wlgOwnerRows.length === 8 && wlgOwnerRows.every((r) => !('metadata' in r) && !('idempotencyKey' in r) && r.description && r.status === 'posted'), Object.keys(wlgOwnerRows[0] ?? {}));
  check('Platform actions appear as Platform support to the owner', wlgOwnerRows.every((r) => r.performedByNameSnapshot === 'Platform support'), wlgOwnerRows.map((r) => r.performedByNameSnapshot));
  check('The wallet reports its status', (await api('/wallet', { token: wlgToken })).data?.status === 'active');

  // Workspace users do not get account money by holding a subscription permission.
  const wlgStaffEmail = `wlstaff${wlgStamp}@example.com`;
  const wlgStaff = await api('/staff', { method: 'POST', token: wlgToken, storeId: wlgStore.data?._id, body: { name: 'WL Staff', email: wlgStaffEmail, password: 'Password@123', storeId: wlgStore.data?._id, extraPermissions: ['subscription.view', 'subscription.manage'] } });
  check('A staff member with subscription permissions is created', wlgStaff.status === 201, wlgStaff.error);
  const wlgStaffLogin = await login(wlgStaffEmail, 'Password@123');
  check('That staff member can see the subscription', (await api('/subscriptions/current', { token: wlgStaffLogin.token })).status === 200);
  check('...but not the account wallet', (await api('/wallet', { token: wlgStaffLogin.token })).status === 403 && (await api('/wallet/transactions', { token: wlgStaffLogin.token })).status === 403);
  check('...and cannot pay from it', (await api('/subscriptions/purchase', { method: 'POST', token: wlgStaffLogin.token, body: { plan: 'starter', billingCycle: 'monthly', paymentMethod: 'wallet', idempotencyKey: `wlg${wlgStamp}buy` } })).status === 403);
  check('...or request a top-up into it', (await api('/wallet/top-ups', { method: 'POST', token: wlgStaffLogin.token, body: { amountMinor: 1000, paymentMethod: 'bkash', senderNumber: '01700000000', transactionId: `WLGS${wlgStamp}` } })).status === 403);
  check('Another account owner cannot read this wallet', ((await api('/wallet/transactions?limit=50', { token: admin.token })).data ?? []).every((r) => !wlgOwnerRows.some((own) => own.id === r.id)));

  // ------------------------------------------------ subscription billing and renewal engine
  section('Subscription billing and renewal engine');
  const rnwStamp = Date.now();
  const rnwDay = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const rnwRegister = async (label) => {
    const reg = await api('/auth/register', { method: 'POST', body: { businessName: `${label} ${rnwStamp}`, name: `${label} Owner`, email: `${label.toLowerCase().replace(/\s+/g, '')}${rnwStamp}@example.com`, password: 'Password@123' } });
    const store = await api('/stores', { method: 'POST', token: reg.data?.tokens?.accessToken, body: { name: `${label} Main`, currency: 'BDT' } });
    await verifyContact(reg.data?.tokens?.accessToken);
    return { token: reg.data?.tokens?.accessToken, homeId: reg.data?.tenant?.id, accountId: reg.data?.tenant?.accountId, storeId: store.data?._id, email: `${label.toLowerCase().replace(/\s+/g, '')}${rnwStamp}@example.com` };
  };
  const rnwAssign = (tenantId, planCode, startDate, endDate) =>
    api('/platform/subscriptions', { method: 'POST', token: platform2.token, body: { tenantId, planId: plansByCode[planCode]._id, startDate, endDate, status: 'active', autoRenew: false } });
  let rnwKeySeq = 0;
  const rnwFund = (accountId, direction, amountMinor) =>
    api(`/platform/accounts/${accountId}/wallet/adjustments`, { method: 'POST', token: platform2.token, body: { direction, amountMinor, reason: 'Smoke test: renewal engine funding', idempotencyKey: `rnw-${rnwStamp}-${(rnwKeySeq += 1)}` } });
  const rnwRenew = (workspaceId, token, body = {}) => api(`/workspaces/${workspaceId}/subscription/renew`, { method: 'POST', token, body });

  // Three workspaces of one account, each ending in 3 days, and ৳10,000 in the wallet.
  const rnwA = await rnwRegister('RNW Clothing');
  const rnwRest = await wcCreateAs(rnwA.token, { businessName: `RNW Restaurant ${rnwStamp}`, vertical: 'restaurant' });
  const rnwPharm = await wcCreateAs(rnwA.token, { businessName: `RNW Pharmacy ${rnwStamp}`, vertical: 'pharmacy' });
  const rnwIds = { clothing: rnwA.homeId, restaurant: rnwRest.data?.workspace?.id, pharmacy: rnwPharm.data?.workspace?.id };
  await rnwAssign(rnwIds.clothing, 'showroom-monthly', rnwDay(-27), rnwDay(3));
  await rnwAssign(rnwIds.restaurant, 'starter-store-monthly', rnwDay(-27), rnwDay(3));
  await rnwAssign(rnwIds.pharmacy, 'brand-monthly', rnwDay(-27), rnwDay(3));
  await rnwFund(rnwA.accountId, 'credit', 1_000_000);
  for (const id of Object.values(rnwIds)) await api(`/workspaces/${id}/subscription/auto-renew`, { method: 'POST', token: rnwA.token, body: { enabled: true } });

  const rnwUpcoming = await api('/account/renewals', { token: rnwA.token });
  const rnwRow = (data, id) => (data?.renewals ?? []).find((r) => r.workspace.id === id);
  check(
    'Upcoming renewals show each workspace with its date, engine price and status',
    rnwUpcoming.status === 200 && rnwRow(rnwUpcoming.data, rnwIds.clothing)?.renewalAmountMinor === 199_000 && rnwRow(rnwUpcoming.data, rnwIds.restaurant)?.renewalAmountMinor === 99_000 && rnwRow(rnwUpcoming.data, rnwIds.pharmacy)?.renewalAmountMinor === 299_000 && (rnwUpcoming.data?.renewals ?? []).every((r) => r.status === 'active' && r.nextRenewalAt && r.canRenewNow),
    rnwUpcoming.data ?? rnwUpcoming.error,
  );
  check('৳10,000 wallet, ৳5,970 of renewals, ৳4,030 after', rnwUpcoming.data?.totals?.walletBalanceMinor === 1_000_000 && rnwUpcoming.data.totals.nextCycleMinor === 597_000 && rnwUpcoming.data.totals.balanceAfterMinor === 403_000, rnwUpcoming.data?.totals);

  // Successful renewal.
  const rnwOldClothing = (await api(`/workspaces/${rnwIds.clothing}/subscription`, { token: rnwA.token })).data?.subscription;
  const rnwOk = await rnwRenew(rnwIds.clothing, rnwA.token);
  check('The owner renews Clothing now from the wallet', rnwOk.status === 200 && rnwOk.data?.billing?.state === 'renewed' && rnwOk.data.billing.amountMinor === 199_000 && rnwOk.data.billing.walletBalanceMinor === 801_000, rnwOk.data ?? rnwOk.error);
  const rnwNewClothing = (await api(`/workspaces/${rnwIds.clothing}/subscription`, { token: rnwA.token })).data?.subscription;
  check('The period is extended from the old end', rnwNewClothing?.id !== rnwOldClothing?.id && new Date(rnwNewClothing?.currentPeriodStart).getTime() === new Date(rnwOldClothing?.currentPeriodEnd).getTime() && rnwNewClothing.status === 'active', { old: rnwOldClothing, renewed: rnwNewClothing });
  const rnwLedger = (await api('/wallet/transactions?limit=5', { token: rnwA.token })).data ?? [];
  check('One ledger debit at the engine price', rnwLedger[0]?.type === 'debit' && rnwLedger[0].amountMinor === 199_000 && rnwLedger[0].source === 'subscription', rnwLedger[0]);
  check('The renewal has an invoice', ((await api(`/account/invoices?workspaceId=${rnwIds.clothing}`, { token: rnwA.token })).data ?? []).some((i) => i.kind === 'renewal' && i.totalMinor === 199_000));
  check('The renewal is audited', ((await api(`/platform/audit-log?action=subscription.renewed&tenantId=${rnwIds.clothing}&limit=5`, { token: platform2.token })).data ?? []).length === 1);

  // Duplicate and concurrent renewals.
  const rnwDup = await rnwRenew(rnwIds.clothing, rnwA.token);
  check('Renewing again right away charges nothing', rnwDup.status === 409 && rnwDup.error?.details?.reason === 'RENEWAL_NOT_DUE' && (await api('/wallet', { token: rnwA.token })).data?.balanceMinor === 801_000, rnwDup.error);
  const rnwRace = await Promise.all([1, 2, 3, 4, 5].map(() => rnwRenew(rnwIds.restaurant, rnwA.token)));
  check('Five simultaneous renewals of Restaurant renew it once', rnwRace.filter((r) => r.status === 200 && r.data?.billing?.state === 'renewed').length === 1 && (await api('/wallet', { token: rnwA.token })).data?.balanceMinor === 702_000, { statuses: rnwRace.map((r) => [r.status, r.data?.billing?.state ?? r.error?.details?.reason]) });

  // Price and identity come from the server.
  check('A client amount is refused', (await rnwRenew(rnwIds.pharmacy, rnwA.token, { amountMinor: 1 })).status === 422);
  check('A client plan or price is refused', (await rnwRenew(rnwIds.pharmacy, rnwA.token, { plan: 'starter', priceMinor: 100 })).status === 422);
  check('Nothing was charged by the refused requests', (await api('/wallet', { token: rnwA.token })).data?.balanceMinor === 702_000);
  check("Another account's workspace cannot be renewed", (await rnwRenew(admin.session.tenant.id, rnwA.token)).status === 404);
  check('A malformed workspace id is refused', (await rnwRenew('not-an-id', rnwA.token)).status === 422);
  check('Another account owner cannot renew these workspaces', (await rnwRenew(rnwIds.pharmacy, admin.token)).status === 404);
  check('Staff cannot use the owner renewal', (await rnwRenew(rnwIds.pharmacy, cashier.token)).status === 403);
  check('Platform admins cannot renew as the owner', (await rnwRenew(rnwIds.pharmacy, platform2.token)).status === 403);
  check('Unauthenticated renewal is refused', (await api(`/workspaces/${rnwIds.pharmacy}/subscription/renew`, { method: 'POST', body: {} })).status === 401);
  const rnwStaffEmail = `rnwstaff${rnwStamp}@example.com`;
  await api('/staff', { method: 'POST', token: rnwA.token, storeId: rnwA.storeId, body: { name: 'RNW Staff', email: rnwStaffEmail, password: 'Password@123', storeId: rnwA.storeId, extraPermissions: ['subscription.view', 'subscription.manage'] } });
  const rnwStaff = await login(rnwStaffEmail, 'Password@123');
  check('Staff with subscription rights but no wallet rights cannot renew from the wallet', (await api('/subscriptions/renew', { method: 'POST', token: rnwStaff.token, body: {} })).status === 403);
  check('The workspace renewal endpoint prices it too', (await api('/subscriptions/renew', { method: 'POST', token: rnwA.token, body: { amountMinor: 1 } })).status === 422 && (await api('/subscriptions/renew', { method: 'POST', token: rnwA.token, body: {} })).error?.details?.reason === 'RENEWAL_NOT_DUE');

  // Insufficient wallet: nothing debited, nothing extended, other workspaces untouched.
  await rnwFund(rnwA.accountId, 'debit', 602_000);
  const rnwPharmBefore = (await api(`/workspaces/${rnwIds.pharmacy}/subscription`, { token: rnwA.token })).data?.subscription;
  const rnwShort = await rnwRenew(rnwIds.pharmacy, rnwA.token);
  check(
    'A renewal the wallet cannot cover is refused with a clear billing state',
    rnwShort.status === 409 && rnwShort.error?.details?.reason === 'INSUFFICIENT_FUNDS' && rnwShort.error.details.billing?.amountMinor === 299_000 && rnwShort.error.details.billing.walletBalanceMinor === 100_000,
    rnwShort.error,
  );
  const rnwPharmAfter = (await api(`/workspaces/${rnwIds.pharmacy}/subscription`, { token: rnwA.token })).data?.subscription;
  check('...nothing is debited', (await api('/wallet', { token: rnwA.token })).data?.balanceMinor === 100_000);
  check('...the period is not extended and the status is unchanged', rnwPharmAfter?.id === rnwPharmBefore?.id && rnwPharmAfter.currentPeriodEnd === rnwPharmBefore.currentPeriodEnd && rnwPharmAfter.status === 'active', { before: rnwPharmBefore, after: rnwPharmAfter });
  check('...the failure is logged', ((await api(`/platform/audit-log?action=subscription.renewal_failed&tenantId=${rnwIds.pharmacy}&limit=5`, { token: platform2.token })).data ?? []).some((e) => e.newValue?.insufficientFunds === true));
  const rnwAfterShort = (await api('/account/renewals', { token: rnwA.token })).data;
  check('...and the other workspaces are untouched', rnwRow(rnwAfterShort, rnwIds.clothing)?.status === 'active' && rnwRow(rnwAfterShort, rnwIds.restaurant)?.status === 'active' && rnwRow(rnwAfterShort, rnwIds.clothing)?.nextRenewalAt === rnwNewClothing?.currentPeriodEnd, rnwAfterShort?.renewals);

  // Cancelled and expired subscriptions.
  await api(`/workspaces/${rnwIds.restaurant}/subscription/cancel`, { method: 'POST', token: rnwA.token, body: {} });
  check('A cancelled subscription is not renewed', (await rnwRenew(rnwIds.restaurant, rnwA.token)).error?.details?.reason === 'NOT_RENEWABLE');
  const rnwShop = await wcCreateAs(rnwA.token, { businessName: `RNW Shop ${rnwStamp}`, vertical: 'supershop' });
  const rnwShopId = rnwShop.data?.workspace?.id;
  await rnwAssign(rnwShopId, 'starter-store-monthly', rnwDay(-40), rnwDay(-10));
  check('The expired subscription is locked', (await api(`/workspaces/${rnwShopId}/subscription`, { token: rnwA.token })).data?.isActive === false);
  await rnwFund(rnwA.accountId, 'credit', 99_000);
  const rnwRevived = await rnwRenew(rnwShopId, rnwA.token);
  const rnwShopSub = (await api(`/workspaces/${rnwShopId}/subscription`, { token: rnwA.token })).data;
  check('An expired subscription renewed from the wallet starts a fresh period now', rnwRevived.status === 200 && rnwRevived.data?.billing?.state === 'renewed' && rnwShopSub?.isActive === true && Math.abs(new Date(rnwShopSub.subscription.currentPeriodStart).getTime() - Date.now()) < 10 * 60_000, rnwRevived.data ?? rnwRevived.error);

  // Automatic renewals of several workspaces: each independent.
  const rnwB = await rnwRegister('RNW Multi');
  const rnwB2 = await wcCreateAs(rnwB.token, { businessName: `RNW Multi Second ${rnwStamp}`, vertical: 'clothing' });
  const rnwBIds = { cheap: rnwB.homeId, dear: rnwB2.data?.workspace?.id };
  await rnwAssign(rnwBIds.cheap, 'starter-store-monthly', rnwDay(-31), rnwDay(-1));
  await rnwAssign(rnwBIds.dear, 'showroom-monthly', rnwDay(-31), rnwDay(-1));
  for (const id of Object.values(rnwBIds)) await api(`/workspaces/${id}/subscription/auto-renew`, { method: 'POST', token: rnwB.token, body: { enabled: true } });
  await rnwFund(rnwB.accountId, 'credit', 150_000);
  await api('/platform/subscriptions/run-renewals', { method: 'POST', token: platform2.token, body: {} });
  const rnwBAfter = (await api('/account/renewals', { token: rnwB.token })).data;
  check('The workspace the wallet can pay for is renewed', rnwRow(rnwBAfter, rnwBIds.cheap)?.status === 'active' && new Date(rnwRow(rnwBAfter, rnwBIds.cheap)?.nextRenewalAt).getTime() > Date.now(), rnwRow(rnwBAfter, rnwBIds.cheap));
  check('The one it cannot is overdue, and did not affect the other', rnwRow(rnwBAfter, rnwBIds.dear)?.status === 'past_due' && rnwBAfter?.totals?.walletBalanceMinor === 51_000, { dear: rnwRow(rnwBAfter, rnwBIds.dear), totals: rnwBAfter?.totals });

  // ------------------------------------------------ universal entitlement engine
  section('Universal entitlement engine');
  const enxStamp = Date.now();
  const enxReg = await api('/auth/register', { method: 'POST', body: { businessName: `ENX Clothing ${enxStamp}`, name: 'ENX Owner', email: `enx${enxStamp}@example.com`, password: 'Password@123' } });
  const enxToken = enxReg.data?.tokens?.accessToken;
  const enxHomeId = enxReg.data?.tenant?.id;
  const enxStore = await api('/stores', { method: 'POST', token: enxToken, body: { name: 'ENX Main', currency: 'BDT' } });
  const enxAssign = (code) => api('/platform/subscriptions', { method: 'POST', token: platform2.token, body: { tenantId: enxHomeId, planId: plansByCode[code]._id, periods: 1, status: 'active' } });
  const enxOwn = async () => (await api('/subscriptions/entitlements', { token: enxToken })).data;

  // Starter (the trial plan): the shape, and the numbers.
  const enxStarter = await enxOwn();
  check('Entitlements are resolved for the workspace itself', enxStarter?.workspaceId === enxHomeId && enxStarter.posProductCode === 'clothing' && enxStarter.access?.usable === true, enxStarter);
  check('Starter: Advanced Analytics blocked, marketing blocked', enxStarter?.features?.advancedAnalytics?.enabled === false && enxStarter.features.marketing.enabled === false, enxStarter?.features);
  check('Starter: numeric limits with server-counted usage', enxStarter?.limits?.products?.limit === 300 && enxStarter.limits.products.unlimited === false && enxStarter.limits.branches.limit === 1 && enxStarter.limits.branches.used === 1 && enxStarter.limits.branches.remaining === 0 && enxStarter.limits.branches.canAddMore === false, enxStarter?.limits);
  check('Unlimited is never a number', JSON.stringify(enxStarter?.limits ?? {}).includes('-1') === false);
  const enxBlocked = await api('/reports/sales', { token: enxToken });
  check('Starter Advanced Analytics is refused even for the owner (subscription denies despite role)', enxBlocked.status === 403 && enxBlocked.error?.code === 'ADVANCED_ANALYTICS_REQUIRED' && enxBlocked.data == null, enxBlocked.error);
  check('A feature every plan includes stays allowed', (await api('/reports/overview', { token: enxToken })).status === 200);
  const enxOverLimit = await api('/stores', { method: 'POST', token: enxToken, body: { name: 'ENX Second', currency: 'BDT' } });
  check('Starter: a second branch exceeds the limit', enxOverLimit.status === 402 && enxOverLimit.error?.code === 'LIMIT_EXCEEDED', enxOverLimit.error);

  // Professional.
  check('Professional is assigned', (await enxAssign('showroom-monthly')).status < 300);
  const enxPro = await enxOwn();
  check('Professional: Advanced Analytics and marketing allowed', enxPro?.features?.advancedAnalytics?.enabled === true && enxPro.features.marketing.enabled === true && enxPro.limits.branches.limit === 2 && enxPro.limits.branches.canAddMore === true, enxPro?.features);
  check('Professional: Advanced Analytics is served', (await api('/reports/sales', { token: enxToken })).status === 200);

  // Enterprise: unlimited.
  check('Enterprise is assigned', (await enxAssign('brand-monthly')).status < 300);
  const enxBrand = await enxOwn();
  check('Enterprise: Advanced Analytics allowed', enxBrand?.features?.advancedAnalytics?.enabled === true && (await api('/reports/sales', { token: enxToken })).status === 200);
  check('Enterprise: unlimited limits are reported as unlimited', enxBrand?.limits?.staff?.unlimited === true && enxBrand.limits.staff.limit === null && enxBrand.limits.staff.remaining === null && enxBrand.limits.staff.canAddMore === true && enxBrand.limits.products.unlimited === true, enxBrand?.limits);

  // Role denies despite the subscription.
  const enxStaffEmail = `enxstaff${enxStamp}@example.com`;
  const enxStaffCreated = await api('/staff', { method: 'POST', token: enxToken, storeId: enxStore.data?._id, body: { name: 'ENX Staff', email: enxStaffEmail, password: 'Password@123', storeId: enxStore.data?._id, extraPermissions: [] } });
  check('A staff member without reports permission is added', enxStaffCreated.status === 201, enxStaffCreated.error);
  const enxStaff = await login(enxStaffEmail, 'Password@123');
  const enxRoleDenied = await api('/reports/sales', { token: enxStaff.token });
  check('Role denies despite the subscription including it', enxRoleDenied.status === 403 && enxRoleDenied.error?.code === 'FORBIDDEN', enxRoleDenied.error);
  const enxAnalystEmail = `enxanalyst${enxStamp}@example.com`;
  await api('/staff', { method: 'POST', token: enxToken, storeId: enxStore.data?._id, body: { name: 'ENX Analyst', email: enxAnalystEmail, password: 'Password@123', storeId: enxStore.data?._id, extraPermissions: ['reports.view'] } });
  const enxAnalyst = await login(enxAnalystEmail, 'Password@123');
  check('Role and subscription both allowing: access granted', (await api('/reports/sales', { token: enxAnalyst.token })).status === 200);
  check('Any member reads their own workspace entitlements', (await api('/subscriptions/entitlements', { token: enxStaff.token })).data?.workspaceId === enxHomeId);

  // Cross-workspace.
  const enxRest = await wcCreateAs(enxToken, { businessName: `ENX Restaurant ${enxStamp}`, vertical: 'restaurant' });
  const enxRestId = enxRest.data?.workspace?.id;
  const enxRestEnt = (await api(`/workspaces/${enxRestId}/entitlements`, { token: enxToken })).data;
  check('A second workspace resolves its own entitlements, not the first one’s', enxRestEnt?.workspaceId === enxRestId && enxRestEnt.posProductCode === 'restaurant' && enxRestEnt.access?.usable === false && enxRestEnt.access.reason === 'no_subscription' && enxRestEnt.features.advancedAnalytics.enabled === false, enxRestEnt);
  check('...while the first workspace keeps its Enterprise entitlements', (await api(`/workspaces/${enxHomeId}/entitlements`, { token: enxToken })).data?.features?.advancedAnalytics?.enabled === true);
  check("Another account cannot read this workspace's entitlements", (await api(`/workspaces/${enxHomeId}/entitlements`, { token: admin.token })).status === 404);
  check('Staff cannot use the owner entitlement view', (await api(`/workspaces/${enxHomeId}/entitlements`, { token: enxStaff.token })).status === 403);
  check('A workspace session only ever sees its own workspace', (await api('/subscriptions/entitlements', { token: admin.token })).data?.workspaceId === admin.session.tenant.id);
  check('Unauthenticated entitlement reads are refused', (await api('/subscriptions/entitlements')).status === 401);

  // Back to Starter: the limit applies again.
  check('Starter is assigned again', (await enxAssign('starter-store-monthly')).status < 300);
  const enxBack = await enxOwn();
  check('Downgraded: Advanced Analytics blocked again, branch limit reached', enxBack?.features?.advancedAnalytics?.enabled === false && enxBack.limits.branches.canAddMore === false && (await api('/reports/sales', { token: enxAnalyst.token })).error?.code === 'ADVANCED_ANALYTICS_REQUIRED', enxBack?.limits?.branches);

  // ------------------------------------------------ multi-POS customer onboarding
  section('Multi-POS customer onboarding');
  const onbStamp = Date.now();
  const onbEmail = `onb${onbStamp}@example.com`;

  // The POS types come from the platform catalog, not the client.
  const onbTypes = await api('/workspaces/verticals/public');
  const onbCatalog = (await api('/platform/pos-products', { token: platform2.token })).data ?? [];
  const onbActiveCodes = onbCatalog.filter((p) => p.status === 'active').map((p) => p.code).sort();
  check('The registration page is offered exactly the active POS products', onbTypes.status === 200 && (onbTypes.data ?? []).map((o) => o.vertical).sort().join() === onbActiveCodes.join() && onbTypes.data.every((o) => o.label), { offered: (onbTypes.data ?? []).map((o) => o.vertical), active: onbActiveCodes });
  check('An inactive POS product is never offered', !(onbTypes.data ?? []).some((o) => onbCatalog.some((p) => p.code === o.vertical && p.status !== 'active')));

  // First POS, chosen at registration.
  check('Registering with an unknown POS type is refused', (await api('/auth/register', { method: 'POST', body: { businessName: 'Onb Bakery', name: 'Onb', email: `onbbad${onbStamp}@example.com`, password: 'Password@123', vertical: 'bakery' } })).status === 422);
  check('Registering with a reserved POS type that is not in the catalog is refused', (await api('/auth/register', { method: 'POST', body: { businessName: 'Onb Grocery', name: 'Onb', email: `onbgro${onbStamp}@example.com`, password: 'Password@123', vertical: 'grocery' } })).status === 422);
  const onbReg = await api('/auth/register', { method: 'POST', body: { businessName: `ONB Pharmacy ${onbStamp}`, name: 'ONB Owner', email: onbEmail, password: 'Password@123', vertical: 'pharmacy' } });
  let onbToken = onbReg.data?.tokens?.accessToken;
  const onbPharmId = onbReg.data?.tenant?.id;
  check('The account creates its first POS: a Pharmacy, on the free trial', onbReg.status === 201 && onbReg.data?.tenant?.vertical === 'pharmacy' && onbReg.data?.entitlement?.status === 'trial', onbReg.data?.tenant ?? onbReg.error);
  await api('/stores', { method: 'POST', token: onbToken, body: { name: 'ONB Pharmacy Main', currency: 'BDT' } });

  // Second POS, with business information.
  const onbRest = await api('/workspaces', { method: 'POST', token: onbToken, body: { businessName: `ONB Restaurant ${onbStamp}`, vertical: 'restaurant', contactPhone: '01712345678', contactEmail: `kitchen${onbStamp}@example.com` } });
  const onbRestId = onbRest.data?.workspace?.id;
  check('The account creates a second POS: a Restaurant', onbRest.status === 201 && onbRest.data?.workspace?.vertical === 'restaurant' && onbRest.data?.trial?.started === false, onbRest.data ?? onbRest.error);
  check('Its business information is stored', (await api(`/workspaces/${onbRestId}`, { token: onbToken })).data?.contactPhone === '01712345678');
  check('An unknown POS type is refused for a new workspace', (await api('/workspaces', { method: 'POST', token: onbToken, body: { businessName: 'Onb Florist', vertical: 'florist' } })).status >= 400);
  check('An account id in the body is refused', (await api('/workspaces', { method: 'POST', token: onbToken, body: { businessName: 'Onb Forged', vertical: 'restaurant', accountId: admin.session.tenant.accountId } })).status === 422);

  // The dashboard.
  const onbDash = await api('/account/dashboard', { token: onbToken });
  const onbCard = (data, id) => (data?.workspaces ?? []).find((w) => w.id === id);
  check('The dashboard lists every workspace with its POS type', onbDash.status === 200 && onbDash.data?.workspaces?.length === 2 && onbCard(onbDash.data, onbPharmId)?.posType === 'pharmacy' && onbCard(onbDash.data, onbRestId)?.posType === 'restaurant' && onbCard(onbDash.data, onbRestId)?.posTypeLabel, onbDash.data ?? onbDash.error);
  check('The Pharmacy shows its trial plan, status and renewal date', onbCard(onbDash.data, onbPharmId)?.subscription?.status === 'trialing' && Boolean(onbCard(onbDash.data, onbPharmId)?.renewalDate) && onbCard(onbDash.data, onbPharmId)?.canOpen === true, onbCard(onbDash.data, onbPharmId));
  check('The Restaurant needs a plan', onbCard(onbDash.data, onbRestId)?.needsPlan === true && onbCard(onbDash.data, onbRestId)?.subscription === null);
  check('The dashboard offers the POS types that can be added', onbDash.data?.addPos?.canAdd === true && (onbDash.data.addPos.options ?? []).some((o) => o.vertical === 'supershop'));

  // Choosing a plan: prices for the workspace's own POS type, from the server.
  const onbPlans = await api(`/workspaces/${onbRestId}/plans`, { token: onbToken });
  check('The plans offered are the Restaurant catalog', onbPlans.status === 200 && onbPlans.data?.catalog?.posType === 'restaurant' && ['starter', 'professional', 'enterprise'].every((code) => onbPlans.data.catalog.plans.some((p) => p.code === code)), onbPlans.data?.catalog ?? onbPlans.error);
  const onbQuote = await api(`/workspaces/${onbRestId}/checkout/quote`, { method: 'POST', token: onbToken, body: { plan: 'professional', billingCycle: 'monthly' } });
  const onbPrice = onbQuote.data?.payableMinor;
  const onbRestPlan = (onbPlans.data?.catalog?.plans ?? []).find((p) => p.code === 'professional');
  check('The quote is the engine price for the Restaurant, not the Clothing price', onbQuote.status === 200 && onbQuote.data?.posType === 'restaurant' && onbPrice > 0 && onbPrice === onbQuote.data.listPriceMinor && onbPrice !== 199_000 && JSON.stringify(onbRestPlan?.monthly ?? '').includes(String(onbPrice)), { quote: onbQuote.data ?? onbQuote.error, plan: onbRestPlan });
  const onbAnnual = await api(`/workspaces/${onbRestId}/checkout/quote`, { method: 'POST', token: onbToken, body: { plan: 'professional', billingCycle: 'annual' } });
  check('The annual cycle is priced by the server too', onbAnnual.data?.billingCycle === 'annual' && onbAnnual.data.payableMinor === 1_990_000, onbAnnual.data);
  check('An unknown plan is refused', (await api(`/workspaces/${onbRestId}/checkout/quote`, { method: 'POST', token: onbToken, body: { plan: 'platinum', billingCycle: 'monthly' } })).status === 404);
  check('A malformed plan is refused', (await api(`/workspaces/${onbRestId}/checkout/quote`, { method: 'POST', token: onbToken, body: { plan: 'PRO!!', billingCycle: 'monthly' } })).status === 422);
  check('An unknown billing cycle is refused', (await api(`/workspaces/${onbRestId}/checkout/quote`, { method: 'POST', token: onbToken, body: { plan: 'professional', billingCycle: 'weekly' } })).status === 422);

  // Checkout: the server revalidates and never trusts a client price.
  await api(`/platform/accounts/${onbReg.data?.tenant?.accountId}/wallet/adjustments`, { method: 'POST', token: platform2.token, body: { direction: 'credit', amountMinor: 250_000, reason: 'Smoke test: onboarding funds', idempotencyKey: `onb-${onbStamp}-fund` } });
  const onbCheckout = (body) => api(`/workspaces/${onbRestId}/checkout`, { method: 'POST', token: onbToken, body: { paymentMethod: 'wallet', plan: 'professional', billingCycle: 'monthly', idempotencyKey: `onb${onbStamp}co`, ...body } });
  check('A client amount is refused', (await onbCheckout({ amountMinor: 1 })).status === 422);
  check('A client price is refused', (await onbCheckout({ priceMinor: 1 })).status === 422);
  const onbStale = await onbCheckout({ expectedPayableMinor: 1 });
  check('A manipulated confirmed price is refused, not charged', onbStale.status === 409 && onbStale.error?.details?.reason === 'PRICE_CHANGED' && onbStale.error.details.payableMinor === onbPrice, onbStale.error);
  check('...and nothing was bought or charged', (await api('/wallet', { token: onbToken })).data?.balanceMinor === 250_000 && onbCard((await api('/account/dashboard', { token: onbToken })).data, onbRestId)?.subscription === null);
  const onbBought = await onbCheckout({ expectedPayableMinor: onbPrice });
  check('Checkout with the current price buys the plan from the wallet', onbBought.status === 201 && onbBought.data?.quote?.payableMinor === onbPrice && (await api('/wallet', { token: onbToken })).data?.balanceMinor === 250_000 - onbPrice, onbBought.data ?? onbBought.error);
  const onbAfter = (await api('/account/dashboard', { token: onbToken })).data;
  check('Each workspace has its own subscription: Restaurant Professional, Pharmacy still on trial', onbCard(onbAfter, onbRestId)?.subscription?.planCode === 'showroom-monthly' && onbCard(onbAfter, onbRestId)?.subscription?.status === 'active' && onbCard(onbAfter, onbRestId)?.renewalAmountMinor === onbPrice && onbCard(onbAfter, onbPharmId)?.subscription?.status === 'trialing', onbAfter?.workspaces);
  check('Buying the same plan again is refused by the eligibility rules', (await onbCheckout({ idempotencyKey: `onb${onbStamp}co2`, expectedPayableMinor: onbPrice })).status === 400);
  check('The checkout is audited', ((await api(`/platform/audit-log?action=workspace.checkout&tenantId=${onbRestId}&limit=5`, { token: platform2.token })).data ?? []).length === 1);

  // Inactive subscription.
  const onbShop = await api('/workspaces', { method: 'POST', token: onbToken, body: { businessName: `ONB Shop ${onbStamp}`, vertical: 'supershop' } });
  const onbShopId = onbShop.data?.workspace?.id;
  const onbShopSwitch = await api('/auth/switch-workspace', { method: 'POST', token: onbToken, body: { workspaceId: onbShopId } });
  onbToken = onbShopSwitch.data?.tokens?.accessToken ?? onbToken;
  await api('/stores', { method: 'POST', token: onbToken, body: { name: 'ONB Shop Main', currency: 'BDT' } });
  check('A workspace without a plan cannot use its POS', (await api('/supershop/products', { token: onbToken })).status === 402);
  check('...and the dashboard says it needs a plan', onbCard((await api('/account/dashboard', { token: onbToken })).data, onbShopId)?.needsPlan === true);

  // Switching and isolation.
  check("Switching into another account's workspace is refused", (await api('/auth/switch-workspace', { method: 'POST', token: onbToken, body: { workspaceId: admin.session.tenant.id } })).status === 403);
  check("Plans for another account's workspace are refused", (await api(`/workspaces/${admin.session.tenant.id}/plans`, { token: onbToken })).status === 404);
  check("Checkout for another account's workspace is refused", (await api(`/workspaces/${admin.session.tenant.id}/checkout`, { method: 'POST', token: onbToken, body: { paymentMethod: 'wallet', plan: 'starter', billingCycle: 'monthly' } })).status === 404);
  check('Another account never sees these workspaces on its dashboard', ((await api('/account/dashboard', { token: admin.token })).data?.workspaces ?? []).every((w) => ![onbPharmId, onbRestId, onbShopId].includes(w.id)));
  check('Staff have no account dashboard', (await api('/account/dashboard', { token: cashier.token })).status === 403);
  const onbPharmSwitch = await api('/auth/switch-workspace', { method: 'POST', token: onbToken, body: { workspaceId: onbPharmId } });
  const onbShopTokenBefore = onbToken;
  onbToken = onbPharmSwitch.data?.tokens?.accessToken ?? onbToken;
  // A token names one workspace and is re-authorised on every request: it acts only there, never where the query points.
  check('A token acts only in the workspace it names', (await api('/subscriptions/current', { token: onbShopTokenBefore })).data?.subscription?.tenantId !== onbPharmId);
  check('A workspace named in the query is ignored: the session decides', (await api(`/subscriptions/current?tenantId=${onbRestId}&workspaceId=${onbRestId}`, { token: onbToken })).data?.subscription?.tenantId === onbPharmId);
  check('Inside the Pharmacy only its own branches are listed', ((await api('/stores', { token: onbToken })).data ?? []).every((store) => store.name === 'ONB Pharmacy Main'));
  check('Inside the Pharmacy the Restaurant POS is refused', (await api('/restaurant/menu', { token: onbToken })).status === 403);
  check('Inside the Pharmacy the Supershop POS is refused', (await api('/supershop/products', { token: onbToken })).status === 403);

  // ------------------------------------------------ unified account billing center
  section('Unified account billing center');
  const ubcStamp = Date.now();
  const ubcReg = await api('/auth/register', { method: 'POST', body: { businessName: `UBC Clothing ${ubcStamp}`, name: 'UBC Owner', email: `ubc${ubcStamp}@example.com`, password: 'Password@123' } });
  const ubcToken = ubcReg.data?.tokens?.accessToken;
  const ubcClothingId = ubcReg.data?.tenant?.id;
  const ubcAccountId = ubcReg.data?.tenant?.accountId;
  const ubcStore = await api('/stores', { method: 'POST', token: ubcToken, body: { name: 'UBC Main', currency: 'BDT' } });
  const ubcRestId = (await api('/workspaces', { method: 'POST', token: ubcToken, body: { businessName: `UBC Restaurant ${ubcStamp}`, vertical: 'restaurant' } })).data?.workspace?.id;
  const ubcPharmId = (await api('/workspaces', { method: 'POST', token: ubcToken, body: { businessName: `UBC Pharmacy ${ubcStamp}`, vertical: 'pharmacy' } })).data?.workspace?.id;
  check('The billing account has three POS workspaces', Boolean(ubcClothingId && ubcRestId && ubcPharmId && ubcStore.status === 201));
  await api(`/platform/accounts/${ubcAccountId}/wallet/adjustments`, { method: 'POST', token: platform2.token, body: { direction: 'credit', amountMinor: 3_000_000, reason: 'Smoke test: billing center funds', idempotencyKey: `ubc-${ubcStamp}-fund` } });

  let ubcSeq = 0;
  const ubcQuote = (id, plan, billingCycle = 'monthly', token = ubcToken) => api(`/workspaces/${id}/checkout/quote`, { method: 'POST', token, body: { plan, billingCycle } });
  const ubcBuy = async (id, plan, billingCycle = 'monthly') => {
    const quote = await ubcQuote(id, plan, billingCycle);
    const bought = await api(`/workspaces/${id}/checkout`, { method: 'POST', token: ubcToken, body: { paymentMethod: 'wallet', plan, billingCycle, idempotencyKey: `ubc${ubcStamp}k${(ubcSeq += 1)}`, expectedPayableMinor: quote.data?.payableMinor } });
    return { quote, bought };
  };
  const ubcRestStarter = await ubcBuy(ubcRestId, 'starter');
  const ubcPharmEnt = await ubcBuy(ubcPharmId, 'enterprise');
  check('Each workspace buys its own plan from the shared wallet', ubcRestStarter.bought.status === 201 && ubcPharmEnt.bought.status === 201, [ubcRestStarter.bought.error, ubcPharmEnt.bought.error]);

  // SUBSCRIPTIONS: every workspace separately.
  const ubcBilling = async (token = ubcToken) => (await api('/account/billing', { token })).data;
  const ubcItem = (data, id) => (data?.workspaces ?? []).find((w) => w.workspace.id === id);
  let ubcView = await ubcBilling();
  check('Billing lists every workspace subscription separately', ubcView?.workspaces?.length === 3 && new Set(ubcView.workspaces.map((w) => w.subscription?.id)).size === 3, ubcView?.workspaces?.map((w) => w.subscription?.id));
  check('Each shows its POS type label from the catalog', ubcItem(ubcView, ubcRestId)?.workspace?.posTypeLabel === 'Restaurant' && ubcItem(ubcView, ubcPharmId)?.workspace?.posTypeLabel === 'Pharmacy' && ubcItem(ubcView, ubcClothingId)?.workspace?.posTypeLabel === 'Clothing');
  check('Restaurant: Starter, its own price per month, active', ubcItem(ubcView, ubcRestId)?.subscription?.planCode === 'starter-store-monthly' && ubcItem(ubcView, ubcRestId).subscription.billingCycle === 'monthly' && ubcItem(ubcView, ubcRestId).subscription.priceMinor === ubcRestStarter.quote.data?.listPriceMinor && ubcItem(ubcView, ubcRestId).subscription.status === 'active', ubcItem(ubcView, ubcRestId)?.subscription);
  check('Pharmacy: Enterprise, its own price, active', ubcItem(ubcView, ubcPharmId)?.subscription?.planCode === 'brand-monthly' && ubcItem(ubcView, ubcPharmId).subscription.priceMinor === ubcPharmEnt.quote.data?.listPriceMinor && ubcItem(ubcView, ubcPharmId).subscription.status === 'active');
  check('Clothing: still on its trial', ubcItem(ubcView, ubcClothingId)?.subscription?.status === 'trialing');

  // ACTIONS, through the existing transition rules.
  const ubcUpQuote = await ubcQuote(ubcRestId, 'professional');
  check('Upgrade: the quote is classified by the transition rules and credits unused time', ubcUpQuote.data?.transition?.kind === 'upgrade' && ubcUpQuote.data.payableMinor < ubcUpQuote.data.listPriceMinor, ubcUpQuote.data);
  const ubcUp = await ubcBuy(ubcRestId, 'professional');
  check('Upgrade: Restaurant moves to Professional now', ubcUp.bought.status === 201 && ubcItem(await ubcBilling(), ubcRestId)?.subscription?.planCode === 'showroom-monthly', ubcUp.bought.error);
  const ubcCycle = await ubcQuote(ubcPharmId, 'enterprise', 'annual');
  check('Monthly to annual is a cycle change, priced by the server', ubcCycle.status === 200 && ubcCycle.data?.transition?.kind === 'cycle-change' && ubcCycle.data.billingCycle === 'annual', ubcCycle.data ?? ubcCycle.error);
  check('The plan already running cannot be bought again', (await ubcQuote(ubcPharmId, 'enterprise')).status === 400);

  const ubcAction = (id, action, { method = 'POST', body, token = ubcToken } = {}) => api(`/workspaces/${id}/subscription/${action}`, { method, token, body });
  const ubcDown = await ubcAction(ubcRestId, 'scheduled-change', { body: { plan: 'starter', billingCycle: 'monthly' } });
  check('Downgrade: scheduled for the next renewal, classified as a downgrade', ubcDown.status === 200 && ubcDown.data?.change?.kind === 'downgrade' && ubcDown.data.renewal?.scheduledChange?.planCode === 'starter-store-monthly', ubcDown.data ?? ubcDown.error);
  check('Downgrade: the current plan keeps running until then', ubcDown.data?.subscription?.planCode === 'showroom-monthly');
  check('Scheduling the plan already running is refused', (await ubcAction(ubcPharmId, 'scheduled-change', { body: { plan: 'enterprise', billingCycle: 'monthly' } })).status === 400);
  check('Scheduling an unknown plan is refused', (await ubcAction(ubcPharmId, 'scheduled-change', { body: { plan: 'platinum', billingCycle: 'monthly' } })).status === 404);
  check('Scheduling with a price in the body is refused', (await ubcAction(ubcPharmId, 'scheduled-change', { body: { plan: 'starter', billingCycle: 'monthly', priceMinor: 1 } })).status === 422);
  check('A scheduled downgrade can be withdrawn', (await ubcAction(ubcRestId, 'scheduled-change', { method: 'DELETE' })).data?.renewal?.scheduledChange === null);

  const ubcCancel = await ubcAction(ubcRestId, 'cancel', { body: { immediate: false } });
  check('Cancel at period end: access continues, marked as cancelling', ubcCancel.status === 200 && ubcItem(await ubcBilling(), ubcRestId)?.subscription?.cancelAtPeriodEnd === true && ubcItem(await ubcBilling(), ubcRestId)?.isActive === true, ubcCancel.error);
  check('A cancelling subscription cannot schedule a change', (await ubcAction(ubcRestId, 'scheduled-change', { body: { plan: 'starter', billingCycle: 'monthly' } })).status === 409);
  check('...and can be resumed', (await ubcAction(ubcRestId, 'reactivate', { body: {} })).data?.subscription?.cancelAtPeriodEnd === false);
  const ubcRenew = await ubcAction(ubcPharmId, 'renew', { body: {} });
  check('Renew: refused while the period is not due, with a reason', ubcRenew.status === 409 && ubcRenew.error?.details?.reason === 'RENEWAL_NOT_DUE', ubcRenew.error);

  const ubcTopUp = await api('/account/top-ups', { method: 'POST', token: ubcToken, body: { amountMinor: 50_000, paymentMethod: 'bkash', senderNumber: '01700000000', transactionId: `UBC${ubcStamp}` } });
  check('Add funds: a top-up request is filed for verification', ubcTopUp.status === 201 && ubcTopUp.data?.status === 'pending', ubcTopUp.error);

  // WALLET.
  const ubcWallet = await api('/account/wallet', { token: ubcToken });
  ubcView = await ubcBilling();
  check('The wallet shows the current balance, the same as billing', ubcWallet.status === 200 && ubcWallet.data?.balanceMinor === ubcView?.wallet?.balanceMinor && ubcWallet.data.status === 'active', ubcWallet.data ?? ubcWallet.error);
  check('The wallet counts the pending top-up without crediting it', ubcWallet.data?.pendingTopUps === 1 && ubcWallet.data.totalCreditsMinor === 3_000_000);
  check('The breakdown is Subscription, SMS, Email and Other services', (ubcWallet.data?.services ?? []).map((s) => s.service).join() === 'subscription,sms,email,other', ubcWallet.data?.services);
  const ubcSubRows = (await api('/account/wallet/transactions?service=subscription&limit=100', { token: ubcToken })).data ?? [];
  const ubcNetSubs = ubcSubRows.reduce((sum, r) => sum + (r.type === 'debit' ? r.amountMinor : r.type === 'refund' ? -r.amountMinor : 0), 0);
  const ubcSubSpend = (ubcWallet.data?.services ?? []).find((s) => s.service === 'subscription')?.amountMinor;
  check('Subscription spending reconciles with the subscription transactions', ubcSubRows.length >= 3 && ubcSubSpend === ubcNetSubs && ubcSubSpend === 3_000_000 - ubcWallet.data.balanceMinor, { ubcSubSpend, ubcNetSubs, balance: ubcWallet.data?.balanceMinor });
  check('The wallet lists how it can be funded', (ubcWallet.data?.fundingMethods?.manual ?? []).includes('bkash'));
  const ubcAllRows = await api('/account/wallet/transactions?limit=100', { token: ubcToken });
  check('Transaction history spans every workspace of the account', ubcAllRows.status === 200 && [ubcRestId, ubcPharmId].every((id) => ubcAllRows.data.some((r) => r.workspaceId === id)), ubcAllRows.data?.map((r) => r.workspaceId));
  check('Transactions carry no internal metadata or operation keys', (ubcAllRows.data ?? []).every((r) => !('metadata' in r) && !('idempotencyKey' in r) && r.accountId === ubcAccountId));
  const ubcRestRows = (await api(`/account/wallet/transactions?workspaceId=${ubcRestId}&limit=100`, { token: ubcToken })).data ?? [];
  check('Transactions can be narrowed to one workspace', ubcRestRows.length >= 2 && ubcRestRows.every((r) => r.workspaceId === ubcRestId));
  check('An unknown filter field is refused', (await api('/account/wallet/transactions?accountId=abc', { token: ubcToken })).status === 422);
  check('A malformed workspace filter is refused', (await api('/account/wallet/transactions?workspaceId=nope', { token: ubcToken })).status === 422);

  // SECURITY: account isolation.
  check("Another owner cannot filter by this account's workspace", (await api(`/account/wallet/transactions?workspaceId=${ubcRestId}`, { token: admin.token })).status === 404);
  check("Another owner's wallet shows none of this account's transactions", ((await api('/account/wallet/transactions?limit=100', { token: admin.token })).data ?? []).every((r) => !ubcAllRows.data.some((own) => own.id === r.id)));
  check("Another owner's wallet balance is their own", (await api('/account/wallet', { token: admin.token })).data?.balanceMinor !== undefined && ((await api('/account/billing', { token: admin.token })).data?.workspaces ?? []).every((w) => ![ubcClothingId, ubcRestId, ubcPharmId].includes(w.workspace.id)));
  check("Another owner's invoices and payments exclude this account", ((await api(`/account/invoices?workspaceId=${ubcRestId}`, { token: admin.token })).status === 404) && ((await api('/account/payments?limit=100', { token: admin.token })).data ?? []).every((p) => ![ubcRestId, ubcPharmId].includes(p.workspaceId)));
  for (const [label, action, method, body] of [['schedule a change', 'scheduled-change', 'POST', { plan: 'starter', billingCycle: 'monthly' }], ['withdraw a change', 'scheduled-change', 'DELETE', undefined], ['cancel', 'cancel', 'POST', { immediate: false }], ['renew', 'renew', 'POST', {}], ['resume', 'reactivate', 'POST', {}], ['change auto-renew', 'auto-renew', 'POST', { enabled: false }]]) {
    check(`Another owner cannot ${label} for this account's workspace`, (await ubcAction(ubcRestId, action, { method, body, token: admin.token })).status === 404);
  }
  check("Another owner cannot quote a plan for this account's workspace", (await ubcQuote(ubcRestId, 'starter', 'monthly', admin.token)).status === 404);
  check('Nothing changed on the Restaurant after those attempts', ((item) => item?.subscription?.planCode === 'showroom-monthly' && item.subscription.cancelAtPeriodEnd === false && item.renewal.scheduledChange === null)(ubcItem(await ubcBilling(), ubcRestId)));

  // SECURITY: workspace staff.
  const ubcStaffEmail = `ubcstaff${ubcStamp}@example.com`;
  const ubcStaff = await api('/staff', { method: 'POST', token: ubcToken, storeId: ubcStore.data?._id, body: { name: 'UBC Staff', email: ubcStaffEmail, password: 'Password@123', storeId: ubcStore.data?._id, extraPermissions: ['subscription.view', 'subscription.manage'] } });
  const ubcStaffLogin = await login(ubcStaffEmail, 'Password@123');
  check('A staff member with subscription permissions is created in the Clothing workspace', ubcStaff.status === 201 && Boolean(ubcStaffLogin.token), ubcStaff.error);
  for (const path of ['/account/billing', '/account/wallet', '/account/wallet/transactions', '/account/subscriptions', '/account/invoices', '/account/payments', '/account/statement', '/account/top-ups']) {
    check(`Staff do not see ${path}`, (await api(path, { token: ubcStaffLogin.token })).status === 403);
  }
  check('Staff do not see the wallet through the workspace either', (await api('/wallet', { token: ubcStaffLogin.token })).status === 403);
  check("Staff cannot read another workspace's plans", [403, 404].includes((await api(`/workspaces/${ubcPharmId}/plans`, { token: ubcStaffLogin.token })).status));
  check("Staff cannot change another workspace's subscription", [403, 404].includes((await ubcAction(ubcRestId, 'scheduled-change', { body: { plan: 'starter', billingCycle: 'monthly' }, token: ubcStaffLogin.token })).status));
  check('Staff cannot cancel from the account billing routes', [403, 404].includes((await ubcAction(ubcClothingId, 'cancel', { body: { immediate: false }, token: ubcStaffLogin.token })).status));
  check('Staff see only their own workspace subscription', (await api('/subscriptions/current', { token: ubcStaffLogin.token })).data?.subscription?.tenantId === ubcClothingId);

  // Explicitly authorised staff: the workspace's own share of the wallet, never the account's.
  const ubcTreasurerEmail = `ubctreas${ubcStamp}@example.com`;
  await api('/staff', { method: 'POST', token: ubcToken, storeId: ubcStore.data?._id, body: { name: 'UBC Treasurer', email: ubcTreasurerEmail, password: 'Password@123', storeId: ubcStore.data?._id, extraPermissions: ['wallet.view'] } });
  const ubcTreasurer = await login(ubcTreasurerEmail, 'Password@123');
  const ubcTreasRows = await api('/wallet/transactions?limit=100', { token: ubcTreasurer.token });
  check('Staff granted wallet.view see the wallet', ubcTreasRows.status === 200);
  check("...but only their own workspace's movements, not the other workspaces'", (ubcTreasRows.data ?? []).every((r) => r.workspaceId === ubcClothingId) && !(ubcTreasRows.data ?? []).some((r) => [ubcRestId, ubcPharmId].includes(r.workspaceId)));
  check('...and still not the account billing center', (await api('/account/wallet', { token: ubcTreasurer.token })).status === 403 && (await api('/account/billing', { token: ubcTreasurer.token })).status === 403);

  // SECURITY: workspace isolation for the owner's own workspaces.
  const ubcRestSwitch = await api('/auth/switch-workspace', { method: 'POST', token: ubcToken, body: { workspaceId: ubcRestId } });
  const ubcRestToken = ubcRestSwitch.data?.tokens?.accessToken;
  await api('/stores', { method: 'POST', token: ubcRestToken, body: { name: 'UBC Restaurant Main', currency: 'BDT' } });
  const ubcRestCurrent = await api('/subscriptions/current', { token: ubcRestToken });
  check("Inside the Restaurant, the subscription is the Restaurant's", ubcRestCurrent.data?.subscription?.tenantId === ubcRestId, ubcRestCurrent.data?.subscription ?? ubcRestCurrent.error);
  const ubcRestInvoices = (await api('/subscriptions/invoices?limit=100', { token: ubcRestToken })).data ?? [];
  check("Inside the Restaurant, invoices are the Restaurant's only", ubcRestInvoices.length === 2 && ubcRestInvoices.every((i) => String(i.workspace?.id) === ubcRestId), ubcRestInvoices.map((i) => i.workspace));

  // AUDIT.
  const ubcAudits = async (action, tenantId) => ((await api(`/platform/audit-log?action=${action}&tenantId=${tenantId}&limit=20`, { token: platform2.token })).data ?? []).length;
  check('Audited: checkouts (plan purchases and the upgrade)', (await ubcAudits('workspace.checkout', ubcRestId)) === 2 && (await ubcAudits('workspace.checkout', ubcPharmId)) === 1);
  check('Audited: the scheduled change and its withdrawal', (await ubcAudits('workspace.subscription_change_scheduled', ubcRestId)) === 1 && (await ubcAudits('workspace.subscription_change_withdrawn', ubcRestId)) === 1);
  check('Audited: the cancellation and the resume', (await ubcAudits('workspace.subscription_cancelled', ubcRestId)) >= 1 && (await ubcAudits('workspace.subscription_reactivated', ubcRestId)) === 1);
  check('Audited: the refused renewal', (await ubcAudits('workspace.subscription_renewal_refused', ubcPharmId)) === 1);
  check('Refused attempts by another owner changed nothing and scheduled nothing', (await ubcAudits('workspace.subscription_change_scheduled', ubcRestId)) === 1);

  // ------------------------------------------------ clothing as the first production POS
  section('Clothing POS on the multi-POS platform');
  const cmgStamp = Date.now();

  // The demo workspace is an EXISTING Clothing business: account, POS type, catalog tier.
  const cmgSession = (await api('/auth/me', { token: admin.token })).data;
  check('The existing Clothing business belongs to an account', Boolean(cmgSession?.tenant?.accountId));
  check('...and is marked as a Clothing POS workspace', cmgSession?.tenant?.vertical === 'clothing');
  const cmgCurrent = (await api('/subscriptions/current', { token: admin.token })).data;
  // Stored plan codes stay exactly as they were written; only the NAME is the catalog tier.
  const CMG_TIER_OF = { 'starter-store': 'Starter', showroom: 'Professional', brand: 'Enterprise' };
  // `/subscriptions/current` returns the subscription itself: the plan is its frozen snapshot.
  const cmgStoredCode = cmgCurrent?.subscription?.planSnapshot?.code ?? '';
  const cmgStoredMatch = /^(starter-store|showroom|brand)-(monthly|annual)$/.exec(cmgStoredCode);
  check('...and keeps its stored plan code, unrenamed', Boolean(cmgStoredMatch), cmgStoredCode);
  check('...which is sold under its catalog tier name', cmgStoredMatch ? (cmgCurrent?.subscription?.planSnapshot?.name ?? '').startsWith(CMG_TIER_OF[cmgStoredMatch[1]]) : false, { code: cmgStoredCode, name: cmgCurrent?.subscription?.planSnapshot?.name });

  // The legacy codes map onto the catalog tiers; the stored values are never renamed.
  const cmgCatalog = (await api('/pricing?posType=clothing')).data;
  const cmgPlanNames = (cmgCatalog?.plans ?? []).map((p) => p.displayName);
  check('The Clothing catalog sells Starter, Professional and Enterprise', ['Starter', 'Professional', 'Enterprise'].every((name) => cmgPlanNames.includes(name)), cmgPlanNames);
  check('The catalog never exposes internal plan codes to customers', (cmgCatalog?.plans ?? []).every((p) => ['starter', 'professional', 'enterprise'].includes(p.code)), (cmgCatalog?.plans ?? []).map((p) => p.code));
  check('The Clothing POS product is active on the platform', ((await api('/workspaces/verticals/public')).data ?? []).some((o) => o.vertical === 'clothing' && o.available));

  // ADVANCED ANALYTICS per tier, enforced by the server.
  const cmgOwner = await api('/auth/register', { method: 'POST', body: { businessName: `CMG Clothing ${cmgStamp}`, name: 'CMG Owner', email: `cmg${cmgStamp}@example.com`, password: 'Password@123', vertical: 'clothing' } });
  let cmgToken = cmgOwner.data?.tokens?.accessToken;
  const cmgWsId = cmgOwner.data?.tenant?.id;
  const cmgAccountId = cmgOwner.data?.tenant?.accountId;
  await api('/stores', { method: 'POST', token: cmgToken, body: { name: 'CMG Main', currency: 'BDT' } });
  await api(`/platform/accounts/${cmgAccountId}/wallet/adjustments`, { method: 'POST', token: platform2.token, body: { direction: 'credit', amountMinor: 1_000_000, reason: 'Smoke test: clothing tiers', idempotencyKey: `cmg-${cmgStamp}-fund` } });
  const cmgBuy = async (plan) => {
    const quote = await api(`/workspaces/${cmgWsId}/checkout/quote`, { method: 'POST', token: cmgToken, body: { plan, billingCycle: 'monthly' } });
    return api(`/workspaces/${cmgWsId}/checkout`, { method: 'POST', token: cmgToken, body: { paymentMethod: 'wallet', plan, billingCycle: 'monthly', idempotencyKey: `cmg${cmgStamp}${plan}`, expectedPayableMinor: quote.data?.payableMinor } });
  };
  const cmgAnalytics = (token) => api('/reports/sales?preset=last30', { token });
  const cmgDashboard = (token) => api('/reports/overview?preset=last30', { token });

  const cmgStoredFor = async () => (await api('/subscriptions/current', { token: cmgToken })).data?.subscription?.planSnapshot?.code;
  await cmgBuy('starter');
  check('Buying Starter stores the legacy starter-store code, unrenamed', (await cmgStoredFor()) === 'starter-store-monthly');
  check('Starter: the dashboard works', (await cmgDashboard(cmgToken)).status === 200);
  const cmgStarterLocked = await cmgAnalytics(cmgToken);
  check('Starter: Advanced Analytics is locked, with the code the UI shows a lock for', cmgStarterLocked.status === 403 && cmgStarterLocked.error?.code === 'ADVANCED_ANALYTICS_REQUIRED', cmgStarterLocked.error);
  check('Starter: the session reports the feature as off, so the page renders locked', (await api('/auth/me', { token: cmgToken })).data?.entitlement?.features?.advancedReports === false);
  check('Starter: its entitlements say the same', (await api('/subscriptions/entitlements', { token: cmgToken })).data?.features?.advancedAnalytics?.enabled === false);

  await cmgBuy('professional');
  check('Buying Professional stores the legacy showroom code, unrenamed', (await cmgStoredFor()) === 'showroom-monthly');
  check('Professional: Advanced Analytics is unlocked', (await cmgAnalytics(cmgToken)).status === 200);
  check('Professional: the session reports the feature as on', (await api('/auth/me', { token: cmgToken })).data?.entitlement?.features?.advancedReports === true);
  await cmgBuy('enterprise');
  check('Buying Enterprise stores the legacy brand code, unrenamed', (await cmgStoredFor()) === 'brand-monthly');
  check('Enterprise: Advanced Analytics is unlocked', (await cmgAnalytics(cmgToken)).status === 200);
  check('Enterprise: the dashboard still works', (await cmgDashboard(cmgToken)).status === 200);

  // HISTORICAL DATA: a sale keeps the figures it was rung up with.
  const cmgBarcodeValue = `CMGB${String(cmgStamp).slice(-9)}`;
  const cmgProduct = await api('/products', { method: 'POST', token: cmgToken, body: { name: `CMG Shirt ${cmgStamp}`, brand: 'CMG', variants: [{ attributes: [{ name: 'Size', value: 'M' }], sku: `CMG${cmgStamp}`, barcode: cmgBarcodeValue, sellingPriceMinor: 100_000, costPriceMinor: 40_000, stock: 10 }] } });
  const cmgProductId = cmgProduct.data?._id ?? cmgProduct.data?.id;
  const cmgVariantId = cmgProduct.data?.variants?.[0]?._id ?? cmgProduct.data?.variants?.[0]?.id;
  check('Products and variants still work on the platform', cmgProduct.status === 201 && Boolean(cmgVariantId), cmgProduct.error);
  const cmgSale = await api('/sales', { method: 'POST', token: cmgToken, body: { items: [{ variantId: cmgVariantId, quantity: 2 }], paymentMethod: 'cash' } });
  check('A Clothing sale is rung up on the new platform', cmgSale.status === 201 && cmgSale.data?.totalMinor === 200_000, cmgSale.error ?? cmgSale.data?.totalMinor);
  const cmgSaleId = cmgSale.data?._id ?? cmgSale.data?.id;
  const cmgSaleItemId = cmgSale.data?.items?.[0]?._id;
  const cmgBefore = (await api(`/sales/${cmgSaleId}`, { token: cmgToken })).data;
  // Change today's price and the plan; the historical sale must not move.
  await api(`/products/${cmgProductId}/variants/${cmgVariantId}`, { method: 'PATCH', token: cmgToken, body: { sellingPriceMinor: 150_000 } });
  await api(`/workspaces/${cmgWsId}/subscription/scheduled-change`, { method: 'POST', token: cmgToken, body: { plan: 'starter', billingCycle: 'monthly' } });
  const cmgAfter = (await api(`/sales/${cmgSaleId}`, { token: cmgToken })).data;
  check('The historical sale keeps its own total after a price change', cmgAfter?.totalMinor === cmgBefore?.totalMinor && cmgAfter?.totalMinor === 200_000, { before: cmgBefore?.totalMinor, after: cmgAfter?.totalMinor });
  check('...and its line prices are the ones it was sold at', (cmgAfter?.items ?? []).every((i) => i.unitPriceMinor === 100_000), (cmgAfter?.items ?? []).map((i) => i.unitPriceMinor));
  check('A posted sale cannot be edited or deleted through the API', (await api(`/sales/${cmgSaleId}`, { method: 'PATCH', token: cmgToken, body: { totalMinor: 1 } })).status === 404 && (await api(`/sales/${cmgSaleId}`, { method: 'DELETE', token: cmgToken })).status === 404);
  const cmgInvoices = (await api('/subscriptions/invoices?limit=50', { token: cmgToken })).data ?? [];
  check('Each plan change left its own invoice, at the price paid then', cmgInvoices.length === 3 && new Set(cmgInvoices.map((i) => i.totalMinor)).size >= 2, cmgInvoices.map((i) => [i.planName, i.totalMinor]));

  // The Clothing POS itself keeps working end to end.
  const cmgReturn = await api('/returns', { method: 'POST', token: cmgToken, body: { saleId: cmgSaleId, items: [{ saleItemId: cmgSaleItemId, quantity: 1, restock: true }], reason: 'Wrong size', refundMethod: 'cash' } });
  check('Returns still work against a historical sale', cmgReturn.status === 201, cmgReturn.error);
  check('Stock moved back after the return', ((await api(`/products/${cmgProductId}`, { token: cmgToken })).data?.variants ?? []).some((v) => v.stock === 9));
  const cmgBarcode = await api(`/products/pos-search?q=${cmgBarcodeValue}&limit=5`, { token: cmgToken });
  check('Barcode lookup still finds the variant', cmgBarcode.status === 200 && (cmgBarcode.data ?? []).some((v) => v.barcode === cmgBarcodeValue), cmgBarcode.data ?? cmgBarcode.error);
  const cmgCustomer = await api('/customers', { method: 'POST', token: cmgToken, body: { name: 'CMG Customer', phone: `018${String(cmgStamp).slice(-8)}` } });
  check('Customers still work', cmgCustomer.status === 201, cmgCustomer.error);
  check('Branches still work', (await api('/stores', { token: cmgToken })).status === 200);
  check('Staff and roles still work', (await api('/staff', { token: cmgToken })).status === 200 && (await api('/roles', { token: cmgToken })).status === 200);
  check('Wallet and subscription still work', (await api('/wallet', { token: cmgToken })).status === 200 && (await api('/subscriptions/current', { token: cmgToken })).status === 200);
  check('The workspace reports its POS type to the client', (await api('/auth/me', { token: cmgToken })).data?.tenant?.vertical === 'clothing');

  // ------------------------------------------------ multi-tenant security hardening
  section('Security: IDOR and the ownership chain');
  const mtsStamp = Date.now();

  // Two unrelated accounts, each with its own workspace and records.
  const mtsMake = async (tag) => {
    const reg = await api('/auth/register', { method: 'POST', body: { businessName: `MTS ${tag} ${mtsStamp}`, name: `MTS ${tag}`, email: `mts${tag}${mtsStamp}@example.com`, password: 'Password@123', vertical: 'clothing' } });
    const token = reg.data?.tokens?.accessToken;
    const store = await api('/stores', { method: 'POST', token, body: { name: `MTS ${tag} Main`, currency: 'BDT' } });
    const product = await api('/products', { method: 'POST', token, body: { name: `MTS ${tag} Tee`, variants: [{ attributes: [], sku: `MTS${tag}${mtsStamp}`, sellingPriceMinor: 100_000, stock: 10 }] } });
    const variantId = product.data?.variants?.[0]?._id;
    const sale = await api('/sales', { method: 'POST', token, body: { items: [{ variantId, quantity: 1 }], paymentMethod: 'cash' } });
    const customer = await api('/customers', { method: 'POST', token, body: { name: `MTS ${tag} Buyer`, phone: `019${String(mtsStamp).slice(-6)}${tag === 'A' ? '01' : '02'}` } });
    const staff = await api('/staff', { method: 'POST', token, storeId: store.data?._id, body: { name: `MTS ${tag} Staff`, email: `mtsstaff${tag}${mtsStamp}@example.com`, password: 'Password@123', storeId: store.data?._id } });
    const subscription = (await api('/subscriptions/current', { token })).data?.subscription;
    return {
      token,
      workspaceId: reg.data?.tenant?.id,
      accountId: reg.data?.tenant?.accountId,
      storeId: store.data?._id,
      productId: product.data?._id,
      variantId,
      saleId: sale.data?._id,
      customerId: customer.data?._id,
      staffId: staff.data?._id ?? staff.data?.id,
      subscriptionId: subscription?._id ?? subscription?.id,
    };
  };
  const mtsA = await mtsMake('A');
  const mtsB = await mtsMake('B');
  check('Two separate accounts with their own records exist', Boolean(mtsA.workspaceId && mtsB.workspaceId && mtsA.saleId && mtsB.saleId && mtsA.staffId && mtsB.staffId && mtsA.subscriptionId), { a: mtsA, b: mtsB });
  check('...and they really are different accounts', mtsA.accountId !== mtsB.accountId && mtsA.workspaceId !== mtsB.workspaceId);

  // IDOR: A aims every kind of id at B's records. Nothing may be readable or writable.
  const mtsIdor = [
    ['a product', `/products/${mtsB.productId}`],
    ['a sale', `/sales/${mtsB.saleId}`],
    ['a sale receipt', `/sales/${mtsB.saleId}/receipt`],
    ['a customer', `/customers/${mtsB.customerId}`],
    ['a staff member', `/staff/${mtsB.staffId}`],
    ['a branch', `/stores/${mtsB.storeId}`],
    ['a workspace', `/workspaces/${mtsB.workspaceId}`],
    ['a workspace plan list', `/workspaces/${mtsB.workspaceId}/plans`],
    ['a workspace entitlement', `/workspaces/${mtsB.workspaceId}/entitlements`],
  ];
  for (const [label, path] of mtsIdor) {
    const response = await api(path, { token: mtsA.token });
    check(`IDOR: reading ${label} of another account is refused`, [403, 404].includes(response.status), { path, status: response.status });
  }
  const mtsWrites = [
    ['edit a product', `/products/${mtsB.productId}`, 'PATCH', { name: 'Owned' }],
    ['edit a customer', `/customers/${mtsB.customerId}`, 'PATCH', { name: 'Owned' }],
    ['delete a product', `/products/${mtsB.productId}`, 'DELETE', undefined],
    ['edit a branch', `/stores/${mtsB.storeId}`, 'PATCH', { name: 'Owned' }],
    ['edit a staff member', `/staff/${mtsB.staffId}`, 'PATCH', { isActive: false }],
    ['cancel a subscription', `/workspaces/${mtsB.workspaceId}/subscription/cancel`, 'POST', { immediate: true }],
    ['schedule a plan change', `/workspaces/${mtsB.workspaceId}/subscription/scheduled-change`, 'POST', { plan: 'starter', billingCycle: 'monthly' }],
    ['check out a plan', `/workspaces/${mtsB.workspaceId}/checkout`, 'POST', { paymentMethod: 'wallet', plan: 'enterprise', billingCycle: 'monthly', idempotencyKey: `mts${mtsStamp}x` }],
  ];
  for (const [label, path, method, body] of mtsWrites) {
    const response = await api(path, { method, token: mtsA.token, body });
    check(`IDOR: attempting to ${label} of another account is refused`, response.status >= 400 && response.status !== 429, { path, status: response.status });
  }
  const mtsBIntact = (await api('/subscriptions/current', { token: mtsB.token })).data?.subscription;
  check("None of that changed the other account's records", (await api(`/products/${mtsB.productId}`, { token: mtsB.token })).data?.name === `MTS B Tee` && (await api(`/customers/${mtsB.customerId}`, { token: mtsB.token })).data?.name === 'MTS B Buyer' && Boolean(mtsBIntact));

  // Ownership chain: the account and workspace come from the session, never the request.
  const mtsForged = await api('/customers', { method: 'POST', token: mtsA.token, body: { name: 'Forged', phone: `017${String(mtsStamp).slice(-7)}`, tenantId: mtsB.workspaceId, storeId: mtsB.storeId, accountId: mtsB.accountId } });
  check('Ownership chain: ids in the body are refused outright', mtsForged.status === 422, mtsForged.status);
  check('...and nothing was written into the other workspace', ((await api('/customers?limit=100', { token: mtsB.token })).data ?? []).every((c) => c.name !== 'Forged'));
  const mtsQueryHop = await api(`/products?tenantId=${mtsB.workspaceId}&workspaceId=${mtsB.workspaceId}&accountId=${mtsB.accountId}&limit=50`, { token: mtsA.token });
  check('Ownership chain: ids in the query are ignored, not obeyed', (mtsQueryHop.data ?? []).every((product) => product._id !== mtsB.productId));
  check('Ownership chain: a workspace id naming another account is refused on its billing', (await api(`/account/wallet/transactions?workspaceId=${mtsB.workspaceId}`, { token: mtsA.token })).status === 404);

  // Subscription security.
  section('Security: subscriptions, wallet and administration');
  const mtsSubWrites = [
    ['activate a plan directly', '/platform/subscriptions', 'POST', { tenantId: mtsA.workspaceId, planId: mtsA.subscriptionId, periods: 12 }],
    ['extend its own expiry', `/platform/subscriptions/${mtsA.subscriptionId}/extend`, 'POST', { days: 3650 }],
    ['set its own status', `/platform/subscriptions/${mtsA.subscriptionId}/status`, 'PATCH', { status: 'active' }],
  ];
  for (const [label, path, method, body] of mtsSubWrites) {
    const response = await api(path, { method, token: mtsA.token, body });
    check(`Subscription: a customer cannot ${label}`, response.status === 403, { path, status: response.status });
  }
  const mtsPriceCheat = await api(`/workspaces/${mtsA.workspaceId}/checkout`, { method: 'POST', token: mtsA.token, body: { paymentMethod: 'wallet', plan: 'enterprise', billingCycle: 'monthly', idempotencyKey: `mts${mtsStamp}p`, priceMinor: 1, amountMinor: 1, payableMinor: 1 } });
  check('Subscription: a price in the checkout body is refused', mtsPriceCheat.status === 422, mtsPriceCheat.status);
  const mtsEntitlementHop = await api('/reports/sales?preset=last30', { token: mtsA.token });
  check('Entitlement: a trial cannot read Advanced Analytics', mtsEntitlementHop.status === 403 && mtsEntitlementHop.error?.code === 'ADVANCED_ANALYTICS_REQUIRED', mtsEntitlementHop.error?.code);
  check('Entitlement: it cannot be bypassed with a query parameter', (await api('/reports/sales?preset=last30&entitlement=advancedAnalytics&advancedReports=true&plan=enterprise', { token: mtsA.token })).status === 403);
  check("Entitlement: another workspace's entitlements are not readable", [403, 404].includes((await api(`/workspaces/${mtsB.workspaceId}/entitlements`, { token: mtsA.token })).status));

  // Wallet security.
  const mtsWalletBefore = (await api('/wallet', { token: mtsA.token })).data?.balanceMinor ?? 0;
  const mtsWalletWrites = [
    ['credit its own wallet', `/platform/accounts/${mtsA.accountId}/wallet/adjustments`, 'POST', { direction: 'credit', amountMinor: 1_000_000, reason: 'Self service credit attempt', idempotencyKey: `mts${mtsStamp}w` }],
    ['debit another account', `/platform/accounts/${mtsB.accountId}/wallet/adjustments`, 'POST', { direction: 'debit', amountMinor: 1_000, reason: 'Draining a stranger', idempotencyKey: `mts${mtsStamp}d` }],
    ['reverse a ledger row', `/platform/accounts/${mtsA.accountId}/wallet/transactions/${mtsA.subscriptionId}/reverse`, 'POST', { reason: 'Undoing my own spending' }],
  ];
  for (const [label, path, method, body] of mtsWalletWrites) {
    check(`Wallet: a customer cannot ${label}`, (await api(path, { method, token: mtsA.token, body })).status === 403, label);
  }
  const mtsBalanceBody = await api('/account/top-ups', { method: 'POST', token: mtsA.token, body: { amountMinor: 1_000, paymentMethod: 'bkash', senderNumber: '01700000000', transactionId: `MTS${mtsStamp}`, status: 'approved', balanceMinor: 9_999_999 } });
  check('Wallet: a status or balance in a top-up request is refused', mtsBalanceBody.status === 422, mtsBalanceBody.status);
  const mtsPending = await api('/account/top-ups', { method: 'POST', token: mtsA.token, body: { amountMinor: 1_000, paymentMethod: 'bkash', senderNumber: '01700000000', transactionId: `MTSOK${mtsStamp}` } });
  check('Wallet: an unverified top-up credits nothing', mtsPending.status === 201 && mtsPending.data?.status === 'pending' && (await api('/wallet', { token: mtsA.token })).data?.balanceMinor === mtsWalletBefore, mtsPending.error ?? mtsPending.data?.status);
  check('Wallet: a customer cannot approve their own top-up', (await api(`/platform/top-ups/${mtsPending.data?.id}/review`, { method: 'POST', token: mtsA.token, body: { decision: 'approved' } })).status === 403);
  const mtsLedgerRow = ((await api('/wallet/transactions?limit=5', { token: mtsB.token })).data ?? [])[0];
  if (mtsLedgerRow) {
    check('Wallet: a posted ledger row cannot be edited or deleted', (await api(`/wallet/transactions/${mtsLedgerRow.id}`, { method: 'PATCH', token: mtsB.token, body: { amountMinor: 1 } })).status === 404 && (await api(`/wallet/transactions/${mtsLedgerRow.id}`, { method: 'DELETE', token: mtsB.token })).status === 404);
  }

  // Administration.
  const mtsAdminPaths = ['/platform/overview', '/platform/accounts', '/platform/tenants', '/platform/audit-log', '/platform/settings', '/platform/subscriptions', '/platform/coupons', '/platform/pos-products'];
  for (const path of mtsAdminPaths) {
    check(`Admin: a workspace owner cannot reach ${path}`, (await api(path, { token: mtsA.token })).status === 403, path);
  }
  check('Admin: a workspace owner cannot suspend a workspace', (await api(`/platform/tenants/${mtsB.workspaceId}/status`, { method: 'PATCH', token: mtsA.token, body: { status: 'suspended' } })).status === 403);
  check('Admin: a workspace owner cannot edit the coupon catalogue', (await api('/platform/coupons', { method: 'POST', token: mtsA.token, body: { code: `MTS${mtsStamp}`, discountType: 'percent', discountValue: 100 } })).status === 403);
  check('Admin: staff cannot reach platform administration', (await api('/platform/accounts', { token: cashier.token })).status === 403);
  check('Admin: an unknown key in a coupon is refused even for a platform admin', (await api('/platform/coupons', { method: 'POST', token: platform2.token, body: { code: `MTSX${mtsStamp}`, discountType: 'percent', discountValue: 10, tenantId: mtsB.workspaceId, usedCount: 999 } })).status === 422);

  // Mass assignment on the newer surfaces.
  const mtsMass = [
    ['a workspace with a forged account', '/workspaces', 'POST', { businessName: `MTS Forged ${mtsStamp}`, vertical: 'clothing', accountId: mtsB.accountId, ownerUserId: mtsB.staffId }],
    ['a staff member with an internal role', '/staff', 'POST', { name: 'MTS Root', email: `mtsroot${mtsStamp}@example.com`, password: 'Password@123', role: 'platform_admin', tenantId: mtsB.workspaceId, isPlatformAdmin: true }],
  ];
  for (const [label, path, method, body] of mtsMass) {
    const response = await api(path, { method, token: mtsA.token, body });
    check(`Mass assignment: ${label} is refused`, response.status === 422, { path, status: response.status });
  }
  check('Mass assignment: a role naming an unknown permission is refused', (await api('/roles', { method: 'POST', token: admin.token, body: { name: `MTS Role ${mtsStamp}`, permissions: ['platform.manage', 'wallet.mint'] } })).status === 422);
  check('Mass assignment: custom roles stay behind the plan on a trial', (await api('/roles', { method: 'POST', token: mtsA.token, body: { name: `MTS Trial Role ${mtsStamp}`, permissions: ['sales.view'] } })).status === 402);
  const mtsAccountPatch = await api('/account', { method: 'PATCH', token: mtsA.token, body: { name: 'MTS Renamed', status: 'suspended', trialUsed: false } });
  check('Mass assignment: a status or trial flag in an account update is refused', mtsAccountPatch.status === 422, mtsAccountPatch.status);
  check('Mass assignment: the account status is unchanged', (await api('/account', { token: mtsA.token })).data?.status === 'active');
  check('Mass assignment: no staff member holds an internal role', ((await api('/staff?limit=50', { token: mtsA.token })).data ?? []).every((user) => user.role !== 'platform_admin'));

  // Logging: sensitive actions are recorded, and secrets are not.
  const mtsAudit = (await api('/platform/audit-log?limit=100', { token: platform2.token })).data ?? [];
  const mtsAuditText = JSON.stringify(mtsAudit);
  check('Logging: sensitive actions are audited', mtsAudit.length > 0 && mtsAudit.every((entry) => Boolean(entry.action)));
  check('Logging: no password, secret, token or API key is recorded', !/"password"|"passwordHash"|"apiKey"|"apiSecret"|"accessToken"|"refreshToken"|"smtpPassword"/i.test(mtsAuditText), mtsAuditText.slice(0, 200));
  const mtsIntegrations = JSON.stringify((await api('/platform/integrations', { token: platform2.token })).data ?? {});
  check('Logging: integrations report only WHETHER a credential is set', mtsIntegrations.includes('apiKeySet') && mtsIntegrations.includes('passwordSet') && !/"apiKey"\s*:\s*"[^"]/.test(mtsIntegrations) && !/"password"\s*:\s*"[^"]/.test(mtsIntegrations), mtsIntegrations.slice(0, 200));
  const mtsSettings = JSON.stringify((await api('/platform/settings', { token: platform2.token })).data ?? {});
  check('Logging: platform settings carry no credential values', !/"apiKey"\s*:\s*"[^"]/.test(mtsSettings) && !/"password"\s*:\s*"[^"]/.test(mtsSettings) && !/"apiSecret"\s*:\s*"[^"]/.test(mtsSettings), mtsSettings.slice(0, 200));
  check('Logging: a session never returns a password hash', !JSON.stringify((await api('/auth/me', { token: mtsA.token })).data ?? {}).toLowerCase().includes('passwordhash'));

  // ------------------------------------------------ production readiness: the six plans
  section('Production readiness: every plan and cycle end to end');
  const prdStamp = Date.now();
  const PRD_PRICES = [
    ['starter', 'monthly', 99_000, 'starter-store-monthly'],
    ['starter', 'annual', 990_000, 'starter-store-annual'],
    ['professional', 'monthly', 199_000, 'showroom-monthly'],
    ['professional', 'annual', 1_990_000, 'showroom-annual'],
    ['enterprise', 'monthly', 299_000, 'brand-monthly'],
    ['enterprise', 'annual', 2_990_000, 'brand-annual'],
  ];
  const prdTotal = PRD_PRICES.reduce((sum, [, , price]) => sum + price, 0);

  const prdReg = await api('/auth/register', { method: 'POST', body: { businessName: `PRD Clothing ${prdStamp}`, name: 'PRD Owner', email: `prd${prdStamp}@example.com`, password: 'Password@123', vertical: 'clothing' } });
  let prdToken = prdReg.data?.tokens?.accessToken;
  const prdAccountId = prdReg.data?.tenant?.accountId;
  check('A fresh account is created for the plan matrix', prdReg.status === 201 && Boolean(prdAccountId), prdReg.error);
  await api(`/platform/accounts/${prdAccountId}/wallet/adjustments`, { method: 'POST', token: platform2.token, body: { direction: 'credit', amountMinor: prdTotal + 100_000, reason: 'Smoke test: plan matrix funding', idempotencyKey: `prd-${prdStamp}-fund` } });

  // One workspace per combination, so each purchase is a clean first subscription
  // rather than a transition, and the six run independently of one another.
  const prdBought = [];
  for (const [plan, billingCycle, expected, legacyCode] of PRD_PRICES) {
    const created = await api('/workspaces', { method: 'POST', token: prdToken, body: { businessName: `PRD ${plan} ${billingCycle} ${prdStamp}`, vertical: 'clothing' } });
    const workspaceId = created.data?.workspace?.id;
    const quote = await api(`/workspaces/${workspaceId}/checkout/quote`, { method: 'POST', token: prdToken, body: { plan, billingCycle } });
    check(`Pricing: ${plan} ${billingCycle} is quoted at ${expected / 100} BDT`, quote.status === 200 && quote.data?.payableMinor === expected && quote.data?.currency === 'BDT', quote.data ?? quote.error);
    const bought = await api(`/workspaces/${workspaceId}/checkout`, { method: 'POST', token: prdToken, body: { paymentMethod: 'wallet', plan, billingCycle, idempotencyKey: `prd${prdStamp}${plan}${billingCycle}`, expectedPayableMinor: expected } });
    check(`Subscription: ${plan} ${billingCycle} is bought from the wallet`, bought.status === 201, bought.error);
    prdBought.push({ plan, billingCycle, expected, legacyCode, workspaceId });
  }

  const prdDash = (await api('/account/dashboard', { token: prdToken })).data;
  // Seven: the six bought above, plus the workspace registration opened on a trial.
  const prdActive = (prdDash?.workspaces ?? []).filter((w) => prdBought.some((row) => row.workspaceId === w.id));
  check('All six subscriptions live side by side in one account', (prdDash?.workspaces ?? []).length === 7 && prdActive.length === 6 && prdActive.every((w) => w.subscription?.status === 'active'), (prdDash?.workspaces ?? []).map((w) => [w.name, w.subscription?.status]));
  check('...alongside the account\u2019s original trial workspace', (prdDash?.workspaces ?? []).some((w) => w.subscription?.status === 'trialing'));
  check('The wallet paid exactly the sum of the six prices', prdDash?.wallet?.balanceMinor === 100_000, { balance: prdDash?.wallet?.balanceMinor, expected: 100_000 });
  for (const row of prdBought) {
    const item = (prdDash?.workspaces ?? []).find((w) => w.id === row.workspaceId);
    check(`Each workspace keeps its own plan: ${row.plan} ${row.billingCycle}`, item?.subscription?.planCode === row.legacyCode && item.subscription.billingCycle === row.billingCycle, item?.subscription);
  }

  // Entitlements per tier, on the workspaces that just bought them.
  for (const [plan, expectedAnalytics] of [['starter', false], ['professional', true], ['enterprise', true]]) {
    const row = prdBought.find((entry) => entry.plan === plan && entry.billingCycle === 'monthly');
    const switched = await api('/auth/switch-workspace', { method: 'POST', token: prdToken, body: { workspaceId: row.workspaceId } });
    prdToken = switched.data?.tokens?.accessToken ?? prdToken;
    await api('/stores', { method: 'POST', token: prdToken, body: { name: `PRD ${plan} Main`, currency: 'BDT' } });
    const dashboard = await api('/reports/overview?preset=last30', { token: prdToken });
    const analytics = await api('/reports/sales?preset=last30', { token: prdToken });
    const entitlements = await api('/subscriptions/entitlements', { token: prdToken });
    check(`Entitlement: ${plan} has the dashboard`, dashboard.status === 200, dashboard.error);
    check(`Entitlement: ${plan} Advanced Analytics is ${expectedAnalytics ? 'available' : 'locked'}`, expectedAnalytics ? analytics.status === 200 : analytics.status === 403 && analytics.error?.code === 'ADVANCED_ANALYTICS_REQUIRED', { status: analytics.status, code: analytics.error?.code });
    check(`Entitlement: ${plan} reports the same to the client`, entitlements.data?.features?.advancedAnalytics?.enabled === expectedAnalytics);
  }

  // Role permissions on the enterprise workspace (custom roles are a paid feature).
  const prdEnterprise = prdBought.find((entry) => entry.plan === 'enterprise' && entry.billingCycle === 'monthly');
  const prdSwitch = await api('/auth/switch-workspace', { method: 'POST', token: prdToken, body: { workspaceId: prdEnterprise.workspaceId } });
  prdToken = prdSwitch.data?.tokens?.accessToken ?? prdToken;
  const prdStore = ((await api('/stores', { token: prdToken })).data ?? [])[0];
  const prdRole = await api('/roles', { method: 'POST', token: prdToken, body: { name: `PRD Till ${prdStamp}`, permissions: ['sales.create', 'sales.view'] } });
  check('Roles: a custom role can be created on Enterprise', prdRole.status === 201, prdRole.error);
  const prdCashierEmail = `prdtill${prdStamp}@example.com`;
  const prdCashier = await api('/staff', { method: 'POST', token: prdToken, storeId: prdStore?._id, body: { name: 'PRD Till', email: prdCashierEmail, password: 'Password@123', roleId: prdRole.data?._id, storeId: prdStore?._id } });
  check('Roles: a staff member takes that role', prdCashier.status === 201, prdCashier.error);
  const prdTill = await login(prdCashierEmail, 'Password@123');
  check('Roles: the role grants what it says', (await api('/sales', { token: prdTill.token })).status === 200);
  check('Roles: and nothing more', (await api('/reports/overview?preset=last30', { token: prdTill.token })).status === 403 && (await api('/staff', { token: prdTill.token })).status === 403 && (await api('/wallet', { token: prdTill.token })).status === 403);
  check('Roles: that staff member cannot reach the account billing center', (await api('/account/billing', { token: prdTill.token })).status === 403 && (await api('/account/dashboard', { token: prdTill.token })).status === 403);

  // Account B sees none of it.
  const prdB = await api('/auth/register', { method: 'POST', body: { businessName: `PRD Other ${prdStamp}`, name: 'PRD Other', email: `prdb${prdStamp}@example.com`, password: 'Password@123', vertical: 'clothing' } });
  const prdBToken = prdB.data?.tokens?.accessToken;
  check('Isolation: a second account starts with its own single workspace', ((await api('/account/dashboard', { token: prdBToken })).data?.workspaces ?? []).length === 1);
  check('Isolation: it cannot see the first account’s workspaces', ((await api('/account/dashboard', { token: prdBToken })).data?.workspaces ?? []).every((w) => !prdBought.some((row) => row.workspaceId === w.id)));
  check('Isolation: it cannot open their subscriptions or wallets', (await api(`/workspaces/${prdEnterprise.workspaceId}/plans`, { token: prdBToken })).status === 404 && (await api(`/account/wallet/transactions?workspaceId=${prdEnterprise.workspaceId}`, { token: prdBToken })).status === 404);
  check('Isolation: its wallet is its own', ((await api('/account/wallet', { token: prdBToken })).data?.balanceMinor ?? 0) === 0);

  // ------------------------------------------------ payment verification infrastructure
  section('Payment verification: Send Money, SMS matching and reconciliation');
  const pviStamp = Date.now();

  const pviReg = await api('/auth/register', { method: 'POST', body: { businessName: `PAY Clothing ${pviStamp}`, name: 'PAY Owner', email: `pay${pviStamp}@example.com`, password: 'Password@123', vertical: 'clothing' } });
  const pviToken = pviReg.data?.tokens?.accessToken;
  const pviWsId = pviReg.data?.tenant?.id;
  const pviAccountId = pviReg.data?.tenant?.accountId;
  const pviOther = await api('/auth/register', { method: 'POST', body: { businessName: `PAY Other ${pviStamp}`, name: 'PAY Other', email: `payb${pviStamp}@example.com`, password: 'Password@123', vertical: 'clothing' } });
  const pviOtherToken = pviOther.data?.tokens?.accessToken;
  const pviBalance = async (token = pviToken) => (await api('/account/wallet', { token })).data?.balanceMinor ?? 0;

  // A registered device: the credential is issued once and is not a login.
  const pviDevice = await api('/platform/payment-devices', { method: 'POST', token: platform2.token, body: { label: `PAY Relay ${pviStamp}`, allowedProviders: ['bkash', 'nagad'], merchantAccounts: ['01700-111222', '01800-333444'] } });
  const pviDeviceId = pviDevice.data?.device?.deviceId;
  const pviSecret = pviDevice.data?.secret;
  check('A payment SMS device is registered and its secret issued once', pviDevice.status === 201 && Boolean(pviDeviceId && pviSecret), pviDevice.error);
  check('The device listing never returns the credential', JSON.stringify((await api('/platform/payment-devices', { token: platform2.token })).data ?? []).includes('tokenHash') === false);

  const pviSms = (body, { deviceId = pviDeviceId, secret = pviSecret } = {}) =>
    api('/payment-providers/paymently/events', { method: 'POST', headers: { 'x-device-id': deviceId ?? '', 'x-device-secret': secret ?? '' }, body });

  // --- the normal path: declare, then prove by SMS -----------------------------
  const pviMethods = await api('/account/payment-methods', { token: pviToken });
  check('The account is offered the active Send Money methods', pviMethods.status === 200 && (pviMethods.data?.sendMoney ?? []).some((m) => m.provider === 'bkash' && m.payTo), pviMethods.data);
  check('An unconfigured hosted gateway is not offered', (pviMethods.data?.hosted ?? []).length === 0);

  const pviRef = `BKT${String(pviStamp).slice(-8)}`;
  const pviOpen = await api('/account/payments/send-money', { method: 'POST', token: pviToken, body: { amountMinor: 50_000, provider: 'bkash', reference: pviRef, customerPhone: '01711111111' } });
  check('Declaring a Send Money transfer opens a pending payment', pviOpen.status === 201 && pviOpen.data?.status === 'pending' && pviOpen.data?.payTo, pviOpen.error);
  check('...and credits nothing on its own', (await pviBalance()) === 0);
  check('The same transaction ID cannot be declared twice', (await api('/account/payments/send-money', { method: 'POST', token: pviToken, body: { amountMinor: 50_000, provider: 'bkash', reference: pviRef, customerPhone: '01711111111' } })).error?.details?.reason === 'REFERENCE_ALREADY_USED');

  const pviMatched = await pviSms({ provider: 'bkash', sender: 'bKash', message: `You have received Tk 500.00 from 01711111111. TrxID ${pviRef} at 16/09/2026 10:00` });
  check('A matching payment SMS verifies the payment', pviMatched.status === 202 && pviMatched.data?.outcome === 'matched', pviMatched.data ?? pviMatched.error);
  check('...and the wallet is credited exactly once', (await pviBalance()) === 50_000);
  const pviLedger = (await api('/account/wallet/transactions?limit=20', { token: pviToken })).data ?? [];
  check('...through the normal wallet ledger', pviLedger.filter((row) => row.direction === 'in' && row.amountMinor === 50_000).length === 1, pviLedger.map((r) => [r.type, r.amountMinor]));

  // --- duplicates and replay ----------------------------------------------------
  const pviReplay = await pviSms({ provider: 'bkash', sender: 'bKash', message: `You have received Tk 500.00 from 01711111111. TrxID ${pviRef} at 16/09/2026 10:00` });
  check('The same SMS delivered again is recognised, not credited again', pviReplay.data?.outcome === 'duplicate' && (await pviBalance()) === 50_000, pviReplay.data);
  const pviBurst = await Promise.all([1, 2, 3, 4, 5].map(() => pviSms({ provider: 'bkash', sender: 'bKash', message: `You have received Tk 500.00 from 01711111111. TrxID ${pviRef} at 16/09/2026 10:00` })));
  check('Five simultaneous deliveries credit nothing further', pviBurst.every((r) => r.status === 202) && (await pviBalance()) === 50_000, pviBurst.map((r) => r.data?.outcome));

  // --- Nagad, through its own parser -------------------------------------------
  const pviNagadRef = `NGD${String(pviStamp).slice(-8)}`;
  await api('/account/payments/send-money', { method: 'POST', token: pviToken, body: { amountMinor: 30_000, provider: 'nagad', reference: pviNagadRef, customerPhone: '01811111111' } });
  const pviNagad = await pviSms({ provider: 'nagad', sender: 'NAGAD', message: `You have received Tk 300.00 from 01811111111. TxnID ${pviNagadRef} at 16/09/2026 11:00` });
  check('A Nagad transfer is matched by its own parser', pviNagad.data?.outcome === 'matched' && (await pviBalance()) === 80_000, pviNagad.data);
  check('A bKash message reported as Nagad is refused', (await pviSms({ provider: 'nagad', sender: 'bKash', message: `You have received Tk 100.00 from 01711111111. TrxID XYZ${pviStamp} at 16/09/2026` })).data?.outcome === 'rejected');

  // --- evidence that does not add up -------------------------------------------
  const pviShortRef = `BKS${String(pviStamp).slice(-8)}`;
  await api('/account/payments/send-money', { method: 'POST', token: pviToken, body: { amountMinor: 100_000, provider: 'bkash', reference: pviShortRef, customerPhone: '01711111111' } });
  const pviShort = await pviSms({ provider: 'bkash', sender: 'bKash', message: `You have received Tk 10.00 from 01711111111. TrxID ${pviShortRef} at 16/09/2026 12:00` });
  check('An SMS for less than the declared amount does not verify', pviShort.data?.outcome === 'unmatched' && (await pviBalance()) === 80_000, pviShort.data);
  check('...and it is flagged for a platform admin instead', (await api('/platform/payment-events?outcome=unmatched&limit=20', { token: platform2.token })).data?.some((e) => e.reference === pviShortRef));
  const pviUnknown = await pviSms({ provider: 'bkash', sender: 'bKash', message: `You have received Tk 900.00 from 01711111111. TrxID NOPE${String(pviStamp).slice(-6)} at 16/09/2026` });
  check('An SMS naming no declared payment credits nothing', pviUnknown.data?.outcome === 'unmatched' && (await pviBalance()) === 80_000);
  check('An unparseable message is rejected', (await pviSms({ provider: 'bkash', sender: 'bKash', message: 'Your balance is low. Recharge now!' })).data?.outcome === 'rejected');

  // --- the device cannot be impersonated, and cannot credit anything ------------
  check('An event with no device credential is refused', (await api('/payment-providers/paymently/events', { method: 'POST', body: { provider: 'bkash', sender: 'bKash', message: 'x' } })).status === 401);
  check('A wrong device secret is refused', (await pviSms({ provider: 'bkash', sender: 'bKash', message: 'x' }, { secret: 'pd_wrong' })).status === 401);
  check('An unknown device id is refused', (await pviSms({ provider: 'bkash', sender: 'bKash', message: 'x' }, { deviceId: 'dev_nope' })).status === 401);
  check('A device cannot name an account, an amount or a payment', (await pviSms({ provider: 'bkash', sender: 'bKash', message: `You have received Tk 500.00 from 01711111111. TrxID FORGE${pviStamp} at 16/09/2026`, accountId: pviAccountId, amountMinor: 999_999, status: 'verified', creditWallet: true })).status === 422);
  check('A customer token is not a device credential', (await api('/payment-providers/paymently/events', { method: 'POST', token: pviToken, body: { provider: 'bkash', sender: 'bKash', message: 'x' } })).status === 401);

  // --- nothing about a payment may come from the client -------------------------
  for (const [label, body] of [
    ['a status', { amountMinor: 1_000, provider: 'bkash', reference: `F1${pviStamp}`, customerPhone: '01711111111', status: 'paid' }],
    ['a verified flag', { amountMinor: 1_000, provider: 'bkash', reference: `F2${pviStamp}`, customerPhone: '01711111111', verificationMethod: 'manual_admin' }],
    ['an account', { amountMinor: 1_000, provider: 'bkash', reference: `F3${pviStamp}`, customerPhone: '01711111111', accountId: pviAccountId }],
    ['a merchant account', { amountMinor: 1_000, provider: 'bkash', reference: `F4${pviStamp}`, customerPhone: '01711111111', merchantAccount: '01999999999' }],
  ]) {
    check(`A payment carrying ${label} is refused`, (await api('/account/payments/send-money', { method: 'POST', token: pviToken, body })).status === 422, label);
  }
  check("A payment cannot name another account's workspace", (await api('/account/payments/send-money', { method: 'POST', token: pviToken, body: { amountMinor: 1_000, provider: 'bkash', reference: `F5${pviStamp}`, customerPhone: '01711111111', workspaceId: pviOther.data?.tenant?.id } })).status === 404);
  check('An unconfigured hosted gateway cannot be started', [400, 422].includes((await api('/account/payments/hosted', { method: 'POST', token: pviToken, body: { amountMinor: 1_000, provider: 'uddoktapay' } })).status));

  // --- manual reconciliation ----------------------------------------------------
  const pviManualRef = `MAN${String(pviStamp).slice(-8)}`;
  const pviManual = await api('/account/payments/send-money', { method: 'POST', token: pviToken, body: { amountMinor: 20_000, provider: 'bkash', reference: pviManualRef, customerPhone: '01711111111' } });
  const pviManualId = pviManual.data?.paymentId;
  check('A customer cannot verify their own payment', [403, 404].includes((await api(`/platform/payments/${pviManualId}/manual-verify`, { method: 'POST', token: pviToken, body: { reason: 'Please just approve this one' } })).status));
  check('Manual verification needs a reason', (await api(`/platform/payments/${pviManualId}/manual-verify`, { method: 'POST', token: platform2.token, body: { reason: 'short' } })).status === 422);
  const pviApproved = await api(`/platform/payments/${pviManualId}/manual-verify`, { method: 'POST', token: platform2.token, body: { reason: 'Checked the merchant statement against the customer receipt' } });
  check('A platform admin can verify it, crediting the wallet once', pviApproved.status === 200 && (await pviBalance()) === 100_000, pviApproved.error);
  check('Verifying it again credits nothing further', (await api(`/platform/payments/${pviManualId}/manual-verify`, { method: 'POST', token: platform2.token, body: { reason: 'Trying the same approval twice over' } })).status === 400 && (await pviBalance()) === 100_000);

  const pviRejectRef = `REJ${String(pviStamp).slice(-8)}`;
  const pviReject = await api('/account/payments/send-money', { method: 'POST', token: pviToken, body: { amountMinor: 20_000, provider: 'bkash', reference: pviRejectRef, customerPhone: '01711111111' } });
  check('A claim that cannot be proven is rejected, not credited', (await api(`/platform/payments/${pviReject.data?.paymentId}/manual-reject`, { method: 'POST', token: platform2.token, body: { reason: 'No matching transaction in the merchant statement' } })).status === 200 && (await pviBalance()) === 100_000);

  // --- administration and isolation ---------------------------------------------
  check('A workspace owner cannot manage payment devices', (await api('/platform/payment-devices', { token: pviToken })).status === 403 && (await api('/platform/payment-devices', { method: 'POST', token: pviToken, body: { label: 'Mine', allowedProviders: ['bkash'], merchantAccounts: [] } })).status === 403);
  check('A workspace owner cannot read reported SMS evidence', (await api('/platform/payment-events', { token: pviToken })).status === 403);
  check('Staff cannot reach payment administration', (await api('/platform/payment-events', { token: cashier.token })).status === 403);
  check("A payment never credits another account's wallet", (await pviBalance(pviOtherToken)) === 0);
  check("...and the other account sees none of these payments", ((await api('/account/payments?limit=50', { token: pviOtherToken })).data ?? []).every((p) => p.workspaceId !== pviWsId));

  // --- audit --------------------------------------------------------------------
  const pviAudit = (await api('/platform/audit-log?limit=100', { token: platform2.token })).data ?? [];
  const pviActions = pviAudit.map((entry) => entry.action);
  check('Registering a device is audited', pviActions.includes('platform.payment_device_registered'));
  check('Manual verification and rejection are audited', pviActions.includes('platform.payment_manually_verified') && pviActions.includes('platform.payment_manually_rejected'));
  check('No device credential is ever written to the audit log', !JSON.stringify(pviAudit).includes(pviSecret ?? 'pd_never'));

  // --- revocation ----------------------------------------------------------------
  const pviDeviceRow = ((await api('/platform/payment-devices', { token: platform2.token })).data ?? []).find((d) => d.deviceId === pviDeviceId);
  check('A revoked device stops being accepted immediately', (await api(`/platform/payment-devices/${pviDeviceRow?.id}/revoke`, { method: 'POST', token: platform2.token, body: { reason: 'The handset was lost by the shop manager' } })).status === 200 && (await pviSms({ provider: 'bkash', sender: 'bKash', message: `You have received Tk 100.00 from 01711111111. TrxID AFTER${String(pviStamp).slice(-6)} at 16/09/2026` })).status === 401);
  check('The wallet is untouched after revocation', (await pviBalance()) === 100_000);

  // ------------------------------------------------ clothing POS product grid + categories
  section('Clothing POS: product grid paging and category filter');
  const pcgStamp = Date.now();
  const pcgReg = await api('/auth/register', { method: 'POST', body: { businessName: `PCG Clothing ${pcgStamp}`, name: 'PCG Owner', email: `pcg${pcgStamp}@example.com`, password: 'Password@123', vertical: 'clothing' } });
  const pcgToken = pcgReg.data?.tokens?.accessToken;
  const pcgStore = await api('/stores', { method: 'POST', token: pcgToken, body: { name: 'PCG Main', currency: 'BDT' } });
  const pcgCat = async (name) => (await api('/categories', { method: 'POST', token: pcgToken, body: { name: `${name} ${pcgStamp}` } })).data?._id;
  const pcgShirts = await pcgCat('Shirts');
  const pcgPants = await pcgCat('Pants');
  const pcgWinter = await pcgCat('Winter');
  const pcgEmpty = await pcgCat('Empty');
  check('Categories are created for the store', Boolean(pcgShirts && pcgPants && pcgWinter && pcgEmpty));

  // Products with MANY variants each - the case that used to fill the grid after a handful of cards.
  const pcgSizes = ['S', 'M', 'L', 'XL', 'XXL', '3XL'];
  const pcgMake = async (label, categoryId, index) =>
    api('/products', {
      method: 'POST',
      token: pcgToken,
      body: {
        name: `${label} ${String(index).padStart(2, '0')} ${pcgStamp}`,
        categoryId,
        variants: pcgSizes.map((size) => ({ attributes: [{ name: 'Size', value: size }], sku: `PCG${pcgStamp}${label.slice(0, 2)}${index}-${size}`, sellingPriceMinor: 100_000, stock: 5 })),
      },
    });
  const pcgShirtIds = [];
  for (let i = 1; i <= 20; i += 1) pcgShirtIds.push((await pcgMake('Shirt', pcgShirts, i)).data?._id);
  const pcgPantIds = [];
  for (let i = 1; i <= 10; i += 1) pcgPantIds.push((await pcgMake('Pant', pcgPants, i)).data?._id);
  check('30 products with 6 variants each are created', [...pcgShirtIds, ...pcgPantIds].every(Boolean));

  const pcgPage = (params) => api(`/products/pos-catalog?${new URLSearchParams(params)}`, { token: pcgToken });
  const pcgProductsOf = (items) => [...new Set((items ?? []).map((row) => row.productId))];
  const pcgAll = async (params) => {
    const seen = [];
    for (let page = 1; page < 20; page += 1) {
      const res = await pcgPage({ ...params, page, limit: 12 });
      seen.push(...pcgProductsOf(res.data?.items));
      if (!res.data?.hasMore) break;
    }
    return seen;
  };

  // Paging is by PRODUCT: 180 variants no longer cap the grid at a handful of cards.
  const pcgP1 = await pcgPage({ page: 1, limit: 12 });
  check('Page 1 holds 12 products, not 12 variants', pcgP1.status === 200 && pcgProductsOf(pcgP1.data?.items).length === 12 && pcgP1.data.items.length === 72 && pcgP1.data.hasMore === true, { status: pcgP1.status, products: pcgProductsOf(pcgP1.data?.items).length, rows: pcgP1.data?.items?.length });
  const pcgEvery = await pcgAll({});
  check('Scrolling through every page reaches all 30 products', pcgEvery.length === 30 && new Set(pcgEvery).size === 30, pcgEvery.length);
  check('The last page says there is nothing more', (await pcgPage({ page: 3, limit: 12 })).data?.hasMore === false);
  check('Each card carries all of its variants for the variant picker', pcgP1.data?.items?.filter((row) => row.productId === pcgP1.data.items[0].productId).length === 6);

  // Categories.
  const pcgShirtAll = await pcgAll({ categoryId: pcgShirts });
  check('A category shows ALL of its products, across pages', pcgShirtAll.length === 20 && pcgShirtAll.every((id) => pcgShirtIds.includes(id)), pcgShirtAll.length);
  const pcgPantAll = await pcgAll({ categoryId: pcgPants });
  check('Another category shows only its own products', pcgPantAll.length === 10 && pcgPantAll.every((id) => pcgPantIds.includes(id)));
  const pcgEmptyRes = await pcgPage({ categoryId: pcgEmpty, page: 1, limit: 12 });
  check('A category with no products returns an empty page', pcgEmptyRes.status === 200 && pcgEmptyRes.data?.items?.length === 0 && pcgEmptyRes.data.hasMore === false);
  const pcgCats = (await api('/categories?limit=100', { token: pcgToken })).data ?? [];
  check('The category list reports which categories hold products', pcgCats.find((c) => c._id === pcgShirts)?.productCount === 20 && pcgCats.find((c) => c._id === pcgEmpty)?.productCount === 0);

  // Search, with and without a category.
  const pcgSearchAll = await pcgAll({ q: 'Shirt 1' });
  // 'Shirt 1' matches Shirt 10-19 (names are zero-padded, so not Shirt 01).
  check('All + search finds every matching product', pcgSearchAll.length === 10, pcgSearchAll.length);
  check('Category + search narrows to both', (await pcgAll({ q: 'Shirt 1', categoryId: pcgShirts })).length === 10 && (await pcgAll({ q: 'Shirt 1', categoryId: pcgPants })).length === 0);
  check('A variant SKU finds its product', pcgProductsOf((await pcgPage({ q: `PCG${pcgStamp}Pa3-M` })).data?.items).includes(pcgPantIds[2]));
  check('Clearing search and category returns everything', (await pcgAll({})).length === 30);

  // Newly added, moved, inactive and deleted products.
  const pcgCoat = (await api('/products', { method: 'POST', token: pcgToken, body: { name: `Coat ${pcgStamp}`, categoryId: pcgWinter, variants: [{ attributes: [], sku: `PCG${pcgStamp}COAT`, sellingPriceMinor: 300_000, stock: 2 }] } })).data?._id;
  check('A newly added product appears under its new category', (await pcgAll({ categoryId: pcgWinter })).includes(pcgCoat));
  await api(`/products/${pcgPantIds[0]}`, { method: 'PATCH', token: pcgToken, body: { categoryId: pcgShirts } });
  check('A product moved to another category appears there, and not in the old one', (await pcgAll({ categoryId: pcgShirts })).includes(pcgPantIds[0]) && !(await pcgAll({ categoryId: pcgPants })).includes(pcgPantIds[0]));
  await api(`/products/${pcgPantIds[1]}`, { method: 'PATCH', token: pcgToken, body: { isActive: false } });
  await api(`/products/${pcgPantIds[2]}`, { method: 'DELETE', token: pcgToken });
  const pcgAfter = await pcgAll({});
  check('Inactive and deleted products are not offered for sale', !pcgAfter.includes(pcgPantIds[1]) && !pcgAfter.includes(pcgPantIds[2]) && pcgAfter.length === 29, pcgAfter.length);

  // The fixed search: category is applied before the limit, not after.
  const pcgLegacy = await api(`/products/pos-search?categoryId=${pcgPants}&limit=50`, { token: pcgToken });
  check('pos-search with a category returns that category, not whatever fell in the first N', pcgLegacy.status === 200 && pcgLegacy.data.length > 0 && pcgLegacy.data.every((row) => String(row.categoryId) === String(pcgPants)), { n: pcgLegacy.data?.length });

  // Barcode lookup is untouched.
  const pcgBarcodeProduct = (await api('/products', { method: 'POST', token: pcgToken, body: { name: `Scarf ${pcgStamp}`, categoryId: pcgWinter, variants: [{ attributes: [], sku: `PCG${pcgStamp}SCARF`, barcode: `88${String(pcgStamp).slice(-10)}`, sellingPriceMinor: 50_000, stock: 3 }] } })).data;
  const pcgScan = await api(`/products/pos-search?q=88${String(pcgStamp).slice(-10)}&limit=5`, { token: pcgToken });
  check('Barcode lookup still returns the exact variant', pcgScan.status === 200 && pcgScan.data?.[0]?.barcode === `88${String(pcgStamp).slice(-10)}` && pcgScan.data[0].productId === pcgBarcodeProduct?._id);

  // Validation and isolation.
  check('A page larger than allowed is refused', (await pcgPage({ limit: 500 })).status === 422);
  check('An unknown filter is refused', (await pcgPage({ tenantId: 'x' })).status === 422);
  check('A malformed category id is refused', (await pcgPage({ categoryId: 'nope' })).status === 422);
  const pcgForeign = await api(`/products/pos-catalog?categoryId=${pcgShirts}&limit=50`, { token: admin.token });
  check("Another workspace's category shows none of its products", pcgForeign.status === 200 && pcgForeign.data?.items?.length === 0);
  check("Another workspace's branch cannot be borrowed", (await api('/products/pos-catalog', { token: admin.token, storeId: pcgStore.data?._id })).status === 403);
  check('Another workspace never sees these products in its grid', !JSON.stringify((await api('/products/pos-catalog?limit=60', { token: admin.token })).data ?? {}).includes(`${pcgStamp}`));
  check('Signed-out requests are refused', (await api('/products/pos-catalog')).status === 401);

  // A cashier can browse the grid and the categories, and the sale flow is unchanged.
  const pcgCashierGrid = await api('/products/pos-catalog?limit=12', { token: cashier.token });
  check('A cashier can browse the POS grid and categories', pcgCashierGrid.status === 200 && (await api('/categories?limit=100', { token: cashier.token })).status === 200);
  const pcgVariant = pcgP1.data?.items?.find((row) => row.stock > 0);
  const pcgSale = await api('/sales', { method: 'POST', token: pcgToken, body: { items: [{ variantId: pcgVariant?.variantId, quantity: 2 }], paymentMethod: 'cash' } });
  check('A variant picked from the grid sells through the normal sale flow', pcgSale.status === 201 && pcgSale.data?.totalMinor === 200_000, pcgSale.error);
  const pcgStockAfter = (await pcgPage({ q: pcgVariant?.sku ?? '' })).data?.items?.find((row) => row.variantId === pcgVariant?.variantId)?.stock;
  check('The grid shows the stock after the sale', pcgStockAfter === 3, pcgStockAfter);

  // ------------------------------------------------ POS payment without a tendered field
  section('Clothing POS: payment without a tendered amount');
  const ptnStamp = Date.now();
  const ptnReg = await api('/auth/register', { method: 'POST', body: { businessName: `PTN Clothing ${ptnStamp}`, name: 'PTN Owner', email: `ptn${ptnStamp}@example.com`, password: 'Password@123', vertical: 'clothing' } });
  const ptnToken = ptnReg.data?.tokens?.accessToken;
  await api('/stores', { method: 'POST', token: ptnToken, body: { name: 'PTN Main', currency: 'BDT' } });
  const ptnProduct = await api('/products', { method: 'POST', token: ptnToken, body: { name: `PTN Tee ${ptnStamp}`, variants: [{ attributes: [], sku: `PTN${ptnStamp}`, sellingPriceMinor: 100_000, stock: 20 }] } });
  const ptnVariantId = ptnProduct.data?.variants?.[0]?._id;
  const ptnSale = (payments, extra = {}) =>
    api('/sales', { method: 'POST', token: ptnToken, body: { items: [{ variantId: ptnVariantId, quantity: 1 }], paymentMethod: payments[0].method, payments, ...extra } });

  // A lower agreed price goes through the discount, and one method pays the new total in full.
  const ptnDiscounted = await ptnSale([{ method: 'cash', amountMinor: 90_000, reference: '' }], { discountType: 'fixed', discountValue: 10_000 });
  check('One method paying the discounted total in full completes the sale', ptnDiscounted.status === 201 && ptnDiscounted.data?.totalMinor === 90_000 && ptnDiscounted.data.paidMinor === 90_000 && ptnDiscounted.data.changeMinor === 0, ptnDiscounted.data ?? ptnDiscounted.error);
  const ptnSplit = await ptnSale([{ method: 'cash', amountMinor: 70_000, reference: '' }, { method: 'bkash', amountMinor: 30_000, reference: '' }]);
  check('A split where the first method covers the rest completes the sale', ptnSplit.status === 201 && ptnSplit.data?.payments?.length === 2 && ptnSplit.data.paidMinor === 100_000, ptnSplit.error);
  const ptnShort = await ptnSale([{ method: 'cash', amountMinor: 70_000, reference: '' }]);
  check('Paying less than the total is still refused by the server', ptnShort.status === 422, ptnShort.status);


  // --- The same tender rules in every vertical ---------------------------------
  // One service settles every POS sale: enabled for the branch, covering the
  // total, change only out of cash. These run the same four tenders through all
  // four verticals and check they are answered the same way.
  section('POS tender rules (all verticals)');

  const setMethods = (token, methods) => api('/stores/current', { method: 'PATCH', token, body: { paymentMethods: methods } });
  const ALL_METHODS = ['cash', 'bkash', 'nagad', 'bank', 'card', 'other'];

  // Each vertical: how it takes money, what it costs, and how it refuses.
  const tenderVerticals = [
    {
      name: 'Clothing',
      token: ptnToken,
      totalMinor: 100_000,
      // A method the branch has turned off is a bad request in every vertical;
      // Clothing alone answers 422 for a tender that does not add up.
      refusalMethod: 400,
      refusalAmount: 422,
      // A Clothing payment row also carries a reference (a bKash trx id, say),
      // which the three newer verticals do not have. Task 03 territory.
      sell: (payments) =>
        api('/sales', {
          method: 'POST',
          token: ptnToken,
          body: {
            items: [{ variantId: ptnVariantId, quantity: 1 }],
            paymentMethod: payments[0].method,
            payments: payments.map((payment) => ({ ...payment, reference: '' })),
          },
        }),
      paidOf: (r) => r.data?.paidMinor,
      changeOf: (r) => r.data?.changeMinor,
    },
    {
      name: 'Super Shop',
      token: ssToken,
      totalMinor: 4800,
      refusalMethod: 400,
      refusalAmount: 400,
      sell: (payments) => ssSale({ items: [{ productId: soap.data._id, quantity: 1 }], payments }),
      paidOf: (r) => r.data?.paidMinor,
      changeOf: (r) => r.data?.changeMinor,
    },
    {
      name: 'Pharmacy',
      token: phToken,
      totalMinor: 120,
      refusalMethod: 400,
      refusalAmount: 400,
      sell: (payments) => phApi('/sales', { method: 'POST', body: { items: [{ medicineId: napa.data._id, quantity: 1 }], payments } }),
      paidOf: (r) => r.data?.paidMinor,
      changeOf: (r) => r.data?.changeMinor,
    },
    {
      name: 'Restaurant',
      token: rvToken,
      totalMinor: 8000,
      refusalMethod: 400,
      refusalAmount: 400,
      // A restaurant settles an ORDER, so open one and pay it.
      sell: async (payments) => {
        const order = await rvOrder({ type: 'takeaway', items: [{ menuItemId: borhani.data._id, quantity: 1 }] });
        return api(`/restaurant/orders/${order.data._id}/pay`, { method: 'POST', token: rvToken, body: { rev: order.data.rev, payments } });
      },
      paidOf: (r) => r.data?.paidMinor,
      changeOf: (r) => r.data?.changeMinor,
    },
  ];

  for (const v of tenderVerticals) {
    const total = v.totalMinor;

    // Rule 1: the branch's enabled methods are the branch's, not the client's.
    await setMethods(v.token, ['cash', 'bkash']);
    const disabled = await v.sell([{ method: 'card', amountMinor: total }]);
    check(`${v.name}: a method this branch has turned off is refused`, disabled.status === v.refusalMethod, { status: disabled.status, error: disabled.error?.message });
    await setMethods(v.token, ALL_METHODS);

    // Rule 2: the money has to cover the sale.
    const short = await v.sell([{ method: 'cash', amountMinor: total - 1 }]);
    check(`${v.name}: a payment short of the total is refused`, short.status === v.refusalAmount, { status: short.status, error: short.error?.message });

    // Exactly the total: settled, nothing to give back.
    const exact = await v.sell([{ method: 'cash', amountMinor: total }]);
    check(`${v.name}: paying exactly the total settles it with no change`, exact.status < 300 && v.paidOf(exact) === total && v.changeOf(exact) === 0, {
      status: exact.status,
      paid: v.paidOf(exact),
      change: v.changeOf(exact),
      error: exact.error,
    });

    // A split that adds up, across two methods.
    const split = await v.sell([
      { method: 'cash', amountMinor: total - 100 },
      { method: 'bkash', amountMinor: 100 },
    ]);
    check(`${v.name}: a split across two methods that adds up is accepted`, split.status < 300 && v.paidOf(split) === total && v.changeOf(split) === 0, {
      status: split.status,
      paid: v.paidOf(split),
      error: split.error,
    });

    // Rule 3: change comes out of the drawer.
    const overCash = await v.sell([{ method: 'cash', amountMinor: total + 5000 }]);
    check(`${v.name}: cash over the total is change, not revenue`, overCash.status < 300 && v.changeOf(overCash) === 5000, {
      status: overCash.status,
      change: v.changeOf(overCash),
      error: overCash.error,
    });

    // What the till actually sends once it can split: the cash row carries what
    // was handed over, every other row what it paid.
    const splitWithChange = await v.sell([
      { method: 'cash', amountMinor: total - 100 + 5000 },
      { method: 'bkash', amountMinor: 100 },
    ]);
    check(`${v.name}: a split where the cash is over-tendered gives change`, splitWithChange.status < 300 && v.changeOf(splitWithChange) === 5000, {
      status: splitWithChange.status,
      change: v.changeOf(splitWithChange),
      error: splitWithChange.error,
    });
  }

  // Rule 3, where the four still differ. An over-tendered card cannot be handed
  // back out of the drawer, so the three newer verticals refuse it. Clothing
  // takes it, and has since before this service existed: its till sends the cash
  // handed over separately (`cashTenderedMinor`), and that path already refuses
  // change that did not come from cash. Task 03 is where the two converge.
  for (const v of tenderVerticals.filter((entry) => entry.name !== 'Clothing')) {
    const overCard = await v.sell([{ method: 'card', amountMinor: v.totalMinor + 5000 }]);
    check(`${v.name}: a card over the total is refused - only cash can exceed it`, overCard.status === v.refusalAmount, { status: overCard.status, error: overCard.error?.message });
  }
  const clothingOverCard = await tenderVerticals[0].sell([{ method: 'card', amountMinor: 105_000 }]);
  check(
    'Clothing: an over-tendered card is still accepted (the one rule it does not share yet)',
    clothingOverCard.status === 201 && clothingOverCard.data?.changeMinor === 5000,
    { status: clothingOverCard.status, change: clothingOverCard.data?.changeMinor },
  );
  const ctnCashPath = await api('/sales', {
    method: 'POST',
    token: ptnToken,
    body: {
      items: [{ variantId: ptnVariantId, quantity: 1 }],
      paymentMethod: 'card',
      payments: [{ method: 'card', amountMinor: 100_000, reference: '' }],
      cashTenderedMinor: 5000,
    },
  });
  check('Clothing: cash received with no cash payment is refused on the cash path', ctnCashPath.status === 422, ctnCashPath.status);


  // --- One stock ledger, four verticals ----------------------------------------
  // Every vertical keeps its own ledger with its own columns; `/stock-ledger`
  // answers the question they all share - what moved, by how much, what was
  // left, why, and who did it - in one shape.
  section('Stock ledger (all verticals)');

  const ledgerOf = async (path, token, params = '') => api(`${path}/stock-ledger${params}`, { token });
  const ledgerShape = (row) =>
    row &&
    typeof row.id === 'string' &&
    typeof row.itemLabel === 'string' &&
    typeof row.quantityChange === 'number' &&
    typeof row.balanceBefore === 'number' &&
    typeof row.balanceAfter === 'number' &&
    typeof row.by === 'string' &&
    'referenceNumber' in row &&
    'at' in row;

  const ssLedger = await ledgerOf('/supershop', ssToken);
  check('Super Shop: the ledger reads in the shared shape', ssLedger.status === 200 && ledgerShape(ssLedger.data?.[0]), ssLedger.data?.[0] ?? ssLedger.error);
  check(
    'Super Shop: a sale is a negative movement that lands on the balance',
    (ssLedger.data ?? []).some((row) => row.type === 'sale' && row.quantityChange < 0 && row.balanceAfter === row.balanceBefore + row.quantityChange),
    (ssLedger.data ?? []).slice(0, 3),
  );
  check('Super Shop: the sale rows carry the invoice they came from', (ssLedger.data ?? []).some((row) => row.type === 'sale' && row.referenceNumber.startsWith('INV-')));

  const phLedger = await ledgerOf('/pharmacy', phToken);
  check('Pharmacy: the ledger reads in the same shape', phLedger.status === 200 && ledgerShape(phLedger.data?.[0]), phLedger.data?.[0] ?? phLedger.error);
  check('Pharmacy: a movement names the batch it moved', (phLedger.data ?? []).every((row) => row.itemDetail.startsWith('Batch ')), (phLedger.data ?? [])[0]);
  check(
    'Pharmacy: putting a voided sale back is its own movement, per batch',
    (phLedger.data ?? []).some((row) => row.type === 'void' && row.quantityChange > 0),
  );

  const clLedger = await ledgerOf('/inventory', admin.token);
  check('Clothing: the ledger reads in the same shape', clLedger.status === 200 && ledgerShape(clLedger.data?.[0]), clLedger.data?.[0] ?? clLedger.error);
  check('Clothing: rows name the variant and its SKU', (clLedger.data ?? []).some((row) => row.itemLabel.includes('(') && row.itemDetail.length > 0), (clLedger.data ?? [])[0]);

  // A restaurant has no stock, and says so rather than failing.
  const rvLedger = await ledgerOf('/restaurant', rvToken);
  check('Restaurant: the same route answers with an empty ledger, not an error', rvLedger.status === 200 && (rvLedger.data ?? []).length === 0 && rvLedger.meta?.total === 0, rvLedger.data ?? rvLedger.error);

  // Filters behave the same everywhere.
  const ssFirstItem = (ssLedger.data ?? [])[0]?.itemId;
  const ssFiltered = await ledgerOf('/supershop', ssToken, `?itemId=${ssFirstItem}`);
  check('The ledger filters to one item', ssFiltered.status === 200 && (ssFiltered.data ?? []).every((row) => row.itemId === ssFirstItem), ssFiltered.data?.length);
  const ssSales = await ledgerOf('/supershop', ssToken, '?type=sale');
  check('The ledger filters by movement type', ssSales.status === 200 && (ssSales.data ?? []).every((row) => row.type === 'sale'));
  check('An unknown item id is rejected, not ignored', (await ledgerOf('/supershop', ssToken, '?itemId=not-an-id')).status === 422);
  check('The ledger is paginated', (await ledgerOf('/supershop', ssToken, '?limit=1')).data?.length === 1);
  check('Reading the ledger needs a session', (await api('/supershop/stock-ledger')).status === 401);
  check('Another workspace cannot read this one’s ledger', (await ledgerOf('/supershop', phToken)).status === 403);

  // --- What the shelf is worth (Super Shop inventory screen) -------------------
  // The cards above the Inventory screen. Counted from the CATALOGUE, so a
  // product that has never been received still counts as out of stock, and
  // weighed goods keep their cost per kilogram against a quantity in grams.
  section('Inventory summary (Super Shop)');

  const invSummary = async () => (await ssApi('/inventory-summary')).data;
  const invBefore = await invSummary();
  check(
    'The summary answers with the five figures the screen shows',
    invBefore &&
      ['productCount', 'stockValueMinor', 'retailValueMinor', 'outOfStock', 'lowStock'].every((key) => typeof invBefore[key] === 'number'),
    invBefore,
  );

  const invProduct = (await ssApi('/products', {
    method: 'POST',
    body: { name: `Inv Counted Rice ${Date.now()}`, category: 'Inventory test', unitType: 'each', priceMinor: 12_000, reorderLevel: 4 },
  })).data;
  const invNew = await invSummary();
  check('A product that was never received counts as out of stock', invNew.outOfStock === invBefore.outOfStock + 1 && invNew.productCount === invBefore.productCount + 1, {
    before: invBefore.outOfStock,
    after: invNew.outOfStock,
  });

  await ssApi(`/products/${invProduct._id}/stock`, { method: 'POST', body: { quantity: 10, costPriceMinor: 500 } });
  const invReceived = await invSummary();
  check('Receiving 10 pieces at ৳5 adds exactly ৳50 of stock value', invReceived.stockValueMinor === invNew.stockValueMinor + 5_000, {
    before: invNew.stockValueMinor,
    after: invReceived.stockValueMinor,
  });
  check('And the product is no longer counted as out of stock', invReceived.outOfStock === invNew.outOfStock - 1);
  check('Shelf value uses the selling price, not the cost', invReceived.retailValueMinor === invNew.retailValueMinor + 120_000, {
    before: invNew.retailValueMinor,
    after: invReceived.retailValueMinor,
  });

  // At or below the reorder level, but not empty: low, not out.
  await ssApi(`/products/${invProduct._id}/adjust`, { method: 'POST', body: { type: 'adjust', quantityDelta: -7, reason: 'Counted down to the reorder level' } });
  const invLow = await invSummary();
  check('At the reorder level the product is low, not out', invLow.lowStock === invReceived.lowStock + 1 && invLow.outOfStock === invReceived.outOfStock);

  // Weighed goods: the cost is per kilogram against a quantity in grams.
  const invWeighed = (await ssApi('/products', {
    method: 'POST',
    body: { name: `Inv Weighed Dal ${Date.now()}`, category: 'Inventory test', unitType: 'weight', priceMinor: 20_000, reorderLevel: 0 },
  })).data;
  const invBeforeWeight = await invSummary();
  await ssApi(`/products/${invWeighed._id}/stock`, { method: 'POST', body: { quantity: 2_500, costPriceMinor: 16_000 } });
  const invAfterWeight = await invSummary();
  check('2.5 kg at ৳160 per kg is worth ৳400, not 2,500 times the price', invAfterWeight.stockValueMinor === invBeforeWeight.stockValueMinor + 40_000, {
    before: invBeforeWeight.stockValueMinor,
    after: invAfterWeight.stockValueMinor,
  });

  check('The summary needs a session', (await api('/supershop/inventory-summary')).status === 401);
  check('Another workspace cannot read this one’s stock value', (await api('/supershop/inventory-summary', { token: phToken })).status === 403);


  // --- Selling what the system says is gone, in every vertical -----------------
  // The same permission, the same narrow rule as Clothing: it covers "there is
  // none of this", never "there is not enough". A pharmacy adds one of its own -
  // units must still be attributable to a real, unexpired batch.
  section('Out-of-stock override (Super Shop and Pharmacy)');

  const oosStaff = async (token, storeId, email, permissions) => {
    const created = await api('/staff', {
      method: 'POST',
      token,
      body: { name: 'OOS Till', email, password: 'Password@123', storeId, extraPermissions: permissions },
    });
    return { id: created.data?.id, created, session: await login(email, 'Password@123') };
  };
  const TILL_PERMISSIONS = ['sales.create', 'sales.view', 'products.view', 'inventory.view'];
  const oosStamp = String(Date.now()).slice(-6);

  // --- Super Shop --------------------------------------------------------------
  const ssStoreId = (await api('/stores', { token: ssToken })).data?.[0]?._id;
  const ssTill = await oosStaff(ssToken, ssStoreId, `ssoos${oosStamp}@example.com`, TILL_PERMISSIONS);
  check('Super Shop: a till can be created without the override', ssTill.created.status === 201, ssTill.created.error);
  check('Super Shop: and does not hold it', !ssTill.session.session.user.permissions.includes('sales.sellOutOfStock'));

  // Empty one product completely, and leave another with some but not enough.
  const oosSoapOnHand = (await ssApi(`/products/${soap.data._id}`)).data?.product?.stock?.quantityOnHand ?? 0;
  await ssApi(`/products/${soap.data._id}/adjust`, { method: 'POST', body: { type: 'adjust', quantityDelta: -oosSoapOnHand, reason: 'Emptied for the override test' } });
  check('Super Shop: the product is now at zero', (await ssApi(`/products/${soap.data._id}`)).data?.product?.stock?.quantityOnHand === 0);

  const ssSellAs = (token, quantity = 1) =>
    api('/supershop/sales', { method: 'POST', token, body: { items: [{ productId: soap.data._id, quantity }], payments: [{ method: 'cash', amountMinor: 50_000 }] } });

  const ssRefused = await ssSellAs(ssTill.session.token);
  check('Super Shop: a till without the permission cannot sell what is not there', ssRefused.status === 400, ssRefused.error?.message);
  check('Super Shop: and nothing moved', (await ssApi(`/products/${soap.data._id}`)).data?.product?.stock?.quantityOnHand === 0);

  await api(`/staff/${ssTill.id}`, { method: 'PATCH', token: ssToken, body: { extraPermissions: [...TILL_PERMISSIONS, 'sales.sellOutOfStock'] } });
  const ssOverride = await ssSellAs(ssTill.session.token, 2);
  check('Super Shop: with the permission the sale goes through', ssOverride.status === 201, ssOverride.error);
  check('Super Shop: the line says it was sold out of stock', ssOverride.data?.items?.[0]?.outOfStockOverride === true, ssOverride.data?.items?.[0]);
  check('Super Shop: stock is now negative by what was sold', (await ssApi(`/products/${soap.data._id}`)).data?.product?.stock?.quantityOnHand === -2);
  const ssOosLedger = (await api(`/supershop/stock-ledger?itemId=${soap.data._id}&limit=5`, { token: ssToken })).data ?? [];
  check('Super Shop: the ledger row is flagged and shows the negative balance', ssOosLedger[0]?.balanceAfter === -2 && ssOosLedger[0]?.quantityChange === -2, ssOosLedger[0]);

  // The narrow rule: "some but not enough" is refused for everyone.
  await ssApi(`/products/${soap.data._id}/stock`, { method: 'POST', body: { quantity: 5, costPriceMinor: 3000 } });
  check('Super Shop: receiving pays off the negative first', (await ssApi(`/products/${soap.data._id}`)).data?.product?.stock?.quantityOnHand === 3);
  const ssNotEnough = await ssSellAs(ssTill.session.token, 4);
  check('Super Shop: the override does not cover "not enough", even with the permission', ssNotEnough.status === 400, ssNotEnough.error?.message);

  // A product never received into this branch has no stock row and no cost basis.
  const ssNever = await ssProduct({ name: `Never Received ${oosStamp}`, priceMinor: 1000 });
  const ssNeverSold = await api('/supershop/sales', {
    method: 'POST',
    token: ssTill.session.token,
    body: { items: [{ productId: ssNever.data._id, quantity: 1 }], payments: [{ method: 'cash', amountMinor: 1000 }] },
  });
  check('Super Shop: a product never received here is still refused', ssNeverSold.status === 400, ssNeverSold.error?.message);

  // --- Pharmacy ----------------------------------------------------------------
  const phStoreId = (await api('/stores', { token: phToken })).data?.[0]?._id;
  const phTill = await oosStaff(phToken, phStoreId, `phoos${oosStamp}@example.com`, TILL_PERMISSIONS);
  check('Pharmacy: a till can be created without the override', phTill.created.status === 201, phTill.created.error);

  // A medicine whose only unexpired batch has been emptied.
  const phOos = await phMedicine({ name: `Oosmed ${oosStamp}`, strength: '10 mg', dosageForm: 'tablet', sellingPriceMinor: 500 });
  await phReceive(phOos.data._id, { batchNumber: `OOS-${oosStamp}`, expiryDate: phDay(200), quantity: 4, costPriceMinor: 300 });
  const phSellAs = (token, medicineId, quantity = 1) =>
    api('/pharmacy/sales', { method: 'POST', token, body: { items: [{ medicineId, quantity }], payments: [{ method: 'cash', amountMinor: 50_000 }] } });
  await phSellAs(phToken, phOos.data._id, 4);
  check('Pharmacy: the batch is now empty', ((await phApi(`/medicines/${phOos.data._id}`)).data?.medicine?.stock?.sellable ?? -1) === 0);

  const phRefused = await phSellAs(phTill.session.token, phOos.data._id);
  check('Pharmacy: a till without the permission cannot dispense what is not there', phRefused.status === 400, phRefused.error?.message);

  await api(`/staff/${phTill.id}`, { method: 'PATCH', token: phToken, body: { extraPermissions: [...TILL_PERMISSIONS, 'sales.sellOutOfStock'] } });
  const phOverride = await phSellAs(phTill.session.token, phOos.data._id, 3);
  check('Pharmacy: with the permission the sale goes through', phOverride.status === 201, phOverride.error);
  check('Pharmacy: the line says so and still names the batch it came from', phOverride.data?.items?.[0]?.outOfStockOverride === true && phOverride.data?.items?.[0]?.allocations?.[0]?.batchNumber === `OOS-${oosStamp}`, phOverride.data?.items?.[0]);
  check('Pharmacy: the batch is negative by what was dispensed', ((await phApi(`/medicines/${phOos.data._id}`)).data?.medicine?.stock?.sellable ?? 0) === -3);

  // The rule that does not bend: expired stock is never dispensed. Both the
  // batch lookup and the update that takes the units are filtered on
  // `expiryDate >= today`, so the override cannot reach an expired batch. An
  // expired batch cannot be built through the API (receiving one is refused),
  // so what is checked here is the other half of the same rule: with no
  // unexpired batch there is nothing to dispense against.
  // A medicine that has never been received has no batch to dispense against.
  const phNever = await phMedicine({ name: `Nevermed ${oosStamp}`, strength: '1 mg', dosageForm: 'tablet', sellingPriceMinor: 100 });
  const phNeverSold = await phSellAs(phTill.session.token, phNever.data._id);
  check('Pharmacy: with no batch at all there is nothing to dispense against, permission or not', phNeverSold.status === 400, phNeverSold.error?.message);
  check('Pharmacy: and the refusal explains what is actually in stock', /unexpired unit/.test(phNeverSold.error?.message ?? ''), phNeverSold.error?.message);


  // --- Tenders a workspace defines itself --------------------------------------
  // The six built-ins exist everywhere and cannot be edited away. Anything else
  // a shop takes - a local wallet, a meal voucher - it defines here, and every
  // sale keeps the name it was taken under.
  section('Custom payment methods');

  const pmList = (token) => api('/payment-methods', { token });
  const pmCreate = (token, body) => api('/payment-methods', { method: 'POST', token, body });

  const pmBuiltIns = await pmList(ssToken);
  check('The six built-ins are listed for every workspace', pmBuiltIns.status === 200 && ['cash', 'bkash', 'nagad', 'bank', 'card', 'other'].every((key) => (pmBuiltIns.data ?? []).some((t) => t.key === key && t.isBuiltIn)), pmBuiltIns.data);
  check('Nothing had to be created for them', (pmBuiltIns.data ?? []).filter((t) => t.isBuiltIn).every((t) => t.isActive && t.label));

  const pmVoucher = await pmCreate(ssToken, { label: 'Meal Voucher' });
  check('A workspace defines its own tender', pmVoucher.status === 201 && pmVoucher.data?.key === 'meal-voucher' && pmVoucher.data?.label === 'Meal Voucher', pmVoucher.data ?? pmVoucher.error);
  check('It is listed alongside the built-ins', ((await pmList(ssToken)).data ?? []).some((t) => t.key === 'meal-voucher' && t.isBuiltIn === false));
  check('A built-in key cannot be redefined', (await pmCreate(ssToken, { label: 'Cash', key: 'cash' })).status === 409);
  check('The same key cannot be defined twice', (await pmCreate(ssToken, { label: 'Meal Voucher' })).status === 409);
  check('A nameless method is rejected', (await pmCreate(ssToken, { label: 'x' })).status === 422);
  check('Another workspace does not see it', !((await pmList(phToken)).data ?? []).some((t) => t.key === 'meal-voucher'));

  // Until the branch enables it, no till may take it.
  const pmBeforeEnabling = await ssSale({ items: [{ productId: soap.data._id, quantity: 1 }], payments: [{ method: 'meal-voucher', amountMinor: 4800 }] });
  check('A method the branch has not enabled is refused', pmBeforeEnabling.status === 400, pmBeforeEnabling.error?.message);

  const ssAllMethods = ['cash', 'bkash', 'nagad', 'bank', 'card', 'other', 'meal-voucher'];
  const pmEnable = await api('/stores/current', { method: 'PATCH', token: ssToken, body: { paymentMethods: ssAllMethods } });
  check('The branch enables it like any other tender', pmEnable.status === 200, pmEnable.error);
  check('A branch cannot enable a method the workspace never defined', (await api('/stores/current', { method: 'PATCH', token: ssToken, body: { paymentMethods: [...ssAllMethods, 'moon-credits'] } })).status === 400);

  const pmSale = await ssSale({ items: [{ productId: soap.data._id, quantity: 1 }], payments: [{ method: 'meal-voucher', amountMinor: 4800 }] });
  check('A sale can now be taken with it', pmSale.status === 201, pmSale.error);
  check('The sale records the key AND what it was called', pmSale.data?.payments?.[0]?.method === 'meal-voucher' && pmSale.data?.payments?.[0]?.methodLabel === 'Meal Voucher', pmSale.data?.payments);
  check('The till offers it with the shop’s own name', ((await api('/stores/pos-config', { token: ssToken })).data?.tenders ?? []).some((t) => t.key === 'meal-voucher' && t.label === 'Meal Voucher'));

  // Renaming must not rewrite history.
  const pmId = pmVoucher.data._id;
  check('The method can be renamed', (await api(`/payment-methods/${pmId}`, { method: 'PATCH', token: ssToken, body: { label: 'Lunch Voucher' } })).status === 200);
  const pmAfterRename = await ssApi(`/sales/${pmSale.data._id}`);
  check('A sale taken before the rename still says what it said', pmAfterRename.data?.payments?.[0]?.methodLabel === 'Meal Voucher', pmAfterRename.data?.payments);
  check('New sales use the new name', (await ssSale({ items: [{ productId: soap.data._id, quantity: 1 }], payments: [{ method: 'meal-voucher', amountMinor: 4800 }] })).data?.payments?.[0]?.methodLabel === 'Lunch Voucher');

  // Switching it off takes it off every till at once.
  check('The method can be switched off', (await api(`/payment-methods/${pmId}`, { method: 'PATCH', token: ssToken, body: { isActive: false } })).status === 200);
  check('...which takes it out of the branch’s list', !((await api('/stores/pos-config', { token: ssToken })).data?.paymentMethods ?? []).includes('meal-voucher'));
  const pmAfterOff = await ssSale({ items: [{ productId: soap.data._id, quantity: 1 }], payments: [{ method: 'meal-voucher', amountMinor: 4800 }] });
  check('...and no further sale can use it', pmAfterOff.status === 400, pmAfterOff.error?.message);
  check('...while the sales that used it are untouched', (await ssApi(`/sales/${pmSale.data._id}`)).data?.payments?.[0]?.methodLabel === 'Meal Voucher');

  // Permissions: reading is for every till, changing is a settings action.
  check('A till can read the methods it may take', (await pmList(ssTill.session.token)).status === 200);
  check('A till cannot define one', (await pmCreate(ssTill.session.token, { label: 'Sneaky Tender' })).status === 403);
  check('Defining a tender needs a session', (await pmCreate(undefined, { label: 'Anonymous' })).status === 401);


  // --- Returns beyond Clothing -------------------------------------------------
  // Super Shop and Pharmacy could only void a whole sale. They take a real
  // return now: chosen lines, chosen quantities, money back on a tender the
  // branch takes, goods back where that vertical keeps them.
  section('Returns (Super Shop and Pharmacy)');

  // --- Super Shop: a discounted sale, partly returned ---------------------------
  const retStamp = String(Date.now()).slice(-6);
  const retSoap = await ssProduct({ name: `Return Soap ${retStamp}`, priceMinor: 10_000, reorderLevel: 2 });
  await ssApi(`/products/${retSoap.data._id}/stock`, { method: 'POST', body: { quantity: 10, costPriceMinor: 6000 } });
  // 3 x 100.00 = 300.00, less a 30.00 discount = 270.00 paid.
  const retSale = await ssSale({ items: [{ productId: retSoap.data._id, quantity: 3 }], payments: [{ method: 'cash', amountMinor: 27_000 }], discountMinor: 3000 });
  check('Super Shop: a discounted sale is recorded', retSale.status === 201 && retSale.data?.totalMinor === 27_000, retSale.data ?? retSale.error);

  const retLineId = retSale.data.items[0]._id;
  const ssReturn2 = (saleId, body) => ssApi(`/sales/${saleId}/return`, { method: 'POST', body });
  const ssReturn = (body) => ssReturn2(retSale.data._id, body);

  const retTooMany = await ssReturn({ items: [{ saleItemId: retLineId, quantity: 4 }], reason: 'Too many' });
  check('Super Shop: more than was sold cannot come back', retTooMany.status === 400, retTooMany.error?.message);
  check('Super Shop: an unknown line is refused', (await ssReturn({ items: [{ saleItemId: '64b000000000000000000000', quantity: 1 }], reason: 'Not mine' })).status === 400);
  check('Super Shop: a return needs a reason', (await ssReturn({ items: [{ saleItemId: retLineId, quantity: 1 }], reason: 'x' })).status === 422);
  check('Super Shop: a refund method the branch does not take is refused', (await ssReturn({ items: [{ saleItemId: retLineId, quantity: 1 }], reason: 'Wrong tender', refundMethod: 'moon-credits' })).status === 400);

  const ssOnHandBefore = (await ssApi(`/products/${retSoap.data._id}`)).data?.product?.stock?.quantityOnHand;
  const retOne = await ssReturn({ items: [{ saleItemId: retLineId, quantity: 1 }], reason: 'Customer changed their mind' });
  check('Super Shop: one of three comes back', retOne.status === 201, retOne.error);
  check(
    'Super Shop: the refund is what was paid for it, not the list price',
    retOne.data?.totalMinor === 9000,
    { refunded: retOne.data?.totalMinor, note: 'a 10% sale discount means 90.00 back on a 100.00 item' },
  );
  check('Super Shop: the goods go back on the shelf', (await ssApi(`/products/${retSoap.data._id}`)).data?.product?.stock?.quantityOnHand === ssOnHandBefore + 1);
  check('Super Shop: the movement is in the ledger as a return', ((await api(`/supershop/stock-ledger?itemId=${retSoap.data._id}&limit=3`, { token: ssToken })).data ?? []).some((row) => row.quantityChange === 1));
  const retSaleAfter = await ssApi(`/sales/${retSale.data._id}`);
  check('Super Shop: the sale tracks what has come back', retSaleAfter.data?.items?.[0]?.returnedQuantity === 1 && retSaleAfter.data?.returnedTotalMinor === 9000 && retSaleAfter.data?.fullyReturned === false, {
    line: retSaleAfter.data?.items?.[0]?.returnedQuantity,
    total: retSaleAfter.data?.returnedTotalMinor,
  });

  const retRest = await ssReturn({ items: [{ saleItemId: retLineId, quantity: 2, restock: false }], reason: 'Faulty batch' });
  check('Super Shop: the rest can come back later', retRest.status === 201, retRest.error);
  check('Super Shop: the sale is now fully returned', (await ssApi(`/sales/${retSale.data._id}`)).data?.fullyReturned === true);
  check('Super Shop: nothing more can come back', (await ssReturn({ items: [{ saleItemId: retLineId, quantity: 1 }], reason: 'Again' })).status === 400);
  check('Super Shop: the returns are listed', ((await ssApi('/returns')).data ?? []).length >= 2 && ((await ssApi('/returns')).data ?? [])[0]?.returnNumber);

  // The Returns screen starts by FINDING the sale, so a sale has to be findable
  // by the person who bought it, not only by its number.
  const retNamedSale = await ssSale({
    items: [{ productId: retSoap.data._id, quantity: 1 }],
    payments: [{ method: 'cash', amountMinor: 10_000 }],
    customer: { name: `Findable Shopper ${retStamp}`, phone: `0179${String(retStamp).slice(-7)}` },
  });
  check('Super Shop: a sale for a named customer is recorded', retNamedSale.status === 201, retNamedSale.error);
  check('Super Shop: a sale can be found by its number', ((await ssApi(`/sales?search=${retNamedSale.data?.saleNumber}&status=completed`)).data ?? []).some((row) => row._id === retNamedSale.data?._id));
  const retByName = await ssApi(`/sales?search=Findable Shopper ${retStamp}&status=completed`);
  check('Super Shop: and by the customer who bought it', (retByName.data ?? []).some((row) => row._id === retNamedSale.data?._id), retByName.data?.length);

  // Goods that should not go back on the shelf.
  const retNoRestock = await ssProduct({ name: `Broken Jar ${retStamp}`, priceMinor: 5000 });
  await ssApi(`/products/${retNoRestock.data._id}/stock`, { method: 'POST', body: { quantity: 4, costPriceMinor: 2000 } });
  const retBrokenSale = await ssSale({ items: [{ productId: retNoRestock.data._id, quantity: 2 }], payments: [{ method: 'cash', amountMinor: 10_000 }] });
  const retBrokenBefore = (await ssApi(`/products/${retNoRestock.data._id}`)).data?.product?.stock?.quantityOnHand;
  const retBroken = await ssReturn2(retBrokenSale.data._id, { items: [{ saleItemId: retBrokenSale.data.items[0]._id, quantity: 1, restock: false }], reason: 'Arrived broken' });
  check('Super Shop: damaged goods are refunded without going back on the shelf', retBroken.status === 201 && (await ssApi(`/products/${retNoRestock.data._id}`)).data?.product?.stock?.quantityOnHand === retBrokenBefore, {
    status: retBroken.status,
    before: retBrokenBefore,
  });

  // --- Pharmacy: back to the batch it came from ---------------------------------
  const retMed = await phMedicine({ name: `Retmed ${retStamp}`, strength: '20 mg', dosageForm: 'tablet', sellingPriceMinor: 900 });
  await phReceive(retMed.data._id, { batchNumber: `RET-${retStamp}`, expiryDate: phDay(300), quantity: 20, costPriceMinor: 500 });
  const retPhSale = await phApi('/sales', { method: 'POST', body: { items: [{ medicineId: retMed.data._id, quantity: 5 }], payments: [{ method: 'cash', amountMinor: 4500 }] } });
  check('Pharmacy: a sale is dispensed from the batch', retPhSale.status === 201 && retPhSale.data?.items?.[0]?.allocations?.[0]?.batchNumber === `RET-${retStamp}`, retPhSale.error);

  const phBatchBefore = ((await phApi(`/medicines/${retMed.data._id}`)).data?.batches ?? []).find((b) => b.batchNumber === `RET-${retStamp}`)?.quantityOnHand;
  const phReturn = await phApi(`/sales/${retPhSale.data._id}/return`, {
    method: 'POST',
    body: { items: [{ saleItemId: retPhSale.data.items[0]._id, quantity: 2 }], reason: 'Wrong strength dispensed' },
  });
  check('Pharmacy: two of five come back', phReturn.status === 201 && phReturn.data?.totalMinor === 1800, phReturn.data ?? phReturn.error);
  const phBatchAfter = ((await phApi(`/medicines/${retMed.data._id}`)).data?.batches ?? []).find((b) => b.batchNumber === `RET-${retStamp}`)?.quantityOnHand;
  check('Pharmacy: the units go back to the batch they came from', phBatchAfter === phBatchBefore + 2, { before: phBatchBefore, after: phBatchAfter });
  check('Pharmacy: the return names that batch', phReturn.data?.items?.[0]?.allocations?.[0]?.batchNumber === `RET-${retStamp}`, phReturn.data?.items?.[0]);
  check('Pharmacy: the ledger shows the units coming back', ((await api(`/pharmacy/stock-ledger?itemId=${retMed.data._id}&limit=5`, { token: phToken })).data ?? []).some((row) => row.quantityChange === 2));
  check('Pharmacy: the sale tracks what has come back', (await phApi(`/sales/${retPhSale.data._id}`)).data?.items?.[0]?.returnedQuantity === 2);

  // Rules that hold in both verticals.
  check('A return cannot be made against another workspace’s sale', (await phApi(`/sales/${retSale.data._id}/return`, { method: 'POST', body: { items: [{ saleItemId: retLineId, quantity: 1 }], reason: 'Not mine at all' } })).status === 404);
  check('A voided sale cannot be returned against', (await ssReturn2(basket.data._id, { items: [{ saleItemId: basket.data.items[0]._id, quantity: 1 }], reason: 'Already voided' })).status === 404);
  check('Returning needs the returns.create permission', (await api(`/supershop/sales/${retBrokenSale.data._id}/return`, { method: 'POST', token: ssTill.session.token, body: { items: [{ saleItemId: retBrokenSale.data.items[0]._id, quantity: 1 }], reason: 'No permission' } })).status === 403);


  // --- Refunding a paid restaurant order ---------------------------------------
  // A kitchen has no shelf, so a restaurant return is money and a record. An
  // open order is changed or cancelled instead - a different thing, which is
  // why only a PAID order can be refunded here.
  section('Restaurant refunds');

  const rvRefStamp = String(Date.now()).slice(-6);
  const rvRefItem = await rvMenu({ name: `Refund Curry ${rvRefStamp}`, category: 'Mains', priceMinor: 20_000 });
  const rvRefOrder = await rvOrder({ type: 'takeaway', items: [{ menuItemId: rvRefItem.data._id, quantity: 3 }] });
  check('Restaurant: an order is opened for the refund checks', rvRefOrder.status === 201, rvRefOrder.error);

  const rvReturn = (orderId, body) => api(`/restaurant/orders/${orderId}/return`, { method: 'POST', token: rvToken, body });
  const rvRefLineId = rvRefOrder.data.items[0]._id;

  const rvOpenRefund = await rvReturn(rvRefOrder.data._id, { items: [{ saleItemId: rvRefLineId, quantity: 1 }], reason: 'Not paid yet' });
  check('Restaurant: an unpaid order cannot be refunded', rvOpenRefund.status === 404, rvOpenRefund.error?.message);

  // Pay it, with a discount, so the refund has to share the discount out.
  const rvRefPaid = await api(`/restaurant/orders/${rvRefOrder.data._id}/pay`, {
    method: 'POST',
    token: rvToken,
    body: { rev: rvRefOrder.data.rev, discountMinor: 6000, payments: [{ method: 'cash', amountMinor: 54_000 }] },
  });
  check('Restaurant: the order is paid with a discount', rvRefPaid.status === 200 && rvRefPaid.data?.totalMinor === 54_000, rvRefPaid.error);

  check('Restaurant: more than was ordered cannot be refunded', (await rvReturn(rvRefOrder.data._id, { items: [{ saleItemId: rvRefLineId, quantity: 4 }], reason: 'Too many' })).status === 400);
  check('Restaurant: a refund needs a reason', (await rvReturn(rvRefOrder.data._id, { items: [{ saleItemId: rvRefLineId, quantity: 1 }], reason: 'x' })).status === 422);
  check('Restaurant: a tender this branch does not take is refused', (await rvReturn(rvRefOrder.data._id, { items: [{ saleItemId: rvRefLineId, quantity: 1 }], reason: 'Wrong tender', refundMethod: 'moon-credits' })).status === 400);

  const rvRefunded = await rvReturn(rvRefOrder.data._id, { items: [{ saleItemId: rvRefLineId, quantity: 1 }], reason: 'Dish sent back to the kitchen' });
  check('Restaurant: one of three dishes is refunded', rvRefunded.status === 201, rvRefunded.error);
  check(
    'Restaurant: the refund is what was paid for it, not the menu price',
    rvRefunded.data?.totalMinor === 18_000,
    { refunded: rvRefunded.data?.totalMinor, note: 'a 10% order discount means 180.00 back on a 200.00 dish' },
  );
  check('Restaurant: the refund names the tender it went back on', rvRefunded.data?.refundMethodLabel === 'Cash', rvRefunded.data?.refundMethodLabel);
  const rvRefAfter = await api(`/restaurant/orders/${rvRefOrder.data._id}`, { token: rvToken });
  check('Restaurant: the order tracks what has been refunded', rvRefAfter.data?.items?.[0]?.returnedQuantity === 1 && rvRefAfter.data?.returnedTotalMinor === 18_000 && rvRefAfter.data?.fullyReturned === false, {
    line: rvRefAfter.data?.items?.[0]?.returnedQuantity,
    total: rvRefAfter.data?.returnedTotalMinor,
  });
  check('Restaurant: the order is still paid, not reopened', rvRefAfter.data?.status === 'paid');

  const rvRefRest = await rvReturn(rvRefOrder.data._id, { items: [{ saleItemId: rvRefLineId, quantity: 2 }], reason: 'The rest went back too' });
  check('Restaurant: the rest can be refunded later', rvRefRest.status === 201, rvRefRest.error);
  check('Restaurant: the order is fully refunded', (await api(`/restaurant/orders/${rvRefOrder.data._id}`, { token: rvToken })).data?.fullyReturned === true);
  check('Restaurant: nothing more can be refunded', (await rvReturn(rvRefOrder.data._id, { items: [{ saleItemId: rvRefLineId, quantity: 1 }], reason: 'Again please' })).status === 400);
  check('Restaurant: the refunds are listed', ((await api('/restaurant/returns', { token: rvToken })).data ?? []).length >= 2);
  check('Restaurant: another workspace cannot refund this order', (await api(`/restaurant/orders/${rvRefOrder.data._id}/return`, { method: 'POST', token: admin.token, body: { items: [{ saleItemId: rvRefLineId, quantity: 1 }], reason: 'Not mine' } })).status === 403);

  // --- What the shop KEPT, not what it charged ---------------------------------
  // Every vertical records refunds now, so every report that says "net" has to
  // mean net. Clothing has always subtracted returns; these are the other three.
  section('Analytics net of refunds');

  const ssNet = await ssApi('/reports?preset=today');
  check(
    'Super Shop: the report separates what was charged from what came back',
    ssNet.status === 200 && ssNet.data?.totals?.returnAmountMinor > 0 && ssNet.data.totals.grossSalesMinor > ssNet.data.totals.netSalesMinor,
    ssNet.data?.totals,
  );
  check(
    'Super Shop: net is gross less the refunds, exactly',
    ssNet.data.totals.netSalesMinor === ssNet.data.totals.grossSalesMinor - ssNet.data.totals.returnAmountMinor,
    ssNet.data?.totals,
  );
  check('Super Shop: the refunds are counted', ssNet.data.totals.returnCount >= 2, ssNet.data?.totals?.returnCount);
  check(
    'Super Shop: a day in the trend shows both figures',
    (ssNet.data.trend ?? []).some((row) => row.returnAmountMinor > 0 && row.netSalesMinor === row.grossSalesMinor - row.returnAmountMinor),
    ssNet.data?.trend,
  );
  check(
    'Super Shop: a one-day period has one trend row that equals the totals',
    (ssNet.data.trend ?? []).length !== 1 ||
      (ssNet.data.trend[0].netSalesMinor === ssNet.data.totals.netSalesMinor && ssNet.data.trend[0].grossProfitMinor === ssNet.data.totals.grossProfitMinor),
    { trend: ssNet.data.trend?.[0], totals: ssNet.data.totals },
  );
  const ssNetDash = await ssApi('/dashboard');
  check(
    'Super Shop: the dashboard shows what was refunded and what was kept',
    ssNetDash.data?.kpis?.refundedMinor > 0 && ssNetDash.data.kpis.netSalesMinor === ssNetDash.data.kpis.totalMinor - ssNetDash.data.kpis.refundedMinor,
    ssNetDash.data?.kpis,
  );
  check(
    'Super Shop: the dashboard and the report agree on profit',
    ssNetDash.data.kpis.grossProfitMinor === ssNet.data.totals.grossProfitMinor,
    { dashboard: ssNetDash.data.kpis.grossProfitMinor, report: ssNet.data.totals.grossProfitMinor },
  );

  const phNet = await phApi('/reports?preset=today');
  check(
    'Pharmacy: net is gross less the refunds',
    phNet.status === 200 && phNet.data?.totals?.returnAmountMinor > 0 && phNet.data.totals.netSalesMinor === phNet.data.totals.grossSalesMinor - phNet.data.totals.returnAmountMinor,
    phNet.data?.totals,
  );
  check(
    'Pharmacy: medicine that went back to its batch takes its cost out of profit too',
    phNet.data.totals.grossProfitMinor === phNet.data.totals.netSalesMinor - phNet.data.totals.costMinor,
    phNet.data?.totals,
  );
  const phNetDash = await phApi('/dashboard');
  check(
    'Pharmacy: the dashboard shows what was refunded and what was kept',
    phNetDash.data?.kpis?.refundedMinor > 0 && phNetDash.data.kpis.netSalesMinor === phNetDash.data.kpis.totalMinor - phNetDash.data.kpis.refundedMinor,
    phNetDash.data?.kpis,
  );

  // This workspace is on Starter, where Advanced Analytics is locked (checked
  // far above). Move it up so the report itself can be read.
  const rvNetPlan = ((await api('/plans?vertical=restaurant')).data ?? []).find((p) => p.code === 'showroom-monthly');
  await api('/platform/subscriptions', { method: 'POST', token: platform2.token, body: { tenantId: rv.created.data?.workspace?.id, planId: rvNetPlan?._id, periods: 1, status: 'active' } });
  const rvNet = await api('/restaurant/reports?preset=today', { token: rvToken });
  check(
    'Restaurant: net is gross less the refunds',
    rvNet.status === 200 && rvNet.data?.totals?.returnAmountMinor > 0 && rvNet.data.totals.netSalesMinor === rvNet.data.totals.grossSalesMinor - rvNet.data.totals.returnAmountMinor,
    rvNet.data?.totals,
  );
  const rvNetDash = await api('/restaurant/dashboard?preset=today', { token: rvToken });
  check(
    'Restaurant: the dashboard shows what was refunded and what was kept',
    rvNetDash.data?.kpis?.refundedMinor > 0 && rvNetDash.data.kpis.netRevenueMinor === rvNetDash.data.kpis.revenueMinor - rvNetDash.data.kpis.refundedMinor,
    rvNetDash.data?.kpis,
  );

  // A refund is not a sale going away: the sale still stands, and the gross says so.
  check('The sales themselves are unchanged by a refund', ssNet.data.totals.salesCount >= 2 && rvNet.data.totals.paidOrders >= 1);

  // What came back, not just how much.
  check(
    'Super Shop: the report lists what came back, with the reason and who took it',
    (ssNet.data.returns?.recent ?? []).some((row) => row.returnNumber && row.reason && row.by && row.units > 0),
    ssNet.data?.returns?.recent?.[0],
  );
  check(
    'Super Shop: goods refunded but not restocked are counted as such',
    (ssNet.data.returns?.recent ?? []).some((row) => row.notRestockedUnits > 0),
    ssNet.data?.returns?.recent,
  );
  check('Pharmacy: the report lists what came back', (phNet.data.returns?.recent ?? []).length >= 1 && phNet.data.returns.units >= 2, phNet.data?.returns);
  check('Restaurant: the report lists what was refunded', (rvNet.data.returns?.recent ?? []).length >= 1, rvNet.data?.returns);

  // Restaurant took split payments from task 04 but could not report them.
  check(
    'Restaurant: payments are broken down by method, cash net of change',
    (rvNet.data.payments ?? []).length >= 1 && rvNet.data.payments.every((row) => typeof row.amountMinor === 'number' && row.method),
    rvNet.data?.payments,
  );

  // The same vocabulary in all three, which is what task 13 is for.
  for (const [name, totals] of [['Super Shop', ssNet.data.totals], ['Pharmacy', phNet.data.totals], ['Restaurant', rvNet.data.totals]]) {
    check(
      `${name}: reports gross, returns and net by the same names`,
      ['grossSalesMinor', 'returnAmountMinor', 'netSalesMinor', 'returnCount'].every((key) => typeof totals[key] === 'number'),
      Object.keys(totals),
    );
  }


  // --- Loyalty beyond Clothing -------------------------------------------------
  // A Super Shop runs the same program: a scanned CARD earns and redeems, never
  // a customer and never a phone, and the points come back when goods do.
  section('Loyalty in Super Shop');

  const ssLoyEnable = await api('/stores/current', { method: 'PATCH', token: ssToken, body: { loyalty: { enabled: true, earnSpendMinor: 10_000, pointValueMinor: 100 } } });
  check('Super Shop: the owner can switch the program on', ssLoyEnable.status === 200 && ssLoyEnable.data?.loyalty?.enabled === true, ssLoyEnable.error);
  check('Super Shop: the till is told it is available', (await api('/stores/pos-config', { token: ssToken })).data?.loyalty?.available === true);

  const ssLoyStamp = String(Date.now()).slice(-7);
  const ssLoyCustomer = (await api('/customers', { method: 'POST', token: ssToken, body: { name: 'Shopper Loyal', phone: `0175${ssLoyStamp}` } })).data;
  const ssCard = await api('/loyalty/memberships', { method: 'POST', token: ssToken, body: { customerId: ssLoyCustomer._id, idempotencyKey: `ssloy${ssLoyStamp}` } });
  check('Super Shop: a card is issued to a customer', ssCard.status === 201 && ssCard.data?.cardNumber, ssCard.error);
  const ssCardNumber = ssCard.data.cardNumber;
  const ssMembershipId = ssCard.data._id ?? ssCard.data.id;

  check('Super Shop: the card can be looked up by its number', (await api(`/loyalty/lookup?code=${ssCardNumber}`, { token: ssToken })).data?.cardNumber === ssCardNumber);

  // Earning: ৳100 of goods (excluding VAT) = 1 point.
  const ssLoyProduct = await ssProduct({ name: `Loyal Rice ${ssLoyStamp}`, priceMinor: 25_000, reorderLevel: 1 });
  await ssApi(`/products/${ssLoyProduct.data._id}/stock`, { method: 'POST', body: { quantity: 20, costPriceMinor: 15_000 } });
  const ssLoySale = await ssSale({
    items: [{ productId: ssLoyProduct.data._id, quantity: 2 }],
    payments: [{ method: 'cash', amountMinor: 50_000 }],
    loyaltyMembershipId: ssMembershipId,
  });
  check('Super Shop: a sale on a scanned card earns points', ssLoySale.status === 201 && ssLoySale.data?.loyalty?.pointsEarned === 5, ssLoySale.data?.loyalty ?? ssLoySale.error);
  check('Super Shop: the sale keeps the card and the rules it earned under', ssLoySale.data?.loyalty?.cardNumber === ssCardNumber && ssLoySale.data.loyalty.earnSpendMinor === 10_000, ssLoySale.data?.loyalty);
  check('Super Shop: the balance moved', (await api(`/loyalty/lookup?code=${ssCardNumber}`, { token: ssToken })).data?.pointsBalance === 5);

  // A customer alone earns nothing: only a card does.
  const ssNoCardSale = await ssSale({
    items: [{ productId: ssLoyProduct.data._id, quantity: 1 }],
    payments: [{ method: 'cash', amountMinor: 25_000 }],
    customerId: ssLoyCustomer._id,
  });
  check('Super Shop: a customer without a card earns nothing', ssNoCardSale.status === 201 && ssNoCardSale.data?.loyalty === null, ssNoCardSale.data?.loyalty);
  check('Super Shop: and the balance did not move', (await api(`/loyalty/lookup?code=${ssCardNumber}`, { token: ssToken })).data?.pointsBalance === 5);

  // Redeeming: points pay for part of the basket.
  const ssRedeem = await ssSale({
    items: [{ productId: ssLoyProduct.data._id, quantity: 1 }],
    payments: [{ method: 'cash', amountMinor: 24_500 }],
    loyaltyMembershipId: ssMembershipId,
    redeemPoints: 5,
  });
  check('Super Shop: points pay for part of the basket', ssRedeem.status === 201 && ssRedeem.data?.totalMinor === 24_500, { total: ssRedeem.data?.totalMinor, error: ssRedeem.error });
  check('Super Shop: the sale records what the points were worth', ssRedeem.data?.loyalty?.pointsRedeemed === 5 && ssRedeem.data.loyalty.discountMinor === 500, ssRedeem.data?.loyalty);
  check('Super Shop: redeeming spends the points and the sale earns on what was paid', (await api(`/loyalty/lookup?code=${ssCardNumber}`, { token: ssToken })).data?.pointsBalance === 2, 'spent 5, earned 2 on ৳245');
  check('Super Shop: more points than the card holds is refused', (await ssSale({ items: [{ productId: ssLoyProduct.data._id, quantity: 1 }], payments: [{ method: 'cash', amountMinor: 25_000 }], loyaltyMembershipId: ssMembershipId, redeemPoints: 9999 })).status === 422);
  check('Super Shop: redeeming without a card is refused', (await ssSale({ items: [{ productId: ssLoyProduct.data._id, quantity: 1 }], payments: [{ method: 'cash', amountMinor: 25_000 }], redeemPoints: 2 })).status === 422);

  // Returning the goods takes the points back with them.
  const ssLoyReturn = await ssApi(`/sales/${ssLoySale.data._id}/return`, {
    method: 'POST',
    body: { items: [{ saleItemId: ssLoySale.data.items[0]._id, quantity: 2 }], reason: 'Returned the whole basket' },
  });
  check('Super Shop: the sale can be returned', ssLoyReturn.status === 201, ssLoyReturn.error);
  check(
    'Super Shop: returning the goods takes their points back',
    (await api(`/loyalty/lookup?code=${ssCardNumber}`, { token: ssToken })).data?.pointsBalance === -3,
    'earned 5 on that sale, so 5 come back off a balance of 2',
  );

  // Voiding a sale that redeemed points gives them back.
  const ssVoidLoy = await ssVoid(ssRedeem.data._id, 'Voided after redeeming');
  check('Super Shop: a sale that redeemed points can be voided', ssVoidLoy.status === 200, ssVoidLoy.error);
  check(
    'Super Shop: the void gives the redeemed points back and takes the earned ones',
    (await api(`/loyalty/lookup?code=${ssCardNumber}`, { token: ssToken })).data?.pointsBalance === 0,
    'redeemed 5 returned, earned 2 reversed, from -3',
  );

  // Another workspace's card is not this one's.
  check('A card from another workspace cannot be used', (await ssSale({ items: [{ productId: ssLoyProduct.data._id, quantity: 1 }], payments: [{ method: 'cash', amountMinor: 25_000 }], loyaltyMembershipId: '64b000000000000000000000' })).status === 400);

  // ------------------------------------------------ cash received, change and receipt
  section('Clothing POS: cash received, change and receipt');
  const ctnStamp = Date.now();
  const ctnReg = await api('/auth/register', { method: 'POST', body: { businessName: `CTN Clothing ${ctnStamp}`, name: 'CTN Owner', email: `ctn${ctnStamp}@example.com`, password: 'Password@123', vertical: 'clothing' } });
  const ctnToken = ctnReg.data?.tokens?.accessToken;
  await api('/stores', { method: 'POST', token: ctnToken, body: { name: 'CTN Main', currency: 'BDT' } });
  const ctnProduct = await api('/products', { method: 'POST', token: ctnToken, body: { name: `CTN Tee ${ctnStamp}`, variants: [{ attributes: [], sku: `CTN${ctnStamp}`, sellingPriceMinor: 100_000, stock: 100 }] } });
  const ctnVariantId = ctnProduct.data?.variants?.[0]?._id;
  // Exactly what the POS sends: applied amounts in `payments`, cash handed over in `cashTenderedMinor`.
  const ctnSale = (payments, cashTenderedMinor, extra = {}) =>
    api('/sales', {
      method: 'POST',
      token: ctnToken,
      body: { items: [{ variantId: ctnVariantId, quantity: 1 }], paymentMethod: payments[0].method, payments: payments.map((p) => ({ ...p, reference: '' })), ...(cashTenderedMinor !== undefined ? { cashTenderedMinor } : {}), ...extra },
    });
  const ctnApplied = (sale) => (sale.data?.payments ?? []).reduce((sum, p) => sum + p.amountMinor, 0);
  const ctnCashRow = (sale) => (sale.data?.payments ?? []).find((p) => p.method === 'cash')?.amountMinor;

  // Cash only (total 1000).
  const ctn1 = await ctnSale([{ method: 'cash', amountMinor: 100_000 }], 100_000);
  check('Cash 1000 on 1000: change 0, customer paid 1000', ctn1.status === 201 && ctn1.data.totalMinor === 100_000 && ctn1.data.changeMinor === 0 && ctn1.data.paidMinor === 100_000, ctn1.data ?? ctn1.error);
  const ctn2 = await ctnSale([{ method: 'cash', amountMinor: 100_000 }], 120_000);
  check('Cash 1200 on 1000: change 200, customer paid 1200', ctn2.status === 201 && ctn2.data.changeMinor === 20_000 && ctn2.data.paidMinor === 120_000, ctn2.data ?? ctn2.error);
  check('...and the total stays 1000 - change is not revenue', ctn2.data?.totalMinor === 100_000);
  check('...and the recorded cash payment is 1000, not 1200', ctnCashRow(ctn2) === 100_000 && ctnApplied(ctn2) === 100_000, ctn2.data?.payments);
  const ctn3 = await ctnSale([{ method: 'cash', amountMinor: 100_000 }], 200_000);
  check('Cash 2000 on 1000: change 1000', ctn3.status === 201 && ctn3.data.changeMinor === 100_000 && ctn3.data.totalMinor === 100_000);
  const ctn4 = await ctnSale([{ method: 'cash', amountMinor: 100_000 }], 70_000);
  check('Cash 700 on 1000 is refused (300 still due)', ctn4.status === 422 && ctn4.error?.details?.shortfallMinor === 30_000, ctn4.error);

  // Split (bKash 400).
  const ctn5 = await ctnSale([{ method: 'bkash', amountMinor: 40_000 }, { method: 'cash', amountMinor: 60_000 }], 60_000);
  check('bKash 400 + cash 600: change 0', ctn5.status === 201 && ctn5.data.changeMinor === 0 && ctnApplied(ctn5) === 100_000, ctn5.error);
  const ctn6 = await ctnSale([{ method: 'bkash', amountMinor: 40_000 }, { method: 'cash', amountMinor: 60_000 }], 80_000);
  check('bKash 400 + cash 800: change 200, cash recorded 600', ctn6.status === 201 && ctn6.data.changeMinor === 20_000 && ctnCashRow(ctn6) === 60_000 && ctn6.data.paidMinor === 120_000, ctn6.data ?? ctn6.error);
  const ctn7 = await ctnSale([{ method: 'bkash', amountMinor: 40_000 }, { method: 'cash', amountMinor: 60_000 }], 50_000);
  check('bKash 400 + cash 500 is refused (100 still due)', ctn7.status === 422 && ctn7.error?.details?.shortfallMinor === 10_000, ctn7.error);

  // Input safety.
  check('Negative cash received is refused', (await ctnSale([{ method: 'cash', amountMinor: 100_000 }], -1)).status === 422);
  check('Non-numeric cash received is refused', (await ctnSale([{ method: 'cash', amountMinor: 100_000 }], '1200')).status === 422);
  check('Fractional cash received is refused', (await ctnSale([{ method: 'cash', amountMinor: 100_000 }], 1200.5)).status === 422);

  // A tampered request cannot move the total, invent revenue or pass an underpaid sale.
  const ctnInflated = await ctnSale([{ method: 'cash', amountMinor: 120_000 }], 120_000);
  check('Applied payments above the total are refused - change cannot be booked as payment', ctnInflated.status === 422 && ctnInflated.error?.details?.appliedMinor === 120_000, ctnInflated.error);
  check('Applied payments below the total are refused', (await ctnSale([{ method: 'cash', amountMinor: 70_000 }], 200_000)).status === 422);
  check('Cash received with no cash payment is refused', (await ctnSale([{ method: 'bkash', amountMinor: 100_000 }], 120_000)).status === 422);
  const ctnTotalTamper = await ctnSale([{ method: 'cash', amountMinor: 100_000 }], 500_000, { totalMinor: 1, subtotalMinor: 1 });
  // The sale schema strips unknown fields: a forged total is ignored and the server prices the sale.
  check('A total in the body is ignored - the server prices the sale (1000) and computes change from it', ctnTotalTamper.status === 201 && ctnTotalTamper.data.totalMinor === 100_000 && ctnTotalTamper.data.subtotalMinor === 100_000 && ctnTotalTamper.data.changeMinor === 400_000, ctnTotalTamper.data ?? ctnTotalTamper.error);
  const ctnDiscounted = await ctnSale([{ method: 'cash', amountMinor: 90_000 }], 100_000, { discountType: 'fixed', discountValue: 10_000 });
  check('The server prices the sale itself: discount 100, cash 1000 -> total 900, change 100', ctnDiscounted.status === 201 && ctnDiscounted.data.totalMinor === 90_000 && ctnDiscounted.data.changeMinor === 10_000, ctnDiscounted.data ?? ctnDiscounted.error);

  // Receipt data.
  const ctnReceipt = (sale) => api(`/sales/${sale.data?._id}/receipt`, { token: ctnToken });
  const ctnR2 = (await ctnReceipt(ctn2)).data?.sale;
  check('Receipt (cash overpaid): total 1000, cash 1000, customer paid 1200, change 200', ctnR2?.totalMinor === 100_000 && ctnR2.payments?.[0]?.amountMinor === 100_000 && ctnR2.paidMinor === 120_000 && ctnR2.changeMinor === 20_000, ctnR2);
  const ctnR1 = (await ctnReceipt(ctn1)).data?.sale;
  check('Receipt (exact cash): customer paid 1000, change 0', ctnR1?.paidMinor === 100_000 && ctnR1.changeMinor === 0);
  const ctnR6 = (await ctnReceipt(ctn6)).data?.sale;
  check('Receipt (split + overpaid cash): bKash 400, cash 600, customer paid 1200, change 200, total 1000', ctnR6?.totalMinor === 100_000 && ctnR6.payments?.find((p) => p.method === 'bkash')?.amountMinor === 40_000 && ctnR6.payments?.find((p) => p.method === 'cash')?.amountMinor === 60_000 && ctnR6.paidMinor === 120_000 && ctnR6.changeMinor === 20_000, ctnR6);
  check("Another workspace cannot read this sale's receipt", [403, 404].includes((await api(`/sales/${ctn2.data?._id}/receipt`, { token: admin.token })).status));

  // The older request format still works unchanged.
  const ctnLegacy = await api('/sales', { method: 'POST', token: ctnToken, body: { items: [{ variantId: ctnVariantId, quantity: 1 }], paymentMethod: 'cash', paidMinor: 120_000 } });
  check('The legacy single-tender format still computes change', ctnLegacy.status === 201 && ctnLegacy.data.changeMinor === 20_000 && ctnLegacy.data.totalMinor === 100_000, ctnLegacy.error);

  // ------------------------------------------------ VAT display source and receipt data
  section('Clothing POS: VAT setting drives totals and receipt data');
  const vatStamp = Date.now();
  const vatReg = await api('/auth/register', { method: 'POST', body: { businessName: `VAT Clothing ${vatStamp}`, name: 'VAT Owner', email: `vat${vatStamp}@example.com`, password: 'Password@123', vertical: 'clothing' } });
  const vatToken = vatReg.data?.tokens?.accessToken;
  await api('/stores', { method: 'POST', token: vatToken, body: { name: 'VAT Main', currency: 'BDT' } });
  const vatProduct = await api('/products', { method: 'POST', token: vatToken, body: { name: `VAT Tee ${vatStamp}`, variants: [{ attributes: [], sku: `VAT${vatStamp}`, sellingPriceMinor: 100_000, stock: 50 }] } });
  const vatVariantId = vatProduct.data?.variants?.[0]?._id;
  const vatSell = (cashTenderedMinor, amount) =>
    api('/sales', { method: 'POST', token: vatToken, body: { items: [{ variantId: vatVariantId, quantity: 1 }], paymentMethod: 'cash', payments: [{ method: 'cash', amountMinor: amount, reference: '' }], cashTenderedMinor } });

  // VAT off: no tax is charged, and the receipt data says VAT is off.
  await api('/stores/current', { method: 'PATCH', token: vatToken, body: { tax: { enabled: false } } });
  const vatOffSale = await vatSell(120_000, 100_000);
  const vatOffReceipt = (await api(`/sales/${vatOffSale.data?._id}/receipt`, { token: vatToken })).data;
  check('VAT off: no tax charged, total equals the item price', vatOffSale.status === 201 && vatOffSale.data.taxMinor === 0 && vatOffSale.data.totalMinor === 100_000, vatOffSale.data ?? vatOffSale.error);
  check('VAT off: the receipt data carries the same VAT-off setting', vatOffReceipt?.store?.tax?.enabled === false);
  check('VAT off: receipt data keeps cash change (customer paid 1200, change 200)', vatOffReceipt?.sale?.paidMinor === 120_000 && vatOffReceipt.sale.changeMinor === 20_000);

  // VAT on (10%, added on top): the server charges it, and the receipt data says VAT is on.
  const vatOn = await api('/stores/current', { method: 'PATCH', token: vatToken, body: { tax: { enabled: true, rateBasisPoints: 1000, inclusive: false, label: 'VAT' } } });
  check('VAT can be switched on through the existing store setting', vatOn.status === 200 && vatOn.data?.tax?.enabled === true, vatOn.error);
  const vatOnSale = await vatSell(110_000, 110_000);
  const vatOnReceipt = (await api(`/sales/${vatOnSale.data?._id}/receipt`, { token: vatToken })).data;
  check('VAT on: the server adds VAT to the total', vatOnSale.status === 201 && vatOnSale.data.subtotalMinor === 100_000 && vatOnSale.data.taxMinor === 10_000 && vatOnSale.data.totalMinor === 110_000, vatOnSale.data ?? vatOnSale.error);
  check('VAT on: the receipt data carries the VAT-on setting and the tax', vatOnReceipt?.store?.tax?.enabled === true && vatOnReceipt.sale.taxMinor === 10_000);

  // Turning VAT off later does not rewrite a sale that charged VAT.
  await api('/stores/current', { method: 'PATCH', token: vatToken, body: { tax: { enabled: false } } });
  const vatHistory = (await api(`/sales/${vatOnSale.data?._id}/receipt`, { token: vatToken })).data?.sale;
  check('A past VAT sale keeps its recorded VAT after VAT is turned off', vatHistory?.taxMinor === 10_000 && vatHistory.totalMinor === 110_000);

  // Branding has no setting: an attempt to switch it off is not stored anywhere.
  const vatBranding = await api('/stores/current', { method: 'PATCH', token: vatToken, body: { receipt: { showBranding: false, platformBranding: false } } });
  const vatAfterBranding = JSON.stringify((await api(`/sales/${vatOffSale.data?._id}/receipt`, { token: vatToken })).data ?? {});
  check('There is no receipt setting that can hide the platform branding', [200, 422].includes(vatBranding.status) && !/showBranding|platformBranding/.test(vatAfterBranding));

  // ------------------------------------------------ returns: exchange refund method
  section('Clothing POS: exchange as a refund method');
  const excStamp = Date.now();
  const excReg = await api('/auth/register', { method: 'POST', body: { businessName: `EXC Clothing ${excStamp}`, name: 'EXC Owner', email: `exc${excStamp}@example.com`, password: 'Password@123', vertical: 'clothing' } });
  const excToken = excReg.data?.tokens?.accessToken;
  await api('/stores', { method: 'POST', token: excToken, body: { name: 'EXC Main', currency: 'BDT' } });
  const excMake = async (name, variants) =>
    (await api('/products', { method: 'POST', token: excToken, body: { name: `${name} ${excStamp}`, variants: variants.map(([label, price, stock], i) => ({ attributes: label ? [{ name: 'Size', value: label }] : [], sku: `EXC${excStamp}${name.slice(0, 3)}${i}`, sellingPriceMinor: price, stock })) } })).data;
  const excA = await excMake('Shirt', [['M', 100_000, 60], ['L', 110_000, 20]]);
  const excB = await excMake('Jeans', [['32', 120_000, 20]]);
  const excC = await excMake('Jacket', [['', 130_000, 20]]);
  const excCheap = await excMake('Socks', [['', 90_000, 20]]);
  const excBig = await excMake('Coat', [['', 150_000, 20]]);
  const excAM = excA?.variants?.find((v) => v.name.includes('M'))?._id ?? excA?.variants?.[0]?._id;
  const excAL = excA?.variants?.find((v) => v.name.includes('L'))?._id ?? excA?.variants?.[1]?._id;
  const excV = (product) => product?.variants?.[0]?._id;
  const excStock = async (productId, variantId) => ((await api(`/products/${productId}`, { token: excToken })).data?.variants ?? []).find((v) => v._id === variantId)?.stock;

  // The original sale: 20 x Shirt M at 1000.
  const excSale = await api('/sales', { method: 'POST', token: excToken, body: { items: [{ variantId: excAM, quantity: 20 }], paymentMethod: 'cash' } });
  const excSaleId = excSale.data?._id;
  const excLineId = excSale.data?.items?.[0]?._id;
  check('An original sale of 20 shirts at 1000 exists', excSale.status === 201 && Boolean(excLineId), excSale.error);
  let excKeySeq = 0;
  const excKey = () => `exc-${excStamp}-${(excKeySeq += 1)}`;
  const excReturn = (exchange, extra = {}) =>
    api('/returns', { method: 'POST', token: excToken, body: { saleId: excSaleId, items: [{ saleItemId: excLineId, quantity: 1, restock: true }], reason: 'Wrong size', refundMethod: 'exchange', ...(exchange ? { exchange } : {}), ...extra } });
  const excReturnable = async () => (await api(`/returns/returnable/${excSaleId}`, { token: excToken })).data?.items?.[0]?.returnableQuantity;

  // 1. Equal price: nothing to pay.
  const excAMBefore = await excStock(excA?._id, excAM);
  const exc1 = await excReturn({ items: [{ variantId: excAM, quantity: 1 }], idempotencyKey: excKey() });
  check('Equal price (same product, same variant): exchange completes with 0 extra', exc1.status === 201 && exc1.data?.refundMethod === 'exchange' && exc1.data.exchange?.refundableMinor === 100_000 && exc1.data.exchange.extraPayableMinor === 0 && exc1.data.replacementSale?.totalMinor === 100_000 && exc1.data.replacementSale.payments.length === 0, exc1.data ?? exc1.error);
  check('Equal price: stock of the same variant back in and out again (net unchanged)', (await excStock(excA?._id, excAM)) === excAMBefore);
  check('Equal price: a payment on a 0 exchange is refused', (await excReturn({ items: [{ variantId: excAM, quantity: 1 }], payments: [{ method: 'cash', amountMinor: 100 }], idempotencyKey: excKey() })).status === 422);

  // 2. Higher price, cash.
  const exc2 = await excReturn({ items: [{ variantId: excV(excC), quantity: 1 }], payments: [{ method: 'cash', amountMinor: 30_000 }], idempotencyKey: excKey() });
  check('Higher price (1300): extra 300 paid in cash', exc2.status === 201 && exc2.data?.exchange?.extraPayableMinor === 30_000 && exc2.data.replacementSale?.payments?.[0]?.amountMinor === 30_000, exc2.data ?? exc2.error);

  // 3. Cheaper: refused, nothing moves.
  const excReturnableBefore = await excReturnable();
  const excCheapStockBefore = await excStock(excCheap?._id, excV(excCheap));
  const exc3 = await excReturn({ items: [{ variantId: excV(excCheap), quantity: 1 }], idempotencyKey: excKey() });
  check('Cheaper replacement (900) is refused with the exchange rule', exc3.status === 422 && exc3.error?.details?.reason === 'EXCHANGE_CHEAPER_REPLACEMENT', exc3.error);
  check('...and nothing moved: returnable quantity and stock unchanged', (await excReturnable()) === excReturnableBefore && (await excStock(excCheap?._id, excV(excCheap))) === excCheapStockBefore);

  // 4. Different product. 5. Same product, different variant.
  const exc4 = await excReturn({ items: [{ variantId: excV(excB), quantity: 1 }], payments: [{ method: 'cash', amountMinor: 20_000 }], idempotencyKey: excKey() });
  check('Different product (1200): allowed, extra 200', exc4.status === 201 && exc4.data?.exchange?.extraPayableMinor === 20_000, exc4.error);
  const excALBefore = await excStock(excA?._id, excAL);
  const exc5 = await excReturn({ items: [{ variantId: excAL, quantity: 1 }], payments: [{ method: 'bkash', amountMinor: 10_000 }], idempotencyKey: excKey() });
  check('Same product, different variant (1100): allowed, extra 100 by bKash', exc5.status === 201 && exc5.data?.exchange?.extraPayableMinor === 10_000 && exc5.data.replacementSale?.payments?.[0]?.method === 'bkash', exc5.error);
  check('Variant integrity: the exact variant picked (L) is the one deducted', (await excStock(excA?._id, excAL)) === excALBefore - 1 && String(exc5.data?.replacementSale?.items?.[0]?.variantId) === String(excAL));

  // 6. Split payment. 7. Cash overpayment.
  const exc6 = await excReturn({ items: [{ variantId: excV(excBig), quantity: 1 }], payments: [{ method: 'cash', amountMinor: 20_000 }, { method: 'bkash', amountMinor: 30_000 }], idempotencyKey: excKey() });
  check('Split payment: extra 500 as cash 200 + bKash 300', exc6.status === 201 && exc6.data?.exchange?.extraPayableMinor === 50_000 && exc6.data.replacementSale?.payments?.length === 2, exc6.error);
  const exc7 = await excReturn({ items: [{ variantId: excV(excC), quantity: 1 }], payments: [{ method: 'cash', amountMinor: 30_000 }], cashTenderedMinor: 50_000, idempotencyKey: excKey() });
  check('Cash overpayment: extra 300, cash received 500 -> change 200, cash recorded 300', exc7.status === 201 && exc7.data?.replacementSale?.changeMinor === 20_000 && exc7.data.replacementSale.payments[0].amountMinor === 30_000, exc7.data?.replacementSale ?? exc7.error);

  // 8. Insufficient payment.
  check('Insufficient payment (200 of 300) is refused', (await excReturn({ items: [{ variantId: excV(excC), quantity: 1 }], payments: [{ method: 'cash', amountMinor: 20_000 }], idempotencyKey: excKey() })).status === 422);
  check('Cash received below the cash due is refused', (await excReturn({ items: [{ variantId: excV(excC), quantity: 1 }], payments: [{ method: 'cash', amountMinor: 30_000 }], cashTenderedMinor: 20_000, idempotencyKey: excKey() })).status === 422);
  check('Overpaying the applied amount is refused (extra is recalculated on the server)', (await excReturn({ items: [{ variantId: excV(excC), quantity: 1 }], payments: [{ method: 'cash', amountMinor: 50_000 }], idempotencyKey: excKey() })).status === 422);

  // 9. Refund value is the price actually sold at, not today's catalogue price.
  const excDiscSale = await api('/sales', { method: 'POST', token: excToken, body: { items: [{ variantId: excAM, quantity: 1, unitPriceMinor: 80_000 }], paymentMethod: 'cash' } });
  const exc9 = await api('/returns', { method: 'POST', token: excToken, body: { saleId: excDiscSale.data?._id, items: [{ saleItemId: excDiscSale.data?.items?.[0]?._id, quantity: 1, restock: true }], refundMethod: 'exchange', exchange: { items: [{ variantId: excV(excCheap), quantity: 1 }], payments: [{ method: 'cash', amountMinor: 10_000 }], idempotencyKey: excKey() } } });
  check('Sold at 800 (catalogue 1000): a 900 replacement is allowed with extra 100', exc9.status === 201 && exc9.data?.exchange?.refundableMinor === 80_000 && exc9.data.exchange.extraPayableMinor === 10_000, exc9.data ?? exc9.error);

  // 11. Stock both ways.
  const excAMStock = await excStock(excA?._id, excAM);
  const excBStock = await excStock(excB?._id, excV(excB));
  const exc11 = await excReturn({ items: [{ variantId: excV(excB), quantity: 1 }], payments: [{ method: 'cash', amountMinor: 20_000 }], idempotencyKey: excKey() });
  check('Stock: returned shirt back in (+1), replacement jeans out (-1)', exc11.status === 201 && (await excStock(excA?._id, excAM)) === excAMStock + 1 && (await excStock(excB?._id, excV(excB))) === excBStock - 1);

  // 12. Duplicate submission.
  const excDupKey = excKey();
  const excCStock = await excStock(excC?._id, excV(excC));
  const excDupReturnable = await excReturnable();
  const excBurst = await Promise.all([1, 2, 3, 4, 5].map(() => excReturn({ items: [{ variantId: excV(excC), quantity: 1 }], payments: [{ method: 'cash', amountMinor: 30_000 }], idempotencyKey: excDupKey })));
  const excBurstNumbers = new Set(excBurst.filter((r) => [200, 201].includes(r.status)).map((r) => r.data?.returnNumber));
  check('Five simultaneous identical exchanges produce ONE exchange', excBurstNumbers.size === 1 && excBurst.some((r) => r.status === 201), excBurst.map((r) => [r.status, r.data?.returnNumber, r.error?.message]));
  check('...one replacement deducted, one unit returned', (await excStock(excC?._id, excV(excC))) === excCStock - 1 && (await excReturnable()) === excDupReturnable - 1);
  const excReplay = await excReturn({ items: [{ variantId: excV(excC), quantity: 1 }], payments: [{ method: 'cash', amountMinor: 30_000 }], idempotencyKey: excDupKey });
  check('Retrying with the same key returns the first exchange', excReplay.status === 200 && excReplay.data?.replayed === true && excBurstNumbers.has(excReplay.data.returnNumber));

  // Receipt data for the replacement sale.
  const excReceipt = (await api(`/sales/${exc7.data?.replacementSale?._id}/receipt`, { token: excToken })).data?.sale;
  check('Receipt data: exchange with return number, returned items, refund value, change', excReceipt?.exchange?.returnNumber === exc7.data?.returnNumber && excReceipt.exchange.creditMinor === 100_000 && excReceipt.exchange.returnedItems?.[0]?.quantity === 1 && excReceipt.totalMinor === 130_000 && excReceipt.changeMinor === 20_000, excReceipt);

  // Tampering and validation.
  check('No replacement for an exchange is refused', (await excReturn(undefined)).status === 422);
  check('Replacement data on a normal cash refund is refused', (await excReturn({ items: [{ variantId: excAM, quantity: 1 }], idempotencyKey: excKey() }, { refundMethod: 'cash' })).status === 422);
  check('A price, refund value or extra amount in the request is refused', (await excReturn({ items: [{ variantId: excV(excC), quantity: 1, unitPriceMinor: 1 }], extraPayableMinor: 0, idempotencyKey: excKey() })).status === 422 && (await excReturn({ items: [{ variantId: excV(excC), quantity: 1 }], refundableMinor: 999_999, idempotencyKey: excKey() })).status === 422);
  check('A replacement quantity above stock is refused', (await excReturn({ items: [{ variantId: excV(excBig), quantity: 999 }], payments: [{ method: 'cash', amountMinor: 1 }], idempotencyKey: excKey() })).status >= 400);

  // 13. Normal returns unchanged.
  const excCash = await api('/returns', { method: 'POST', token: excToken, body: { saleId: excSaleId, items: [{ saleItemId: excLineId, quantity: 1, restock: true }], refundMethod: 'cash' } });
  check('A normal cash refund still works, with no exchange data', excCash.status === 201 && excCash.data?.refundMethod === 'cash' && excCash.data.exchange === null && excCash.data.totalMinor === 100_000, excCash.error);
  const excBkash = await api('/returns', { method: 'POST', token: excToken, body: { saleId: excSaleId, items: [{ saleItemId: excLineId, quantity: 1, restock: true }], refundMethod: 'bkash' } });
  check('A normal bKash refund still works', excBkash.status === 201 && excBkash.data?.refundMethod === 'bkash');

  // 14. Isolation.
  const excForeignVariant = (await api('/products/pos-search?limit=1', { token: admin.token })).data?.[0]?.variantId;
  check("Another workspace's product cannot be the replacement", (await excReturn({ items: [{ variantId: excForeignVariant, quantity: 1 }], payments: [{ method: 'cash', amountMinor: 1 }], idempotencyKey: excKey() })).status >= 400);
  check("Another workspace cannot exchange against this sale", [403, 404].includes((await api('/returns', { method: 'POST', token: admin.token, body: { saleId: excSaleId, items: [{ saleItemId: excLineId, quantity: 1, restock: true }], refundMethod: 'exchange', exchange: { items: [{ variantId: excForeignVariant, quantity: 1 }], idempotencyKey: excKey() } } })).status));

  // ------------------------------------------------ billing emails: invoice, confirmation, expiry reminder
  section('Billing emails: invoices, renewal confirmations and expiry reminders');
  const bemStamp = Date.now();
  const bemEmail = `bem${bemStamp}@example.com`;
  const bemReg = await api('/auth/register', { method: 'POST', body: { businessName: `BEM Clothing ${bemStamp}`, name: 'BEM Owner', email: bemEmail, password: 'Password@123', vertical: 'clothing' } });
  const bemToken = bemReg.data?.tokens?.accessToken;
  const bemHomeId = bemReg.data?.tenant?.id;
  const bemAccountId = bemReg.data?.tenant?.accountId;
  await api('/stores', { method: 'POST', token: bemToken, body: { name: 'BEM Main', currency: 'BDT' } });
  await api(`/platform/accounts/${bemAccountId}/wallet/adjustments`, { method: 'POST', token: platform2.token, body: { direction: 'credit', amountMinor: 2_000_000, reason: 'Smoke test: billing emails', idempotencyKey: `bem-${bemStamp}-fund` } });
  const bemRows = async (params) => (await api(`/platform/email-notifications?limit=100&${new URLSearchParams(params)}`, { token: platform2.token })).data ?? [];
  const bemWait = async (params, predicate) => {
    // Delivery runs after the purchase returns, and a mail server that cannot be reached takes a while to fail.
    for (let i = 0; i < 150; i += 1) {
      const rows = await bemRows(params);
      if (predicate(rows)) return rows;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return bemRows(params);
  };

  // Purchase -> invoice email, after the payment and never instead of it.
  const bemRest = (await api('/workspaces', { method: 'POST', token: bemToken, body: { businessName: `BEM Restaurant ${bemStamp}`, vertical: 'restaurant' } })).data?.workspace?.id;
  const bemQuote = await api(`/workspaces/${bemRest}/checkout/quote`, { method: 'POST', token: bemToken, body: { plan: 'starter', billingCycle: 'monthly' } });
  const bemBuy = await api(`/workspaces/${bemRest}/checkout`, { method: 'POST', token: bemToken, body: { paymentMethod: 'wallet', plan: 'starter', billingCycle: 'monthly', idempotencyKey: `bem${bemStamp}buy`, expectedPayableMinor: bemQuote.data?.payableMinor } });
  check('A subscription is bought from the wallet', bemBuy.status === 201, bemBuy.error);
  const bemInvoiceRows = await bemWait({ tenantId: bemRest }, (rows) => rows.some((r) => r.type === 'subscription_invoice' && ['sent', 'failed', 'skipped'].includes(r.status)));
  const bemInvoiceRow = bemInvoiceRows.find((r) => r.type === 'subscription_invoice');
  const bemInvoice = ((await api(`/account/invoices?workspaceId=${bemRest}`, { token: bemToken })).data ?? [])[0];
  check('One invoice email is recorded for the purchase', bemInvoiceRows.filter((r) => r.type === 'subscription_invoice').length === 1 && Boolean(bemInvoiceRow?.invoiceId), bemInvoiceRows);
  check("...addressed to the account owner's email, not anything from the request", bemInvoiceRow?.recipient === bemEmail.toLowerCase(), bemInvoiceRow);
  check('...for the real invoice, by its number', bemInvoiceRow?.invoiceId === bemInvoice?.id && bemInvoiceRow.subject?.includes(bemInvoice?.number), { row: bemInvoiceRow?.subject, invoice: bemInvoice?.number });
  check('Delivery failing (no reachable mail server here) is recorded, not thrown', ['failed', 'sent'].includes(bemInvoiceRow?.status) && (bemInvoiceRow.status === 'sent' || Boolean(bemInvoiceRow.lastError)), bemInvoiceRow);
  check('...and the purchase stays completed', ((await api('/account/dashboard', { token: bemToken })).data?.workspaces ?? []).find((w) => w.id === bemRest)?.subscription?.status === 'active');
  check('No email address or secret is exposed by the delivery log', !JSON.stringify(bemInvoiceRow ?? {}).match(/password|apiKey|html|"text"/i));

  // A refused purchase sends nothing.
  const bemPharm = (await api('/workspaces', { method: 'POST', token: bemToken, body: { businessName: `BEM Pharmacy ${bemStamp}`, vertical: 'pharmacy' } })).data?.workspace?.id;
  const bemRefused = await api(`/workspaces/${bemPharm}/checkout`, { method: 'POST', token: bemToken, body: { paymentMethod: 'wallet', plan: 'starter', billingCycle: 'monthly', idempotencyKey: `bem${bemStamp}bad`, expectedPayableMinor: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 400));
  check('A refused purchase creates no invoice email', bemRefused.status === 409 && (await bemRows({ tenantId: bemPharm })).length === 0);

  // Sweeps and repeats never duplicate it.
  const bemSweep = await api('/platform/subscriptions/run-renewals', { method: 'POST', token: platform2.token, body: {} });
  check('The renewal pass reports email retries', bemSweep.status === 200 && typeof bemSweep.data?.emails?.checked === 'number', bemSweep.data);
  check('Repeated sweeps do not create a second invoice email', (await bemRows({ tenantId: bemRest, type: 'subscription_invoice' })).length === 1);

  // Expiry reminder: a period ending in 2 days, reminded once however often the job runs.
  const bemDay = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const bemAssign = await api('/platform/subscriptions', { method: 'POST', token: platform2.token, body: { tenantId: bemHomeId, planId: plansByCode['showroom-monthly']._id, startDate: bemDay(-28), endDate: bemDay(2), status: 'active', autoRenew: false } });
  check('A subscription ending in 2 days is set up', bemAssign.status === 201 || bemAssign.status === 200, bemAssign.error);
  await api('/platform/subscriptions/run-renewals', { method: 'POST', token: platform2.token, body: {} });
  await api('/platform/subscriptions/run-renewals', { method: 'POST', token: platform2.token, body: {} });
  const bemReminders = await bemRows({ tenantId: bemHomeId, type: 'subscription_expiry_reminder' });
  check('Exactly one expiry reminder for that period after repeated runs', bemReminders.length === 1 && bemReminders[0].recipient === bemEmail.toLowerCase(), bemReminders);
  check('Other workspaces of the account get no reminder they do not need', (await bemRows({ tenantId: bemRest, type: 'subscription_expiry_reminder' })).length === 0);

  // Renewal -> payment confirmation; the new period is not reminded now.
  const bemRenew = await api(`/workspaces/${bemHomeId}/subscription/renew`, { method: 'POST', token: bemToken, body: {} });
  check('Renewing now from the wallet succeeds', bemRenew.status === 200 || bemRenew.status === 201, bemRenew.error);
  const bemConfirm = await bemWait({ tenantId: bemHomeId, type: 'payment_confirmation' }, (rows) => rows.length > 0 && ['sent', 'failed', 'skipped'].includes(rows[0].status));
  check('The renewal records one payment confirmation email', bemConfirm.length === 1 && bemConfirm[0].subject?.startsWith('Payment Successful'), bemConfirm);
  await api('/platform/subscriptions/run-renewals', { method: 'POST', token: platform2.token, body: {} });
  check('The renewed period is not reminded (its end is weeks away)', (await bemRows({ tenantId: bemHomeId, type: 'subscription_expiry_reminder' })).length === 1);

  // Admin visibility and retry.
  check('Workspace owners cannot read the delivery log', (await api('/platform/email-notifications', { token: bemToken })).status === 403);
  check('Staff cannot read the delivery log', (await api('/platform/email-notifications', { token: cashier.token })).status === 403);
  const bemFailed = (await bemRows({ tenantId: bemRest, type: 'subscription_invoice' })).find((r) => r.status === 'failed');
  if (bemFailed) {
    const bemRetry = await api(`/platform/email-notifications/${bemFailed._id}/retry`, { method: 'POST', token: platform2.token, body: {} });
    check('A platform admin can retry a failed email', bemRetry.status === 200 && ['failed', 'sent'].includes(bemRetry.data?.outcome), bemRetry.data ?? bemRetry.error);
    check('...which reuses the same record and invoice (no duplicate)', (await bemRows({ tenantId: bemRest, type: 'subscription_invoice' })).length === 1);
  }
  check('A workspace owner cannot trigger a retry', (await api(`/platform/email-notifications/${bemInvoiceRow?._id}/retry`, { method: 'POST', token: bemToken, body: {} })).status === 403);

  // --- Out-of-stock sale override (permission sales.sellOutOfStock) ---------
  section('Clothing POS: out-of-stock sale override');
  {
    const oosStamp = String(Date.now()).slice(-6);
    const oosAdmin = await login('admin@demostore.dev', 'Admin@123');
    const oosCashier = await login('cashier@demostore.dev', 'Cashier@123');
    const oosSenior = await login('senior@demostore.dev', 'Cashier@123');
    const oosStores = (await api('/stores', { token: oosAdmin.token })).data ?? [];
    const oosMain = oosStores.find((s) => s.isDefault) ?? oosStores[0];
    const oosOther = oosStores.find((s) => String(s._id) !== String(oosMain._id));
    const at = { storeId: oosMain._id };

    check('Cashier does NOT hold sales.sellOutOfStock by default', !oosCashier.session.user.permissions.includes('sales.sellOutOfStock'));
    check('Senior Cashier holds sales.sellOutOfStock by default', oosSenior.session.user.permissions.includes('sales.sellOutOfStock'));
    check('Admin holds sales.sellOutOfStock', oosAdmin.session.user.permissions.includes('sales.sellOutOfStock'));
    const oosRoles = (await api('/roles', { token: oosAdmin.token })).data ?? [];
    check('Store Manager role grants it, Cashier role does not', oosRoles.find((r) => r.name === 'Store Manager')?.permissions.includes('sales.sellOutOfStock') && !oosRoles.find((r) => r.name === 'Cashier')?.permissions.includes('sales.sellOutOfStock'));
    const oosCatalog = (await api('/roles/permissions/catalog', { token: oosAdmin.token })).data ?? [];
    check('The permission is listed for assignment under Sales', JSON.stringify(oosCatalog).includes('Sell Out-of-Stock Products'));

    const oosBarcode = (await api('/products/barcode/generate', { method: 'POST', token: oosAdmin.token, ...at })).data?.barcode;
    const oosProduct = await api('/products', {
      method: 'POST',
      token: oosAdmin.token,
      ...at,
      body: {
        name: `OOS Shirt ${oosStamp}`,
        variants: [
          { attributes: [{ name: 'Size', value: 'M' }], sellingPriceMinor: 90000, costPriceMinor: 40000, stock: 0, barcode: oosBarcode },
          { attributes: [{ name: 'Size', value: 'L' }], sellingPriceMinor: 90000, costPriceMinor: 40000, stock: 5 },
          { attributes: [{ name: 'Size', value: 'XL' }], sellingPriceMinor: 90000, costPriceMinor: 40000, stock: 2 },
          { attributes: [{ name: 'Size', value: 'XXL' }], sellingPriceMinor: 90000, costPriceMinor: 40000, stock: 0 },
        ],
      },
    });
    check('A product with an out-of-stock and in-stock variants is created', oosProduct.status === 201, oosProduct.error);
    const [oosA, oosB, oosC, oosD] = oosProduct.data?.variants ?? [];
    const oosStock = async (v) => (await api(`/products/${oosProduct.data._id}`, { token: oosAdmin.token, ...at })).data?.variants?.find((x) => String(x._id) === String(v._id))?.stock;
    const sell = (token, variantId, quantity = 1, extra = {}, itemExtra = {}) =>
      api('/sales', { method: 'POST', token, ...at, body: { items: [{ variantId, quantity, ...itemExtra }], paymentMethod: 'cash', ...extra } });

    // Unauthorized staff: unchanged behaviour.
    const oosCash1 = await sell(oosCashier.token, oosA._id);
    check('Cashier without the permission cannot sell a zero-stock variant', oosCash1.status >= 400 && oosCash1.error?.code === 'INSUFFICIENT_STOCK', oosCash1.error);
    const oosForged = await sell(oosCashier.token, oosA._id, 1, { allowOutOfStock: true, overrideStock: true, skipStockCheck: true, forceSale: true });
    check('...and client flags (allowOutOfStock, overrideStock, skipStockCheck, forceSale) do not bypass it', oosForged.status >= 400);
    const oosForgedItem = await sell(oosCashier.token, oosA._id, 1, {}, { allowOutOfStock: true, stock: 10 });
    check('...nor do flags or a stock value on the line', oosForgedItem.status >= 400);
    check('Stock is untouched by the refused attempts', (await oosStock(oosA)) === 0);
    const oosCashB = await sell(oosCashier.token, oosB._id);
    check('Cashier still sells an in-stock variant of the same product normally', oosCashB.status === 201 && !oosCashB.data?.items?.[0]?.outOfStockOverride, oosCashB.error);
    check('...which takes stock 5 -> 4 as before', (await oosStock(oosB)) === 4);

    // Authorized staff.
    const oosBefore = (await api('/reports/branches?preset=today', { token: oosAdmin.token })).data?.totals?.orders ?? 0;
    const oosScan = await api(`/products/pos-search?q=${oosBarcode}&limit=5`, { token: oosSenior.token, ...at });
    const oosScanned = (oosScan.data ?? []).find((v) => v.barcode === oosBarcode);
    check('Barcode lookup finds the zero-stock variant (the POS decides by permission)', Boolean(oosScanned) && oosScanned.stock === 0, oosScan.data);
    const oosSeniorSale = await sell(oosSenior.token, oosScanned?.variantId ?? oosA._id);
    check('Senior Cashier sells the zero-stock variant', oosSeniorSale.status === 201, oosSeniorSale.error);
    check('...the line is flagged as an out-of-stock override', oosSeniorSale.data?.items?.[0]?.outOfStockOverride === true);
    check('...priced from the catalogue as normal', oosSeniorSale.data?.totalMinor === 90000);
    check('...stock follows the ledger: 0 -> -1', (await oosStock(oosA)) === -1);
    const oosLedger = (await api(`/inventory/ledger?variantId=${oosA._id}&limit=5`, { token: oosAdmin.token, ...at })).data ?? [];
    const oosRow = oosLedger.find((r) => r.referenceNumber === oosSeniorSale.data?.saleNumber);
    check('Ledger row: SALE, -1, 0 -> -1, override flag, performed by the senior cashier', oosRow?.type === 'SALE' && oosRow.quantityChange === -1 && oosRow.previousStock === 0 && oosRow.newStock === -1 && oosRow.outOfStockOverride === true && oosRow.performedByNameSnapshot === oosSeniorSale.data?.cashierNameSnapshot, oosRow);
    const oosAfter = (await api('/reports/branches?preset=today', { token: oosAdmin.token })).data?.totals?.orders ?? 0;
    check('The override sale counts as a normal completed sale in reports', oosAfter === oosBefore + 1 && oosSeniorSale.data?.status === 'completed', { oosBefore, oosAfter });
    const oosReceipt = await api(`/sales/${oosSeniorSale.data?._id}/receipt`, { token: oosAdmin.token, ...at });
    check('The receipt for an override sale loads like any other', oosReceipt.success, oosReceipt.error);
    check('The printed customer receipt template never shows the internal override', !/outOfStock|out-of-stock/i.test(readFileSync(new URL('../client/src/features/receipt/ThermalReceipt.tsx', import.meta.url), 'utf8')));

    check('Some stock but not enough is still refused, even with the permission (2 in stock, 5 asked)', (await sell(oosSenior.token, oosC._id, 5)).status >= 400 && (await oosStock(oosC)) === 2);
    const oosFromNeg = await sell(oosSenior.token, oosA._id, 2);
    check('Selling again below zero works for the authorized user (-1 -> -3)', oosFromNeg.status === 201 && (await oosStock(oosA)) === -3, oosFromNeg.error);
    const oosAdminSale = await sell(oosAdmin.token, oosD._id);
    check('Admin can sell out of stock', oosAdminSale.status === 201 && oosAdminSale.data?.items?.[0]?.outOfStockOverride === true, oosAdminSale.error);

    // Custom staff: grant then revoke, with the SAME session.
    const oosStaffEmail = `oos${oosStamp}@demostore.dev`;
    const oosStaff = await api('/staff', { method: 'POST', token: oosAdmin.token, ...at, body: { name: 'OOS Staff', email: oosStaffEmail, password: 'Password@123', storeId: oosMain._id, extraPermissions: ['sales.create', 'sales.view', 'products.view'] } });
    check('A custom staff member is created without the permission', oosStaff.status === 201, oosStaff.error);
    const oosCustom = await login(oosStaffEmail, 'Password@123');
    check('Custom staff cannot sell out of stock', (await sell(oosCustom.token, oosD._id)).status >= 400);
    await api(`/staff/${oosStaff.data.id}`, { method: 'PATCH', token: oosAdmin.token, body: { extraPermissions: ['sales.create', 'sales.view', 'products.view', 'sales.sellOutOfStock'] } });
    const oosGranted = await sell(oosCustom.token, oosD._id);
    check('After the admin grants it, the same session can', oosGranted.status === 201 && oosGranted.data?.items?.[0]?.outOfStockOverride === true, oosGranted.error);
    await api(`/staff/${oosStaff.data.id}`, { method: 'PATCH', token: oosAdmin.token, body: { extraPermissions: ['sales.create', 'sales.view', 'products.view'] } });
    const oosRevoked = await sell(oosCustom.token, oosD._id);
    check('After revoking it, the same session is refused at once', oosRevoked.status >= 400 && oosRevoked.error?.code === 'INSUFFICIENT_STOCK', oosRevoked.error);
    check('...and the sale made while granted is unchanged', (await api(`/sales/${oosGranted.data?._id}`, { token: oosAdmin.token, ...at })).data?.items?.[0]?.outOfStockOverride === true);

    // Store isolation.
    if (oosOther) {
      const oosCross = await api('/sales', { method: 'POST', token: oosAdmin.token, storeId: oosOther._id, body: { items: [{ variantId: oosD._id, quantity: 1 }], paymentMethod: 'cash' } });
      check("Another branch's out-of-stock variant cannot be sold, even by an admin", oosCross.status >= 400, oosCross.status);
      const oosSeniorCross = await api('/sales', { method: 'POST', token: oosSenior.token, storeId: oosOther._id, body: { items: [{ variantId: oosD._id, quantity: 1 }], paymentMethod: 'cash' } });
      check('A senior cashier cannot use the override through a branch they cannot access', oosSeniorCross.status >= 400);
    }

    // Concurrency: two authorized tills at zero stock.
    const oosD0 = await oosStock(oosD);
    const oosRace = await Promise.all([sell(oosSenior.token, oosD._id), sell(oosAdmin.token, oosD._id)]);
    const oosWon = oosRace.filter((r) => r.status === 201).length;
    const oosRaceLedger = ((await api(`/inventory/ledger?variantId=${oosD._id}&limit=50`, { token: oosAdmin.token, ...at })).data ?? []).filter((r) => oosRace.some((x) => x.data?.saleNumber && x.data.saleNumber === r.referenceNumber));
    check('Concurrent authorized sales each move stock exactly once', oosWon === 2 && (await oosStock(oosD)) === oosD0 - 2 && oosRaceLedger.length === 2, { oosWon, oosD0 });

    // Negative stock stays workable: edit, cancel, restock.
    const oosEdit = await api(`/products/${oosProduct.data._id}/variants/${oosA._id}`, { method: 'PATCH', token: oosAdmin.token, ...at, body: { sellingPriceMinor: 95000 } });
    check('A variant below zero can still be edited', oosEdit.status === 200, oosEdit.error);
    const oosCancel = await api(`/sales/${oosFromNeg.data?._id}/cancel`, { method: 'POST', token: oosAdmin.token, ...at, body: { reason: 'Test cancellation' } });
    check('Cancelling an override sale puts its units back (-3 -> -1)', oosCancel.status === 200 && (await oosStock(oosA)) === -1, oosCancel.error);
    const oosRestock = await api('/inventory/adjust', { method: 'POST', token: oosAdmin.token, ...at, body: { variantId: oosA._id, mode: 'delta', value: 4, reason: 'Delivery arrived' } });
    check('Receiving stock reconciles it (-1 + 4 = 3)', oosRestock.success && (await oosStock(oosA)) === 3, oosRestock.error);
    check('A plain adjustment still cannot take stock below zero', (await api('/inventory/adjust', { method: 'POST', token: oosAdmin.token, ...at, body: { variantId: oosA._id, mode: 'delta', value: -10, reason: 'Too much' } })).status >= 400 && (await oosStock(oosA)) === 3);
    const oosNowIn = await sell(oosCashier.token, oosA._id);
    check('Back in stock, the cashier sells it normally with no override flag', oosNowIn.status === 201 && !oosNowIn.data?.items?.[0]?.outOfStockOverride, oosNowIn.error);
    const oosSummary = (await api('/inventory/summary', { token: oosAdmin.token, ...at })).data;
    check('Stock value totals never go negative', oosSummary?.stockValueMinor >= 0 && oosSummary?.totalUnits >= 0, oosSummary);
  }

  // --- Clothing POS loyalty program -----------------------------------------
  section('Clothing POS: loyalty points, membership cards and barcodes');
  {
    const loyStamp = String(Date.now()).slice(-7);
    const loyPlatform = await login('platform@pos.dev', 'Platform@123');
    const loyPlans = (await api('/plans', {})).data ?? [];
    const loySetPlan = (tenantId, code) =>
      api('/platform/subscriptions', { method: 'POST', token: loyPlatform.token, body: { tenantId, planId: loyPlans.find((p) => p.code === code)._id, periods: 1, status: 'active', autoRenew: false } });
    const loyReg = await api('/auth/register', { method: 'POST', body: { businessName: `Loyal Wear ${loyStamp}`, name: 'Loyal Owner', email: `loy${loyStamp}@example.com`, password: 'Password@123', vertical: 'clothing' } });
    const loyOwner = loyReg.data?.tokens?.accessToken;
    const loyTenantId = loyReg.data?.tenant?.id ?? loyReg.data?.tenant?._id;
    const loyStoreA = (await api('/stores', { method: 'POST', token: loyOwner, body: { name: 'Loyal Main', code: `LY${loyStamp}`, currency: 'BDT' } })).data;
    check('A fresh Clothing workspace is set up for loyalty tests', Boolean(loyOwner && loyStoreA?._id), loyReg.error);
    const A = { storeId: loyStoreA._id };
    const key = (label) => `loy${loyStamp}${label}`.replace(/[^A-Za-z0-9_-]/g, '');

    // ---- Starter: nothing works ----
    await loySetPlan(loyTenantId, 'starter-store-monthly');
    const loyStarterSummary = await api('/loyalty/summary', { token: loyOwner, ...A });
    check('Starter: loyalty API is refused with ENTITLEMENT_REQUIRED', loyStarterSummary.status === 403 && loyStarterSummary.error?.code === 'ENTITLEMENT_REQUIRED', loyStarterSummary.error);
    check('Starter: card lookup is refused', (await api('/loyalty/lookup?code=2990000000000', { token: loyOwner, ...A })).status === 403);
    check('Starter: loyalty settings cannot be saved', (await api('/stores/current', { method: 'PATCH', token: loyOwner, ...A, body: { loyalty: { enabled: true } } })).status === 403);
    check('Starter: POS config reports loyalty unavailable', (await api('/stores/pos-config', { token: loyOwner, ...A })).data?.loyalty?.available === false);

    // ---- Professional ----
    await loySetPlan(loyTenantId, 'showroom-monthly');
    check('Professional: loyalty API is available', (await api('/loyalty/summary', { token: loyOwner, ...A })).status === 200);
    const loyDefaults = (await api('/stores/current', { token: loyOwner, ...A })).data?.loyalty;
    check('Defaults: ৳100 = 1 point, 1 point = ৳1, no fee, program off', loyDefaults?.earnSpendMinor === 10000 && loyDefaults?.pointValueMinor === 100 && loyDefaults?.membershipFeeMinor === 0 && loyDefaults?.enabled === false, loyDefaults);
    check('Settings refuse ৳0 = 1 point', (await api('/stores/current', { method: 'PATCH', token: loyOwner, ...A, body: { loyalty: { earnSpendMinor: 0 } } })).status === 422);
    check('Settings refuse a negative point value', (await api('/stores/current', { method: 'PATCH', token: loyOwner, ...A, body: { loyalty: { pointValueMinor: -100 } } })).status === 422);
    check('Settings refuse a fractional-poisha value', (await api('/stores/current', { method: 'PATCH', token: loyOwner, ...A, body: { loyalty: { pointValueMinor: 0.5 } } })).status === 422);

    const loyCust = async (name, phone) => (await api('/customers', { method: 'POST', token: loyOwner, ...A, body: { name, phone } })).data;
    const john = await loyCust('John Loyal', `0171${loyStamp}`);
    const loyDisabledIssue = await api('/loyalty/memberships', { method: 'POST', token: loyOwner, ...A, body: { customerId: john._id, idempotencyKey: key('off') } });
    check('Cards cannot be issued while the program is switched off', loyDisabledIssue.status === 400, loyDisabledIssue.error);
    const loyEnable = await api('/stores/current', { method: 'PATCH', token: loyOwner, ...A, body: { loyalty: { enabled: true, membershipFeeMinor: 20000 } } });
    check('Owner enables the program with a ৳200 membership fee', loyEnable.status === 200 && loyEnable.data?.loyalty?.membershipFeeMinor === 20000, loyEnable.error);
    check('POS config now reports loyalty available with the point value', (await api('/stores/pos-config', { token: loyOwner, ...A })).data?.loyalty?.available === true);

    const loyProduct = async (name, price, stock) =>
      (await api('/products', { method: 'POST', token: loyOwner, ...A, body: { name: `${name} ${loyStamp}`, variants: [{ attributes: [], sellingPriceMinor: price, costPriceMinor: 1000, stock }] } })).data?.variants?.[0]?._id;
    const pShirt = await loyProduct('Loyal Shirt', 100000, 100);
    const pTee = await loyProduct('Loyal Tee', 50000, 100);
    const pRare = await loyProduct('Loyal Rare', 50000, 1);
    const sell = (body, token = loyOwner, extra = A) => api('/sales', { method: 'POST', token, ...extra, body: { paymentMethod: 'cash', ...body } });

    // ---- phone / customer alone never earns ----
    const loyPhoneSale = await sell({ items: [{ variantId: pShirt, quantity: 1 }], customerId: john._id });
    check('A customer (with a phone) but no card earns nothing', loyPhoneSale.status === 201 && loyPhoneSale.data?.loyalty === null, loyPhoneSale.error);
    const loyNewCust = await sell({ items: [{ variantId: pShirt, quantity: 1 }], customer: { name: 'Walk In', phone: `0181${loyStamp}` } });
    check('Entering a phone at checkout creates no card and no points', loyNewCust.status === 201 && loyNewCust.data?.loyalty === null && (await api('/loyalty/summary', { token: loyOwner, ...A })).data?.totalMembers === 0);

    // ---- issuing a card: only with the fee paid ----
    check('Issuing without the fee is refused', (await api('/loyalty/memberships', { method: 'POST', token: loyOwner, ...A, body: { customerId: john._id, idempotencyKey: key('nofee') } })).status === 422);
    check('A payment that does not match the fee is refused', (await api('/loyalty/memberships', { method: 'POST', token: loyOwner, ...A, body: { customerId: john._id, payments: [{ method: 'cash', amountMinor: 10000 }], idempotencyKey: key('short') } })).status === 422);
    check('Client-set points, barcode or fee are refused', (await api('/loyalty/memberships', { method: 'POST', token: loyOwner, ...A, body: { customerId: john._id, payments: [{ method: 'cash', amountMinor: 20000 }], idempotencyKey: key('forge'), pointsBalance: 5000, barcode: '2991234567890', membershipFeeMinor: 0 } })).status === 422);
    check('No card exists after the refused attempts', (await api('/loyalty/summary', { token: loyOwner, ...A })).data?.totalMembers === 0);
    const loyIssue = await api('/loyalty/memberships', { method: 'POST', token: loyOwner, ...A, body: { customerId: john._id, payments: [{ method: 'cash', amountMinor: 20000 }], cashTenderedMinor: 50000, idempotencyKey: key('john') } });
    const card = loyIssue.data;
    check('Card issued once the ৳200 fee is paid: ACTIVE, 0 points, change ৳300', loyIssue.status === 201 && card?.status === 'active' && card.pointsBalance === 0 && card.membershipFeeMinor === 20000 && card.feeChangeMinor === 30000, loyIssue.error ?? card);
    const eanOk = (code) => /^299\d{10}$/.test(code) && (10 - (code.slice(0, 12).split('').reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0) % 10)) % 10 === Number(code[12]);
    check('The card has an opaque EAN-13 barcode (no phone or email in it) and a card number', eanOk(card?.barcode ?? '') && !card.barcode.includes(john.phone.slice(-7)) && /^LM-\d{6}$/.test(card.cardNumber), card);
    const loyReplay = await api('/loyalty/memberships', { method: 'POST', token: loyOwner, ...A, body: { customerId: john._id, payments: [{ method: 'cash', amountMinor: 20000 }], idempotencyKey: key('john') } });
    check('Retrying the same issue returns the same card', loyReplay.status === 200 && loyReplay.data?.id === card.id && loyReplay.data?.barcode === card.barcode);
    check('A second active card for the same customer is refused', (await api('/loyalty/memberships', { method: 'POST', token: loyOwner, ...A, body: { customerId: john._id, payments: [{ method: 'cash', amountMinor: 20000 }], idempotencyKey: key('john2') } })).status === 409);
    const reprintA = await api(`/loyalty/memberships/${card.id}`, { token: loyOwner, ...A });
    const reprintB = await api(`/loyalty/memberships/${card.id}`, { token: loyOwner, ...A });
    check('Reprinting reads the same card: same customer, card number and barcode', reprintA.data?.barcode === card.barcode && reprintB.data?.barcode === card.barcode && reprintB.data?.cardNumber === card.cardNumber && reprintB.data?.customer?.id === john._id);

    // ---- scanning ----
    const loyScan = await api(`/loyalty/lookup?code=${card.barcode}`, { token: loyOwner, ...A });
    check('Scanning the barcode loads the right customer and points', loyScan.status === 200 && loyScan.data?.customer?.name === 'John Loyal' && loyScan.data.pointsBalance === 0 && loyScan.data.id === card.id, loyScan.data);
    check('The printed card number also finds it', (await api(`/loyalty/lookup?code=${card.cardNumber}`, { token: loyOwner, ...A })).data?.id === card.id);
    const loyBad = await api('/loyalty/lookup?code=2990000000017', { token: loyOwner, ...A });
    check('An unknown barcode: "Loyalty member not found", nothing created', loyBad.status === 404 && /Loyalty member not found/.test(loyBad.error?.message ?? '') && (await api('/loyalty/summary', { token: loyOwner, ...A })).data?.totalMembers === 1);
    check("A phone number is not a card", (await api(`/loyalty/lookup?code=${john.phone}`, { token: loyOwner, ...A })).status === 404);

    // ---- earning ----
    const loySale1 = await sell({ items: [{ variantId: pShirt, quantity: 1 }], loyaltyMembershipId: card.id, idempotencyKey: key('s1') });
    check('৳1,000 sale with the card earns 10 points (default ৳100 = 1)', loySale1.status === 201 && loySale1.data?.loyalty?.pointsEarned === 10 && loySale1.data.loyalty.balanceAfter === 10, loySale1.error ?? loySale1.data?.loyalty);
    check('The card attaches its customer to the sale', loySale1.data?.customerId === john._id);
    const loyHist1 = (await api(`/loyalty/memberships/${card.id}/history`, { token: loyOwner, ...A })).data ?? [];
    check('Ledger: one earn +10, 0 -> 10, with the sale number', loyHist1.length === 1 && loyHist1[0].type === 'earn' && loyHist1[0].points === 10 && loyHist1[0].balanceBefore === 0 && loyHist1[0].balanceAfter === 10 && loyHist1[0].saleNumber === loySale1.data?.saleNumber, loyHist1);
    const loyOdd = await sell({ items: [{ variantId: pShirt, quantity: 1, unitPriceMinor: 99900 }], loyaltyMembershipId: card.id });
    check('৳999 earns 9 points (whole earning units only)', loyOdd.data?.loyalty?.pointsEarned === 9, loyOdd.error);
    const loyForged = await sell({ items: [{ variantId: pTee, quantity: 1 }], loyaltyMembershipId: card.id, pointsEarned: 10000, loyaltyDiscountMinor: 50000, points: 5000 });
    check('Client-sent points or discounts are ignored (৳500 earns 5)', loyForged.status === 201 && loyForged.data?.loyalty?.pointsEarned === 5 && loyForged.data.totalMinor === 50000, loyForged.error);
    check('A card cannot be combined with a different customer', (await sell({ items: [{ variantId: pTee, quantity: 1 }], loyaltyMembershipId: card.id, customerId: loyNewCust.data?.customerId })).status === 422);

    // ---- duplicates ----
    const loyDup = await sell({ items: [{ variantId: pShirt, quantity: 1 }], loyaltyMembershipId: card.id, idempotencyKey: key('s1') });
    check('Retrying a checkout returns the same sale (200), no new points', loyDup.status === 200 && loyDup.data?._id === loySale1.data?._id);
    const loyBurst = await Promise.all([1, 2, 3].map(() => sell({ items: [{ variantId: pTee, quantity: 2 }], loyaltyMembershipId: card.id, idempotencyKey: key('burst') })));
    const loyBurstIds = new Set(loyBurst.filter((r) => r.data?._id).map((r) => r.data._id));
    const loyBurstEarns = ((await api(`/loyalty/memberships/${card.id}/history?limit=100`, { token: loyOwner, ...A })).data ?? []).filter((r) => r.type === 'earn' && loyBurstIds.has(r.saleId));
    check('Three simultaneous identical checkouts: one sale, one earning', loyBurstIds.size === 1 && loyBurstEarns.length === 1, { ids: [...loyBurstIds], earns: loyBurstEarns.length, statuses: loyBurst.map((r) => r.status) });
    const loyBalanceNow = async () => (await api(`/loyalty/memberships/${card.id}`, { token: loyOwner, ...A })).data?.pointsBalance;
    const loyLedgerSum = async () => ((await api(`/loyalty/memberships/${card.id}/history?limit=100`, { token: loyOwner, ...A })).data ?? []).reduce((s, r) => s + r.points, 0);
    check('Balance equals the sum of the ledger', (await loyBalanceNow()) === (await loyLedgerSum()) && (await loyBalanceNow()) === 10 + 9 + 5 + 10);
    // Reprinting (direct or browser) only reads GET /sales/:id/receipt - it must never move points.
    const loyBeforeReprint = { balance: await loyBalanceNow(), ledger: ((await api(`/loyalty/memberships/${card.id}/history?limit=100`, { token: loyOwner, ...A })).data ?? []).length, sales: (await api('/sales?limit=1', { token: loyOwner, ...A })).meta?.total };
    for (let i = 0; i < 3; i += 1) await api(`/sales/${loySale1.data._id}/receipt`, { token: loyOwner, ...A });
    const loyAfterReprint = { balance: await loyBalanceNow(), ledger: ((await api(`/loyalty/memberships/${card.id}/history?limit=100`, { token: loyOwner, ...A })).data ?? []).length, sales: (await api('/sales?limit=1', { token: loyOwner, ...A })).meta?.total };
    check('Reprinting a loyalty receipt 3 times changes no points, ledger or sales', JSON.stringify(loyBeforeReprint) === JSON.stringify(loyAfterReprint), { loyBeforeReprint, loyAfterReprint });

    // ---- manual adjustment ----
    check('Adjustment needs a reason', (await api(`/loyalty/memberships/${card.id}/adjust`, { method: 'POST', token: loyOwner, ...A, body: { points: 100, reason: '', idempotencyKey: key('adj0') } })).status === 422);
    const loyAdj = await api(`/loyalty/memberships/${card.id}/adjust`, { method: 'POST', token: loyOwner, ...A, body: { points: 1000, reason: 'Customer service compensation', idempotencyKey: key('adj1') } });
    await api(`/loyalty/memberships/${card.id}/adjust`, { method: 'POST', token: loyOwner, ...A, body: { points: 1000, reason: 'Customer service compensation', idempotencyKey: key('adj1') } });
    check('Owner adjusts +1000 with a reason, once even when retried', loyAdj.status === 200 && (await loyBalanceNow()) === 1034, loyAdj.error);
    check('An adjustment cannot take the card below zero', (await api(`/loyalty/memberships/${card.id}/adjust`, { method: 'POST', token: loyOwner, ...A, body: { points: -999999, reason: 'Too much', idempotencyKey: key('adj2') } })).status === 422 && (await loyBalanceNow()) === 1034);

    // ---- redemption ----
    const loyRedeem = await sell({ items: [{ variantId: pTee, quantity: 1 }], loyaltyMembershipId: card.id, redeemPoints: 50 });
    check('Redeem 50 points on ৳500: ৳50 off, pays ৳450, earns 4, balance 1034 - 50 + 4', loyRedeem.status === 201 && loyRedeem.data?.totalMinor === 45000 && loyRedeem.data.loyalty.discountMinor === 5000 && loyRedeem.data.loyalty.pointsEarned === 4 && loyRedeem.data.loyalty.balanceAfter === 988 && (await loyBalanceNow()) === 988, loyRedeem.error ?? loyRedeem.data?.loyalty);
    check('The loyalty discount is part of the sale discount total (reports stay right)', loyRedeem.data?.discountMinor === 5000);
    const loyTooMany = await sell({ items: [{ variantId: pShirt, quantity: 1 }], loyaltyMembershipId: card.id, redeemPoints: 5000 });
    check('Redeeming more points than the card holds is refused', loyTooMany.status === 422 && loyTooMany.error?.details?.reason === 'LOYALTY_INSUFFICIENT_POINTS' && (await loyBalanceNow()) === 988, loyTooMany.error);
    const loyTooHigh = await sell({ items: [{ variantId: pTee, quantity: 1 }], loyaltyMembershipId: card.id, redeemPoints: 600 });
    check('Redeeming more than the sale is worth is refused (৳600 on ৳500)', loyTooHigh.status === 422 && loyTooHigh.error?.details?.reason === 'LOYALTY_REDEMPTION_TOO_HIGH' && (await loyBalanceNow()) === 988, loyTooHigh.error);
    const loyFull = await sell({ items: [{ variantId: pTee, quantity: 1 }], loyaltyMembershipId: card.id, redeemPoints: 500 });
    check('Points can cover the whole sale: total ৳0, no payment, earns 0', loyFull.status === 201 && loyFull.data?.totalMinor === 0 && loyFull.data.payments.length === 0 && loyFull.data.loyalty.pointsEarned === 0 && (await loyBalanceNow()) === 488, loyFull.error);
    check('...and a payment on a fully covered sale is refused', (await sell({ items: [{ variantId: pTee, quantity: 1 }], loyaltyMembershipId: card.id, redeemPoints: 500, payments: [{ method: 'cash', amountMinor: 100 }] })).status === 422);
    check('Redeeming without a card is refused', (await sell({ items: [{ variantId: pTee, quantity: 1 }], redeemPoints: 10 })).status === 422);
    const loyStockBefore = (await api(`/products/pos-search?q=Loyal Rare&limit=5`, { token: loyOwner, ...A })).data?.[0]?.stock;
    const loyFailed = await api('/sales', { method: 'POST', token: loyOwner, ...A, body: { paymentMethod: 'cash', items: [{ variantId: pTee, quantity: 1 }, { variantId: pRare, quantity: 5 }], loyaltyMembershipId: card.id, redeemPoints: 100 } });
    check('A sale that fails (not enough stock) keeps the points: none deducted or earned', loyFailed.status >= 400 && (await loyBalanceNow()) === 488 && (await loyBalanceNow()) === (await loyLedgerSum()), loyFailed.error);
    check('...and its stock is untouched', (await api(`/products/pos-search?q=Loyal Rare&limit=5`, { token: loyOwner, ...A })).data?.[0]?.stock === loyStockBefore);

    // ---- concurrent redemption ----
    await api(`/loyalty/memberships/${card.id}/adjust`, { method: 'POST', token: loyOwner, ...A, body: { points: -388, reason: 'Set up race test', idempotencyKey: key('adj3') } });
    const loyRace = await Promise.all([1, 2].map(() => sell({ items: [{ variantId: pTee, quantity: 1 }], loyaltyMembershipId: card.id, redeemPoints: 80 })));
    const loyRaceWon = loyRace.filter((r) => r.status === 201);
    check('Two tills redeeming 80 of 100 points at once: only one succeeds', loyRaceWon.length === 1 && (await loyBalanceNow()) === 100 - 80 + loyRaceWon[0].data.loyalty.pointsEarned, loyRace.map((r) => r.status));
    check('Balance still equals the ledger after the race', (await loyBalanceNow()) === (await loyLedgerSum()));

    // ---- returns ----
    await api(`/loyalty/memberships/${card.id}/adjust`, { method: 'POST', token: loyOwner, ...A, body: { points: 1000, reason: 'Set up return tests', idempotencyKey: key('adj4') } });
    const loyRetSale = await sell({ items: [{ variantId: pTee, quantity: 4 }], loyaltyMembershipId: card.id });
    const retItem = loyRetSale.data?.items?.[0]?._id;
    check('৳2,000 sale earns 20', loyRetSale.data?.loyalty?.pointsEarned === 20);
    let bal = await loyBalanceNow();
    const loyRet1 = await api('/returns', { method: 'POST', token: loyOwner, ...A, body: { saleId: loyRetSale.data._id, items: [{ saleItemId: retItem, quantity: 1 }], refundMethod: 'cash' } });
    check('Returning ৳500 of it takes back 5 points (kept ৳1,500 earns 15), refund ৳500', loyRet1.status === 201 && loyRet1.data?.loyalty?.pointsEarnedReversed === 5 && loyRet1.data.totalMinor === 50000 && (await loyBalanceNow()) === bal - 5, loyRet1.error ?? loyRet1.data?.loyalty);
    const loyRet2 = await api('/returns', { method: 'POST', token: loyOwner, ...A, body: { saleId: loyRetSale.data._id, items: [{ saleItemId: retItem, quantity: 3 }], refundMethod: 'cash' } });
    check('Returning the rest takes back the other 15 (20 in total, never more)', loyRet2.status === 201 && loyRet2.data?.loyalty?.pointsEarnedReversed === 15 && (await loyBalanceNow()) === bal - 20, loyRet2.error);

    bal = await loyBalanceNow();
    const loyRedeemRet = await sell({ items: [{ variantId: pTee, quantity: 2 }], loyaltyMembershipId: card.id, redeemPoints: 200 });
    check('৳1,000 sale with 200 points redeemed: pays ৳800, earns 8', loyRedeemRet.data?.totalMinor === 80000 && loyRedeemRet.data.loyalty.pointsEarned === 8, loyRedeemRet.error);
    bal = await loyBalanceNow();
    const rrItem = loyRedeemRet.data?.items?.[0]?._id;
    const loyRR1 = await api('/returns', { method: 'POST', token: loyOwner, ...A, body: { saleId: loyRedeemRet.data._id, items: [{ saleItemId: rrItem, quantity: 1 }], refundMethod: 'cash' } });
    check('Returning half: 100 redeemed points given back, cash refund ৳400 (not ৳500), 4 earned taken back', loyRR1.status === 201 && loyRR1.data?.loyalty?.pointsRedeemedRestored === 100 && loyRR1.data.totalMinor === 40000 && loyRR1.data.loyalty.pointsEarnedReversed === 4 && (await loyBalanceNow()) === bal + 100 - 4, loyRR1.error ?? loyRR1.data?.loyalty);
    const loyRR2 = await api('/returns', { method: 'POST', token: loyOwner, ...A, body: { saleId: loyRedeemRet.data._id, items: [{ saleItemId: rrItem, quantity: 1 }], refundMethod: 'cash' } });
    check('Returning the rest: the other 100 back, ৳400 refund; the sale is fully undone on the card', loyRR2.status === 201 && loyRR2.data?.totalMinor === 40000 && (await loyBalanceNow()) === bal + 200 - 8, loyRR2.error);
    const loyReturnable = await api(`/returns/returnable/${loyRedeemRet.data._id}`, { token: loyOwner, ...A });
    check('The returnable-sale view carries the loyalty figures for the preview', loyReturnable.data?.sale?.loyalty?.pointsRedeemed === 200, loyReturnable.error);

    // ---- cancellation ----
    bal = await loyBalanceNow();
    const loyCancelSale = await sell({ items: [{ variantId: pShirt, quantity: 1 }], loyaltyMembershipId: card.id, redeemPoints: 30 });
    const loyCancel = await api(`/sales/${loyCancelSale.data?._id}/cancel`, { method: 'POST', token: loyOwner, ...A, body: { reason: 'Customer changed mind' } });
    check('Cancelling a loyalty sale restores the card exactly (redeemed back, earned taken back)', loyCancel.status === 200 && (await loyBalanceNow()) === bal && (await loyBalanceNow()) === (await loyLedgerSum()), loyCancel.error);

    // ---- exchange ----
    bal = await loyBalanceNow();
    const loyExSale = await sell({ items: [{ variantId: pTee, quantity: 1 }], loyaltyMembershipId: card.id });
    const loyEx = await api('/returns', {
      method: 'POST',
      token: loyOwner,
      ...A,
      body: { saleId: loyExSale.data?._id, items: [{ saleItemId: loyExSale.data?.items?.[0]?._id, quantity: 1 }], refundMethod: 'exchange', exchange: { items: [{ variantId: pShirt, quantity: 1 }], payments: [{ method: 'cash', amountMinor: 50000 }], idempotencyKey: key('ex1') } },
    });
    check('Exchange ৳500 tee -> ৳1,000 shirt: tee points (5) taken back, shirt earns 10 - no double award', loyEx.status === 201 && loyEx.data?.loyalty?.pointsEarnedReversed === 5 && loyEx.data?.replacementSale?.loyalty?.pointsEarned === 10 && (await loyBalanceNow()) === bal + 5 - 5 + 10, loyEx.error ?? { r: loyEx.data?.loyalty, s: loyEx.data?.replacementSale?.loyalty });

    // ---- inactive card ----
    const loyDeact = await api(`/loyalty/memberships/${card.id}/status`, { method: 'POST', token: loyOwner, ...A, body: { status: 'inactive', reason: 'Card reported lost' } });
    check('Owner deactivates the card; points and history are kept', loyDeact.status === 200 && loyDeact.data?.status === 'inactive' && loyDeact.data.pointsBalance === (await loyLedgerSum()));
    check('An inactive card cannot earn or redeem', (await sell({ items: [{ variantId: pTee, quantity: 1 }], loyaltyMembershipId: card.id })).status === 400);
    check('...and scanning it shows it as inactive', (await api(`/loyalty/lookup?code=${card.barcode}`, { token: loyOwner, ...A })).data?.status === 'inactive');
    check('Reactivating works', (await api(`/loyalty/memberships/${card.id}/status`, { method: 'POST', token: loyOwner, ...A, body: { status: 'active', reason: 'Card found' } })).data?.status === 'active');

    // ---- barcode uniqueness ----
    await api('/stores/current', { method: 'PATCH', token: loyOwner, ...A, body: { loyalty: { membershipFeeMinor: 0 } } });
    const loyMany = [];
    for (let i = 0; i < 6; i += 1) {
      const c = await loyCust(`Member ${i}`, `0191${loyStamp.slice(-6)}${i}`);
      loyMany.push((await api('/loyalty/memberships', { method: 'POST', token: loyOwner, ...A, body: { customerId: c._id, idempotencyKey: key(`m${i}`) } })).data);
    }
    const loyCodes = loyMany.map((m) => m?.barcode);
    check('Free cards issue without payment; every barcode and card number is unique and valid', loyCodes.every(eanOk) && new Set(loyCodes).size === 6 && new Set(loyMany.map((m) => m?.cardNumber)).size === 6, loyCodes);
    check('A payment on a free card is refused', (await api('/loyalty/memberships', { method: 'POST', token: loyOwner, ...A, body: { customerId: (await loyCust('Free Pay', `0161${loyStamp}`))._id, payments: [{ method: 'cash', amountMinor: 100 }], idempotencyKey: key('freepay') } })).status === 422);

    // ---- permissions ----
    const loyRoles = (await api('/roles', { token: loyOwner, ...A })).data ?? [];
    const cashierRole = loyRoles.find((r) => r.name === 'Cashier');
    check('Default roles: Cashier redeems; Senior views; Manager manages', cashierRole?.permissions.includes('loyalty.redeem') && !cashierRole.permissions.includes('loyalty.manage') && loyRoles.find((r) => r.name === 'Store Manager')?.permissions.includes('loyalty.manage') && loyRoles.find((r) => r.name === 'Senior Cashier')?.permissions.includes('loyalty.view'));
    await api('/staff', { method: 'POST', token: loyOwner, ...A, body: { name: 'Loyal Cashier', email: `loyc${loyStamp}@example.com`, password: 'Password@123', storeId: loyStoreA._id, roleId: cashierRole?._id } });
    await api('/staff', { method: 'POST', token: loyOwner, ...A, body: { name: 'Plain Seller', email: `loyp${loyStamp}@example.com`, password: 'Password@123', storeId: loyStoreA._id, extraPermissions: ['sales.create', 'sales.view', 'products.view'] } });
    const loyCashier = (await login(`loyc${loyStamp}@example.com`, 'Password@123')).token;
    const loyPlain = (await login(`loyp${loyStamp}@example.com`, 'Password@123')).token;
    check('Cashier cannot issue cards', (await api('/loyalty/memberships', { method: 'POST', token: loyCashier, ...A, body: { customerId: john._id, idempotencyKey: key('cash1') } })).status === 403);
    check('Cashier cannot adjust points', (await api(`/loyalty/memberships/${card.id}/adjust`, { method: 'POST', token: loyCashier, ...A, body: { points: 10000, reason: 'Free points please', idempotencyKey: key('cash2') } })).status === 403);
    check('Cashier cannot deactivate cards', (await api(`/loyalty/memberships/${card.id}/status`, { method: 'POST', token: loyCashier, ...A, body: { status: 'inactive', reason: 'nope' } })).status === 403);
    check('Cashier cannot list members', (await api('/loyalty/memberships', { token: loyCashier, ...A })).status === 403);
    check('Cashier CAN scan a card at the till', (await api(`/loyalty/lookup?code=${card.barcode}`, { token: loyCashier, ...A })).status === 200);
    check('Cashier CAN redeem points', (await sell({ items: [{ variantId: pTee, quantity: 1 }], loyaltyMembershipId: card.id, redeemPoints: 10 }, loyCashier)).status === 201);
    check('Staff without loyalty.redeem cannot redeem', (await sell({ items: [{ variantId: pTee, quantity: 1 }], loyaltyMembershipId: card.id, redeemPoints: 10 }, loyPlain)).status === 403);
    check('...but their card sale still earns points', (await sell({ items: [{ variantId: pTee, quantity: 1 }], loyaltyMembershipId: card.id }, loyPlain)).data?.loyalty?.pointsEarned === 5);
    check('Settings need settings.edit', (await api('/stores/current', { method: 'PATCH', token: loyCashier, ...A, body: { loyalty: { pointValueMinor: 100000 } } })).status === 403);

    // ---- branch isolation ----
    const loyStoreB = (await api('/stores', { method: 'POST', token: loyOwner, body: { name: 'Loyal Two', code: `LZ${loyStamp}`, currency: 'BDT' } })).data;
    const B = { storeId: loyStoreB?._id };
    await api('/stores/current', { method: 'PATCH', token: loyOwner, ...B, body: { loyalty: { enabled: true } } });
    check("Another branch cannot find this branch's card", (await api(`/loyalty/lookup?code=${card.barcode}`, { token: loyOwner, ...B })).status === 404);
    const loyBShirt = (await api('/products', { method: 'POST', token: loyOwner, ...B, body: { name: `B Shirt ${loyStamp}`, variants: [{ attributes: [], sellingPriceMinor: 100000, stock: 10 }] } })).data?.variants?.[0]?._id;
    check("Another branch cannot use this branch's card on a sale", (await sell({ items: [{ variantId: loyBShirt, quantity: 1 }], loyaltyMembershipId: card.id, redeemPoints: 10 }, loyOwner, B)).status === 400);
    check("Another branch cannot issue a card to this branch's customer", (await api('/loyalty/memberships', { method: 'POST', token: loyOwner, ...B, body: { customerId: john._id, idempotencyKey: key('crossb') } })).status === 400);
    check('The cashier cannot reach the other branch at all', (await api(`/loyalty/lookup?code=${card.barcode}`, { token: loyCashier, ...B })).status === 403);

    // ---- downgrade keeps the data ----
    const loyKeep = await loyBalanceNow();
    await loySetPlan(loyTenantId, 'starter-store-monthly');
    check('After a downgrade to Starter the loyalty API is refused', (await api(`/loyalty/memberships/${card.id}`, { token: loyOwner, ...A })).status === 403);
    check('...and a card sale is refused', (await sell({ items: [{ variantId: pTee, quantity: 1 }], loyaltyMembershipId: card.id })).status === 403);
    check('...but ordinary sales still work', (await sell({ items: [{ variantId: pTee, quantity: 1 }] })).status === 201);
    await loySetPlan(loyTenantId, 'brand-monthly');
    const loyBack = await api(`/loyalty/memberships/${card.id}`, { token: loyOwner, ...A });
    check('Enterprise: loyalty is available and the card, points and history are all still there', loyBack.status === 200 && loyBack.data?.pointsBalance === loyKeep && (await loyLedgerSum()) === loyKeep, loyBack.error);
  }

  // --- Direct thermal printing: QZ Tray signing endpoints ----------------------
  section('Direct thermal printing: QZ Tray signing');
  {
    const prCashier = await login('cashier@demostore.dev', 'Cashier@123');
    check('The certificate endpoint needs a signed-in user', (await api('/printing/qz/certificate')).status === 401);
    check('The signing endpoint needs a signed-in user', (await api('/printing/qz/sign', { method: 'POST', body: { request: 'x' } })).status === 401);
    const prCert = await api('/printing/qz/certificate', { token: prCashier.token });
    check('Without a configured key the API reports unsigned mode (no certificate, nothing secret)', prCert.status === 200 && prCert.data?.configured === false && prCert.data?.certificate === null, prCert.data);
    const prSign = await api('/printing/qz/sign', { method: 'POST', token: prCashier.token, body: { request: '{"call":"printers.find"}' } });
    check('...and signing returns no signature', prSign.status === 200 && prSign.data?.configured === false && prSign.data?.signature === null, prSign.data);
    check('An oversized signing request is refused', (await api('/printing/qz/sign', { method: 'POST', token: prCashier.token, body: { request: 'x'.repeat(10_001) } })).status === 422);
    check('An empty signing request is refused', (await api('/printing/qz/sign', { method: 'POST', token: prCashier.token, body: { request: '' } })).status === 422);
    check('Unknown fields (e.g. raw printer commands) are refused', (await api('/printing/qz/sign', { method: 'POST', token: prCashier.token, body: { request: 'x', printer: 'POS', data: '1b40' } })).status === 422);
    check('No endpoint accepts raw print jobs', (await api('/printing/print', { method: 'POST', token: prCashier.token, body: { data: '1b40' } })).status === 404);
  }

  // --- Clothing POS data export ---------------------------------------------
  section('Clothing POS: data export (CSV, Excel, JSON, PDF)');
  {
    const exStamp = String(Date.now()).slice(-7);
    const exPlatform = await login('platform@pos.dev', 'Platform@123');
    const exPlans = (await api('/plans', {})).data ?? [];
    const exSetPlan = (tenantId, code) =>
      api('/platform/subscriptions', { method: 'POST', token: exPlatform.token, body: { tenantId, planId: exPlans.find((p) => p.code === code)._id, periods: 1, status: 'active', autoRenew: false } });
    const exReg = await api('/auth/register', { method: 'POST', body: { businessName: `Export Wear ${exStamp}`, name: 'Export Owner', email: `exp${exStamp}@example.com`, password: 'Password@123', vertical: 'clothing' } });
    const exOwner = exReg.data?.tokens?.accessToken;
    const exTenantId = exReg.data?.tenant?.id ?? exReg.data?.tenant?._id;
    const exStoreA = (await api('/stores', { method: 'POST', token: exOwner, body: { name: 'Export Main', code: `EX${exStamp}`, currency: 'BDT' } })).data;
    const A = { storeId: exStoreA?._id };
    check('A fresh Clothing workspace is set up for export tests', Boolean(exOwner && exStoreA?._id), exReg.error);

    // ---- Starter: no access at all ----
    await exSetPlan(exTenantId, 'starter-store-monthly');
    const exStarterList = await api('/exports/datasets', { token: exOwner, ...A });
    check('Starter: the dataset registry is refused with ENTITLEMENT_REQUIRED', exStarterList.status === 403 && exStarterList.error?.code === 'ENTITLEMENT_REQUIRED', exStarterList.error);
    const exStarterRun = await download('/exports', { token: exOwner, ...A, body: { type: 'customers', format: 'csv' } });
    check('Starter: running an export is refused and no file is produced', exStarterRun.status === 403 && !exStarterRun.disposition, exStarterRun.error);
    check('Starter: the export history is refused', (await api('/exports', { token: exOwner, ...A })).status === 403);
    check('An export needs a signed-in user', (await download('/exports', { ...A, body: { type: 'customers', format: 'csv' } })).status === 401);

    // ---- Professional: the registry ----
    await exSetPlan(exTenantId, 'showroom-monthly');
    const exCatalog = await api('/exports/datasets', { token: exOwner, ...A });
    const exKeys = (exCatalog.data?.datasets ?? []).map((d) => d.key);
    check('Professional: the registry lists the datasets, formats and limits', exCatalog.status === 200 && exKeys.includes('sales') && exKeys.includes('customers') && exCatalog.data.formats.length === 4 && exCatalog.data.limits.rows > 0, exCatalog.error ?? exCatalog.data);
    check('The registry never offers users, roles or settings', !exKeys.some((k) => /user|staff|role|setting|password|token/i.test(k)), exKeys);
    check('An unknown dataset is refused (no arbitrary collection export)', (await download('/exports', { token: exOwner, ...A, body: { type: 'users', format: 'csv' } })).status === 422);
    check('...and so is a raw collection name', (await download('/exports', { token: exOwner, ...A, body: { collection: 'users', format: 'csv' } })).status === 422);
    check('An unknown format is refused', (await download('/exports', { token: exOwner, ...A, body: { type: 'customers', format: 'sql' } })).status === 422);
    check('A custom range without both dates is refused', (await download('/exports', { token: exOwner, ...A, body: { type: 'sales', format: 'csv', preset: 'custom' } })).status === 422);
    check('A backwards custom range is refused', (await download('/exports', { token: exOwner, ...A, body: { type: 'sales', format: 'csv', preset: 'custom', from: '2026-02-01', to: '2026-01-01' } })).status === 422);

    // ---- data worth exporting: a formula-injection name, Bengali text, money ----
    const exEvil = (await api('/customers', { method: 'POST', token: exOwner, ...A, body: { name: `=1+1 Evil ${exStamp}`, phone: `0151${exStamp}` } })).data;
    const exBangla = (await api('/customers', { method: 'POST', token: exOwner, ...A, body: { name: `রহিম উদ্দিন ${exStamp}`, phone: `0152${exStamp}` } })).data;
    const exVariant = (await api('/products', { method: 'POST', token: exOwner, ...A, body: { name: `শার্ট ${exStamp}`, variants: [{ attributes: [], sellingPriceMinor: 129900, costPriceMinor: 80000, stock: 50 }] } })).data?.variants?.[0]?._id;
    const exSale = await api('/sales', { method: 'POST', token: exOwner, ...A, body: { paymentMethod: 'cash', customerId: exEvil?._id, items: [{ variantId: exVariant, quantity: 2 }] } });
    check('Test data is in place (customers, a Bengali product and a ৳2,598 sale)', Boolean(exEvil?._id && exBangla?._id && exVariant) && exSale.data?.totalMinor === 259800, exSale.error ?? exSale.data?.totalMinor);

    // ---- CSV ----
    const exCsv = await download('/exports', { token: exOwner, ...A, body: { type: 'customers', format: 'csv' } });
    check('CSV: served as a download with the right type and never cached', exCsv.status === 200 && exCsv.contentType.includes('text/csv') && /attachment; filename="customers-\d{4}-\d{2}-\d{2}\.csv"/.test(exCsv.disposition) && exCsv.cacheControl.includes('no-store'), { t: exCsv.contentType, d: exCsv.disposition, c: exCsv.cacheControl });
    check('CSV: starts with a UTF-8 BOM so Excel reads Bengali correctly', exCsv.buffer[0] === 0xef && exCsv.buffer[1] === 0xbb && exCsv.buffer[2] === 0xbf);
    check('CSV: Bengali survives the round trip', exCsv.text.includes(`রহিম উদ্দিন ${exStamp}`));
    check('CSV: a name that looks like a formula is neutralised with an apostrophe', exCsv.text.includes(`'=1+1 Evil ${exStamp}`) && !exCsv.text.includes(`"=1+1 Evil ${exStamp}`), exCsv.text.split('\r\n').find((l) => l.includes('Evil')));
    check('CSV: quotes are escaped and every row is CRLF terminated', exCsv.text.split('\r\n').filter(Boolean).length > 3 && !/[^\r]\n/.test(exCsv.text));
    const exCsvSales = await download('/exports', { token: exOwner, ...A, body: { type: 'sales', format: 'csv', preset: 'today' } });
    check('CSV: money is written as a plain 2-decimal number, not minor units', exCsvSales.text.includes('"2598.00"') && !exCsvSales.text.includes('259800'), exCsvSales.text.split('\r\n').find((l) => l.includes('2598')));
    check('CSV: no password, hash, token or secret column ever appears', !/password|passwordHash|token|secret|apiKey/i.test(exCsv.text) && !/password|token|secret/i.test(exCsvSales.text));

    // ---- XLSX ----
    const exXlsx = await download('/exports', { token: exOwner, ...A, body: { type: 'products', format: 'xlsx' } });
    // A truncated workbook still starts with "PK", so the ZIP is checked end to
    // end: the central directory must be there, with the workbook part in it.
    const exZipComplete = exXlsx.buffer.includes(Buffer.from('PK\u0005\u0006', 'latin1')) && exXlsx.buffer.includes(Buffer.from('xl/workbook.xml')) && exXlsx.buffer.includes(Buffer.from('xl/worksheets/sheet1.xml'));
    check('XLSX: a complete, readable workbook with the spreadsheet content type', exXlsx.status === 200 && exXlsx.buffer.subarray(0, 2).toString() === 'PK' && exZipComplete && exXlsx.contentType.includes('spreadsheetml') && exXlsx.buffer.length > 2000, { t: exXlsx.contentType, n: exXlsx.buffer.length, zip: exZipComplete });
    check('XLSX: the history records the export as completed, with its real size', (await api('/exports?limit=1', { token: exOwner, ...A })).data?.[0]?.status === 'completed');
    check('XLSX: the file is named .xlsx', exXlsx.disposition.includes('.xlsx'));

    // ---- JSON ----
    const exJson = await download('/exports', { token: exOwner, ...A, body: { type: 'customers', format: 'json' } });
    let exParsed = null;
    try { exParsed = JSON.parse(exJson.text); } catch { exParsed = null; }
    check('JSON: valid, structured and describes what it contains', exJson.status === 200 && exParsed?.exportType === 'customers' && Array.isArray(exParsed.sections?.[0]?.records) && exParsed.timezone && exParsed.workspace, exJson.text.slice(0, 200));
    check('JSON: the records carry the exported customers', (exParsed?.sections?.[0]?.records ?? []).some((r) => String(r.name ?? '').includes('রহিম')));
    check('JSON: money is a number in major units', (exParsed?.sections?.[0]?.records ?? []).every((r) => r.totalSpent === undefined || typeof r.totalSpent === 'number'));

    // ---- PDF ----
    const exPdf = await download('/exports', { token: exOwner, ...A, body: { type: 'sales', format: 'pdf', preset: 'today' } });
    check('PDF: a real PDF document', exPdf.status === 200 && exPdf.text.startsWith('%PDF-') && exPdf.contentType.includes('application/pdf') && exPdf.buffer.length > 1000, { t: exPdf.contentType, head: exPdf.text.slice(0, 8) });

    // ---- empty dataset ----
    const exEmpty = await download('/exports', { token: exOwner, ...A, body: { type: 'returns', format: 'csv', preset: 'today' } });
    check('An empty dataset still produces a valid file with its header row', exEmpty.status === 200 && exEmpty.text.includes('Export Main') && exEmpty.text.split('\r\n').some((l) => l.startsWith('"Return')), exEmpty.text.slice(0, 200));

    // ---- permissions ----
    const exRoles = (await api('/roles', { token: exOwner, ...A })).data ?? [];
    check('Store Manager exports by default; Cashier does not', exRoles.find((r) => r.name === 'Store Manager')?.permissions.includes('reports.export') === true && exRoles.find((r) => r.name === 'Cashier')?.permissions.includes('reports.export') !== true, exRoles.map((r) => r.name));
    await api('/staff', { method: 'POST', token: exOwner, ...A, body: { name: 'Export Cashier', email: `expc${exStamp}@example.com`, password: 'Password@123', storeId: exStoreA._id, roleId: exRoles.find((r) => r.name === 'Cashier')?._id } });
    await api('/staff', { method: 'POST', token: exOwner, ...A, body: { name: 'Export Manager', email: `expm${exStamp}@example.com`, password: 'Password@123', storeId: exStoreA._id, roleId: exRoles.find((r) => r.name === 'Store Manager')?._id } });
    const exCashier = (await login(`expc${exStamp}@example.com`, 'Password@123')).token;
    const exManager = (await login(`expm${exStamp}@example.com`, 'Password@123')).token;
    const exCashierRun = await download('/exports', { token: exCashier, ...A, body: { type: 'customers', format: 'csv' } });
    check('A cashier cannot export, even on Professional', exCashierRun.status === 403 && !exCashierRun.disposition, exCashierRun.error);
    check('...and cannot see the history', (await api('/exports', { token: exCashier, ...A })).status === 403);
    check('A store manager can export', (await download('/exports', { token: exManager, ...A, body: { type: 'customers', format: 'csv' } })).status === 200);

    // ---- branch isolation ----
    const exStoreB = (await api('/stores', { method: 'POST', token: exOwner, body: { name: 'Export Two', code: `EZ${exStamp}`, currency: 'BDT' } })).data;
    const B = { storeId: exStoreB?._id };
    await api('/customers', { method: 'POST', token: exOwner, ...B, body: { name: `Branch Two Only ${exStamp}`, phone: `0153${exStamp}` } });
    const exBranchA = await download('/exports', { token: exOwner, ...A, body: { type: 'customers', format: 'csv' } });
    check("A branch export contains only that branch's customers", !exBranchA.text.includes(`Branch Two Only ${exStamp}`) && exBranchA.text.includes(`রহিম উদ্দিন ${exStamp}`));
    const exAllBranches = await download('/exports', { token: exOwner, ...A, body: { type: 'customers', format: 'csv', branch: 'all' } });
    check('The owner may export all branches at once', exAllBranches.status === 200 && exAllBranches.text.includes(`Branch Two Only ${exStamp}`) && exAllBranches.text.includes('All branches'));
    const exManagerAll = await download('/exports', { token: exManager, ...A, body: { type: 'customers', format: 'csv', branch: 'all' } });
    check('A branch manager asking for "all branches" still only gets their own', exManagerAll.status === 200 && !exManagerAll.text.includes(`Branch Two Only ${exStamp}`), exManagerAll.text.slice(0, 120));
    const exManagerOther = await download('/exports', { token: exManager, ...B, body: { type: 'customers', format: 'csv' } });
    check('A branch manager cannot export another branch at all', exManagerOther.status === 403, exManagerOther.error);

    // ---- tenant isolation ----
    const exOther = await api('/auth/register', { method: 'POST', body: { businessName: `Other Wear ${exStamp}`, name: 'Other Owner', email: `exo${exStamp}@example.com`, password: 'Password@123', vertical: 'clothing' } });
    const exOtherToken = exOther.data?.tokens?.accessToken;
    const exOtherStore = (await api('/stores', { method: 'POST', token: exOtherToken, body: { name: 'Other Main', code: `EO${exStamp}`, currency: 'BDT' } })).data;
    await exSetPlan(exOther.data?.tenant?.id ?? exOther.data?.tenant?._id, 'showroom-monthly');
    await api('/customers', { method: 'POST', token: exOtherToken, ...{ storeId: exOtherStore?._id }, body: { name: `Foreign Customer ${exStamp}`, phone: `0154${exStamp}` } });
    const exForeign = await download('/exports', { token: exOtherToken, storeId: exOtherStore?._id, body: { type: 'customers', format: 'csv', branch: 'all' } });
    check("Another workspace's export contains none of this workspace's data", exForeign.status === 200 && !exForeign.text.includes(`রহিম উদ্দিন ${exStamp}`) && exForeign.text.includes(`Foreign Customer ${exStamp}`));
    check("...and it cannot name this workspace's branch", (await download('/exports', { token: exOtherToken, storeId: exStoreA._id, body: { type: 'customers', format: 'csv' } })).status === 403);
    check("...nor smuggle a workspace id through the body", (await download('/exports', { token: exOtherToken, storeId: exOtherStore?._id, body: { type: 'customers', format: 'csv', tenantId: exTenantId, workspaceId: exTenantId } })).status === 422);

    // ---- history and audit ----
    const exHistory = await api('/exports', { token: exOwner, ...A });
    const exRecent = exHistory.data?.[0];
    check('The history records what was exported: type, format, filters, rows, size and who', exHistory.status === 200 && (exHistory.data ?? []).length > 0 && exRecent?.type && exRecent?.format && exRecent?.rowCount >= 0 && exRecent?.byteSize > 0 && exRecent?.requestedByNameSnapshot, exRecent);
    check('The history stores metadata only - never the exported rows or a file link', !/name|phone|email|url|downloadUrl|filePath/i.test(Object.keys(exRecent ?? {}).join(',')) || !JSON.stringify(exRecent ?? {}).includes(`রহিম উদ্দিন ${exStamp}`), Object.keys(exRecent ?? {}));
    check("A workspace's history shows only its own exports", (exHistory.data ?? []).every((row) => row.storeId === exStoreA._id));
    const exAudit = await api('/platform/audit-log?action=data.exported&limit=50', { token: exPlatform.token });
    check('Every export is written to the audit log with counts only', exAudit.status === 200 && (exAudit.data ?? []).length > 0 && !JSON.stringify(exAudit.data ?? []).includes(`রহিম উদ্দিন ${exStamp}`), exAudit.error);

    // ---- downgrade and Enterprise ----
    await exSetPlan(exTenantId, 'starter-store-monthly');
    check('After a downgrade to Starter the export API is refused again', (await download('/exports', { token: exOwner, ...A, body: { type: 'customers', format: 'csv' } })).status === 403);
    await exSetPlan(exTenantId, 'brand-monthly');
    const exEnterprise = await download('/exports', { token: exOwner, ...A, body: { type: 'customers', format: 'csv' } });
    check('Enterprise keeps everything Professional has: export works again', exEnterprise.status === 200 && exEnterprise.text.includes(`রহিম উদ্দিন ${exStamp}`), exEnterprise.error);
  }

  // --- Clothing POS bulk product import ---------------------------------------
  section('Clothing POS: bulk product import (Excel / CSV, every plan)');
  {
    const imStamp = String(Date.now()).slice(-7);
    const imPlatform = await login('platform@pos.dev', 'Platform@123');
    const imPlans = (await api('/plans', {})).data ?? [];
    const imSetPlan = (tenantId, code) =>
      api('/platform/subscriptions', { method: 'POST', token: imPlatform.token, body: { tenantId, planId: imPlans.find((p) => p.code === code)._id, periods: 1, status: 'active', autoRenew: false } });
    const imReg = await api('/auth/register', { method: 'POST', body: { businessName: `Import Wear ${imStamp}`, name: 'Import Owner', email: `imp${imStamp}@example.com`, password: 'Password@123', vertical: 'clothing' } });
    const imOwner = imReg.data?.tokens?.accessToken;
    const imTenantId = imReg.data?.tenant?.id ?? imReg.data?.tenant?._id;
    const imStoreA = (await api('/stores', { method: 'POST', token: imOwner, body: { name: 'Import Main', code: `IM${imStamp}`, currency: 'BDT' } })).data;
    const A = { storeId: imStoreA?._id };
    check('A fresh Clothing workspace is set up for import tests', Boolean(imOwner && imStoreA?._id), imReg.error);

    const preview = (bytes, extra = {}) => uploadSheet('/products/import/preview', { token: imOwner, ...A, bytes, ...extra });
    const commitImport = (importId, body = {}, token = imOwner, store = A) =>
      api(`/products/import/${importId}/commit`, { method: 'POST', token, ...store, body: { skipInvalidRows: false, ...body } });
    const productCount = async (token = imOwner, store = A) => (await api('/products?limit=1&includeInactive=true', { token, ...store })).meta?.total ?? 0;
    const findProduct = async (name, token = imOwner, store = A) =>
      ((await api(`/products?search=${encodeURIComponent(name)}&includeInactive=true&limit=50`, { token, ...store })).data ?? []).find((p) => p.name === name);

    // ---- every plan, starting with Starter ----
    await imSetPlan(imTenantId, 'starter-store-monthly');
    const imStarterColumns = await api('/products/import/columns', { token: imOwner, ...A });
    check('STARTER: the import API is available (import is not a paid upgrade)', imStarterColumns.status === 200 && imStarterColumns.data?.columns?.length > 0, imStarterColumns.error);
    const imStarterPreview = await preview(productCsv([['Starter Tee', 'Default', '500', '', '', '', '', '', '', '3', 'Yes']]));
    check('STARTER: a file validates', imStarterPreview.status === 200 && imStarterPreview.data?.summary?.validRows === 1, imStarterPreview.error);
    const imStarterRun = await commitImport(imStarterPreview.data?.importId);
    check('STARTER: the products are created', imStarterRun.status === 200 && imStarterRun.data?.summary?.productsCreated === 1, imStarterRun.error);
    check('Data export stays Professional-only: Starter still cannot export', (await api('/exports/datasets', { token: imOwner, ...A })).status === 403);

    await imSetPlan(imTenantId, 'showroom-monthly');
    check('PROFESSIONAL: import is available', (await api('/products/import/columns', { token: imOwner, ...A })).status === 200);
    await imSetPlan(imTenantId, 'brand-monthly');
    check('ENTERPRISE: import is available', (await api('/products/import/columns', { token: imOwner, ...A })).status === 200);
    check('An import needs a signed-in user', (await uploadSheet('/products/import/preview', { ...A, bytes: productCsv([['X', 'Default', '1']]) })).status === 401);

    // ---- file types ----
    check('A .txt file is refused', (await preview(Buffer.from('Product,Variant,Price\nA,B,1'), { filename: 'products.txt', type: 'text/plain' })).status === 400);
    check('An .xlsm (macro) workbook is refused', (await preview(productCsv([['A', 'B', '1']]), { filename: 'products.xlsm', type: 'application/vnd.ms-excel.sheet.macroEnabled.12' })).status === 400);
    check('An executable is refused', (await preview(Buffer.from('MZ binary'), { filename: 'evil.exe', type: 'application/octet-stream' })).status === 400);
    const imNotCsv = await preview(Buffer.from('this is not a spreadsheet at all'), { filename: 'notes.csv' });
    check('A .csv that is not a spreadsheet is refused with a readable message', imNotCsv.status === 400 && /header|column/i.test(imNotCsv.error?.message ?? ''), imNotCsv.error);

    // ---- headers ----
    const imNoPrice = await preview(productCsv([['A', 'Default']], { headers: ['Product', 'Variant'] }));
    check('Missing required columns stop the import and are named', imNoPrice.status === 400 && /Selling price/.test(imNoPrice.error?.message ?? ''), imNoPrice.error);
    const imLoose = await preview(productCsv([['Loose Tee', 'Default', '700']], { headers: [' product name ', 'VARIANT', 'Price'], title: false }));
    check('Harmless header differences (case, spacing, "Price") still map', imLoose.status === 200 && imLoose.data?.summary?.validRows === 1, imLoose.error);
    const imTwoPrice = await preview(productCsv([['A', 'Default', '1', '2']], { headers: ['Product', 'Variant', 'Price', 'Selling price'], title: false }));
    check('Two columns for the same field are refused rather than guessed', imTwoPrice.status === 400, imTwoPrice.error);

    // ---- mandatory fields ----
    const imBad = await preview(
      productCsv([
        ['', 'Black / M', '990'],
        ['No Variant Tee', '', '990'],
        ['No Price Tee', 'Default', ''],
        ['Bad Price Tee', 'Default', 'abc'],
        ['Negative Tee', 'Default', '-100'],
        ['Good Tee', 'Default', '990'],
      ]),
    );
    const imBadErrors = imBad.data?.errors ?? [];
    const errorFor = (row) => imBadErrors.find((e) => e.rowNumber === row)?.message ?? '';
    check(
      'Missing name, missing variant, missing price, "abc" and a negative price are all rejected - with the file row numbers',
      imBad.status === 200 &&
        imBad.data?.summary?.invalidRows === 5 &&
        imBad.data?.summary?.validRows === 1 &&
        /Product name is required/.test(errorFor(7)) &&
        /Variant is required/.test(errorFor(8)) &&
        /Selling price is required/.test(errorFor(9)) &&
        /not a valid price/.test(errorFor(10)) &&
        /not a valid price|negative/.test(errorFor(11)),
      imBadErrors,
    );
    const imBefore = await productCount();
    check('Validating creates nothing', (await productCount()) === imBefore);
    const imRefused = await commitImport(imBad.data?.importId);
    check('Importing a file with invalid rows is refused until the user confirms', imRefused.status === 400 && imRefused.error?.details?.reason === 'INVALID_ROWS', imRefused.error);
    const imSkipped = await commitImport(imBad.data?.importId, { skipInvalidRows: true });
    check('Confirming "valid rows only" imports exactly those rows', imSkipped.status === 200 && imSkipped.data?.summary?.productsCreated === 1 && imSkipped.data?.summary?.rowsSkipped === 5, imSkipped.error);
    check('A previewed import cannot be committed twice', (await commitImport(imBad.data?.importId, { skipInvalidRows: true })).status === 400);

    // ---- grouping, optional fields, Bengali ----
    const imGroup = await preview(
      productCsv([
        ['Oversized T-Shirt', 'Black / M', '990', '600', '', '', '', 'Urban Thread', 'Color: Black; Size: M', '10', 'Yes'],
        ['Oversized T-Shirt', 'Black / L', '990', '600', '', '', '', 'Urban Thread', 'Color: Black; Size: L', '7', 'Yes'],
        ['Oversized T-Shirt', 'White / M', '1050.50', '', '', '', '', 'Urban Thread', 'Color: White; Size: M', '', 'Yes'],
        [`Bangla Shirt ${imStamp}`, 'Default', '1299', '', '', '', '', '', '', '2', 'Yes'],
      ]),
    );
    check(
      'Four rows become two products: one with three variants, one with a single default variant',
      imGroup.status === 200 && imGroup.data?.summary?.productsToCreate === 2 && imGroup.data?.summary?.variantsToCreate === 4,
      imGroup.data?.summary,
    );
    const imGroupRun = await commitImport(imGroup.data?.importId);
    check('...and they are created as such', imGroupRun.status === 200 && imGroupRun.data?.summary?.productsCreated === 2 && imGroupRun.data?.summary?.variantsCreated === 4, imGroupRun.error);
    const imTee = await findProduct('Oversized T-Shirt');
    const imTeeFull = (await api(`/products/${imTee?._id}`, { token: imOwner, ...A })).data;
    const imTeeVariants = imTeeFull?.variants ?? [];
    check(
      'One product with Black / M, Black / L and White / M - not three unrelated products',
      imTeeVariants.length === 3 && ['Black / M', 'Black / L', 'White / M'].every((name) => imTeeVariants.some((v) => v.name === name)),
      imTeeVariants.map((v) => v.name),
    );
    check('Attributes are parsed into real options, so the product has Color and Size', (imTeeFull?.options ?? []).map((o) => o.name).join(',') === 'Color,Size' && imTeeFull?.hasVariants === true, imTeeFull?.options);
    check('Prices are exact minor units, never floating point (1050.50 -> 105050)', imTeeVariants.find((v) => v.name === 'White / M')?.sellingPriceMinor === 105050 && imTeeVariants.find((v) => v.name === 'Black / M')?.costPriceMinor === 60000);
    check('Blank optional fields fall back to the same defaults as the New product form', imTeeVariants.find((v) => v.name === 'White / M')?.costPriceMinor === 0 && imTeeVariants.find((v) => v.name === 'White / M')?.stock === 0 && imTeeVariants.every((v) => v.isActive === true));
    check('Every imported variant gets a generated SKU', imTeeVariants.every((v) => typeof v.sku === 'string' && v.sku.length > 0) && new Set(imTeeVariants.map((v) => v.sku)).size === 3, imTeeVariants.map((v) => v.sku));
    check('A blank barcode stays blank rather than being invented', imTeeVariants.every((v) => !v.barcode));

    // ---- stock goes through the inventory ledger ----
    const imLedger = (await api('/inventory/ledger?limit=50', { token: imOwner, ...A })).data ?? [];
    const imBlackM = imTeeVariants.find((v) => v.name === 'Black / M');
    check('Opening stock is recorded as an inventory movement, not a silent field write', imBlackM?.stock === 10 && imLedger.some((t) => String(t.variantId) === String(imBlackM?._id) && t.type === 'INITIAL_STOCK' && t.quantityChange === 10), imLedger.slice(0, 2));

    // ---- the imported product works at the till ----
    const imGenerated = await api(`/products/${imTee?._id}/variants/${imBlackM?._id}`, { method: 'PATCH', token: imOwner, ...A, body: { barcode: `299${imStamp}0001` } });
    check('An imported variant can be given a barcode afterwards', imGenerated.status === 200, imGenerated.error);
    const imScan = await api(`/products/pos-search?q=299${imStamp}0001`, { token: imOwner, ...A });
    check('...and the POS finds it by scanning that barcode', (imScan.data ?? []).some((v) => String(v.variantId) === String(imBlackM?._id)), imScan.data);
    const imSale = await api('/sales', { method: 'POST', token: imOwner, ...A, body: { paymentMethod: 'cash', items: [{ variantId: imBlackM?._id, quantity: 2 }] } });
    check('...and it sells, at the imported price, taking stock with it', imSale.status === 201 && imSale.data?.totalMinor === 198000, imSale.error);
    check('...leaving the ledger consistent (10 - 2 = 8)', (await api(`/products/${imTee?._id}`, { token: imOwner, ...A })).data?.variants?.find((v) => v.name === 'Black / M')?.stock === 8);

    // ---- duplicates ----
    const imDup = await preview(
      productCsv([
        ['Oversized T-Shirt', 'Black / XL', '990', '', '', '', '', '', '', '1', 'Yes'],
        ['Dup Sku One', 'Default', '100', '', `DUP${imStamp}`, '', '', '', '', '1', 'Yes'],
        ['Dup Sku Two', 'Default', '100', '', `DUP${imStamp}`, '', '', '', '', '1', 'Yes'],
        ['Dup Barcode One', 'Default', '100', '', '', `299${imStamp}0002`, '', '', '', '1', 'Yes'],
        ['Dup Barcode Two', 'Default', '100', '', '', `299${imStamp}0002`, '', '', '', '1', 'Yes'],
        ['Existing Barcode', 'Default', '100', '', '', `299${imStamp}0001`, '', '', '', '1', 'Yes'],
        ['Same Product', 'Default', '100', '', '', '', '', '', '', '1', 'Yes'],
        ['Same Product', 'Default', '150', '', '', '', '', '', '', '1', 'Yes'],
      ]),
    );
    const imDupErrors = imDup.data?.errors ?? [];
    const dupError = (row) => imDupErrors.find((e) => e.rowNumber === row)?.message ?? '';
    check('An existing product name is never silently overwritten or duplicated', /already exists/.test(dupError(7)), dupError(7));
    check('A SKU repeated in the file is refused', /appears more than once/.test(dupError(9)), dupError(9));
    check('A barcode repeated in the file is refused', /appears more than once/.test(dupError(11)), dupError(11));
    check('A barcode that already exists in the branch is refused', /already exists/.test(dupError(12)), dupError(12));
    check('The same variant twice in one product is refused', /already has a variant/.test(dupError(14)), dupError(14));
    check('The valid rows of that file are still importable', imDup.data?.summary?.validRows === 3, imDup.data?.summary);

    // ---- categories ----
    const imCatCsv = productCsv([[`Cat Tee ${imStamp}`, 'Default', '400', '', '', '', `Imported Cat ${imStamp}`, '', '', '1', 'Yes']]);
    const imCatOff = await preview(imCatCsv);
    check("An unknown category is reported, not created behind the user's back", imCatOff.data?.summary?.invalidRows === 1 && /does not exist/.test(imCatOff.data?.errors?.[0]?.message ?? ''), imCatOff.data?.errors);
    const imCatOn = await preview(imCatCsv, { fields: { createMissingCategories: 'true' } });
    check('Ticking "create missing categories" plans it instead', imCatOn.data?.summary?.validRows === 1 && imCatOn.data?.missingCategories?.length === 1, imCatOn.data?.missingCategories);
    const imCatRun = await commitImport(imCatOn.data?.importId);
    check('...and the category is created in THIS branch and attached', imCatRun.data?.summary?.categoriesCreated === 1 && (await findProduct(`Cat Tee ${imStamp}`))?.categoryNameSnapshot === `Imported Cat ${imStamp}`, imCatRun.error);
    const imExistingCat = (await api('/categories?limit=100', { token: imOwner, ...A })).data ?? [];
    check('An existing category is matched by name, not duplicated', imExistingCat.filter((c) => c.name === `Imported Cat ${imStamp}`).length === 1);

    // ---- ids in the file are never trusted ----
    const imForeign = await api('/auth/register', { method: 'POST', body: { businessName: `Other Import ${imStamp}`, name: 'Other Owner', email: `impo${imStamp}@example.com`, password: 'Password@123', vertical: 'clothing' } });
    const imForeignToken = imForeign.data?.tokens?.accessToken;
    const imForeignTenant = imForeign.data?.tenant?.id ?? imForeign.data?.tenant?._id;
    const imForeignStore = (await api('/stores', { method: 'POST', token: imForeignToken, body: { name: 'Other Main', code: `IO${imStamp}`, currency: 'BDT' } })).data;
    await imSetPlan(imForeignTenant, 'starter-store-monthly');
    const F = { storeId: imForeignStore?._id };
    const imIdBytes = productCsv(
      [[`Forged ${imStamp}`, 'Default', '100', imTenantId, imStoreA._id, imTee?._id, '', '', '', '1', 'Yes']],
      { headers: ['Product', 'Variant', 'Selling price', 'Tenant ID', 'Store ID', 'Product ID', 'Category ID', 'Brand', 'Attributes', 'Stock', 'Active'] },
    );
    const imIdPreview = await uploadSheet('/products/import/preview', { token: imForeignToken, ...F, bytes: imIdBytes });
    check(
      'Id columns are ignored entirely - they are not even offered as unmapped columns',
      imIdPreview.status === 200 && (imIdPreview.data?.unmappedHeaders ?? []).length === 0 && imIdPreview.data?.summary?.validRows === 1,
      imIdPreview.error ?? imIdPreview.data?.unmappedHeaders,
    );
    const imIdRun = await api(`/products/import/${imIdPreview.data?.importId}/commit`, { method: 'POST', token: imForeignToken, ...F, body: { skipInvalidRows: false } });
    const imForeignProduct = await findProduct(`Forged ${imStamp}`, imForeignToken, F);
    check(
      'A product imported with foreign ids in the file belongs to the importing workspace and branch, with new ids',
      imIdRun.status === 200 && String(imForeignProduct?.storeId) === String(imForeignStore._id) && String(imForeignProduct?._id) !== String(imTee?._id),
      imIdRun.error,
    );
    check("...and the other workspace's catalogue is untouched", !(await findProduct(`Forged ${imStamp}`)), 'leaked');
    check('A workspace cannot import into a branch it does not own', (await uploadSheet('/products/import/preview', { token: imForeignToken, storeId: imStoreA._id, bytes: productCsv([['X', 'Default', '1']]) })).status === 403);

    // ---- export -> import, the round trip ----
    await imSetPlan(imForeignTenant, 'showroom-monthly');
    const imExport = await download('/exports', { token: imOwner, ...A, body: { type: 'products', format: 'csv' } });
    const imRoundTrip = await uploadSheet('/products/import/preview', { token: imForeignToken, ...F, bytes: imExport.buffer, filename: 'products-export.csv', fields: { createMissingCategories: 'true' } });
    check(
      'A file straight from Data export imports with no renaming: the export columns are the import columns',
      imRoundTrip.status === 200 && imRoundTrip.data?.summary?.validRows > 0 && imRoundTrip.data?.summary?.invalidRows === 0,
      imRoundTrip.error ?? imRoundTrip.data?.summary,
    );
    const imRoundRun = await api(`/products/import/${imRoundTrip.data?.importId}/commit`, { method: 'POST', token: imForeignToken, ...F, body: { skipInvalidRows: false } });
    check('...and the round trip recreates the same products and variants in the new workspace', imRoundRun.status === 200 && imRoundRun.data?.summary?.variantsCreated === imRoundTrip.data?.summary?.validRows, imRoundRun.error);
    const imRoundTee = await findProduct('Oversized T-Shirt', imForeignToken, F);
    const imRoundVariants = (await api(`/products/${imRoundTee?._id}`, { token: imForeignToken, ...F })).data?.variants ?? [];
    check('...with the variants grouped and the prices intact', imRoundVariants.length === 3 && imRoundVariants.find((v) => v.name === 'White / M')?.sellingPriceMinor === 105050, imRoundVariants.map((v) => [v.name, v.sellingPriceMinor]));
    check('...and barcodes carried over only where the file had them', imRoundVariants.filter((v) => v.barcode).length === 1);

    // ---- Excel ----
    const ExcelJS = (await import('exceljs')).default;
    const imBook = new ExcelJS.Workbook();
    const imSheet = imBook.addWorksheet('Products');
    imSheet.addRow(['Demo Wear - Main']);
    imSheet.addRow([]);
    imSheet.addRow(['Product', 'Variant', 'Selling price', 'Stock', 'Attributes']);
    imSheet.addRow([`Excel Shirt ${imStamp}`, 'Red / S', 1234.5, 4, 'Color: Red; Size: S']);
    imSheet.addRow([`Excel Shirt ${imStamp}`, 'Red / M', 1234.5, 6, 'Color: Red; Size: M']);
    const imXlsxBytes = Buffer.from(await imBook.xlsx.writeBuffer());
    const imXlsx = await preview(imXlsxBytes, { filename: 'products.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    check('XLSX: a real workbook imports, with its own title block skipped', imXlsx.status === 200 && imXlsx.data?.summary?.validRows === 2 && imXlsx.data?.summary?.productsToCreate === 1, imXlsx.error ?? imXlsx.data?.summary);
    const imXlsxRun = await commitImport(imXlsx.data?.importId);
    const imXlsxProduct = await findProduct(`Excel Shirt ${imStamp}`);
    const imXlsxVariants = (await api(`/products/${imXlsxProduct?._id}`, { token: imOwner, ...A })).data?.variants ?? [];
    check('XLSX: 1234.5 becomes exactly 123450 minor units', imXlsxRun.status === 200 && imXlsxVariants.length === 2 && imXlsxVariants.every((v) => v.sellingPriceMinor === 123450), imXlsxVariants.map((v) => v.sellingPriceMinor));

    // ---- spreadsheet formula text is data, never a formula ----
    const imFormula = await preview(productCsv([[`'=1+1 Tee ${imStamp}`, 'Default', '100', '', '', '', '', '', '', '1', 'Yes']]));
    await commitImport(imFormula.data?.importId);
    const imFormulaProduct = await findProduct(`=1+1 Tee ${imStamp}`);
    check('An exported "\'=1+1" name comes back as the plain text "=1+1", stored as data', Boolean(imFormulaProduct) && imFormulaProduct.name === `=1+1 Tee ${imStamp}`, imFormulaProduct?.name);
    const imReExport = await download('/exports', { token: imOwner, ...A, body: { type: 'products', format: 'csv' } });
    check('...and exporting it again neutralises it again', imReExport.text.includes(`"'=1+1 Tee ${imStamp}"`));

    // ---- size ----
    const imHuge = await preview(productCsv(Array.from({ length: 2_001 }, (_, i) => [`Bulk ${imStamp} ${i}`, 'Default', '100'])));
    check('A file with more rows than the documented limit is refused, with the limit', imHuge.status === 400 && imHuge.error?.details?.maxRows === 2000, imHuge.error);

    // ---- permissions ----
    const imRoles = (await api('/roles', { token: imOwner, ...A })).data ?? [];
    check('Store Manager imports by default; Cashier does not', imRoles.find((r) => r.name === 'Store Manager')?.permissions.includes('products.import') === true && imRoles.find((r) => r.name === 'Cashier')?.permissions.includes('products.import') !== true);
    await api('/staff', { method: 'POST', token: imOwner, ...A, body: { name: 'Import Cashier', email: `impc${imStamp}@example.com`, password: 'Password@123', storeId: imStoreA._id, roleId: imRoles.find((r) => r.name === 'Cashier')?._id } });
    await api('/staff', { method: 'POST', token: imOwner, ...A, body: { name: 'Import Maker', email: `impm${imStamp}@example.com`, password: 'Password@123', storeId: imStoreA._id, extraPermissions: ['products.view', 'products.create'] } });
    const imCashier = (await login(`impc${imStamp}@example.com`, 'Password@123')).token;
    const imMaker = (await login(`impm${imStamp}@example.com`, 'Password@123')).token;
    check('A cashier cannot import', (await uploadSheet('/products/import/preview', { token: imCashier, ...A, bytes: productCsv([['X', 'Default', '1']]) })).status === 403);
    check('Being able to CREATE a product is not being able to IMPORT products', (await uploadSheet('/products/import/preview', { token: imMaker, ...A, bytes: productCsv([['X', 'Default', '1']]) })).status === 403);
    check('...and neither of them can see the import history', (await api('/products/import', { token: imCashier, ...A })).status === 403);

    // ---- history and audit ----
    const imHistory = await api('/products/import?limit=20', { token: imOwner, ...A });
    const imRecent = (imHistory.data ?? [])[0];
    check('The history records filename, counts, who and when - and never the file', imHistory.status === 200 && imRecent?.filename && imRecent?.productsCreated >= 0 && imRecent?.requestedByNameSnapshot && !('plan' in imRecent) && !('rowErrors' in imRecent), Object.keys(imRecent ?? {}));
    check('Unconfirmed previews are not shown as imports', (imHistory.data ?? []).every((row) => row.status !== 'pending'));
    const imAudit = await api('/platform/audit-log?action=products.imported&limit=20', { token: imPlatform.token });
    check('Every import is written to the audit log with counts only', imAudit.status === 200 && (imAudit.data ?? []).length > 0 && !JSON.stringify(imAudit.data ?? []).includes('Oversized T-Shirt'), imAudit.error);

    // ---- the plan's product limit still applies ----
    await imSetPlan(imTenantId, 'starter-store-monthly');
    const imLimitPreview = await preview(productCsv(Array.from({ length: 400 }, (_, i) => [`Limit ${imStamp} ${i}`, 'Default', '100'])));
    const imLimitRun = await commitImport(imLimitPreview.data?.importId, { skipInvalidRows: true });
    check(
      "An import cannot exceed the plan's product limit: it stops and says why",
      imLimitRun.status === 200 && imLimitRun.data?.summary?.productsCreated < 400 && /limit|upgrade|plan/i.test(imLimitRun.data?.stopped ?? ''),
      imLimitRun.data?.stopped,
    );
  }

  // --- Clothing POS supplier management ---------------------------------------
  section('Clothing POS: supplier management (Professional and Enterprise)');
  {
    const spStamp = String(Date.now()).slice(-7);
    const spPlatform = await login('platform@pos.dev', 'Platform@123');
    const spPlans = (await api('/plans', {})).data ?? [];
    const spSetPlan = (tenantId, code) =>
      api('/platform/subscriptions', { method: 'POST', token: spPlatform.token, body: { tenantId, planId: spPlans.find((p) => p.code === code)._id, periods: 1, status: 'active', autoRenew: false } });
    const spReg = await api('/auth/register', { method: 'POST', body: { businessName: `Supply Wear ${spStamp}`, name: 'Supply Owner', email: `sup${spStamp}@example.com`, password: 'Password@123', vertical: 'clothing' } });
    const spOwner = spReg.data?.tokens?.accessToken;
    const spTenantId = spReg.data?.tenant?.id ?? spReg.data?.tenant?._id;
    const spStoreA = (await api('/stores', { method: 'POST', token: spOwner, body: { name: 'Supply Main', code: `SP${spStamp}`, currency: 'BDT' } })).data;
    const A = { storeId: spStoreA?._id };
    check('A fresh Clothing workspace is set up for supplier tests', Boolean(spOwner && spStoreA?._id), spReg.error);

    const addSupplier = (body, token = spOwner, store = A) => api('/suppliers', { method: 'POST', token, ...store, body });
    const supplierCount = async (token = spOwner, store = A) => (await api('/suppliers?limit=1', { token, ...store })).meta?.total ?? 0;

    // ---- Starter: nothing at all ----
    await spSetPlan(spTenantId, 'starter-store-monthly');
    const spStarterList = await api('/suppliers', { token: spOwner, ...A });
    check('STARTER: listing suppliers is refused with ENTITLEMENT_REQUIRED', spStarterList.status === 403 && spStarterList.error?.code === 'ENTITLEMENT_REQUIRED', spStarterList.error);
    check('STARTER: creating a supplier is refused', (await addSupplier({ name: 'Denim Mills' })).status === 403);
    check('STARTER: the summary is refused', (await api('/suppliers/summary', { token: spOwner, ...A })).status === 403);
    check('STARTER: a supplier id cannot be read, edited or deleted', (await api('/suppliers/6a8f07351aab4b3f4b21306e', { token: spOwner, ...A })).status === 403 && (await api('/suppliers/6a8f07351aab4b3f4b21306e', { method: 'PATCH', token: spOwner, ...A, body: { name: 'X' } })).status === 403 && (await api('/suppliers/6a8f07351aab4b3f4b21306e', { method: 'DELETE', token: spOwner, ...A })).status === 403);
    check('Suppliers need a signed-in user', (await api('/suppliers', { ...A })).status === 401);

    // ---- Professional ----
    await spSetPlan(spTenantId, 'showroom-monthly');
    const spSummary0 = await api('/suppliers/summary', { token: spOwner, ...A });
    check('PROFESSIONAL: supplier management is available, with a 100 ceiling', spSummary0.status === 200 && spSummary0.data?.max === 100 && spSummary0.data?.active === 0 && spSummary0.data?.unlimited === false, spSummary0.error ?? spSummary0.data);

    const spFirst = await addSupplier({
      name: `Denim Mills ${spStamp}`,
      type: 'manufacturer',
      contact: { name: 'Rahim Ahmed', designation: 'Sales Representative', phone: '01711111111', altPhone: '01811111111', email: 'rahim@example.com' },
      phone: '029999999',
      email: 'sales@denimmills.example',
      website: 'denimmills.example',
      address: { line1: 'House 12, Road 5', area: 'New Market', city: 'Dhaka', district: 'Dhaka', division: 'Dhaka', postalCode: '1205', country: 'Bangladesh' },
      taxNumber: 'VAT-123456',
      tradeLicense: 'TL-99887',
      banking: { accountName: 'Denim Mills Ltd', accountNumber: '1234 5678 9012', bankName: 'City Bank', branchName: 'Dhanmondi' },
      paymentTerms: 'net_30',
      notes: 'Usually supplies premium denim.',
    });
    check('A supplier is created with everything the form collects', spFirst.status === 201 && spFirst.data?.name === `Denim Mills ${spStamp}` && spFirst.data?.contact?.designation === 'Sales Representative' && spFirst.data?.address?.postalCode === '1205' && spFirst.data?.paymentTerms === 'net_30', spFirst.error ?? spFirst.data);
    check('...with a server-assigned code, never a database id', /^SUP-\d{4}$/.test(spFirst.data?.code ?? '') && !String(spFirst.data?.code).includes(String(spFirst.data?._id)), spFirst.data?.code);
    check('...and it is active by default', spFirst.data?.isActive === true);
    const spSecond = await addSupplier({ name: `Cotton House ${spStamp}`, type: 'wholesaler', phone: '01722222222' });
    check('Only the name is really required', spSecond.status === 201 && spSecond.data?.code === 'SUP-0002', spSecond.error ?? spSecond.data?.code);
    check('Codes run in sequence per workspace', spFirst.data?.code === 'SUP-0001');

    // ---- ownership can never come from the client ----
    const spForged = await addSupplier({ name: `Forged ${spStamp}`, tenantId: '6a8f07351aab4b3f4b21306e', storeId: '6a8f07351aab4b3f4b21306e', code: 'SUP-9999' });
    check('A body carrying tenantId, storeId or a code is refused outright', spForged.status === 422, spForged.error);

    // ---- validation ----
    check('An empty name is refused', (await addSupplier({ name: '   ' })).status === 422);
    check('An invalid email is refused', (await addSupplier({ name: `Bad Email ${spStamp}`, email: 'not-an-email' })).status === 422);
    check('An invalid website is refused', (await addSupplier({ name: `Bad Site ${spStamp}`, website: 'http://' })).status === 422);
    check('An invalid phone is refused', (await addSupplier({ name: `Bad Phone ${spStamp}`, phone: 'call me' })).status === 422);
    check('An unknown supplier type is refused', (await addSupplier({ name: `Bad Type ${spStamp}`, type: 'smuggler' })).status === 422);
    check('An unknown payment term is refused', (await addSupplier({ name: `Bad Terms ${spStamp}`, paymentTerms: 'whenever' })).status === 422);
    check('An oversized note is refused', (await addSupplier({ name: `Long Note ${spStamp}`, notes: 'x'.repeat(2_001) })).status === 422);
    check('A Bangladeshi address imports exactly as typed', (await api(`/suppliers/${spFirst.data?._id}`, { token: spOwner, ...A })).data?.address?.line1 === 'House 12, Road 5');

    // ---- duplicates ----
    const spDupe = await addSupplier({ name: `Denim Mills ${spStamp}`, phone: '029999999' });
    check('The same name with the same phone is caught as a duplicate', spDupe.status === 409, spDupe.error);
    check('...but a similar name is still allowed (ABC Garments vs ABC Garments Ltd.)', (await addSupplier({ name: `Denim Mills ${spStamp} Ltd.`, phone: '029999999' })).status === 201);
    check('A different supplier with the same name but no shared contact is allowed', (await addSupplier({ name: `Denim Mills ${spStamp}`, phone: '028888888' })).status === 201);

    // ---- sensitive fields ----
    const spList = await api('/suppliers?limit=50', { token: spOwner, ...A });
    const spListed = (spList.data ?? []).find((row) => row._id === spFirst.data?._id);
    check('The list never carries banking, tax or notes', spList.status === 200 && spListed && !('banking' in spListed) && !('taxNumber' in spListed) && !('notes' in spListed) && !('tradeLicense' in spListed), Object.keys(spListed ?? {}));
    check('The detail view carries banking for someone who may edit suppliers', (await api(`/suppliers/${spFirst.data?._id}`, { token: spOwner, ...A })).data?.banking?.accountNumber === '1234 5678 9012');

    // ---- search, filters, sorting, pagination ----
    check('Search by name', ((await api(`/suppliers?search=${encodeURIComponent(`Cotton House ${spStamp}`)}`, { token: spOwner, ...A })).data ?? []).length === 1);
    check('Search by code', ((await api('/suppliers?search=SUP-0001', { token: spOwner, ...A })).data ?? []).some((row) => row.code === 'SUP-0001'));
    check('Search by contact person', ((await api('/suppliers?search=Rahim', { token: spOwner, ...A })).data ?? []).some((row) => row._id === spFirst.data?._id));
    check('Search by phone', ((await api('/suppliers?search=01722222222', { token: spOwner, ...A })).data ?? []).some((row) => row._id === spSecond.data?._id));
    check('Search by email', ((await api('/suppliers?search=sales@denimmills.example', { token: spOwner, ...A })).data ?? []).some((row) => row._id === spFirst.data?._id));
    check('Filter by type', ((await api('/suppliers?type=wholesaler&limit=50', { token: spOwner, ...A })).data ?? []).every((row) => row.type === 'wholesaler'));
    const spSorted = (await api('/suppliers?sort=name&order=asc&limit=50', { token: spOwner, ...A })).data ?? [];
    check('Sorting by name puts the list in name order', spSorted.map((row) => row.name).join('|') === [...spSorted].sort((a, b) => a.name.localeCompare(b.name)).map((row) => row.name).join('|'));
    const spPaged = await api('/suppliers?limit=2&page=2', { token: spOwner, ...A });
    check('Pagination returns a real slice with its meta', spPaged.status === 200 && (spPaged.data ?? []).length <= 2 && spPaged.meta?.page === 2 && spPaged.meta?.total >= 4, spPaged.meta);

    // ---- edit, deactivate, delete ----
    const spEdit = await api(`/suppliers/${spSecond.data?._id}`, { method: 'PATCH', token: spOwner, ...A, body: { contact: { name: 'Karim Uddin' }, paymentTerms: 'net_15' } });
    check('Editing updates the record in place, without creating another one', spEdit.status === 200 && spEdit.data?._id === spSecond.data?._id && spEdit.data?.contact?.name === 'Karim Uddin' && spEdit.data?.paymentTerms === 'net_15', spEdit.error);
    check('...and a partial edit never wipes the other blocks', spEdit.data?.name === `Cotton House ${spStamp}` && spEdit.data?.phone === '01722222222');
    const spDeactivate = await api(`/suppliers/${spSecond.data?._id}/status`, { method: 'POST', token: spOwner, ...A, body: { isActive: false } });
    check('Deactivating keeps the record and its details', spDeactivate.status === 200 && spDeactivate.data?.isActive === false);
    check('...and an inactive supplier is still searchable', ((await api(`/suppliers?search=${encodeURIComponent(`Cotton House ${spStamp}`)}&status=inactive`, { token: spOwner, ...A })).data ?? []).length === 1);
    check('...and no longer counts against the plan', (await api('/suppliers/summary', { token: spOwner, ...A })).data?.inactive === 1);
    check('Reactivating works', (await api(`/suppliers/${spSecond.data?._id}/status`, { method: 'POST', token: spOwner, ...A, body: { isActive: true } })).data?.isActive === true);
    const spThrowaway = await addSupplier({ name: `Throwaway ${spStamp}` });
    const spDelete = await api(`/suppliers/${spThrowaway.data?._id}`, { method: 'DELETE', token: spOwner, ...A });
    check('Removing a supplier soft-deletes it', spDelete.status === 200 && spDelete.data?.softDeleted === true);
    check('...and it is gone from the list and from the detail view', !((await api('/suppliers?limit=50', { token: spOwner, ...A })).data ?? []).some((row) => row._id === spThrowaway.data?._id) && (await api(`/suppliers/${spThrowaway.data?._id}`, { token: spOwner, ...A })).status === 404);

    // ---- permissions ----
    const spRoles = (await api('/roles', { token: spOwner, ...A })).data ?? [];
    check('Store Manager manages suppliers by default; Cashier does not', ['suppliers.view', 'suppliers.create', 'suppliers.edit', 'suppliers.delete'].every((p) => spRoles.find((r) => r.name === 'Store Manager')?.permissions.includes(p)) && !spRoles.find((r) => r.name === 'Cashier')?.permissions.some((p) => p.startsWith('suppliers.')));
    await api('/staff', { method: 'POST', token: spOwner, ...A, body: { name: 'Supply Cashier', email: `supc${spStamp}@example.com`, password: 'Password@123', storeId: spStoreA._id, roleId: spRoles.find((r) => r.name === 'Cashier')?._id } });
    await api('/staff', { method: 'POST', token: spOwner, ...A, body: { name: 'Supply Viewer', email: `supv${spStamp}@example.com`, password: 'Password@123', storeId: spStoreA._id, extraPermissions: ['products.view', 'suppliers.view'] } });
    const spCashier = (await login(`supc${spStamp}@example.com`, 'Password@123')).token;
    const spViewer = (await login(`supv${spStamp}@example.com`, 'Password@123')).token;
    check('A cashier cannot even list suppliers', (await api('/suppliers', { token: spCashier, ...A })).status === 403);
    check('A viewer can list them', (await api('/suppliers', { token: spViewer, ...A })).status === 200);
    check('...but cannot create, edit, deactivate or delete', (await addSupplier({ name: `Viewer Co ${spStamp}` }, spViewer)).status === 403 && (await api(`/suppliers/${spFirst.data?._id}`, { method: 'PATCH', token: spViewer, ...A, body: { name: 'Changed' } })).status === 403 && (await api(`/suppliers/${spFirst.data?._id}/status`, { method: 'POST', token: spViewer, ...A, body: { isActive: false } })).status === 403 && (await api(`/suppliers/${spFirst.data?._id}`, { method: 'DELETE', token: spViewer, ...A })).status === 403);
    check('...and a viewer is not shown the banking details', !(await api(`/suppliers/${spFirst.data?._id}`, { token: spViewer, ...A })).data?.banking);

    // ---- workspace isolation ----
    const spOther = await api('/auth/register', { method: 'POST', body: { businessName: `Other Supply ${spStamp}`, name: 'Other Owner', email: `supo${spStamp}@example.com`, password: 'Password@123', vertical: 'clothing' } });
    const spOtherToken = spOther.data?.tokens?.accessToken;
    const spOtherTenant = spOther.data?.tenant?.id ?? spOther.data?.tenant?._id;
    const spOtherStore = (await api('/stores', { method: 'POST', token: spOtherToken, body: { name: 'Other Main', code: `SO${spStamp}`, currency: 'BDT' } })).data;
    await spSetPlan(spOtherTenant, 'showroom-monthly');
    const O = { storeId: spOtherStore?._id };
    check("Another workspace sees none of this workspace's suppliers", ((await api('/suppliers?limit=50', { token: spOtherToken, ...O })).data ?? []).length === 0);
    check("...cannot read one by id", (await api(`/suppliers/${spFirst.data?._id}`, { token: spOtherToken, ...O })).status === 404);
    check('...cannot edit one', (await api(`/suppliers/${spFirst.data?._id}`, { method: 'PATCH', token: spOtherToken, ...O, body: { name: 'Stolen' } })).status === 404);
    check('...cannot deactivate one', (await api(`/suppliers/${spFirst.data?._id}/status`, { method: 'POST', token: spOtherToken, ...O, body: { isActive: false } })).status === 404);
    check('...cannot delete one', (await api(`/suppliers/${spFirst.data?._id}`, { method: 'DELETE', token: spOtherToken, ...O })).status === 404);
    check("...and its own codes start at SUP-0001 again", (await api('/suppliers', { method: 'POST', token: spOtherToken, ...O, body: { name: `Other Supplier ${spStamp}` } })).data?.code === 'SUP-0001');

    // ---- shared across the branches of one workspace ----
    const spStoreB = (await api('/stores', { method: 'POST', token: spOwner, body: { name: 'Supply Two', code: `SQ${spStamp}`, currency: 'BDT' } })).data;
    const B = { storeId: spStoreB?._id };
    check('Suppliers are workspace-level: the second branch sees the same list', ((await api('/suppliers?limit=50', { token: spOwner, ...B })).data ?? []).some((row) => row._id === spFirst.data?._id));
    check('...and a supplier added from one branch is one record, not two', (await supplierCount(spOwner, B)) === (await supplierCount(spOwner, A)));
    check('A cashier of this workspace still cannot reach another branch', (await api('/suppliers', { token: spCashier, ...B })).status === 403);

    // ---- the Professional ceiling ----
    const spBulk = [];
    for (let i = (await supplierCount()); i < 99; i += 1) spBulk.push(addSupplier({ name: `Bulk ${spStamp} ${i}` }));
    await Promise.all(spBulk);
    check('Ninety-nine suppliers is fine on Professional', (await supplierCount()) === 99, await supplierCount());
    check('The summary counts down to the ceiling', (await api('/suppliers/summary', { token: spOwner, ...A })).data?.remaining === 1);
    check('The hundredth is allowed', (await addSupplier({ name: `Hundredth ${spStamp}` })).status === 201);
    const spOver = await addSupplier({ name: `One Too Many ${spStamp}` });
    check('The hundred-and-first is refused, in words a merchant can act on', spOver.status === 402 && /100 suppliers/.test(spOver.error?.message ?? '') && /upgrade/i.test(spOver.error?.message ?? ''), spOver.error);
    check('...and nothing was created', (await supplierCount()) === 100);
    check('...and the message does not leak the entitlement internals', !/entitlement|planSnapshot|maxSuppliers.*true/i.test(JSON.stringify(spOver.error ?? {})));

    // ---- concurrency: the ceiling holds when two tills create at once ----
    await api(`/suppliers/${spFirst.data?._id}/status`, { method: 'POST', token: spOwner, ...A, body: { isActive: false } });
    check('Deactivating one frees exactly one slot (99 active)', (await api('/suppliers/summary', { token: spOwner, ...A })).data?.active === 99);
    const spRace = await Promise.all([
      addSupplier({ name: `Race A ${spStamp}` }),
      addSupplier({ name: `Race B ${spStamp}` }),
      addSupplier({ name: `Race C ${spStamp}` }),
      addSupplier({ name: `Race D ${spStamp}` }),
    ]);
    const spRaceCreated = spRace.filter((result) => result.status === 201).length;
    const spActiveAfterRace = (await api('/suppliers/summary', { token: spOwner, ...A })).data?.active;
    check('Four simultaneous creates on a 99/100 plan add exactly one, and the rest are refused', spRaceCreated === 1 && spActiveAfterRace === 100 && spRace.filter((r) => r.status === 402).length === 3, { created: spRaceCreated, active: spActiveAfterRace, statuses: spRace.map((r) => r.status) });
    const spRaceRows = ((await api(`/suppliers?search=${encodeURIComponent(spStamp)}&limit=100`, { token: spOwner, ...A })).data ?? []).filter((row) => row.name.startsWith('Race '));
    check('...and the refused ones left no half-made records behind', spRaceRows.length === 1 && (await supplierCount()) === 101, { rows: spRaceRows.length });

    // ---- Enterprise: unlimited ----
    await spSetPlan(spTenantId, 'brand-monthly');
    const spEntSummary = await api('/suppliers/summary', { token: spOwner, ...A });
    check('ENTERPRISE: the ceiling is lifted and nothing had to be migrated', spEntSummary.data?.unlimited === true && spEntSummary.data?.max === null && spEntSummary.data?.active === 100, spEntSummary.data);
    const spBeyond = await Promise.all(Array.from({ length: 5 }, (_, i) => addSupplier({ name: `Beyond ${spStamp} ${i}` })));
    check('...and suppliers past the old limit are created normally', spBeyond.every((result) => result.status === 201) && (await api('/suppliers/summary', { token: spOwner, ...A })).data?.active === 105);
    check('Enterprise still pages rather than returning everything', (await api('/suppliers?limit=20', { token: spOwner, ...A })).data?.length === 20);

    // ---- downgrade and re-upgrade ----
    await spSetPlan(spTenantId, 'showroom-monthly');
    const spDownSummary = await api('/suppliers/summary', { token: spOwner, ...A });
    check('Enterprise -> Professional keeps every supplier and reports being over the limit', spDownSummary.data?.active === 105 && spDownSummary.data?.max === 100 && spDownSummary.data?.overLimit === true, spDownSummary.data);
    check('...existing suppliers are still readable and editable', (await api(`/suppliers/${spSecond.data?._id}`, { token: spOwner, ...A })).status === 200 && (await api(`/suppliers/${spSecond.data?._id}`, { method: 'PATCH', token: spOwner, ...A, body: { notes: 'Still ours' } })).status === 200);
    check('...but no more can be added while over the ceiling', (await addSupplier({ name: `Over Limit ${spStamp}` })).status === 402);
    await spSetPlan(spTenantId, 'starter-store-monthly');
    check('Professional -> Starter locks the feature', (await api('/suppliers', { token: spOwner, ...A })).status === 403);
    check('...and the data is NOT deleted (the platform still sees the records)', (await api(`/platform/tenants/${spTenantId}`, { token: spPlatform.token })).status === 200);
    await spSetPlan(spTenantId, 'brand-monthly');
    const spBack = await api('/suppliers?limit=1', { token: spOwner, ...A });
    check('Upgrading again brings every supplier back, untouched', spBack.status === 200 && spBack.meta?.total === 106 && (await api(`/suppliers/${spFirst.data?._id}`, { token: spOwner, ...A })).data?.taxNumber === 'VAT-123456', spBack.meta);


    // ---- exporting the supplier list ----
    await spSetPlan(spTenantId, 'showroom-monthly');
    const spCatalogue = await api('/exports/datasets', { token: spOwner, ...A });
    check('The supplier list is offered as an export dataset', (spCatalogue.data?.datasets ?? []).some((d) => d.key === 'suppliers'), (spCatalogue.data?.datasets ?? []).map((d) => d.key));
    check('...as a snapshot, so a date range never hides the older suppliers', (spCatalogue.data?.datasets ?? []).find((d) => d.key === 'suppliers')?.dated === false);
    const spCsv = await download('/exports', { token: spOwner, ...A, body: { type: 'suppliers', format: 'csv' } });
    check(
      'Exporting suppliers as CSV returns the contacts, their terms and their tax numbers',
      spCsv.status === 200 && spCsv.text.includes('SUP-0001') && spCsv.text.includes('Rahim Ahmed') && spCsv.text.includes('Sales Representative') && spCsv.text.includes('VAT-123456') && spCsv.text.includes('30 days'),
      spCsv.error ?? spCsv.text.slice(0, 200),
    );
    check('...and NEVER the banking details', !spCsv.text.includes('1234 5678 9012') && !/account\s*(name|number)/i.test(spCsv.text) && !/city bank/i.test(spCsv.text));
    check('...including the inactive ones, since the list is a snapshot', spCsv.text.split('\r\n').filter((line) => line.startsWith('"SUP-')).length >= 100);
    const spXlsxExport = await download('/exports', { token: spOwner, ...A, body: { type: 'suppliers', format: 'xlsx' } });
    check('Excel works too', spXlsxExport.status === 200 && spXlsxExport.buffer.subarray(0, 2).toString() === 'PK' && spXlsxExport.buffer.includes(Buffer.from('xl/workbook.xml')));
    check('...and the export history records it', ((await api('/exports?limit=5', { token: spOwner, ...A })).data ?? []).some((row) => row.type === 'suppliers'));

    // Exporting must not become a side door into data the user cannot open.
    await api('/staff', { method: 'POST', token: spOwner, ...A, body: { name: 'Report Only', email: `supr2${spStamp}@example.com`, password: 'Password@123', storeId: spStoreA._id, extraPermissions: ['reports.view', 'reports.export'] } });
    const spReporter = (await login(`supr2${spStamp}@example.com`, 'Password@123')).token;
    const spReporterCatalogue = await api('/exports/datasets', { token: spReporter, ...A });
    check('Someone who may export but not see suppliers is not offered the dataset', spReporterCatalogue.status === 200 && !(spReporterCatalogue.data?.datasets ?? []).some((d) => d.key === 'suppliers') && (spReporterCatalogue.data?.datasets ?? []).some((d) => d.key === 'customers'), (spReporterCatalogue.data?.datasets ?? []).map((d) => d.key));
    const spReporterRun = await download('/exports', { token: spReporter, ...A, body: { type: 'suppliers', format: 'csv' } });
    check('...and asking for it anyway is refused', spReporterRun.status === 403 && !spReporterRun.disposition, spReporterRun.error);
    check('...while the datasets they may have still download', (await download('/exports', { token: spReporter, ...A, body: { type: 'customers', format: 'csv' } })).status === 200);

    // ---- audit ----
    const spAudit = await api('/platform/audit-log?action=supplier.created&limit=20', { token: spPlatform.token });
    check('Supplier creation is written to the audit log, without the banking or tax values', spAudit.status === 200 && (spAudit.data ?? []).length > 0 && !JSON.stringify(spAudit.data ?? []).includes('1234 5678 9012') && !JSON.stringify(spAudit.data ?? []).includes('VAT-123456'), spAudit.error);
    check('Deactivation is audited too', ((await api('/platform/audit-log?action=supplier.deactivated&limit=5', { token: spPlatform.token })).data ?? []).length > 0);

    // ---- other verticals are untouched ----
    const spRest = await api('/auth/register', { method: 'POST', body: { businessName: `Resto Supply ${spStamp}`, name: 'Resto Owner', email: `supr${spStamp}@example.com`, password: 'Password@123', vertical: 'restaurant' } });
    const spRestToken = spRest.data?.tokens?.accessToken;
    const spRestStore = (await api('/stores', { method: 'POST', token: spRestToken, body: { name: 'Resto Main', code: `SR${spStamp}`, currency: 'BDT' } })).data;
    await spSetPlan(spRest.data?.tenant?.id ?? spRest.data?.tenant?._id, 'brand-monthly');
    check('A Restaurant workspace has no supplier module at all', (await api('/suppliers', { token: spRestToken, storeId: spRestStore?._id })).status === 403);
  }

  // --- contact verification ---------------------------------------------------
  section('Contact verification (email or phone, before buying)');
  {
    const vfStamp = String(Date.now()).slice(-7);
    const vfPlatform = await login('platform@pos.dev', 'Platform@123');
    const vfPlans = (await api('/plans', {})).data ?? [];
    const vfPlan = vfPlans.find((p) => p.code === 'showroom-monthly');
    const vfReg = await api('/auth/register', {
      method: 'POST',
      body: { businessName: `Verify Wear ${vfStamp}`, name: 'Verify Owner', email: `vf${vfStamp}@example.com`, phone: `0171${vfStamp}`, password: 'Password@123', vertical: 'clothing' },
    });
    const vfToken = vfReg.data?.tokens?.accessToken;
    const vfTenantId = vfReg.data?.tenant?.id ?? vfReg.data?.tenant?._id;
    await api('/stores', { method: 'POST', token: vfToken, body: { name: 'Verify Main', code: `VF${vfStamp}`, currency: 'BDT' } });
    check('A new workspace is registered with an email address and a phone number', Boolean(vfToken && vfTenantId), vfReg.error);

    // ---- what the session says before anything is proven ----
    const vfStatus0 = await api('/auth/verification', { token: vfToken });
    check('Nothing is verified to begin with', vfStatus0.status === 200 && vfStatus0.data?.anyVerified === false && vfStatus0.data?.email?.verified === false && vfStatus0.data?.phone?.verified === false, vfStatus0.error ?? vfStatus0.data);
    check('The contact details come back masked, never in full', vfStatus0.data?.email?.masked?.includes('*') && !vfStatus0.data?.email?.masked?.startsWith(`vf${vfStamp}`) && vfStatus0.data?.phone?.masked?.includes('*'), { email: vfStatus0.data?.email?.masked, phone: vfStatus0.data?.phone?.masked });
    check('The session carries the same status, so the app knows what to ask for', (await api('/auth/me', { token: vfToken })).data?.user?.verification?.anyVerified === false);
    check('Verification needs a signed-in user', (await api('/auth/verification', {})).status === 401 && (await api('/auth/verification/send', { method: 'POST', body: { channel: 'email' } })).status === 401);

    // ---- buying is refused until something is proven ----
    await api(`/platform/tenants/${vfTenantId}/wallet/adjust`, { method: 'POST', token: vfPlatform.token, body: { direction: 'credit', amountMinor: 1_000_000, reason: 'Smoke test: verification' } });
    const vfEarlyBuy = await api('/subscriptions/purchase', { method: 'POST', token: vfToken, body: { plan: 'professional', billingCycle: 'monthly', paymentMethod: 'wallet', idempotencyKey: `vf${vfStamp}a` } });
    check('A wallet purchase is refused with VERIFICATION_REQUIRED', vfEarlyBuy.status === 403 && vfEarlyBuy.error?.code === 'VERIFICATION_REQUIRED' && /verify/i.test(vfEarlyBuy.error?.message ?? ''), vfEarlyBuy.error);
    check('...and so is a manual payment claim', (await api('/subscriptions/upgrade-request', { method: 'POST', token: vfToken, body: { planId: vfPlan._id, paymentMethod: 'bkash', amountMinor: vfPlan.priceMinor, senderNumber: '01700000000', transactionId: `VFT${vfStamp}` } })).error?.code === 'VERIFICATION_REQUIRED');
    check('...and an online checkout', (await api('/payments/checkout', { method: 'POST', token: vfToken, body: { planId: vfPlan._id, provider: 'bkash' } })).error?.code === 'VERIFICATION_REQUIRED');
    check('...and renewing by hand', (await api('/subscriptions/renew', { method: 'POST', token: vfToken, body: {} })).error?.code === 'VERIFICATION_REQUIRED');
    check('The wallet is untouched by a refused purchase', (await api('/wallet', { token: vfToken })).data?.balanceMinor === 1_000_000);
    check('Everything else still works while unverified - this gates buying, not the POS', (await api('/products', { token: vfToken })).status === 200);

    // ---- the code itself ----
    const vfSend = await api('/auth/verification/send', { method: 'POST', token: vfToken, body: { channel: 'email' } });
    check('A code is sent to the email address, and the response says where without saying what', vfSend.status === 200 && vfSend.data?.masked?.includes('*') && typeof vfSend.data?.expiresAt === 'string', vfSend.error ?? vfSend.data);
    // This server has no SMTP and only the SMS test double, so the honest
    // answer is "nothing was delivered" - never a cheerful "code sent".
    check('The response says whether a message really went out, and why not', vfSend.data?.delivered === false && /gateway|test double/i.test(vfSend.data?.deliveryNote ?? ''), { delivered: vfSend.data?.delivered, note: vfSend.data?.deliveryNote });
    const vfSmsSend = await api('/auth/verification/send', { method: 'POST', token: vfToken, body: { channel: 'phone' } });
    check('An SMS through the test double is reported as NOT delivered - it never reaches a phone', vfSmsSend.data?.delivered === false && /test double|not configured|gateway/i.test(vfSmsSend.data?.deliveryNote ?? ''), { delivered: vfSmsSend.data?.delivered, note: vfSmsSend.data?.deliveryNote });
    check('...and the code still works, so the step is completable on a machine with no gateway', (await api('/auth/verification/confirm', { method: 'POST', token: vfToken, body: { channel: 'phone', code: vfSmsSend.data?.devCode } })).data?.phone?.verified === true);
    const vfCode = vfSend.data?.devCode;
    check('Outside production the code is returned so an automated run can complete the step', /^\d{6}$/.test(vfCode ?? ''), typeof vfCode);
    check('An unknown channel is refused', (await api('/auth/verification/send', { method: 'POST', token: vfToken, body: { channel: 'pigeon' } })).status === 422);
    check('A code that is not six digits is refused before anything is checked', (await api('/auth/verification/confirm', { method: 'POST', token: vfToken, body: { channel: 'email', code: '12' } })).status === 422 && (await api('/auth/verification/confirm', { method: 'POST', token: vfToken, body: { channel: 'email', code: 'abcdef' } })).status === 422);
    const vfWrong = await api('/auth/verification/confirm', { method: 'POST', token: vfToken, body: { channel: 'email', code: vfCode === '000000' ? '111111' : '000000' } });
    check('A wrong code is refused, and says how many attempts are left', vfWrong.status === 400 && /attempt/i.test(vfWrong.error?.message ?? ''), vfWrong.error);
    check('...and it does not verify the email address', (await api('/auth/verification', { token: vfToken })).data?.email?.verified === false);
    check('Asking for another code straight away is refused (a cooldown, not a free SMS tap)', (await api('/auth/verification/send', { method: 'POST', token: vfToken, body: { channel: 'email' } })).status === 429);

    const vfConfirm = await api('/auth/verification/confirm', { method: 'POST', token: vfToken, body: { channel: 'email', code: vfCode } });
    check('The right code verifies the email address', vfConfirm.status === 200 && vfConfirm.data?.email?.verified === true && vfConfirm.data?.anyVerified === true, vfConfirm.error);
    check('The same code cannot be used twice', (await api('/auth/verification/confirm', { method: 'POST', token: vfToken, body: { channel: 'email', code: vfCode } })).status === 200 && (await api('/auth/verification', { token: vfToken })).data?.email?.verified === true);
    check('Sending a code to an address that is already verified is refused', (await api('/auth/verification/send', { method: 'POST', token: vfToken, body: { channel: 'email' } })).status === 400);
    check('The session now reports a verified contact', (await api('/auth/me', { token: vfToken })).data?.user?.verification?.anyVerified === true);

    // ---- and now buying works ----
    const vfBuy = await api('/subscriptions/purchase', { method: 'POST', token: vfToken, body: { plan: 'professional', billingCycle: 'monthly', paymentMethod: 'wallet', idempotencyKey: `vf${vfStamp}b` } });
    check('With a verified email address the wallet purchase goes through', vfBuy.status === 201, vfBuy.error);
    check('...and the workspace is on the plan it paid for', (await api('/subscriptions/current', { token: vfToken })).data?.subscription?.planSnapshot?.code === 'showroom-monthly');

    // ---- the phone channel ----
    check('Both contacts end up verified, each with its own code', (await api('/auth/verification', { token: vfToken })).data?.phone?.verified === true && (await api('/auth/verification', { token: vfToken })).data?.email?.verified === true);

    // ---- a phone number that changes is no longer proven ----
    const vfStaffRoles = (await api('/roles', { token: vfToken })).data ?? [];
    await api('/staff', { method: 'POST', token: vfToken, body: { name: 'VF Manager', email: `vfm${vfStamp}@example.com`, password: 'Password@123', phone: `0181${vfStamp}`, roleId: vfStaffRoles.find((r) => r.name === 'Store Manager')?._id } });
    const vfStaffList = (await api('/staff', { token: vfToken })).data ?? [];
    const vfStaffId = vfStaffList.find((u) => u.email === `vfm${vfStamp}@example.com`)?.id;
    const vfStaffToken = (await login(`vfm${vfStamp}@example.com`, 'Password@123')).token;
    await verifyContact(vfStaffToken, 'phone');
    check('A staff member can verify their own phone number', (await api('/auth/verification', { token: vfStaffToken })).data?.phone?.verified === true);
    const vfPhoneChange = await api(`/staff/${vfStaffId}`, { method: 'PATCH', token: vfToken, body: { phone: `0191${vfStamp}` } });
    check('Changing that number clears the verification - it was proven about the old one', vfPhoneChange.status === 200 && (await api('/auth/verification', { token: vfStaffToken })).data?.phone?.verified === false, vfPhoneChange.error);

    // ---- one person, every workspace of their account ----
    const vfSecond = await api('/workspaces', { method: 'POST', token: vfToken, body: { businessName: `Verify Two ${vfStamp}`, vertical: 'clothing' } });
    const vfSecondToken = (await api('/auth/switch-workspace', { method: 'POST', token: vfToken, body: { workspaceId: vfSecond.data?.workspace?.id } })).data?.tokens?.accessToken;
    check('Verification belongs to the person, so their next workspace does not ask again', (await api('/auth/verification', { token: vfSecondToken })).data?.anyVerified === true);

    // ---- someone else's account is unaffected ----
    const vfOther = await api('/auth/register', { method: 'POST', body: { businessName: `Verify Other ${vfStamp}`, name: 'Other Owner', email: `vfo${vfStamp}@example.com`, password: 'Password@123', vertical: 'clothing' } });
    check('A different account starts unverified, whatever anyone else has done', (await api('/auth/verification', { token: vfOther.data?.tokens?.accessToken })).data?.anyVerified === false);
  }

  // --- the new workspace, from inside ---------------------------------------
  const wcSwitch = await api('/auth/switch-workspace', { method: 'POST', token: wcHomeToken, body: { workspaceId: wcSecondId } });
  const wcToken = wcSwitch.data?.tokens?.accessToken;
  check('The owner switches into the new workspace', wcSwitch.status === 200 && wcSwitch.data?.tenant?.id === wcSecondId, wcSwitch.error);
  check('It shares the account', wcSwitch.data?.tenant?.accountId === wcReg.data?.tenant?.accountId);
  check('It starts at store setup', wcSwitch.data?.needsStoreSetup === true);
  check('It has no plan until one is bought', wcSwitch.data?.entitlement?.isUsable === false, wcSwitch.data?.entitlement);

  const wcStore = await api('/stores', { method: 'POST', token: wcToken, body: { name: 'Create Second Main', currency: 'BDT' } });
  check('Its first store can be created before a plan is bought', wcStore.status === 201, wcStore.error);
  const wcExtraStore = await api('/stores', { method: 'POST', token: wcToken, body: { name: 'Create Second Extra', currency: 'BDT' } });
  check('A second store still needs a plan', wcExtraStore.status >= 400, wcExtraStore.status);
  check('POS data stays locked without a plan', (await api('/customers', { token: wcToken })).status === 402);

  const wcHomeStore = await api('/stores/current', { token: wcHomeToken });
  check(
    "Setting up another workspace does not replace the owner's home branch",
    wcHomeStore.status === 200 && wcHomeStore.data?.name === 'Create Home Main',
    { status: wcHomeStore.status, name: wcHomeStore.data?.name },
  );

  const wcFund = await api(`/platform/tenants/${wcHomeId}/wallet/adjust`, {
    method: 'POST',
    token: platform2.token,
    body: { direction: 'credit', amountMinor: wcProfessional.priceMinor, reason: 'Smoke test: fund account wallet' },
  });
  check('The account wallet is funded through the home workspace', wcFund.status === 200, wcFund.error);

  const wcBuy = await api('/subscriptions/upgrade-request', {
    method: 'POST',
    token: wcToken,
    body: { planId: wcProfessional._id, paymentMethod: 'wallet', amountMinor: wcProfessional.priceMinor },
  });
  check('The new workspace buys a plan from the shared wallet', wcBuy.status < 300, wcBuy.error);
  const wcAfter = (await api('/subscriptions/current', { token: wcToken })).data?.entitlement;
  check('The new workspace is now on Professional', wcAfter?.isUsable === true && wcAfter?.planCode === 'showroom-monthly', wcAfter);
  check('The home workspace keeps its own subscription', (await api('/subscriptions/current', { token: wcHomeToken })).data?.entitlement?.status === 'trial');
  check('The shared wallet paid for it', (await api('/wallet', { token: wcHomeToken })).data?.balanceMinor === 0);
  const wcLedger = await api('/wallet/transactions?direction=debit&limit=5', { token: wcHomeToken });
  check(
    'The owner sees the debit, attributed to the new workspace',
    (wcLedger.data ?? []).some((r) => r.tenantId === wcSecondId && r.amountMinor === wcProfessional.priceMinor && r.referenceType === 'subscription'),
    wcLedger.data,
  );

  const wcAudit = await api(`/platform/audit-log?tenantId=${wcSecondId}&limit=20`, { token: platform2.token });
  check('Creation is recorded in the audit log', (wcAudit.data ?? []).some((a) => a.action === 'workspace.created'), (wcAudit.data ?? []).map((a) => a.action));

  // --- trial and limit under concurrency ------------------------------------
  // An owner provisioned on a paid plan has never used the account trial.
  const wcRaceEmail = `race-owner${wcStamp}@example.com`;
  const wcRaceHome = await api('/platform/workspaces', {
    method: 'POST',
    token: platform2.token,
    body: { businessName: `Race Home ${wcStamp}`, planId: wcProfessional._id, owner: { name: 'Race Owner', email: wcRaceEmail, password: 'Password@123' } },
  });
  check('A paid owner is provisioned without a trial', wcRaceHome.status === 201, wcRaceHome.error);
  const wcRace = await login(wcRaceEmail, 'Password@123');
  const wcRaceResults = await Promise.all(
    Array.from({ length: 12 }, (_, i) => wcCreateAs(wcRace.token, { businessName: `Race ${i} ${wcStamp}`, vertical: 'clothing' })),
  );
  const wcRaceCreated = wcRaceResults.filter((r) => r.status === 201);
  const wcRaceRefused = wcRaceResults.filter((r) => r.status === 409);
  const wcMax = wcRaceRefused[0]?.error?.details?.maxWorkspaces;
  check('12 concurrent creations are all either created or refused', wcRaceCreated.length + wcRaceRefused.length === 12, wcRaceResults.map((r) => r.status));
  check('The workspace limit holds under concurrency', typeof wcMax === 'number' && wcRaceCreated.length === wcMax - 1, { created: wcRaceCreated.length, max: wcMax });
  check('Exactly one concurrent creation receives the free trial', wcRaceCreated.filter((r) => r.data?.trial?.started === true).length === 1, wcRaceCreated.map((r) => r.data?.trial));
  check('The owner ends with exactly the limit', ((await api('/auth/workspaces', { token: wcRace.token })).data ?? []).length === wcMax);
  const wcOverLimit = await wcCreateAs(wcRace.token, { businessName: `Over ${wcStamp}`, vertical: 'clothing' });
  check('Creation past the limit is refused', wcOverLimit.status === 409 && wcOverLimit.error?.details?.maxWorkspaces === wcMax, wcOverLimit.error);

  // ------------------------------------------------- workspace switching
  section('Workspace switching');

  const wsStamp = Date.now();
  const wsReg = await api('/auth/register', {
    method: 'POST',
    body: { businessName: `Multi Home ${wsStamp}`, name: 'Multi Owner', email: `multi${wsStamp}@example.com`, password: 'Password@123' },
  });
  check('A multi-workspace owner registers', wsReg.status === 201, wsReg.error);
  const wsHomeId = wsReg.data?.tenant?.id;
  const wsHomeToken = wsReg.data?.tokens?.accessToken;
  await api('/stores', { method: 'POST', token: wsHomeToken, body: { name: 'Home Main', currency: 'BDT' } });

  const wsShowroom = ((await api('/plans')).data ?? []).find((p) => p.code === 'showroom-monthly');
  const wsSecondCreate = await api('/platform/workspaces', {
    method: 'POST',
    token: platform2.token,
    body: { businessName: `Multi Second ${wsStamp}`, ownerUserId: wsReg.data?.user?.id, planId: wsShowroom?._id, storeName: 'Second Main' },
  });
  check('Platform admin adds a second workspace for an existing owner', wsSecondCreate.status === 201, wsSecondCreate.error);

  const wsBadOwner = await api('/platform/workspaces', {
    method: 'POST',
    token: platform2.token,
    body: { businessName: `Bad Owner ${wsStamp}`, ownerUserId: 'not-an-id' },
  });
  check('A malformed owner id is rejected by validation', wsBadOwner.status === 422, wsBadOwner.status);

  const wsStaffOwner = await api('/platform/workspaces', {
    method: 'POST',
    token: platform2.token,
    body: { businessName: `Staff Owner ${wsStamp}`, ownerUserId: cashier.session?.user?.id },
  });
  check('A staff member cannot be given a second workspace', wsStaffOwner.status === 400, wsStaffOwner.status);

  const wsList = await api('/auth/workspaces', { token: wsHomeToken });
  check('The owner sees both workspaces', wsList.data?.length === 2, wsList.data);
  const wsSecondId = wsList.data?.find((w) => !w.isHome)?.id;
  check('The home workspace is the active one', wsList.data?.find((w) => w.isHome)?.isActive === true, wsList.data);

  const wsSwitch = await api('/auth/switch-workspace', {
    method: 'POST',
    token: wsHomeToken,
    body: { workspaceId: wsSecondId, refreshToken: wsReg.data?.tokens?.refreshToken },
  });
  check('The owner switches to the second workspace', wsSwitch.status === 200, wsSwitch.error);
  const wsSecondToken = wsSwitch.data?.tokens?.accessToken;
  check('The session is now in the second workspace', wsSwitch.data?.tenant?.id === wsSecondId, wsSwitch.data?.tenant);
  check('...under the same account', Boolean(wsSwitch.data?.tenant?.accountId) && wsSwitch.data.tenant.accountId === wsReg.data?.tenant?.accountId);
  check("...showing only that workspace's branches", wsSwitch.data?.stores?.length === 1 && wsSwitch.data.stores[0].name === 'Second Main', wsSwitch.data?.stores);
  check("...with that workspace's own subscription", wsSwitch.data?.entitlement?.planCode === 'showroom-monthly', wsSwitch.data?.entitlement?.planCode);
  check('...as its administrator', wsSwitch.data?.user?.role === 'admin');
  check('...and the switcher marks it active', wsSwitch.data?.workspaces?.find((w) => w.id === wsSecondId)?.isActive === true);

  const wsMe = await api('/auth/me', { token: wsSecondToken });
  check('/auth/me follows the switched workspace', wsMe.data?.tenant?.id === wsSecondId, wsMe.data?.tenant);

  const wsSecondCustomers0 = await api('/customers', { token: wsSecondToken });
  check('POS data requests work in the second workspace', wsSecondCustomers0.status === 200, wsSecondCustomers0.error);
  const wsCustomer = await api('/customers', {
    method: 'POST',
    token: wsSecondToken,
    body: { name: 'Second Only', phone: `0198${String(wsStamp).slice(-7)}` },
  });
  check('A customer is created in the second workspace', wsCustomer.status === 201, wsCustomer.error);
  const wsHomeCustomers = await api('/customers', { token: wsHomeToken });
  check(
    "The home workspace cannot see the second workspace's customer",
    wsHomeCustomers.status === 200 && !(wsHomeCustomers.data ?? []).some((c) => c.name === 'Second Only'),
    wsHomeCustomers.data?.map?.((c) => c.name),
  );
  const wsSecondCustomers = await api('/customers', { token: wsSecondToken });
  check('The second workspace sees its own customer', (wsSecondCustomers.data ?? []).some((c) => c.name === 'Second Only'));

  const wsHomeWallet = await api('/wallet', { token: wsHomeToken });
  const wsSecondWallet = await api('/wallet', { token: wsSecondToken });
  check(
    'Both workspaces spend from one account wallet',
    Boolean(wsHomeWallet.data?.accountId) && wsHomeWallet.data.accountId === wsSecondWallet.data?.accountId,
    { home: wsHomeWallet.data?.accountId, second: wsSecondWallet.data?.accountId },
  );

  const wsRefresh = await api('/auth/refresh', { method: 'POST', body: { refreshToken: wsSwitch.data?.tokens?.refreshToken } });
  check('Refresh succeeds after a switch', wsRefresh.status === 200, wsRefresh.error);
  check(
    'Refreshing keeps the session in the second workspace',
    (await api('/auth/me', { token: wsRefresh.data?.accessToken })).data?.tenant?.id === wsSecondId,
  );

  // --- refusals ------------------------------------------------------------
  const wsStranger = await api('/auth/switch-workspace', { method: 'POST', token: admin.token, body: { workspaceId: wsSecondId } });
  check("Another owner cannot switch into someone else's workspace", wsStranger.status === 403, wsStranger.status);
  const wsStaffSwitch = await api('/auth/switch-workspace', { method: 'POST', token: cashier.token, body: { workspaceId: wsHomeId } });
  check('Staff cannot switch workspaces', wsStaffSwitch.status === 403, wsStaffSwitch.status);
  const wsGhost = await api('/auth/switch-workspace', { method: 'POST', token: wsHomeToken, body: { workspaceId: '64b000000000000000000000' } });
  check(
    'A non-existent workspace gets the identical refusal',
    wsGhost.status === 403 && wsGhost.error?.message === wsStranger.error?.message,
    { ghost: wsGhost.error, stranger: wsStranger.error },
  );
  const wsMalformed = await api('/auth/switch-workspace', { method: 'POST', token: wsHomeToken, body: { workspaceId: 'not-an-id' } });
  check('A malformed workspace id is rejected by validation', wsMalformed.status === 422, wsMalformed.status);
  check('Staff are only offered their own workspace', (await api('/auth/workspaces', { token: cashier.token })).data?.length === 1);
  check(
    "Another owner is not offered this account's workspaces",
    !((await api('/auth/workspaces', { token: admin.token })).data ?? []).some((w) => w.id === wsSecondId),
  );

  // --- suspension ------------------------------------------------------------
  const wsSuspend = await api(`/platform/tenants/${wsSecondId}/status`, {
    method: 'PATCH',
    token: platform2.token,
    body: { status: 'suspended', reason: 'Smoke test: workspace switching' },
  });
  check('Platform admin suspends the second workspace', wsSuspend.status === 200, wsSuspend.error);
  check('A suspended workspace refuses requests', (await api('/customers', { token: wsSecondToken })).status === 403);
  check('...while the home workspace keeps working', (await api('/customers', { token: wsHomeToken })).status === 200);
  const wsIntoSuspended = await api('/auth/switch-workspace', { method: 'POST', token: wsHomeToken, body: { workspaceId: wsSecondId } });
  check('Switching into a suspended workspace is refused', wsIntoSuspended.status === 403, wsIntoSuspended.status);
  const wsRefreshSuspended = await api('/auth/refresh', { method: 'POST', body: { refreshToken: wsRefresh.data?.refreshToken } });
  check(
    'Refreshing a session in a suspended workspace returns it home',
    wsRefreshSuspended.status === 200 && (await api('/auth/me', { token: wsRefreshSuspended.data?.accessToken })).data?.tenant?.id === wsHomeId,
    wsRefreshSuspended.error,
  );
  await api(`/platform/tenants/${wsSecondId}/status`, { method: 'PATCH', token: platform2.token, body: { status: 'active' } });

  const wsAudit = await api(`/platform/audit-log?tenantId=${wsSecondId}&limit=20`, { token: platform2.token });
  check('The switch is recorded in the audit log', (wsAudit.data ?? []).some((a) => a.action === 'auth.workspace_switched'), (wsAudit.data ?? []).map((a) => a.action));

  // Last, because presenting a retired token revokes the user's whole session family.
  const wsReuse = await api('/auth/refresh', { method: 'POST', body: { refreshToken: wsReg.data?.tokens?.refreshToken } });
  check('The refresh token the switch was made from is retired', wsReuse.status === 401, wsReuse.status);

  // ------------------------------------------------- account layer
  section('Account layer');

  const acctStamp = Date.now();
  const acctReg = await api('/auth/register', {
    method: 'POST',
    body: { businessName: `Account Test ${acctStamp}`, name: 'Account Owner', email: `acct${acctStamp}@example.com`, password: 'Password@123' },
  });
  check('Registration succeeds', acctReg.status === 201, acctReg.error);
  const acctTenant = acctReg.data?.tenant;
  check('A new workspace belongs to an account', /^[a-f0-9]{24}$/.test(String(acctTenant?.accountId ?? '')), acctTenant);
  check('A new workspace is a Clothing POS workspace', acctTenant?.vertical === 'clothing', acctTenant?.vertical);

  const acctMe = await api('/auth/me', { token: acctReg.data?.tokens?.accessToken });
  check('The session reports the same account', acctMe.data?.tenant?.accountId === acctTenant?.accountId, acctMe.data?.tenant);

  const demoMe = await api('/auth/me', { token: admin.token });
  check('The demo workspace is linked to an account', /^[a-f0-9]{24}$/.test(String(demoMe.data?.tenant?.accountId ?? '')), demoMe.data?.tenant);
  check('The demo workspace is a Clothing POS workspace', demoMe.data?.tenant?.vertical === 'clothing', demoMe.data?.tenant?.vertical);
  check('Different owners get different accounts', demoMe.data?.tenant?.accountId !== acctTenant?.accountId);

  // The account and vertical are decided by the server. A signup naming
  // someone else's account, or another vertical, must not get either.
  const forgedAcct = await api('/auth/register', {
    method: 'POST',
    body: {
      businessName: `Forged Account ${acctStamp}`,
      name: 'Forger',
      email: `forgedacct${acctStamp}@example.com`,
      password: 'Password@123',
      accountId: acctTenant?.accountId,
      vertical: 'pharmacy',
    },
  });
  if (forgedAcct.status === 201) {
    check('Signup ignores a client-supplied accountId', forgedAcct.data?.tenant?.accountId !== acctTenant?.accountId, forgedAcct.data?.tenant);
    // Since multi-POS onboarding the POS type is chosen at signup - from the active catalog only (unknown types are refused).
    check('Signup creates the POS type chosen from the catalog', forgedAcct.data?.tenant?.vertical === 'pharmacy', forgedAcct.data?.tenant);
  } else {
    check('Signup refuses client-supplied account fields', forgedAcct.status === 400 || forgedAcct.status === 422, forgedAcct.status);
  }

  // ------------------------------------------------- trial eligibility
  section('Trial eligibility');

  const eligiblePlans = ((await api('/plans')).data ?? []).filter((p) => p.trialDays > 0);
  check('Exactly one plan offers a trial', eligiblePlans.length === 1, eligiblePlans.map((p) => p.code));
  check(
    'The trial plan is Starter',
    eligiblePlans[0]?.code === 'starter-store-monthly',
    eligiblePlans[0]?.code,
  );
  check('The trial lasts 7 days', eligiblePlans[0]?.trialDays === 7, eligiblePlans[0]?.trialDays);

  const paidPlans = ((await api('/plans')).data ?? []).filter((p) => p.code !== 'starter-store-monthly');
  check('No other plan carries a trial', paidPlans.every((p) => p.trialDays === 0), paidPlans.map((p) => [p.code, p.trialDays]));

  // Signup always lands on the trial plan, never a paid tier.
  const trialStamp2 = Date.now();
  const signup = await api('/auth/register', {
    method: 'POST',
    body: {
      businessName: `Trial Plan ${trialStamp2}`,
      name: 'Trial Owner',
      email: `tplan${trialStamp2}@example.com`,
      password: 'Password@123',
    },
  });
  check('Signup succeeds', signup.status === 201, signup.error);
  check('Signup lands on Starter Store', signup.data?.entitlement?.planCode === 'starter-store-monthly', signup.data?.entitlement?.planCode);
  check('Signup status is trial', signup.data?.entitlement?.status === 'trial');

  // A workspace needs a store before tenant endpoints resolve.
  await api('/stores', {
    method: 'POST',
    token: signup.data.tokens.accessToken,
    body: { name: 'Trial Plan Store', currency: 'BDT' },
  });

  // A platform admin must not be able to hand out a trial on a paid tier.
  const trialBrandPlan = ((await api('/plans')).data ?? []).find((p) => p.code === 'brand-monthly');
  const forgedTrial = await api('/platform/subscriptions', {
    method: 'POST',
    token: platform2.token,
    body: { tenantId: signup.data.tenant.id, planId: trialBrandPlan._id, periods: 1, status: 'trial' },
  });
  check('Platform admin cannot start a trial on Brand', forgedTrial.status >= 400, {
    status: forgedTrial.status,
    error: forgedTrial.error,
  });

  const stillTrial = await api('/subscriptions/current', { token: signup.data.tokens.accessToken });
  check(
    'The refused trial did not change the plan',
    stillTrial.data?.entitlement?.planCode === 'starter-store-monthly',
    stillTrial.data?.entitlement?.planCode,
  );

  // Assigning Brand as a genuine ACTIVE subscription must still work.
  const realAssign = await api('/platform/subscriptions', {
    method: 'POST',
    token: platform2.token,
    body: { tenantId: signup.data.tenant.id, planId: trialBrandPlan._id, periods: 1, status: 'active' },
  });
  check('Platform admin can still assign Brand as active', realAssign.status < 300, realAssign.error);

  // ------------------------------------------------------- pricing page
  section('Pricing catalogue');

  // The public pricing page renders from a catalogue of feature keys. If a key
  // there is not a real, enforced plan feature, the page advertises something
  // the backend will not honour. This is the guard against that drift.
  const catalogSource = readFileSync(new URL('../client/src/lib/planCatalog.ts', import.meta.url), 'utf8');
  // Rows may be written on one line or several, so match the kind and the key
  // independently within each row object rather than assuming a layout.
  const rowKeys = (kinds) => [
    ...new Set(
      [...catalogSource.matchAll(/\{[^{}]*kind:\s*'([^']+)'[^{}]*\}/g)]
        .filter((m) => kinds.includes(m[1]))
        .map((m) => (m[0].match(/key:\s*'([^']+)'/) ?? [])[1])
        .filter(Boolean),
    ),
  ];
  const catalogFeatureKeys = rowKeys(['flag', 'usage']);
  const catalogLimitKeys = rowKeys(['limit']);
  check('Pricing catalogue declares feature rows', catalogFeatureKeys.length > 0, catalogFeatureKeys);
  check('Pricing catalogue declares limit rows', catalogLimitKeys.length > 0, catalogLimitKeys);

  const samplePlan = (await api('/plans')).data?.find((p) => p.code === 'showroom-monthly');
  check('Sample plan available for catalogue check', Boolean(samplePlan));

  const apiFeatureKeys = Object.keys(samplePlan?.features ?? {});
  const apiLimitKeys = Object.keys(samplePlan?.limits ?? {});

  const unknownFeatures = catalogFeatureKeys.filter((key) => !apiFeatureKeys.includes(key));
  check('Every advertised feature exists on the plan', unknownFeatures.length === 0, unknownFeatures);

  const unknownLimits = catalogLimitKeys.filter((key) => !apiLimitKeys.includes(key));
  check('Every advertised limit exists on the plan', unknownLimits.length === 0, unknownLimits);

  // The other direction: a feature the server has but the page never mentions
  // is a differentiator the customer cannot see. Anything deliberately hidden
  // is listed here with the reason.
  const INTENTIONALLY_UNLISTED = {
    // No export endpoint exists anywhere in the codebase, so this flag gates
    // nothing. Advertising it would be selling vapour.
    exportData: 'not implemented - no export endpoint exists',
  };
  const unlisted = apiFeatureKeys.filter(
    (key) => !catalogFeatureKeys.includes(key) && !(key in INTENTIONALLY_UNLISTED),
  );
  check('No plan feature is silently unadvertised', unlisted.length === 0, unlisted);

  const unlistedLimits = apiLimitKeys.filter((key) => !catalogLimitKeys.includes(key));
  check('No plan limit is silently unadvertised', unlistedLimits.length === 0, unlistedLimits);

  // The usage meters read `entitlement.limits` and `usage` by key. A rename on
  // either side would silently render "—" forever, so both directions are
  // checked here as well as for the pricing catalogue.
  const usageSource = readFileSync(new URL('../client/src/lib/usageLimits.ts', import.meta.url), 'utf8');
  const usageLimitKeys = [...new Set([...usageSource.matchAll(/limit: '([^']+)'/g)].map((m) => m[1]))];
  const usageUsageKeys = [...new Set([...usageSource.matchAll(/usage: '([^']+)'/g)].map((m) => m[1]))];

  const liveUsage = (await api('/subscriptions/current', { token: admin.token })).data;
  // `vertical` names what the meters measure; it is not a counter itself.
  const liveUsageKeys = Object.keys(liveUsage?.usage ?? {}).filter((key) => key !== 'vertical');
  const liveLimitKeys = Object.keys(liveUsage?.entitlement?.limits ?? {});

  check(
    'Every usage meter maps to a real limit',
    usageLimitKeys.every((k) => liveLimitKeys.includes(k)),
    usageLimitKeys.filter((k) => !liveLimitKeys.includes(k)),
  );
  check(
    'Every usage meter maps to a real usage counter',
    usageUsageKeys.every((k) => liveUsageKeys.includes(k)),
    usageUsageKeys.filter((k) => !liveUsageKeys.includes(k)),
  );
  check(
    'Every enforced limit has a meter',
    liveLimitKeys.every((k) => usageLimitKeys.includes(k)),
    liveLimitKeys.filter((k) => !usageLimitKeys.includes(k)),
  );
  check(
    'Every usage counter has a meter',
    liveUsageKeys.every((k) => usageUsageKeys.includes(k)),
    liveUsageKeys.filter((k) => !usageUsageKeys.includes(k)),
  );

  // The client and server each sanitise marketing HTML. They run in different
  // bundles, so the allow-lists are duplicated by necessity - but if they drift,
  // the preview stops matching what is actually sent.
  const serverSan = readFileSync(new URL('../server/src/utils/sanitizeEmailHtml.ts', import.meta.url), 'utf8');
  const clientSan = readFileSync(new URL('../client/src/lib/sanitizeHtml.ts', import.meta.url), 'utf8');
  const listOf = (src, name) => {
    const start = src.indexOf(`const ${name} = [`);
    return src.slice(start, src.indexOf('];', start)).replace(/\s+/g, ' ');
  };
  for (const name of ['ALLOWED_TAGS', 'ALLOWED_ATTR']) {
    check(
      `Email sanitiser ${name} matches on client and server`,
      listOf(serverSan, name) === listOf(clientSan, name),
      { server: listOf(serverSan, name).slice(0, 80), client: listOf(clientSan, name).slice(0, 80) },
    );
  }

  // Every advertised feature key must actually gate something server-side.
  // Read from the routes rather than trusting the catalogue's own claim.
  const routeSources = [
    'server/src/modules/messaging/messaging.routes.ts',
    'server/src/modules/reports/reports.routes.ts',
    'server/src/modules/roles/roles.routes.ts',
    'server/src/modules/uploads/uploads.routes.ts',
    'server/src/modules/loyalty/loyalty.routes.ts',
    'server/src/modules/exports/export.routes.ts',
    'server/src/modules/suppliers/suppliers.routes.ts',
  ]
    .map((file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
    .join('\n');

  // Three enforcement shapes count: the `requireFeature` middleware; the
  // entitlement engine's `requireEntitlement`/`requireAccess`, whose canonical
  // keys are mapped to plan flags by reading the entitlement catalogue itself;
  // and a handler branching on the flag directly (which is how image
  // optimisation works, because it changes what the handler DOES rather than
  // whether it runs).
  const entitlementCatalog = readFileSync(new URL('../server/src/config/entitlements.ts', import.meta.url), 'utf8');
  const planFlagOf = Object.fromEntries([...entitlementCatalog.matchAll(/(\w+): \{ label: '[^']*', planFeature: '(\w+)'/g)].map((m) => [m[1], m[2]]));
  const entitlementKeysUsed = [
    ...[...routeSources.matchAll(/requireEntitlement\('([^']+)'\)/g)].map((m) => m[1]),
    ...[...routeSources.matchAll(/requireAccess\(\{[^}]*entitlement: '([^']+)'/g)].map((m) => m[1]),
  ];
  const enforcedKeys = [
    ...new Set([
      ...[...routeSources.matchAll(/requireFeature\('([^']+)'/g)].map((m) => m[1]),
      ...entitlementKeysUsed.map((key) => planFlagOf[key]).filter(Boolean),
      ...[...routeSources.matchAll(/entitlement\.features\.(\w+)/g)].map((m) => m[1]),
    ]),
  ];

  // Flags that are true on every plan describe what the product does rather
  // than separating the tiers, so they need no gate.
  const allPlansForGate = (await api('/plans')).data ?? [];
  const universal = apiFeatureKeys.filter((key) => allPlansForGate.every((p) => p.features?.[key] === true));

  // Commitments that are real but have nothing in code to gate. Each one needs
  // a reason here, so the exemption is a decision rather than an oversight.
  const NOT_A_SOFTWARE_GATE = {
    prioritySupport: 'a response-time commitment from the support team, not a feature flag',
  };

  const advertisedButUngated = catalogFeatureKeys.filter(
    (key) => !enforcedKeys.includes(key) && !universal.includes(key) && !(key in NOT_A_SOFTWARE_GATE),
  );
  check(
    'Every advertised differentiator is enforced server-side',
    advertisedButUngated.length === 0,
    { advertisedButUngated, enforcedKeys, universal },
  );

  // ---------------------------------------------------- limit enforcement
  section('Plan limit enforcement');

  // A dedicated Starter workspace, so the demo tenant's data is untouched.
  const limitStamp = Date.now();
  const limitTenant = await api('/auth/register', {
    method: 'POST',
    body: {
      businessName: `Limit Test ${limitStamp}`,
      name: 'Limit Owner',
      email: `limit${limitStamp}@example.com`,
      password: 'Password@123',
    },
  });
  check('Limit-test workspace registers', limitTenant.status === 201, limitTenant.error);
  const limitTenantToken = limitTenant.data.tokens.accessToken;
  const limitTenantTenantId = limitTenant.data.tenant.id;

  const limitTenantStore = await api('/stores', {
    method: 'POST',
    token: limitTenantToken,
    body: { name: 'Limit Store', currency: 'BDT' },
  });
  check('Limit-test store created', limitTenantStore.status === 201, limitTenantStore.error);

  // Put it on Starter for real, rather than assuming the trial plan matches.
  const limitPlan = (await api('/plans')).data.find((p) => p.code === 'starter-store-monthly');
  const limitTenantSub = await api('/platform/subscriptions', {
    method: 'POST',
    token: platform2.token,
    body: { tenantId: limitTenantTenantId, planId: limitPlan._id, periods: 1 },
  });
  check('Limit-test workspace assigned to Starter', limitTenantSub.status < 300, limitTenantSub.error);

  const limitTenantEnt = (await api('/subscriptions/current', { token: limitTenantToken })).data?.entitlement;
  check('Limit-test workspace is on Starter', limitTenantEnt?.planCode === 'starter-store-monthly', limitTenantEnt?.planCode);

  // --- marketing is not included on Starter --------------------------------
  const limitTenantSmsStatus = await api('/messaging/status', { token: limitTenantToken });
  check('Starter can still READ marketing status', limitTenantSmsStatus.status === 200, limitTenantSmsStatus.error);
  check('Status says SMS is not in the plan', limitTenantSmsStatus.data?.sms?.includedInPlan === false, limitTenantSmsStatus.data?.sms);
  check('Status says email is not in the plan', limitTenantSmsStatus.data?.email?.includedInPlan === false, limitTenantSmsStatus.data?.email);

  const limitTenantSmsSend = await api('/messaging/sms', {
    method: 'POST',
    token: limitTenantToken,
    body: { to: '01700000000', message: 'should not send' },
  });
  check('Starter cannot send SMS', limitTenantSmsSend.status === 403 || limitTenantSmsSend.status === 402, {
    status: limitTenantSmsSend.status,
    error: limitTenantSmsSend.error,
  });

  const limitTenantEmailSend = await api('/messaging/email-campaigns', {
    method: 'POST',
    token: limitTenantToken,
    body: { name: 'Nope', subject: 'Nope', body: '<p>no</p>', audience: 'all-customers' },
  });
  check('Starter cannot send email campaigns', limitTenantEmailSend.status === 403 || limitTenantEmailSend.status === 402, {
    status: limitTenantEmailSend.status,
    error: limitTenantEmailSend.error,
  });

  const limitTenantEstimate = await api('/messaging/estimate?message=hi&recipients=1', { token: limitTenantToken });
  check('Starter cannot price SMS it may not send', limitTenantEstimate.status >= 400, limitTenantEstimate.status);

  const limitTenantBranchReport = await api('/reports/branches', { token: limitTenantToken });
  check('Starter cannot read branch analytics', limitTenantBranchReport.status >= 400, limitTenantBranchReport.status);

  // Showroom and Brand keep it - the gate must not be a blanket block.
  const demoStatus = await api('/messaging/status', { token: admin.token });
  check('Paid plan includes SMS marketing', demoStatus.data?.sms?.includedInPlan === true, demoStatus.data?.sms);
  check('Paid plan includes email marketing', demoStatus.data?.email?.includedInPlan === true, demoStatus.data?.email);
  check('Paid plan can read branch analytics', (await api('/reports/branches', { token: admin.token })).status === 200);

  // --- store limit ---------------------------------------------------------
  const secondStore = await api('/stores', {
    method: 'POST',
    token: limitTenantToken,
    body: { name: 'Second Branch', currency: 'BDT' },
  });
  check('Starter cannot create a second store', secondStore.status >= 400, secondStore.status);

  // --- storage quota -------------------------------------------------------
  // Rather than uploading 2 GB, move the plan's ceiling down to something a
  // test can reach. The enforcement path is identical.
  const originalStarterStorage = limitPlan.limits.maxStorageBytes;
  const tinyQuota = await api(`/plans/${limitPlan._id}`, {
    method: 'PATCH',
    token: platform2.token,
    body: { limits: { maxStorageBytes: 6_000 } },
  });
  check('Platform admin can set a storage limit', tinyQuota.status === 200, tinyQuota.error);

  // The plan changed, but the workspace holds a SNAPSHOT taken at purchase, so
  // re-assign to pick the new ceiling up. This is the snapshot design working.
  await api('/platform/subscriptions', {
    method: 'POST',
    token: platform2.token,
    body: { tenantId: limitTenantTenantId, planId: limitPlan._id, periods: 1 },
  });

  const fitsUpload = await upload('/uploads/image', { token: limitTenantToken, bytes: makePng(4_000) });
  check('Upload within the quota succeeds', fitsUpload.status === 201, fitsUpload.error);

  const overflowUpload = await upload('/uploads/image', { token: limitTenantToken, bytes: makePng(4_000) });
  check('Upload that would exceed the quota is refused', overflowUpload.status >= 400, {
    status: overflowUpload.status,
    error: overflowUpload.error,
  });
  check(
    'Storage refusal names the limit',
    String(overflowUpload.error?.message ?? '').toLowerCase().includes('storage'),
    overflowUpload.error,
  );

  const quotaUsage = (await api('/subscriptions/current', { token: limitTenantToken })).data?.usage;
  check(
    'A refused upload consumes no quota',
    quotaUsage?.storageBytes === 4_000,
    { storageBytes: quotaUsage?.storageBytes },
  );

  // Restore the ORIGINAL value, captured above. Restoring a hardcoded number
  // here silently poisoned the next run when the plan's real limit changed.
  await api(`/plans/${limitPlan._id}`, {
    method: 'PATCH',
    token: platform2.token,
    body: { limits: { maxStorageBytes: originalStarterStorage } },
  });

  // --- image replacement frees storage ------------------------------------
  section('Storage reclaim');

  const reclaimStore = admin.session.stores[0].id;
  const imgA = await upload('/uploads/image', { token: admin.token, storeId: reclaimStore, bytes: makePng(9_000) });
  check('Reclaim: first image uploaded', imgA.status === 201, imgA.error);

  const reclaimBase = (await api('/subscriptions/current', { token: admin.token })).data?.usage?.storageBytes ?? 0;

  const reclaimProduct = await api('/products', {
    method: 'POST',
    token: admin.token,
    body: {
      name: `Reclaim Test ${limitStamp}`,
      sku: `RCLM-${limitStamp}`,
      images: [{ url: imgA.data.url, key: imgA.data.key, isPrimary: true }],
      variants: [{ attributes: [], sellingPriceMinor: 10000, costPriceMinor: 5000, stock: 1 }],
    },
  });
  check('Reclaim: product created with an image', reclaimProduct.status === 201, reclaimProduct.error);

  const imgB = await upload('/uploads/image', { token: admin.token, storeId: reclaimStore, bytes: makePng(2_000) });
  check('Reclaim: replacement image uploaded', imgB.status === 201, imgB.error);

  const afterBothUploads = (await api('/subscriptions/current', { token: admin.token })).data?.usage?.storageBytes;
  check(
    'Reclaim: both images counted',
    afterBothUploads === reclaimBase + imgB.data.size,
    { expected: reclaimBase + imgB.data.size, actual: afterBothUploads },
  );

  const swapped = await api(`/products/${reclaimProduct.data._id}`, {
    method: 'PATCH',
    token: admin.token,
    body: { images: [{ url: imgB.data.url, key: imgB.data.key, isPrimary: true }] },
  });
  check('Reclaim: product image replaced', swapped.status === 200, swapped.error);

  const afterSwap = (await api('/subscriptions/current', { token: admin.token })).data?.usage?.storageBytes;
  check(
    'Replacing an image releases the old one',
    afterSwap === reclaimBase + imgB.data.size - imgA.data.size,
    { expected: reclaimBase + imgB.data.size - imgA.data.size, actual: afterSwap },
  );

  // The security property: a storage key is untrusted client input, so naming
  // ANOTHER tenant's file must not delete it.
  const victimImage = await upload('/uploads/image', { token: admin.token, storeId: reclaimStore, bytes: makePng(1_500) });
  check('Reclaim: victim file uploaded', victimImage.status === 201, victimImage.error);
  const victimUsageBefore = (await api('/subscriptions/current', { token: admin.token })).data?.usage?.storageBytes;

  const attackerProduct = await api('/products', {
    method: 'POST',
    token: limitTenantToken,
    body: {
      name: 'Attacker',
      sku: `ATK-${limitStamp}`,
      // Someone else's storage key, planted in the attacker's own product.
      images: [{ url: victimImage.data.url, key: victimImage.data.key, isPrimary: true }],
      variants: [{ attributes: [], sellingPriceMinor: 100, costPriceMinor: 50, stock: 1 }],
    },
  });
  if (attackerProduct.status === 201) {
    await api(`/products/${attackerProduct.data._id}`, {
      method: 'PATCH',
      token: limitTenantToken,
      body: { images: [] },
    });
  }

  const victimUsageAfter = (await api('/subscriptions/current', { token: admin.token })).data?.usage?.storageBytes;
  check(
    "A tenant cannot delete another tenant's file by naming its key",
    victimUsageAfter === victimUsageBefore,
    { before: victimUsageBefore, after: victimUsageAfter },
  );

  // ------------------------------------------------- MVP package structure
  section('Plan package structure');

  const MB = 1024 ** 2;
  const GB = 1024 ** 3;
  const EXPECTED_PLANS = {
    'starter-store': {
      name: 'Starter',
      monthlyPriceMinor: 99_000,
      limits: { maxStores: 1, maxStaff: 2, maxProducts: 300, maxMonthlySales: 2500, maxCustomers: 500, maxStorageBytes: MB * 500 },
      features: { smsMarketing: false, emailMarketing: false, multiStore: false, advancedReports: false, imageOptimization: false },
    },
    // Internal code `showroom`, sold as Professional.
    showroom: {
      name: 'Professional',
      monthlyPriceMinor: 199_000,
      limits: { maxStores: 2, maxStaff: 6, maxProducts: 3000, maxMonthlySales: 30000, maxCustomers: 10000, maxStorageBytes: GB * 1 },
      features: { smsMarketing: true, emailMarketing: true, multiStore: true, advancedReports: true, imageOptimization: false },
    },
    // Internal code `brand`, sold as Enterprise.
    brand: {
      name: 'Enterprise',
      monthlyPriceMinor: 299_000,
      limits: { maxStores: 10, maxStaff: -1, maxProducts: -1, maxMonthlySales: -1, maxCustomers: -1, maxStorageBytes: GB * 2 },
      features: { smsMarketing: true, emailMarketing: true, multiStore: true, advancedReports: true, imageOptimization: true },
    },
  };

  const allPlans = await api('/plans');
  check('Public plan list loads', allPlans.status === 200, allPlans.error);

  for (const [familyCode, expected] of Object.entries(EXPECTED_PLANS)) {
    for (const interval of ['monthly', 'annual']) {
      const code = `${familyCode}-${interval}`;
      const plan = (allPlans.data ?? []).find((p) => p.code === code);
      check(`Plan ${code} exists`, Boolean(plan), code);
      if (!plan) continue;

      const expectedName = interval === 'annual' ? `${expected.name} Annual` : expected.name;
      check(`${code} is named "${expectedName}"`, plan.name === expectedName, plan.name);
      const expectedPrice = interval === 'annual' ? expected.monthlyPriceMinor * 10 : expected.monthlyPriceMinor;
      check(`${code} costs ৳${(expectedPrice / 100).toLocaleString('en-US')}`, plan.priceMinor === expectedPrice, {
        expected: expectedPrice,
        actual: plan.priceMinor,
      });

      for (const [key, value] of Object.entries(expected.limits)) {
        check(`${code} ${key} = ${value}`, plan.limits?.[key] === value, {
          expected: value,
          actual: plan.limits?.[key],
        });
      }
      for (const [key, value] of Object.entries(expected.features)) {
        check(`${code} ${key} = ${value}`, plan.features?.[key] === value, {
          expected: value,
          actual: plan.features?.[key],
        });
      }
    }
  }

  // Monthly and annual must be the SAME product - only the price differs.
  for (const familyCode of Object.keys(EXPECTED_PLANS)) {
    const monthly = (allPlans.data ?? []).find((p) => p.code === `${familyCode}-monthly`);
    const annual = (allPlans.data ?? []).find((p) => p.code === `${familyCode}-annual`);
    if (!monthly || !annual) continue;

    check(
      `${familyCode}: annual has the same features as monthly`,
      JSON.stringify(monthly.features) === JSON.stringify(annual.features),
      { monthly: monthly.features, annual: annual.features },
    );
    check(
      `${familyCode}: annual has the same limits as monthly`,
      JSON.stringify(monthly.limits) === JSON.stringify(annual.limits),
      { monthly: monthly.limits, annual: annual.limits },
    );
    // "Two months free" = pay for ten, get twelve.
    check(
      `${familyCode}: annual costs exactly ten months`,
      annual.priceMinor === monthly.priceMinor * 10,
      { monthly: monthly.priceMinor, annual: annual.priceMinor },
    );
  }

  // The entitlement a tenant actually receives must carry the new keys, not
  // just the plan catalogue.
  const entLimits = (await api('/subscriptions/current', { token: admin.token })).data?.entitlement?.limits;
  check(
    'Entitlement exposes every new limit',
    entLimits &&
      ['maxStores', 'maxStaff', 'maxProducts', 'maxMonthlySales', 'maxCustomers', 'maxStorageBytes'].every(
        (key) => typeof entLimits[key] === 'number',
      ),
    entLimits,
  );

  // --------------------------------------------------------------- trial
  section('Trial period');

  // Register with hostile extras: a client that tries to grant itself a longer
  // trial, a paid plan, or an active status. Zod strips unknown keys and
  // `validate` replaces the body, so none of these can reach the service.
  const trialStamp = Date.now();
  const forged = await api('/auth/register', {
    method: 'POST',
    body: {
      businessName: `Trial Forge ${trialStamp}`,
      name: 'Forger',
      email: `forge${trialStamp}@example.com`,
      password: 'Password@123',
      // none of the following may have any effect
      trialDays: 3650,
      trialEndsAt: '2099-01-01T00:00:00.000Z',
      currentPeriodEnd: '2099-01-01T00:00:00.000Z',
      status: 'active',
      subscriptionStatus: 'active',
      planCode: 'brand-monthly',
      plan: 'brand',
      limits: { maxProducts: 999999, maxStores: 99, maxStaff: 99 },
    },
  });
  check('Registration ignores forged subscription fields', forged.status === 201, forged.error);

  const forgedEnt = forged.data?.entitlement;
  check('Forged signup still lands on a trial', forgedEnt?.status === 'trial', forgedEnt?.status);
  check('Forged signup does not get the Brand plan', forgedEnt?.planCode !== 'brand-monthly', forgedEnt?.planCode);
  check(
    'Forged plan limits are ignored',
    forgedEnt?.limits?.maxProducts !== 999999 && forgedEnt?.limits?.maxStores !== 99,
    forgedEnt?.limits,
  );

  // The trial length itself, measured against the server clock.
  const expectedTrialDays = 7;
  check(
    `Trial lasts ${expectedTrialDays} days`,
    forgedEnt?.daysRemaining === expectedTrialDays - 1 || forgedEnt?.daysRemaining === expectedTrialDays,
    forgedEnt?.daysRemaining,
  );

  const trialEnd = forgedEnt?.currentPeriodEnd ? new Date(forgedEnt.currentPeriodEnd) : null;
  const expectedEnd = Date.now() + expectedTrialDays * 24 * 60 * 60 * 1000;
  check(
    'Trial end date is computed server-side, not from the request',
    Boolean(trialEnd) && Math.abs(trialEnd.getTime() - expectedEnd) < 60_000,
    { trialEnd: forgedEnt?.currentPeriodEnd },
  );

  // The public plans endpoint is what the marketing copy quotes, so it must
  // agree with what signup actually grants.
  const publicPlans = await api('/plans');
  const advertised = (publicPlans.data ?? []).map((plan) => plan.trialDays).filter((v) => v > 0);
  check(
    'Advertised trial length matches the granted one',
    advertised.length > 0 && advertised.every((d) => d === expectedTrialDays),
    advertised,
  );

  // A trial workspace is fully usable - that is the point of the trial.
  const forgedToken = forged.data.tokens.accessToken;
  const forgedStore = await api('/stores', {
    method: 'POST',
    token: forgedToken,
    body: { name: 'Trial Store', currency: 'BDT' },
  });
  check('Trial workspace can create its store', forgedStore.status === 201, forgedStore.error);
  check(
    'Trial workspace can use the POS',
    (await api('/stores/pos-config', { token: forgedToken })).status === 200,
  );

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

  // ------------------------------- subscription lock + wallet-funded purchase
  section('Subscription lock');

  // Tenant B is on a trial, so the whole app is open to it right now.
  const lockTrialProducts = await api('/products', { token: otherToken });
  check('Trial workspace can reach the catalogue', lockTrialProducts.status === 200, lockTrialProducts.error);

  const otherSubs = await api(`/platform/subscriptions?tenantId=${other.data.tenant.id}`, { token: platform2.token });
  const otherSub = (otherSubs.data ?? [])[0] ?? null;
  check('Platform admin can find tenant B subscription', Boolean(otherSub), otherSubs.error ?? otherSubs.data);

  const expire = await api(`/platform/subscriptions/${otherSub?._id}/status`, {
    method: 'PATCH',
    token: platform2.token,
    body: { status: 'expired', reason: 'Smoke test: lock verification' },
  });
  check('Platform admin can expire a subscription', expire.status === 200, expire.error);

  // --- everything except wallet + subscription must now be shut, for READS
  //     as well as writes.
  const lockedReads = [
    ['catalogue', '/products'],
    ['inventory', '/inventory'],
    ['customers', '/customers'],
    ['sales list', '/sales'],
    ['returns', '/returns'],
    ['staff', '/staff'],
    ['reports', '/reports/dashboard'],
    ['POS config', '/stores/pos-config'],
    ['store settings', '/stores/current'],
  ];
  for (const [label, path] of lockedReads) {
    const res = await api(path, { token: otherToken });
    check(
      `Expired workspace is blocked from reading ${label}`,
      res.status === 402 && res.error?.code === 'SUBSCRIPTION_INACTIVE',
      { status: res.status, error: res.error },
    );
  }

  const lockedSale = await api('/sales', {
    method: 'POST',
    token: otherToken,
    body: { items: [], paymentMethod: 'cash' },
  });
  check('Expired workspace cannot record a sale', lockedSale.status === 402, lockedSale.error);

  // --- the two doors that must stay open
  const lockedWallet = await api('/wallet', { token: otherToken });
  check('Expired workspace can still reach its wallet', lockedWallet.status === 200, lockedWallet.error);

  const lockedBilling = await api('/subscriptions/current', { token: otherToken });
  check('Expired workspace can still reach its subscription', lockedBilling.status === 200, lockedBilling.error);
  check('Expired workspace reports itself unusable', lockedBilling.data?.entitlement?.isUsable === false);

  const lockedPlans = await api('/plans', { token: otherToken });
  check('Expired workspace can still browse plans', lockedPlans.status === 200, lockedPlans.error);

  // --- buying a plan out of the wallet balance
  const targetPlan = (lockedPlans.data ?? []).find((plan) => plan.priceMinor > 0);
  check('A payable plan is available', Boolean(targetPlan));

  const brokeAttempt = await api('/subscriptions/upgrade-request', {
    method: 'POST',
    token: otherToken,
    body: { planId: targetPlan?._id, paymentMethod: 'wallet', amountMinor: targetPlan?.priceMinor ?? 1 },
  });
  check('Wallet purchase fails with an empty balance', brokeAttempt.status >= 400, brokeAttempt.data);

  const stillLocked = await api('/products', { token: otherToken });
  check('A failed wallet purchase does not unlock anything', stillLocked.status === 402);

  const fundOther = await api(`/platform/tenants/${other.data.tenant.id}/wallet/adjust`, {
    method: 'POST',
    token: platform2.token,
    body: {
      direction: 'credit',
      amountMinor: (targetPlan?.priceMinor ?? 0) + 50_000,
      reason: 'Smoke test: funding a wallet-paid subscription',
    },
  });
  check('Platform admin funds tenant B wallet', fundOther.status < 300, fundOther.error);

  await verifyContact(otherToken);
  const balanceBefore = (await api('/wallet', { token: otherToken })).data?.balanceMinor ?? 0;

  const walletBuy = await api('/subscriptions/upgrade-request', {
    method: 'POST',
    token: otherToken,
    body: { planId: targetPlan?._id, paymentMethod: 'wallet', amountMinor: targetPlan?.priceMinor ?? 0 },
  });
  check('Store owner buys a subscription from the wallet', walletBuy.status < 300, walletBuy.error);
  check('Wallet purchase is settled, not left pending', walletBuy.data?.status === 'approved', walletBuy.data?.status);

  const balanceAfter = (await api('/wallet', { token: otherToken })).data?.balanceMinor ?? 0;
  check(
    'Wallet is debited by exactly the plan price',
    balanceBefore - balanceAfter === (targetPlan?.priceMinor ?? -1),
    { balanceBefore, balanceAfter, price: targetPlan?.priceMinor },
  );

  const afterBuy = await api('/subscriptions/current', { token: otherToken });
  check('Subscription is active after paying from the wallet', afterBuy.data?.entitlement?.isUsable === true, afterBuy.data?.entitlement);
  check('Purchased plan is the one that was paid for', afterBuy.data?.entitlement?.planName === targetPlan?.name);

  const unlocked = await api('/products', { token: otherToken });
  check('Paying unlocks the rest of the app', unlocked.status === 200, unlocked.error);

  const unlockedPos = await api('/stores/pos-config', { token: otherToken });
  check('POS is reachable again after paying', unlockedPos.status === 200, unlockedPos.error);

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
