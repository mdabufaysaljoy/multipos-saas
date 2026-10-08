/**
 * An in-memory stand-in for the ZiniPay API, for tests only.
 *
 * It implements the two endpoints the adapter calls - create and verify - with
 * the shapes the LIVE API returns, which is the point of it: the published
 * docs and the Postman collection disagree with each other and with reality,
 * so what is mirrored here is what was observed from the real gateway.
 *
 *   create -> { status, message, payment_url, val_id }
 *             where payment_url is /<brand>/payment/<invoice_id> (a brand slug
 *             sits in the path, so the id is the LAST segment) and val_id is a
 *             DIFFERENT uuid that verify does not recognise.
 *   verify -> { amount, invoice_id, transaction_id, status: PENDING|COMPLETED|FAILED }
 *             with amount as a NUMBER, and 404 for anything else.
 *
 * Tests drive the "customer" through /__control: pay an invoice (optionally for
 * a different amount, to simulate an underpayment), or fail it.
 *
 * Never started by the application itself.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';

export async function startMockZiniPay({ port = 0, apiKey = 'test-zinipay-key' } = {}) {
  /** invoice_id -> { amount, status, cus_name, cus_email, metadata, transaction_id, webhook_url } */
  const invoices = new Map();
  const stats = { creates: 0, verifies: 0, unauthorized: 0 };

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readJson = (req) =>
    new Promise((resolve) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          resolve({});
        }
      });
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const body = await readJson(req);

    // --- test control, not part of the real API -----------------------------
    if (url.pathname === '/__control/pay') {
      const invoice = invoices.get(body.invoiceId);
      if (!invoice) return send(res, 404, { message: 'no such invoice' });
      invoice.status = 'COMPLETED';
      if (typeof body.amount === 'number') invoice.amount = body.amount;
      invoice.transaction_id = `TXN${Math.random().toString(36).slice(2, 11).toUpperCase()}`;
      return send(res, 200, { ok: true, invoice_id: body.invoiceId, webhook_url: invoice.webhook_url });
    }
    if (url.pathname === '/__control/fail') {
      const invoice = invoices.get(body.invoiceId);
      if (!invoice) return send(res, 404, { message: 'no such invoice' });
      invoice.status = 'FAILED';
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/__control/stats') return send(res, 200, { ...stats, invoices: invoices.size });

    // --- the real API -------------------------------------------------------
    // Authenticated by this header alone, and never by a query parameter: a key
    // in a URL ends up in access logs.
    if (req.headers['zini-api-key'] !== apiKey) {
      stats.unauthorized += 1;
      return send(res, 401, { status: false, message: 'Invalid API key' });
    }

    if (url.pathname === '/v1/payment/create' && req.method === 'POST') {
      stats.creates += 1;
      if (!body.amount || !body.cus_email) {
        return send(res, 422, { status: false, message: 'amount and cus_email are required' });
      }
      const invoiceId = randomUUID();
      invoices.set(invoiceId, {
        amount: Number(body.amount),
        status: 'PENDING',
        cus_name: body.cus_name ?? '',
        cus_email: body.cus_email,
        metadata: body.metadata ?? {},
        transaction_id: 'N/A',
        webhook_url: body.webhook_url ?? '',
      });
      return send(res, 201, {
        status: true,
        message: 'Invoice created successfully.',
        // The brand slug is deliberate: it is in the live URL, and it is why
        // the id must be read as the last segment rather than a fixed one.
        payment_url: `https://secure.zinipay.test/mock-brand/payment/${invoiceId}`,
        // A second, different uuid that verify will NOT accept.
        val_id: randomUUID(),
      });
    }

    if (url.pathname === '/v1/payment/verify' && req.method === 'POST') {
      stats.verifies += 1;
      const invoice = invoices.get(body.invoice_id);
      if (!invoice) return send(res, 404, { status: false, message: 'Invoice not found' });
      return send(res, 200, {
        cus_name: invoice.cus_name,
        cus_email: invoice.cus_email,
        // A number, as the live API sends it.
        amount: invoice.amount,
        invoice_id: body.invoice_id,
        payment_method: 'bkash',
        transaction_id: invoice.transaction_id,
        status: invoice.status,
      });
    }

    return send(res, 404, { status: false, message: 'no such endpoint' });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actualPort = server.address().port;

  return {
    url: `http://127.0.0.1:${actualPort}`,
    apiKey,
    invoices,
    stats,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
