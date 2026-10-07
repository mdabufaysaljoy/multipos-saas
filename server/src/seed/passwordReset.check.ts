/**
 * The parts of a password reset that depend on the clock.
 *
 * The HTTP suite covers the flow a person actually walks, but it is
 * deliberately HTTP-only, and three of the rules cannot be reached that way
 * without sleeping: a code that has EXPIRED, a code SUPERSEDED by a newer one,
 * and the resend cooldown that stands between two requests for the same
 * address. Sleeping sixty seconds in a test suite is not a test, it is a
 * delay - so those are asserted here, against the throwaway test database,
 * where the row's own timestamps can be moved.
 *
 * It also proves the things a reader has to take on trust otherwise: that the
 * stored row never contains the code, and that a reset really does rewrite
 * every identity on the address and nothing else.
 *
 * Run as part of `npm test`.
 */
import mongoose, { Types } from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/db';
import { ROLES } from '../config/constants';
import { PasswordResetCodeModel } from '../models/PasswordResetCode';
import { RefreshTokenModel } from '../models/RefreshToken';
import { UserModel, hashPassword } from '../models/User';
import { PASSWORD_RESET_LIMITS, passwordResetService } from '../services/auth/passwordReset.service';

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

/** True when the operation was refused, with the message the system means. */
async function refusedBecause(run: () => Promise<unknown>, fragment: string): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    const message = (error as { message?: string }).message ?? '';
    if (message.toLowerCase().includes(fragment.toLowerCase())) return true;
    console.log(`        refused, but for the wrong reason: ${message}`);
    return false;
  }
}

/**
 * Pushes a row's created/expiry stamps into the past, as waiting would.
 *
 * A pipeline update, because both stamps move relative to what they already
 * are. Mongoose 9 refuses an array update unless `updatePipeline` says that is
 * what was meant, so it is passed explicitly rather than cast away.
 */
const ageCodes = (email: string, minutes: number) =>
  PasswordResetCodeModel.updateMany(
    { email },
    [
      {
        $set: {
          createdAt: { $subtract: ['$createdAt', minutes * 60 * 1000] },
          expiresAt: { $subtract: ['$expiresAt', minutes * 60 * 1000] },
        },
      },
    ] as never,
    { updatePipeline: true },
  );

