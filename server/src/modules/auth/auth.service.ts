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
import { entitlementService } from '../../services/subscription/entitlement.service';
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
    const existing = await UserModel.findOne({ email: input.email, tenantId: { $ne: null }, deletedAt: null })
      .select('_id')
      .lean();
    if (existing) {
      throw ApiError.conflict('An account with this email already exists. Try signing in instead.');
    }

    const passwordHash = await hashPassword(input.password);

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

      const [createdTenant] = await TenantModel.create(
        [
          {
            _id: tenantId,
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
      await startTrialSubscription(tenantId, session);

      return { user: createdUser, tenant: createdTenant };
    });

    const tokens = await this.issueTokens(user._id, user.tenantId, meta);
    return { ...(await this.buildSession(user._id)), tokens, tenant };
  }

  async login(input: LoginInput, meta: SessionMeta) {
    // One generic message for both branches so the endpoint cannot be used to
    // enumerate registered email addresses.
    const invalid = ApiError.unauthorized('Email or password is incorrect');

    const user = await UserModel.findOne({ email: input.email, deletedAt: null }).select('+passwordHash');
    if (!user) throw invalid;

    const matches = await user.comparePassword(input.password);
    if (!matches) throw invalid;

    if (!user.isActive) throw ApiError.forbidden('This account has been deactivated. Contact your administrator.');

    if (user.tenantId) {
      const tenant = await TenantModel.findById(user.tenantId).select('status').lean();
      if (tenant?.status === 'suspended') {
        throw ApiError.forbidden('This workspace has been suspended. Please contact support.');
      }
    }

    await UserModel.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

    const tokens = await this.issueTokens(user._id, user.tenantId, meta);
    return { ...(await this.buildSession(user._id)), tokens };
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

    const tokens = await this.issueTokens(user._id, user.tenantId, meta);
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
  async buildSession(userId: Types.ObjectId) {
    const user = await UserModel.findById(userId).lean();
    if (!user) throw ApiError.unauthorized();

    const permissions = await resolvePermissions(user);

    const [tenant, stores] = await Promise.all([
      user.tenantId ? TenantModel.findById(user.tenantId).lean() : null,
      user.tenantId
        ? StoreModel.find({ tenantId: user.tenantId, isActive: true }).sort({ isDefault: -1, createdAt: 1 }).lean()
        : [],
    ]);

    const entitlement = user.tenantId ? await entitlementService.forTenant(user.tenantId) : null;

    return {
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        tenantId: user.tenantId,
        storeId: user.storeId,
        isActive: user.isActive,
        permissions,
      },
      tenant: tenant
        ? { id: tenant._id, name: tenant.name, slug: tenant.slug, status: tenant.status }
        : null,
      stores: stores.map((store) => ({
        id: store._id,
        name: store.name,
        code: store.code,
        currency: store.currency,
        logoUrl: store.logoUrl,
        isDefault: store.isDefault,
      })),
      entitlement,
      /** Drives the onboarding redirect. */
      needsStoreSetup: Boolean(user.tenantId) && stores.length === 0,
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
