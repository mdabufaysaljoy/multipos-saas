import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Types } from 'mongoose';
import { ROLES } from '../../config/constants';
import { env } from '../../config/env';
import { TenantModel } from '../../models/Tenant';
import { UserModel, type UserDoc } from '../../models/User';
import { ApiError } from '../../utils/ApiError';

/**
 * Sign-in identity: one email + password resolves to exactly one user record.
 *
 * New logins are unique by email across the platform. Records created before
 * that rule (the same email in several workspaces) still sign in: the password
 * is checked against each, and when more than one matches the person chooses
 * which one - only AFTER proving the password, so nothing about who has an
 * account is revealed to someone who does not know it.
 */

type IdentityRecord = Pick<UserDoc, 'isActive' | 'tenantId' | 'role' | 'permissionVersion' | 'lastLoginAt'> & { _id: Types.ObjectId };

/** More matches than this for one email is not a real person; refuse to scan further. */
const MAX_CANDIDATES = 10;

/**
 * A real bcrypt hash of a random value. Comparing against it when no user has
 * the email makes "unknown email" cost the same as "wrong password".
 */
const TIMING_HASH = bcrypt.hashSync(crypto.randomUUID(), env.BCRYPT_ROUNDS);

/** The user records whose password matches, oldest first. */
export async function verifiedIdentities(email: string, password: string) {
  const users = await UserModel.find({ email, deletedAt: null })
    .select('+passwordHash')
    .sort({ createdAt: 1 })
    .limit(MAX_CANDIDATES);
  if (users.length === 0) {
    await bcrypt.compare(password, TIMING_HASH);
    return [];
  }
  const matches = await Promise.all(users.map((user) => user.comparePassword(password)));
  return users.filter((_, index) => matches[index]);
}

/** Why a verified identity may not sign in right now, or null. */
export async function signInBlocker(user: IdentityRecord): Promise<ApiError | null> {
  if (!user.isActive) return ApiError.forbidden('This account has been deactivated. Contact your administrator.');
  if (user.tenantId) {
    const tenant = await TenantModel.findById(user.tenantId).select('status').lean();
    if (tenant?.status === 'suspended') return ApiError.forbidden('This workspace has been suspended. Please contact support.');
  }
  return null;
}

// ---------------------------------------------------------------- selection

const SELECTION_TTL_SECONDS = 5 * 60;
const SELECTION_AUDIENCE = 'login-identity-selection';

/**
 * Derived from, but never equal to, the access-token secret: a selection token
 * can never be accepted as an access token, and an access token never as this.
 */
const selectionSecret = () => crypto.createHmac('sha256', env.JWT_ACCESS_SECRET).update(SELECTION_AUDIENCE).digest('hex');

interface SelectionPayload {
  typ: 'login_selection';
  /** The identities whose password was proven, with their permission version then. */
  ids: { id: string; pv: number }[];
}

export function signSelectionToken(users: IdentityRecord[]) {
  const payload: SelectionPayload = {
    typ: 'login_selection',
    ids: users.map((user) => ({ id: String(user._id), pv: user.permissionVersion })),
  };
  return jwt.sign(payload, selectionSecret(), { expiresIn: SELECTION_TTL_SECONDS, audience: SELECTION_AUDIENCE });
}

export function verifySelectionToken(token: string): SelectionPayload {
  const expired = ApiError.unauthorized('Your sign-in expired. Please enter your password again.');
  try {
    const payload = jwt.verify(token, selectionSecret(), { audience: SELECTION_AUDIENCE }) as Partial<SelectionPayload>;
    if (payload.typ !== 'login_selection' || !Array.isArray(payload.ids)) throw expired;
    return payload as SelectionPayload;
  } catch {
    throw expired;
  }
}

/** What the person chooses between. Shown only after their password matched. */
export async function describeChoices(users: IdentityRecord[]) {
  const tenantIds = users.map((user) => user.tenantId).filter((id): id is Types.ObjectId => Boolean(id));
  const tenants = await TenantModel.find({ _id: { $in: tenantIds } }).select('name vertical').lean();
  return users.map((user) => {
    const tenant = user.tenantId ? tenants.find((t) => t._id.equals(user.tenantId!)) : null;
    return {
      userId: user._id,
      workspaceName: user.tenantId ? tenant?.name ?? 'Workspace' : 'Platform administration',
      vertical: tenant?.vertical ?? null,
      role: user.role,
      roleLabel: user.role === ROLES.ADMIN ? 'Owner' : user.role === ROLES.STAFF ? 'Staff' : 'Platform administrator',
      lastLoginAt: user.lastLoginAt,
    };
  });
}

// ------------------------------------------------------------ uniqueness

/**
 * Refuses an email that already has a login anywhere on the platform, so no new
 * duplicate identities are created. When the existing login is staff in a
 * sibling workspace of the same account, says so: the right move is to add them
 * as a member, not to give them a second password.
 */
export async function assertEmailUnused(email: string, context?: { tenantId: Types.ObjectId }) {
  const existing = await UserModel.findOne({ email, deletedAt: null }).select('_id tenantId role').lean();
  if (!existing) return;

  if (context && existing.tenantId?.equals(context.tenantId)) {
    throw ApiError.conflict('Someone in your workspace already uses this email address');
  }
  if (context && existing.tenantId && existing.role === ROLES.STAFF) {
    const [here, there] = await Promise.all([
      TenantModel.findById(context.tenantId).select('accountId').lean(),
      TenantModel.findById(existing.tenantId).select('accountId').lean(),
    ]);
    if (here?.accountId && there?.accountId && here.accountId.equals(there.accountId)) {
      throw ApiError.conflict(
        'This person already has a login in another of your workspaces. Add them as a member instead of creating a second login.',
        { suggestion: 'add_member' },
      );
    }
  }
  throw ApiError.conflict('This email already has a login. Use a different email address.');
}

// ----------------------------------------------------------------- report

/** Emails held by more than one live user record. Read-only. */
export async function findDuplicateIdentities() {
  return UserModel.aggregate<{
    _id: string;
    count: number;
    users: { id: Types.ObjectId; tenantId: Types.ObjectId | null; role: string; isActive: boolean; lastLoginAt: Date | null }[];
  }>([
    { $match: { deletedAt: null } },
    {
      $group: {
        _id: '$email',
        count: { $sum: 1 },
        users: { $push: { id: '$_id', tenantId: '$tenantId', role: '$role', isActive: '$isActive', lastLoginAt: '$lastLoginAt' } },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1, _id: 1 } },
  ]);
}