async function main() {
  await connectDatabase();
  console.log('\n--- Password reset: expiry, supersession and scope ---');

  const stamp = Date.now();
  const tenantA = new Types.ObjectId();
  const tenantB = new Types.ObjectId();
  const email = `reset.check.${stamp}@example.com`;
  const bystander = `bystander.${stamp}@example.com`;
  const originalHash = await hashPassword('OriginalPassword@123');

  // The same address owning accounts in TWO workspaces, plus somebody else
  // entirely. `User` is unique on tenant + email, so this is a shape the
  // product really produces, and a reset has to get it right.
  const [userA, userB, other] = await UserModel.create([
    { tenantId: tenantA, name: 'Owner A', email, passwordHash: originalHash, role: ROLES.ADMIN },
    { tenantId: tenantB, name: 'Owner B', email, passwordHash: originalHash, role: ROLES.ADMIN },
    { tenantId: tenantA, name: 'Someone Else', email: bystander, passwordHash: originalHash, role: ROLES.ADMIN },
  ]);
  const refreshRow = (userId: Types.ObjectId) =>
    RefreshTokenModel.create({
      userId,
      tenantId: tenantA,
      jti: `jti-${userId}-${stamp}`,
      tokenHash: `hash-${userId}-${stamp}`,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      userAgent: 'check',
      ip: '127.0.0.1',
    });
  await Promise.all([refreshRow(userA._id), refreshRow(userB._id), refreshRow(other._id)]);

  // ---------------------------------------------------- the code is not stored
  const first = await passwordResetService.request(email);
  const firstCode = first.devCode!;
  check('A code is issued for a registered address', /^\d{6}$/.test(firstCode), typeof firstCode);
  const storedFirst = await PasswordResetCodeModel.findOne({ email }).sort({ createdAt: -1 }).lean();
  check('The row does not contain the code anywhere', Boolean(storedFirst) && !JSON.stringify(storedFirst).includes(firstCode));
  check('...only a hash of it', (storedFirst?.codeHash?.length ?? 0) === 64, storedFirst?.codeHash?.length);
  check('...and no user id', Boolean(storedFirst) && !JSON.stringify(storedFirst).includes(String(userA._id)));

  // -------------------------------------------------------------- the cooldown
  check(
    'A second code inside the cooldown is refused',
    await refusedBecause(() => passwordResetService.request(email), 'before asking for another code'),
  );

  // ------------------------------------------------------------- supersession
  await ageCodes(email, 2);
  const second = await passwordResetService.request(email);
  const secondCode = second.devCode!;
  check('Once the cooldown has passed, a new code is issued', /^\d{6}$/.test(secondCode) && secondCode !== firstCode);
  check(
    'The superseded code no longer verifies',
    await refusedBecause(() => passwordResetService.verify(email, firstCode), 'not right'),
  );

  // ----------------------------------------------------------------- expiry
  await ageCodes(email, PASSWORD_RESET_LIMITS.ttlMinutes + 1);
  check(
    'An expired code no longer verifies',
    await refusedBecause(() => passwordResetService.verify(email, secondCode), 'expired'),
  );

  // A ticket earned before expiry is no good after it either: the row is the
  // authority, not the signed token.
  await ageCodes(email, -(PASSWORD_RESET_LIMITS.ttlMinutes + 1));
  const ticketBefore = (await passwordResetService.verify(email, secondCode)).resetTicket;
  await ageCodes(email, PASSWORD_RESET_LIMITS.ttlMinutes + 1);
  check(
    'A ticket whose code has since expired is refused',
    await refusedBecause(() => passwordResetService.reset(ticketBefore, 'AfterExpiry@12345'), 'expired'),
  );

  // ------------------------------------------------------- scope of the reset
  await ageCodes(email, -(PASSWORD_RESET_LIMITS.ttlMinutes + 1));
  await ageCodes(email, 2);
  const third = await passwordResetService.request(email);
  const ticket = (await passwordResetService.verify(email, third.devCode!)).resetTicket;
  const result = await passwordResetService.reset(ticket, 'ReplacedPassword@456');
  check('Both identities on the address are reset together', result.identities === 2, result);

  const [afterA, afterB, afterOther] = await Promise.all([
    UserModel.findById(userA._id).select('+passwordHash'),
    UserModel.findById(userB._id).select('+passwordHash'),
    UserModel.findById(other._id).select('+passwordHash'),
  ]);
  check('Workspace A takes the new password', await afterA!.comparePassword('ReplacedPassword@456'));
  check('Workspace B takes the new password too', await afterB!.comparePassword('ReplacedPassword@456'));
  check('...and neither keeps the old one', !(await afterA!.comparePassword('OriginalPassword@123')));
  check('The stored value is a bcrypt hash, not the password', afterA!.passwordHash.startsWith('$2') && !afterA!.passwordHash.includes('ReplacedPassword@456'));
  check('An unrelated account on another address is untouched', await afterOther!.comparePassword('OriginalPassword@123'));

  check('Both identities had their token version bumped', (afterA!.permissionVersion ?? 0) > 1 && (afterB!.permissionVersion ?? 0) > 1, {
    a: afterA!.permissionVersion,
    b: afterB!.permissionVersion,
  });
  const revoked = await RefreshTokenModel.find({ userId: { $in: [userA._id, userB._id] } }).lean();
  check('Every session on the address is revoked', revoked.length === 2 && revoked.every((row) => row.revokedAt !== null));
  const bystanderToken = await RefreshTokenModel.findOne({ userId: other._id }).lean();
  check("...and the bystander's session is NOT", bystanderToken?.revokedAt === null, bystanderToken?.revokedAt);

  // -------------------------------------------------------------- single use
  check(
    'The spent ticket cannot be used again',
    await refusedBecause(() => passwordResetService.reset(ticket, 'ThirdPassword@789'), 'expired'),
  );
  check('...and the password did not change a second time', await (await UserModel.findById(userA._id).select('+passwordHash'))!.comparePassword('ReplacedPassword@456'));

  // ------------------------------------------- an address nobody is registered at
  const unknown = await passwordResetService.request(`nobody.${stamp}@example.com`);
  check('An unknown address is answered without a code', unknown.devCode === undefined, unknown);
  check('...and leaves no row behind', (await PasswordResetCodeModel.countDocuments({ email: `nobody.${stamp}@example.com` })) === 0);
  check('...and says exactly what a known address says', unknown.message === first.message, { unknown: unknown.message, known: first.message });

  // A deactivated identity behaves like one that is not there.
  await UserModel.updateMany({ email }, { $set: { isActive: false } });
  await ageCodes(email, 2);
  const deactivated = await passwordResetService.request(email);
  check('A deactivated account cannot be reset into', deactivated.devCode === undefined, deactivated);

  await mongoose.connection.collection('users').deleteMany({ email: { $in: [email, bystander] } });
  await mongoose.connection.collection('passwordresetcodes').deleteMany({ email: { $regex: String(stamp) } });
  await mongoose.connection.collection('refreshtokens').deleteMany({ userId: { $in: [userA._id, userB._id, other._id] } });

  console.log(`\n==========  ${passed} passed, ${failed} failed  ==========\n`);
  await disconnectDatabase();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error('Password reset check crashed:', error);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
