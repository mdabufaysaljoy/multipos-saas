import { posCatalogService } from '../../services/posCatalog/posCatalog.service';
import { Types } from 'mongoose';
import { ROLES } from '../../config/constants';
import { env } from '../../config/env';
import { RefreshTokenModel } from '../../models/RefreshToken';
import { StoreModel } from '../../models/Store';
import { TenantModel } from '../../models/Tenant';
import { UserModel, hashPassword } from '../../models/User';
import { ApiError } from '../../utils/ApiError';
import { uniqueSlug } from '../../utils/slug';
import {
  hashToken,
  newTokenId,
  signAccessToken,
  signRefreshToken,
  ttlToMs,
  verifyRefreshToken,
} from '../../utils/tokens';
import { withTransaction } from '../../utils/tx';
import { resolvePermissions } from '../../middleware/auth';
import { createSystemRoles } from '../roles/roles.defaults';
import { startTrialSubscription } from '../../services/subscription/provisioning.service';
import { verificationService } from '../../services/auth/verification.service';
import { entitlementService } from '../../services/subscription/entitlement.service';
import { ownsAccount, ensureAccountForOwner } from '../../services/account/account.service';
import { AccountModel } from '../../models/Account';
import {
  activeWorkspaceFor,
  canActIn,
  listWorkspaces,
  permissionSourceOf,
  resolveActor,
} from '../../services/account/workspaceAccess.service';
import { DEFAULT_POS_VERTICAL } from '../../config/verticals';
import {
  describeChoices,
  signInBlocker,
  signSelectionToken,
  verifiedIdentities,
  verifySelectionToken,
} from '../../services/auth/identity.service';
import type { ChangePasswordInput, LoginInput, RegisterInput } from './auth.validators';

export interface SessionMeta {
  userAgent: string;
  ip: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

class AuthService {
  /**
   * Registers a business owner. This provisions the whole workspace: tenant,
   * admin user, default roles and a trial subscription. The POS store itself is
   * created afterwards in onboarding, so the owner can set it up deliberately.
   */
  async register(input: RegisterInput, meta: SessionMeta) {
    // Logins are unique platform-wide, platform administrators included.
    const existing = await UserModel.findOne({ email: input.email, deletedAt: null })
      .select('_id')
      .lean();
    if (existing) {
      throw ApiError.conflict('An account with this email already exists. Try signing in instead.');
    }

    const passwordHash = await hashPassword(input.password);
    // Only an active POS product with a module can be chosen; the list is the catalog's, not the client's.
    const vertical = await posCatalogService.resolveForNewWorkspace(input.vertical ?? DEFAULT_POS_VERTICAL);

    const { user, tenant } = await withTransaction(async (session) => {
      const tenantId = new Types.ObjectId();
      const userId = new Types.ObjectId();

      const [createdUser] = await UserModel.create(
        [
          {
            _id: userId,
            tenantId,
            name: input.name,
            email: input.email,
            phone: input.phone ?? '',
            passwordHash,
            role: ROLES.ADMIN,
            isActive: true,
          },
        ],
        { session },
      );

      // The account belongs to the user being created here - there is no way
      // for the request to name a different one.
      const accountId = await ensureAccountForOwner(
        userId,
        { name: input.businessName, contactEmail: input.email },
        session,
      );

      const [createdTenant] = await TenantModel.create(
        [
          {
            _id: tenantId,
            accountId,
            // The POS type the customer chose, checked against the active catalog above.
            vertical,
            name: input.businessName,
            slug: uniqueSlug(input.businessName),
            ownerUserId: userId,
            status: 'active',
            contactEmail: input.email,
            contactPhone: input.phone ?? '',
          },
        ],
        { session },
      );

      await createSystemRoles(tenantId, session);
      const trialId = await startTrialSubscription(tenantId, session);
      // The signup trial is the account's one free trial.
      if (trialId) {
        await AccountModel.updateOne({ _id: accountId }, { $set: { trialUsedAt: new Date() } }, { session });
      }

      return { user: createdUser, tenant: createdTenant };
    });

    const tokens = await this.issueTokens(user._id, user.tenantId, meta);
    // NOTE: the shaped tenant from buildSession is authoritative. Spreading the
    // raw document here would make register's response shape differ from
    // /auth/me, which is exactly the kind of inconsistency that bites callers.
    void tenant;
    return { ...(await this.buildSession(user._id)), tokens };
  }

