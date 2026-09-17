/**
 * bKash SANDBOX check: drives the real bKash adapter against bKash's sandbox so
 * credentials, the callback URL and the create -> approve -> execute -> status
 * flow can be proven before going live.
 *
 *   npm run bkash:sandbox -w server -- create [--amount 1.00] [--callback <url>]
 *   npm run bkash:sandbox -w server -- status  <paymentID>
 *   npm run bkash:sandbox -w server -- execute <paymentID>
 *
 * Safety:
 *   - refuses any BKASH_BASE_URL that is not the sandbox (or a local mock), so it
 *     can never create a real charge;
 *   - never connects to the database and never changes application data;
 *   - never prints credentials or access tokens.
 *
 * See docs/bkash-sandbox.md for the full runbook.
 */
import crypto from 'crypto';
import { Types } from 'mongoose';
import { decimalStringToMinor, minorToDecimalString } from '../services/payment/money';
import { BkashPaymentProvider } from '../services/payment/providers/bkash.provider';
import type { VerifyPaymentResult } from '../services/payment/PaymentProvider';

const SANDBOX_HOST = /(^|\.)sandbox\.bka\.sh$/;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1)$/;

function fail(message: string): never {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function describe(result: VerifyPaymentResult) {
  const raw = (result.raw ?? {}) as { transactionStatus?: string; trxID?: string | null };
  return {
    paymentID: result.providerTransactionId,
    status: result.status,
    transactionStatus: raw.transactionStatus ?? null,
    trxID: raw.trxID ?? null,
    amount: result.amountMinor === null ? null : minorToDecimalString(result.amountMinor),
    currency: result.currency,
    failureReason: result.failureReason ?? null,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const [command, target] = args;

  const baseUrl = process.env.BKASH_BASE_URL ?? '';
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    fail('BKASH_BASE_URL is not a valid URL. Use https://tokenized.sandbox.bka.sh/v1.2.0-beta');
  }
  if (!SANDBOX_HOST.test(host) && !LOCAL_HOST.test(host)) {
    fail(`Refusing to run against ${host}: this tool only talks to the bKash SANDBOX (tokenized.sandbox.bka.sh).`);
  }

  const provider = new BkashPaymentProvider({
    appKey: process.env.BKASH_APP_KEY ?? '',
    appSecret: process.env.BKASH_APP_SECRET ?? '',
    username: process.env.BKASH_USERNAME ?? '',
    password: process.env.BKASH_PASSWORD ?? '',
    baseUrl,
    webhookTopicArn: '',
    timeoutMs: 30_000,
  });
  if (!provider.isConfigured()) {
    fail('Set BKASH_APP_KEY, BKASH_APP_SECRET, BKASH_USERNAME, BKASH_PASSWORD and BKASH_BASE_URL (sandbox values).');
  }

  switch (command) {
    case 'create': {
      const amount = flag(args, 'amount') ?? '1.00';
      const amountMinor = decimalStringToMinor(amount);
      if (amountMinor === null || amountMinor <= 0) fail(`"${amount}" is not a valid amount. Use a value like 1.00`);
      const callbackUrl =
        flag(args, 'callback') ?? `${(process.env.PUBLIC_BASE_URL ?? 'http://localhost:4100').replace(/\/$/, '')}/api/payments/callback/bkash`;

      const created = await provider.initiatePayment({
        tenantId: new Types.ObjectId(),
        userId: null,
        subscriptionId: null,
        planId: null,
        amountMinor,
        currency: 'BDT',
        reference: `sandbox-${crypto.randomUUID()}`,
        callbackUrl,
      });
      console.log(JSON.stringify({ step: 'create', ok: true, paymentID: created.providerTransactionId, bkashURL: created.redirectUrl, amount: minorToDecimalString(amountMinor), callbackUrl }));
      console.log('\n  Next:');
      console.log('   1. Open bkashURL in a browser and pay with a bKash sandbox test wallet.');
      console.log(`   2. npm run bkash:sandbox -w server -- execute ${created.providerTransactionId}`);
      console.log(`   3. npm run bkash:sandbox -w server -- status ${created.providerTransactionId}\n`);
      return;
    }
    case 'status':
    case 'execute': {
      if (!target || !/^[A-Za-z0-9_-]{6,100}$/.test(target)) fail(`Usage: npm run bkash:sandbox -w server -- ${command} <paymentID>`);
      const result = command === 'status' ? await provider.verifyPayment(target) : await provider.completePayment(target);
      console.log(JSON.stringify({ step: command, ok: true, ...describe(result) }));
      return;
    }
    default:
      fail('Usage: npm run bkash:sandbox -w server -- create [--amount 1.00] [--callback <url>] | status <paymentID> | execute <paymentID>');
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : 'Unexpected error'));
