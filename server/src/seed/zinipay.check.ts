/**
 * ZiniPay, driven against a stub of its API.
 *
 * The HTTP suite cannot reach this: it would mean calling the real gateway,
 * which needs live credentials, moves real money and cannot be asked to
 * produce a FAILED payment on demand. So the provider is pointed at a stub
 * that answers exactly what the published documentation says ZiniPay answers,
 * and the assertions are about OUR behaviour in each case.
 *
 * The one that matters most is the forged webhook. ZiniPay signs nothing and
 * sends no shared secret, so anybody who learns the callback URL can post
 * `status=true` at it. This proves that doing so marks nothing paid - the
 * notification only names a payment, and the money is decided by asking the
 * API.
 *
 * Run as part of `npm test`.
 */
import { createServer, type Server } from 'node:http';
import { ZiniPayProvider } from '../services/payment/providers/zinipay.provider';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
  }
}

/** What the stub should answer for the next verify call. */
let verifyStatus: 'COMPLETED' | 'PENDING' | 'FAILED' = 'PENDING';
/** Every request the provider made, so the wire format can be asserted. */
const seen: { path: string; apiKey: string | undefined; body: Record<string, unknown> }[] = [];

function startStub(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        seen.push({ path: req.url ?? '', apiKey: req.headers['zini-api-key'] as string | undefined, body });
        res.setHeader('content-type', 'application/json');

        if (req.url === '/v1/payment/create') {
          res.end(
            JSON.stringify({
              status: true,
              message: 'Invoice created successfully.',
              payment_url: 'https://secure.zinipay.com/payment/INVOICE_1',
              val_id: body.val_id,
            }),
          );
          return;
        }
        if (req.url === '/v1/payment/verify') {
          res.end(
            JSON.stringify({
              cus_name: 'John Doe',
              cus_email: 'john@example.com',
              amount: 1200,
              invoice_id: 'INVOICE_1',
              val_id: body.invoice_id,
              payment_method: 'bkash',
              transaction_id: 'TXN123456789',
              status: verifyStatus,
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ message: 'no such endpoint' }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function main() {
  console.log('\n--- ZiniPay: hosted checkout, verification and an unsigned webhook ---');
  const { server, baseUrl } = await startStub();
  const provider = new ZiniPayProvider({ apiKey: 'TEST_KEY', baseUrl });

  // ---- configuration -------------------------------------------------------
  check('A key and a base URL make the provider available', provider.isConfigured());
  check('Without a key it stays hidden', !new ZiniPayProvider({ apiKey: '', baseUrl }).isConfigured());
  check('Hosted checkout cannot charge a stored card, and says so', provider.supportsRecurring() === false);

  // ---- create --------------------------------------------------------------
  const ourPaymentId = '6530f0c8a1b2c3d4e5f60718';
  const started = await provider.initiatePayment({
    tenantId: null as never,
    userId: null,
    subscriptionId: null,
    planId: null,
    amountMinor: 120_000,
    currency: 'BDT',
    reference: ourPaymentId,
    returnUrl: 'https://shop.example.com/wallet?payment=success',
    cancelUrl: 'https://shop.example.com/wallet?payment=cancelled',
    callbackUrl: 'https://api.example.com/api/payments/webhook/zinipay',
    metadata: { customerName: 'Abu Faysal', customerEmail: 'abu@example.com' },
  });

  const createCall = seen.find((call) => call.path === '/v1/payment/create')!;
  check('Creating an invoice hits the documented endpoint', Boolean(createCall));
  check('...authenticated by the zini-api-key header', createCall.apiKey === 'TEST_KEY', createCall.apiKey);
  check('...sending the amount as a decimal, not minor units', createCall.body.amount === '1200.00', createCall.body.amount);
  check('...carrying our payment id as val_id, which ZiniPay echoes back', createCall.body.val_id === ourPaymentId, createCall.body.val_id);
  check('...and the customer it was opened for', createCall.body.cus_name === 'Abu Faysal' && createCall.body.cus_email === 'abu@example.com', createCall.body);
  check('...with the redirect, cancel and webhook URLs', Boolean(createCall.body.redirect_url && createCall.body.cancel_url && createCall.body.webhook_url));
  check('The customer is sent to the hosted page', started.redirectUrl === 'https://secure.zinipay.com/payment/INVOICE_1', started.redirectUrl);
  check('...and nothing is paid yet', started.status === 'pending', started.status);

  // The key must never travel in a URL, where it lands in access logs.
  check('The API key is never put in a query string', seen.every((call) => !call.path.includes('apiKey') && !call.path.includes('apikey')));

  // ---- the webhook is not proof -------------------------------------------
  // This is the property the whole design rests on.
  const forged = await provider.handleWebhook({
    headers: {},
    rawBody: '',
    parsedBody: { invoice_id: 'INVOICE_1', status: 'true', val_id: ourPaymentId },
  });
  check('A webhook names the payment it is about', forged.providerTransactionId === 'INVOICE_1' && forged.reference === ourPaymentId, forged);
  check('...and asks for a re-check rather than being believed', forged.refetch === true);
  check('...reporting NO status, however loudly it claims one', forged.status === null, forged.status);
  check('...no amount', forged.amountMinor === null);
  check('...and no payment time', forged.paidAt === null);

  // ZiniPay documents the callback as a query string too.
  const viaQuery = await provider.handleWebhook({
    headers: {},
    rawBody: '',
    parsedBody: {},
    query: { invoice_id: 'INVOICE_1', status: 'true', val_id: ourPaymentId },
  });
  check('A query-string callback is understood as well', viaQuery.verified && viaQuery.providerTransactionId === 'INVOICE_1', viaQuery);

  const empty = await provider.handleWebhook({ headers: {}, rawBody: '', parsedBody: {} });
  check('A callback naming no payment is refused outright', empty.verified === false, empty);

  // ---- verify is what decides ---------------------------------------------
  verifyStatus = 'PENDING';
  const pending = await provider.verifyPayment('INVOICE_1');
  check('A PENDING invoice is pending', pending.status === 'pending', pending.status);
  check('...and reports no money, so nothing can be activated from it', pending.amountMinor === null && pending.paidAt === null, pending);

  verifyStatus = 'FAILED';
  const failedResult = await provider.verifyPayment('INVOICE_1');
  check('A FAILED invoice is failed', failedResult.status === 'failed', failedResult.status);
  check('...with a reason to show and no money', Boolean(failedResult.failureReason) && failedResult.amountMinor === null, failedResult);

  verifyStatus = 'COMPLETED';
  const paid = await provider.verifyPayment('INVOICE_1');
  check('A COMPLETED invoice is paid', paid.status === 'paid', paid.status);
  check('...for the amount ZiniPay reports, in minor units', paid.amountMinor === 120_000, paid.amountMinor);
  check('...in BDT', paid.currency === 'BDT', paid.currency);
  check('...stamped with when we confirmed it', paid.paidAt instanceof Date, paid.paidAt);
  check('...and carries the real invoice id', paid.providerTransactionId === 'INVOICE_1', paid.providerTransactionId);

  const verifyCall = seen.filter((call) => call.path === '/v1/payment/verify').pop()!;
  check('Verification asks about the invoice by id', verifyCall.body.invoice_id === 'INVOICE_1', verifyCall.body);

  // ---- an unconfigured provider does nothing quietly ----------------------
  const unconfigured = new ZiniPayProvider({ apiKey: '', baseUrl: '' });
  let refused = false;
  try {
    await unconfigured.verifyPayment('INVOICE_1');
  } catch {
    refused = true;
  }
  check('An unconfigured provider refuses rather than guessing', refused);
  check('...and treats a webhook as unverified', (await unconfigured.handleWebhook({ headers: {}, rawBody: '', parsedBody: {} })).verified === false);

  server.close();
  console.log(`\n==========  ${passed} passed, ${failed} failed  ==========\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('ZiniPay check crashed:', error);
  process.exit(1);
});