  /**
   * Signs in by email + password.
   *
   * The password is checked against every live record with the email (normally
   * exactly one). One usable match signs in. Several - identities from before
   * logins were unique - return a short-lived selection token and the choices,
   * and `selectLogin` completes it. The choices are only ever shown to someone
   * who has just proven the password.
   */
  async login(input: LoginInput, meta: SessionMeta) {
    // One generic message for both branches so the endpoint cannot be used to
    // enumerate registered email addresses.
    const invalid = ApiError.unauthorized('Email or password is incorrect');

    const verified = await verifiedIdentities(input.email, input.password);
    if (verified.length === 0) throw invalid;

    const blockers = await Promise.all(verified.map((user) => signInBlocker(user)));
    const usable = verified.filter((_, index) => !blockers[index]);
    if (usable.length === 0) throw blockers[0]!;
    if (usable.length === 1) return this.completeLogin(usable[0]._id, meta);

    return {
      requiresWorkspaceSelection: true as const,
      selectionToken: signSelectionToken(usable),
      choices: await describeChoices(usable),
    };
  }

  /** Finishes a sign-in that matched more than one identity. */
  async selectLogin(input: { selectionToken: string; userId: Types.ObjectId }, meta: SessionMeta) {
    const payload = verifySelectionToken(input.selectionToken);
    const entry = payload.ids.find((candidate) => candidate.id === String(input.userId));
    if (!entry) throw ApiError.forbidden('That sign-in option is not available');

    const user = await UserModel.findOne({ _id: input.userId, deletedAt: null }).lean();
    // A password change or access change since the password was entered voids the choice.
    if (!user || user.permissionVersion !== entry.pv) {
      throw ApiError.unauthorized('Your sign-in expired. Please enter your password again.');
    }
    const blocker = await signInBlocker(user);
    if (blocker) throw blocker;
    return this.completeLogin(user._id, meta);
  }

  /** Issues the session, landing in the last workspace used if still allowed. */
  private async completeLogin(userId: Types.ObjectId, meta: SessionMeta) {
    const user = await UserModel.findOneAndUpdate({ _id: userId }, { $set: { lastLoginAt: new Date() } }, { new: true }).lean();
    if (!user) throw ApiError.unauthorized();
    const landing = await activeWorkspaceFor(user, user.lastActiveTenantId ?? null);
    const tokens = await this.issueTokens(user._id, landing, meta);
    return { ...(await this.buildSession(user._id, landing)), tokens };
  }

  /**
   * Rotates a refresh token. The presented token is revoked and replaced; if a
   * revoked token is presented again (a replay), the whole family is killed.
   */
  async refresh(token: string, meta: SessionMeta): Promise<AuthTokens> {
    let payload;
    try {
      payload = verifyRefreshToken(token);
    } catch {
      throw ApiError.unauthorized('Your session has expired. Please sign in again.');
    }

    const stored = await RefreshTokenModel.findOne({ jti: payload.jti });
    if (!stored) throw ApiError.unauthorized('Your session has expired. Please sign in again.');

    if (stored.revokedAt) {
      await RefreshTokenModel.updateMany(
        { userId: stored.userId, revokedAt: null },
        { $set: { revokedAt: new Date() } },
      );
      throw ApiError.unauthorized('This session was already used. All sessions have been signed out.');
    }

    if (stored.tokenHash !== hashToken(token) || stored.expiresAt.getTime() < Date.now()) {
      throw ApiError.unauthorized('Your session has expired. Please sign in again.');
    }

    const user = await UserModel.findOne({ _id: stored.userId, deletedAt: null }).lean();
    if (!user || !user.isActive) throw ApiError.unauthorized('Account is no longer active');

    // Stay in the workspace the session was in, re-authorised now. If access
    // was lost or the workspace suspended, the session returns home.
    const active = await activeWorkspaceFor(user, stored.tenantId);
    const tokens = await this.issueTokens(user._id, active, meta);
    await RefreshTokenModel.updateOne(
      { _id: stored._id },
      { $set: { revokedAt: new Date(), replacedByJti: tokens.jti } },
    );

    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresIn: tokens.expiresIn };
  }

