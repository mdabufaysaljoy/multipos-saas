/**
 * An in-memory stand-in for the bKash Tokenized Checkout API, for tests only.
 *
 * It implements the endpoints the adapter calls - token grant and refresh,
 * create, execute and payment status - with the same request and response
 * shapes, and it enforces the same rules that matter for safety: credentials on
 * grant, a live token and app key on every other call, and a payment can only be
 * executed after the customer has approved it.
 *
 * Tests drive the "customer" through /__control endpoints: approve (optionally
 * with a different amount, to simulate an underpayment), expire tokens, slow the
 * API down, or make create return a redirect to a foreign host.
 *
 * Never started by the application itself.
 */
import http from 'node:http';

export async function startMockBkash({
  port = 0,
  appKey = 'test-app-key',
  appSecret = 'test-app-secret',
  username = 'test-user',
  password = 'test-pass',
} = {}) {
  let sequence = 0;
  const tokens = new Map(); // id_token -> expiresAt
  const refreshTokens = new Set();
  const payments = new Map();
  const stats = { grants: 0, refreshes: 0, creates: 0, executes: 0, queries: 0, unauthorized: 0 };
  const control = { tokenTtlSeconds: 3600, delayMs: 0, foreignRedirect: false };

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
          resolve(null);
        }
      });
    });
  const issueToken = () => {
    sequence += 1;
    const idToken = `id-token-${sequence}`;
    const refreshToken = `refresh-token-${sequence}`;
    tokens.set(idToken, Date.now() + control.tokenTtlSeconds * 1000);
    refreshTokens.add(refreshToken);
    return { statusCode: '0000', statusMessage: 'Successful', id_token: idToken, refresh_token: refreshToken, expires_in: control.tokenTtlSeconds, token_type: 'Bearer' };
  };
  const authorised = (req) => {
    const expiresAt = tokens.get(req.headers.authorization);
    return req.headers['x-app-key'] === appKey && Boolean(expiresAt) && expiresAt > Date.now();
  };
  const statusPayload = (p) => ({
    statusCode: '0000',
    statusMessage: 'Successful',
    paymentID: p.paymentID,
    mode: '0011',
    paymentCreateTime: p.createdAt,
    amount: p.completedAmount ?? p.amount,
    currency: p.completedCurrency ?? p.currency,
    intent: 'sale',
    merchantInvoice: p.merchantInvoiceNumber,
    transactionStatus: p.transactionStatus,
    verificationStatus: p.transactionStatus === 'Completed' ? 'Complete' : 'Incomplete',
    payerReference: p.payerReference,
    ...(p.trxID ? { trxID: p.trxID } : {}),
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    if (control.delayMs && !url.pathname.startsWith('/__control')) await new Promise((r) => setTimeout(r, control.delayMs));
    const body = req.method === 'POST' ? await readJson(req) : {};
    if (body === null) return send(res, 400, { statusCode: '9999', statusMessage: 'Malformed JSON' });

    // ------------------------------------------------------------- test controls
    if (url.pathname === '/__control/customer-approves') {
      const p = payments.get(body.paymentID);
      if (!p) return send(res, 404, { error: 'unknown payment' });
      p.approved = true;
      if (body.amount !== undefined) p.completedAmount = body.amount;
      if (body.currency !== undefined) p.completedCurrency = body.currency;
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/__control/settings') {
      Object.assign(control, body);
      return send(res, 200, { ok: true, control });
    }
    if (url.pathname === '/__control/expire-tokens') {
      for (const key of tokens.keys()) tokens.set(key, 0);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/__control/stats') return send(res, 200, { ...stats, payments: payments.size });

    // ------------------------------------------------------------------ bKash API
    if (url.pathname === '/tokenized/checkout/token/grant') {
      stats.grants += 1;
      if (req.headers.username !== username || req.headers.password !== password || body.app_key !== appKey || body.app_secret !== appSecret) {
        return send(res, 200, { statusCode: '2079', statusMessage: 'Invalid username or password' });
      }
      return send(res, 200, issueToken());
    }
    if (url.pathname === '/tokenized/checkout/token/refresh') {
      stats.refreshes += 1;
      if (body.app_key !== appKey || body.app_secret !== appSecret || !refreshTokens.has(body.refresh_token)) {
        return send(res, 200, { statusCode: '2079', statusMessage: 'Invalid refresh token' });
      }
      refreshTokens.delete(body.refresh_token);
      return send(res, 200, issueToken());
    }

    if (!authorised(req)) {
      stats.unauthorized += 1;
      return send(res, 401, { statusCode: '9999', statusMessage: 'Unauthorized' });
    }

    if (url.pathname === '/tokenized/checkout/create') {
      stats.creates += 1;
      if (body.mode !== '0011' || body.intent !== 'sale' || !/^\d+\.\d{2}$/.test(body.amount ?? '') || !body.callbackURL || !body.merchantInvoiceNumber) {
        return send(res, 200, { statusCode: '2065', statusMessage: 'Invalid request parameters' });
      }
      sequence += 1;
      const payment = {
        paymentID: `TR0011MOCK${String(sequence).padStart(6, '0')}`,
        amount: body.amount,
        currency: body.currency,
        merchantInvoiceNumber: body.merchantInvoiceNumber,
        payerReference: body.payerReference,
        callbackURL: body.callbackURL,
        transactionStatus: 'Initiated',
        approved: false,
        createdAt: new Date().toISOString(),
      };
      payments.set(payment.paymentID, payment);
      const host = control.foreignRedirect ? 'https://evil.example.com' : `http://127.0.0.1:${server.address().port}`;
      return send(res, 200, {
        statusCode: '0000',
        statusMessage: 'Successful',
        paymentID: payment.paymentID,
        bkashURL: `${host}/checkout?paymentID=${payment.paymentID}`,
        callbackURL: payment.callbackURL,
        successCallbackURL: `${payment.callbackURL}?paymentID=${payment.paymentID}&status=success`,
        failureCallbackURL: `${payment.callbackURL}?paymentID=${payment.paymentID}&status=failure`,
        cancelledCallbackURL: `${payment.callbackURL}?paymentID=${payment.paymentID}&status=cancel`,
        amount: payment.amount,
        intent: 'sale',
        currency: payment.currency,
        paymentCreateTime: payment.createdAt,
        transactionStatus: 'Initiated',
        merchantInvoiceNumber: payment.merchantInvoiceNumber,
      });
    }

    if (url.pathname === '/tokenized/checkout/execute') {
      stats.executes += 1;
      const p = payments.get(body.paymentID);
      if (!p) return send(res, 200, { statusCode: '2056', statusMessage: 'Invalid Payment State' });
      if (p.transactionStatus === 'Completed') return send(res, 200, { statusCode: '2062', statusMessage: 'The payment has already been completed' });
      if (!p.approved) return send(res, 200, { statusCode: '2056', statusMessage: 'Invalid Payment State' });
      sequence += 1;
      p.transactionStatus = 'Completed';
      p.trxID = `MOCKTRX${sequence}`;
      return send(res, 200, {
        statusCode: '0000',
        statusMessage: 'Successful',
        paymentID: p.paymentID,
        customerMsisdn: '01770618575',
        payerReference: p.payerReference,
        paymentExecuteTime: new Date().toISOString(),
        trxID: p.trxID,
        transactionStatus: 'Completed',
        amount: p.completedAmount ?? p.amount,
        currency: p.completedCurrency ?? p.currency,
        intent: 'sale',
        merchantInvoiceNumber: p.merchantInvoiceNumber,
      });
    }

    if (url.pathname === '/tokenized/checkout/payment/status') {
      stats.queries += 1;
      const p = payments.get(body.paymentID);
      if (!p) return send(res, 200, { statusCode: '2056', statusMessage: 'Invalid Payment State' });
      return send(res, 200, statusPayload(p));
    }

    return send(res, 404, { statusCode: '9999', statusMessage: 'Not found' });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    credentials: { appKey, appSecret, username, password },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
