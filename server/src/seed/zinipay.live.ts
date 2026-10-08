/**
 * Asks the REAL ZiniPay whether this server can reach it.
 *
 * Deliberately not part of `npm test`: it needs live credentials and talks to
 * a third party. It creates nothing and moves no money - it asks about an
 * invoice that does not exist, so the only thing it can learn is whether the
 * gateway answers and accepts the key.
 *
 *   npm run check:zinipay --workspace server
 */
import { ZiniPayProvider } from '../services/payment/providers/zinipay.provider';

async function main() {
  const apiKey = process.env.ZINIPAY_API_KEY ?? '';
  if (!apiKey) {
    console.log('No ZINIPAY_API_KEY in the environment - nothing to check.');
    process.exit(1);
  }
  const provider = new ZiniPayProvider({ apiKey, baseUrl: process.env.ZINIPAY_BASE_URL || 'https://api.zinipay.com' });

  const startedAt = Date.now();
  try {
    await provider.verifyPayment('connection-test-no-such-invoice');
    console.log('Unexpected: a made-up invoice resolved.');
    process.exit(1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const took = Date.now() - startedAt;
    // Being told "no such invoice" is the success: the gateway was reached and
    // it read the key. Anything else is the interesting case.
    if (/not found/i.test(message)) {
      console.log(`REACHABLE in ${took}ms - ZiniPay answered and accepted the API key.`);
      process.exit(0);
    }
    if (/invalid api key/i.test(message)) {
      console.log(`REACHABLE in ${took}ms, but the API key was REJECTED.`);
      process.exit(1);
    }
    console.log(`NOT REACHABLE after ${took}ms: ${message}`);
    process.exit(1);
  }
}

void main();