  async logout(token: string | undefined, userId?: Types.ObjectId): Promise<void> {
    if (token) {
      try {
        const payload = verifyRefreshToken(token);
        await RefreshTokenModel.updateOne({ jti: payload.jti }, { $set: { revokedAt: new Date() } });
        return;
      } catch {
        // Fall through: an unreadable token still ends the session below.
      }
    }
    if (userId) {
      await RefreshTokenModel.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
    }
  }

  /**
   * Moves a session into another workspace the user may act in.
   *
   * Access is re-derived from the database (account ownership). The workspace
   * id in the request is only what the user asked for; the account and
   * ownership are never read from the request.
   */
  async switchWorkspace(
    userId: Types.ObjectId,
    workspaceId: Types.ObjectId,
    presentedRefreshToken: string | undefined,
    meta: SessionMeta,
  ) {
    const user = await UserModel.findOne({ _id: userId, deletedAt: null }).lean();
    if (!user || !user.isActive) throw ApiError.unauthorized('Account is no longer active');

    // One answer for "does not exist" and "not yours", so the endpoint cannot
    // be used to probe which workspace ids exist.
    const denied = ApiError.forbidden('You do not have access to that workspace');
    if (!(await canActIn(user, workspaceId))) throw denied;
    const tenant = await TenantModel.findById(workspaceId).select('status').lean();
    if (!tenant) throw denied;
    if (tenant.status === 'suspended') {
      throw ApiError.forbidden('That workspace has been suspended. Please contact support.');
    }

    const tokens = await this.issueTokens(user._id, workspaceId, meta);
    // Remembered for the next sign-in; re-authorised then, never trusted.
    await UserModel.updateOne({ _id: user._id }, { $set: { lastActiveTenantId: workspaceId } }, { timestamps: false });

    // Retire the refresh token the switch was made from, exactly like a
    // rotation, so the previous workspace's refresh chain ends here.
    if (presentedRefreshToken) {
      try {
        const payload = verifyRefreshToken(presentedRefreshToken);
        await RefreshTokenModel.updateOne(
          { jti: payload.jti, userId: user._id, revokedAt: null, tokenHash: hashToken(presentedRefreshToken) },
          { $set: { revokedAt: new Date(), replacedByJti: tokens.jti } },
        );
      } catch {
        // An unreadable token is simply not rotated.
      }
    }

    return { ...(await this.buildSession(user._id, workspaceId)), tokens };
  }

  async workspaces(userId: Types.ObjectId, activeTenantId: Types.ObjectId | null) {
    const user = await UserModel.findOne({ _id: userId, deletedAt: null }).select('_id role tenantId').lean();
    if (!user) throw ApiError.unauthorized();
    return (await listWorkspaces(user)).map((workspace) => ({
      ...workspace,
      isActive: Boolean(activeTenantId && workspace.id.equals(activeTenantId)),
    }));
  }

  async changePassword(userId: Types.ObjectId, input: ChangePasswordInput): Promise<void> {
    const user = await UserModel.findById(userId).select('+passwordHash');
    if (!user) throw ApiError.notFound('Account not found');

    const matches = await user.comparePassword(input.currentPassword);
    if (!matches) throw ApiError.badRequest('Your current password is incorrect');

    user.passwordHash = await hashPassword(input.newPassword);
    user.permissionVersion += 1;
    await user.save();

    // Changing a password ends every other session.
    await RefreshTokenModel.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  }

