/**
 * Proves the financial records really are immutable.
 *
 * CLAUDE.md rule 9 says financial records must be immutable, and three models
 * enforce it with mongoose hooks. Nothing tested them: the HTTP suite cannot,
 * because there is deliberately no route that edits an invoice or a ledger row.
 *
 * That gap bit. Mongoose 9 stopped passing a `next` callback to hooks, so the
 * old `next(new Error(...))` guards would have failed open with nothing to
 * notice - which is exactly the kind of silence this check exists to break.
 *
 * Run as part of `npm test`, against the throwaway test database.
 */
import mongoose, { Types } from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/db';
import { InvoiceModel } from '../models/Invoice';
import { WalletReceiptModel } from '../models/WalletReceipt';
import { WalletTransactionModel } from '../models/WalletTransaction';

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

/**
 * True when the operation was refused FOR THE STATED REASON.
 *
 * The reason matters as much as the refusal. Under mongoose 9 the old
 * `next(new Error(...))` guards still rejected - but with a TypeError from
 * calling an undefined `next`, not with the message the system means. A check
 * that accepted any throw would have called that healthy.
 */
async function refusedBecause(run: () => Promise<unknown>, reason: string): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    return error instanceof Error && error.message.includes(reason);
  }
}

/** True when the operation was refused at all; for validation, where the message varies. */
async function refused(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

async function main() {
  await connectDatabase();
  console.log('\n--- Financial records are immutable ---');

  const tenantId = new Types.ObjectId();
  const stamp = Date.now();

  // ---------------------------------------------------------------- invoices
  const invoiceFixture = (number: string, totalMinor: number) => ({
    tenantId,
    number,
    year: 2026,
    sequence: Math.floor(Math.random() * 1_000_000) + 1,
    paymentId: new Types.ObjectId(),
    kind: 'purchase',
    issuedAt: new Date(),
    currency: 'BDT',
    issuer: { name: 'Check', address: '', email: '', phone: '' },
    billedTo: { accountName: 'Check', workspaceName: 'Check', email: '', phone: '', country: 'BD' },
    lines: [{
      description: 'Immutability check',
      planCode: 'imm',
      planName: 'Immutability',
      billingCycle: 'monthly' as const,
      posType: 'clothing',
      quantity: 1,
      unitAmountMinor: 1000,
      amountMinor: 1000,
    }],
    subtotalMinor: 1000,
    discountMinor: 0,
    creditMinor: 0,
    adjustmentMinor: 0,
    totalMinor,
    payment: { method: 'wallet', reference: null, paidAt: new Date() },
  });

  const invoice = await InvoiceModel.create(invoiceFixture(`IMM-INV-${stamp}`, 1000));
  check('An invoice can be issued', Boolean(invoice?._id));

  check(
    'Invoice totals that do not add up are refused',
    await refused(() => InvoiceModel.create(invoiceFixture(`IMM-BAD-${stamp}`, 999))),
  );

  // Not by changing a total: that trips the totals validator first, and this
  // assertion is about the immutability guard. Re-saving at all is the test.
  invoice.set('payment.reference', 'tampered');
  check('An issued invoice cannot be saved again', await refusedBecause(() => invoice.save(), 'Invoices are immutable'));
  check('An invoice cannot be updated by query', await refusedBecause(() => InvoiceModel.updateOne({ _id: invoice._id }, { $set: { totalMinor: 5000 } }), 'Invoices are immutable'));
  check('An invoice cannot be deleted', await refusedBecause(() => InvoiceModel.deleteOne({ _id: invoice._id }), 'Invoices are immutable'));
  check(
    'The invoice still reads as it was issued',
    (await InvoiceModel.findById(invoice._id).lean())?.totalMinor === 1000,
  );

  // --------------------------------------------------------- wallet receipts
  const receipt = await WalletReceiptModel.create({
    tenantId,
    number: `IMM-RCP-${stamp}`,
    year: 2026,
    sequence: Math.floor(Math.random() * 1_000_000) + 1,
    issuedAt: new Date(),
    topUpRequestId: new Types.ObjectId(),
    walletTransactionId: new Types.ObjectId(),
    amountMinor: 2500,
    currency: 'BDT',
    issuer: { name: 'Check', address: '', email: '', phone: '' },
    receivedFrom: { accountName: 'Check', workspaceName: 'Check', email: '', phone: '' },
    payment: { method: 'wallet', transactionId: 'imm', senderLast4: '0000' },
  });
  check('A wallet receipt can be issued', Boolean(receipt?._id));
  receipt.amountMinor = 1;
  check('An issued receipt cannot be saved again', await refusedBecause(() => receipt.save(), 'Receipts are immutable'));
  check('A receipt cannot be updated by query', await refusedBecause(() => WalletReceiptModel.updateOne({ _id: receipt._id }, { $set: { amountMinor: 1 } }), 'Receipts are immutable'));
  check('A receipt cannot be deleted', await refusedBecause(() => WalletReceiptModel.deleteOne({ _id: receipt._id }), 'Receipts are immutable'));
  check('The receipt still reads as it was issued', (await WalletReceiptModel.findById(receipt._id).lean())?.amountMinor === 2500);

  // ----------------------------------------------------- wallet transactions
  const walletId = new Types.ObjectId();
  const movement = await WalletTransactionModel.create({
    walletId,
    tenantId,
    accountId: null,
    type: 'credit' as const,
    amountMinor: 700,
    balanceBeforeMinor: 0,
    balanceAfterMinor: 700,
    reason: 'Immutability check',
    currency: 'BDT',
    status: 'posted' as const,
    source: 'admin_adjustment' as const,
  });
  check('A ledger row can be written', Boolean(movement?._id));
  movement.amountMinor = 1;
  check('A ledger row cannot be saved again', await refusedBecause(() => movement.save(), 'Wallet transactions are immutable'));
  check('A ledger row cannot be updated by query', await refusedBecause(() => WalletTransactionModel.updateOne({ _id: movement._id }, { $set: { amountMinor: 1 } }), 'Wallet transactions are immutable'));
  check('A ledger row cannot be deleted', await refusedBecause(() => WalletTransactionModel.deleteOne({ _id: movement._id }), 'Wallet transactions are immutable'));
  check('The ledger row still reads as it was written', (await WalletTransactionModel.findById(movement._id).lean())?.amountMinor === 700);

  // Clean up through the maintenance escape hatch the ledger keeps for itself.
  await mongoose.connection.collection('invoices').deleteMany({ tenantId });
  await mongoose.connection.collection('walletreceipts').deleteMany({ tenantId });
  await mongoose.connection.collection('wallettransactions').deleteMany({ tenantId });

  console.log(`\n==========  ${passed} passed, ${failed} failed  ==========\n`);
  await disconnectDatabase();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error('Immutability check crashed:', error);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