  /** Assembles the payload the client needs right after authenticating. */
  //
  // `activeTenantId` must already be authorised by the caller (`authenticate`
  // or `switchWorkspace`). It defaults to the user's home workspace.
  async buildSession(userId: Types.ObjectId, activeTenantId?: Types.ObjectId | null) {
    const user = await UserModel.findById(userId).lean();
    if (!user) throw ApiError.unauthorized();

    const tenantId = activeTenantId ?? user.tenantId;
    // Role, grants and branches as they apply in the workspace being acted in.
    const actor = tenantId ? await resolveActor(user, tenantId) : null;
    if (tenantId && !actor) throw ApiError.unauthorized('You no longer have access to this workspace');
    const permissions = await resolvePermissions(actor ? permissionSourceOf(actor) : user);

    const [tenant, stores, workspaces] = await Promise.all([
      tenantId ? TenantModel.findById(tenantId).lean() : null,
      tenantId
        ? StoreModel.find({ tenantId, isActive: true, deletedAt: null }).sort({ isDefault: -1, createdAt: 1 }).lean()
        : [],
      listWorkspaces(user),
    ]);

    const entitlement = tenantId ? await entitlementService.forTenant(tenantId) : null;
    const isAccountOwner = await ownsAccount(user);

    return {
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: actor?.role ?? user.role,
        // The workspace this session is acting in, and the one the user record belongs to.
        tenantId,
        homeTenantId: user.tenantId,
        storeId: actor?.storeId ?? null,
        isActive: user.isActive,
        permissions,
        /** Owns the customer account: sees billing across every workspace. */
        isAccountOwner,
        /** Which contact details this person has proven. Buying needs one of them. */
        verification: verificationService.status(user),
      },
      tenant: tenant
        ? {
            id: tenant._id,
            name: tenant.name,
            slug: tenant.slug,
            status: tenant.status,
            accountId: tenant.accountId ?? null,
            // A row not yet backfilled predates verticals, so it is Clothing.
            vertical: tenant.vertical ?? DEFAULT_POS_VERTICAL,
          }
        : null,
      // Only the branches this user may actually work in. Admins see them all;
      // staff see their home branch plus any explicitly granted.
      stores: stores
        .filter(
          (store) =>
            Boolean(actor?.isAdmin) ||
            String(store._id) === String(actor?.storeId) ||
            (actor?.storeAccess ?? []).some((id) => String(id) === String(store._id)),
        )
        .map((store) => ({
        id: store._id,
        name: store.name,
        code: store.code,
        currency: store.currency,
        logoUrl: store.logoUrl,
        isDefault: store.isDefault,
      })),
      entitlement,
      /** Workspaces this user may switch between; the active one is flagged. */
      workspaces: workspaces.map((workspace) => ({
        ...workspace,
        isActive: Boolean(tenantId && workspace.id.equals(tenantId)),
      })),
      /** Drives the onboarding redirect. */
      needsStoreSetup: Boolean(tenantId) && stores.length === 0,
    };
  }

  private async issueTokens(userId: Types.ObjectId, tenantId: Types.ObjectId | null, meta: SessionMeta) {
    const user = await UserModel.findById(userId).lean();
    if (!user) throw ApiError.unauthorized();

    const accessToken = signAccessToken({
      sub: String(userId),
      role: user.role,
      tenantId: tenantId ? String(tenantId) : null,
      storeId: user.storeId ? String(user.storeId) : null,
      pv: user.permissionVersion,
    });

    const jti = newTokenId();
    const refreshToken = signRefreshToken({ sub: String(userId), jti });
    const expiresAt = new Date(Date.now() + ttlToMs(env.REFRESH_TOKEN_TTL));

    await RefreshTokenModel.create({
      userId,
      tenantId,
      jti,
      tokenHash: hashToken(refreshToken),
      expiresAt,
      userAgent: meta.userAgent.slice(0, 300),
      ip: meta.ip,
    });

    return { accessToken, refreshToken, jti, expiresIn: Math.floor(ttlToMs(env.ACCESS_TOKEN_TTL) / 1000) };
  }
}

export const authService = new AuthService();
