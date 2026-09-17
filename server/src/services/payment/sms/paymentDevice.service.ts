import crypto from 'crypto';
import type { Types } from 'mongoose';
import { PaymentDeviceModel, type PaymentDeviceDoc } from '../../../models/PaymentDevice';
import { ApiError } from '../../../utils/ApiError';
import { hashToken } from '../../../utils/tokens';

/**
 * Credentials for the devices allowed to REPORT payment SMS.
 *
 * A device credential is not a login: it names no user, carries no
 * permissions, and can do exactly one thing - submit evidence for matching. The
 * secret is generated here, shown once, and stored only as a SHA-256 digest, so
 * a database leak cannot be replayed against the endpoint.
 */
export interface DeviceActor {
  id: Types.ObjectId;
  name: string;
}

const newSecret = () => `pd_${crypto.randomBytes(32).toString('hex')}`;
const newDeviceId = () => `dev_${crypto.randomBytes(8).toString('hex')}`;

/** The device view a platform admin sees. Never includes the digest. */
export const presentDevice = (device: PaymentDeviceDoc & { _id: Types.ObjectId }) => ({
  id: device._id,
  deviceId: device.deviceId,
  label: device.label,
  status: device.status,
  allowedProviders: device.allowedProviders,
  merchantAccounts: device.merchantAccounts,
  lastSeenAt: device.lastSeenAt,
  lastEventAt: device.lastEventAt,
  eventsAccepted: device.eventsAccepted,
  eventsRejected: device.eventsRejected,
  rotatedAt: device.rotatedAt,
  revokedAt: device.revokedAt,
  revokedReason: device.revokedReason,
  createdAt: device.createdAt,
});

class PaymentDeviceService {
  /** Registers a device. The secret is returned ONCE and never stored in clear. */
  async register(input: { label: string; allowedProviders: string[]; merchantAccounts: string[] }, actor: DeviceActor) {
    const secret = newSecret();
    const device = await PaymentDeviceModel.create({
      deviceId: newDeviceId(),
      label: input.label,
      tokenHash: hashToken(secret),
      allowedProviders: input.allowedProviders,
      merchantAccounts: input.merchantAccounts,
      createdBy: actor.id,
      createdByNameSnapshot: actor.name,
    });
    return { device: presentDevice(device.toObject() as never), secret };
  }

  /** Issues a new secret and invalidates the old one immediately. */
  async rotate(id: Types.ObjectId) {
    const secret = newSecret();
    const device = await PaymentDeviceModel.findOneAndUpdate(
      { _id: id, status: 'active' },
      { $set: { tokenHash: hashToken(secret), rotatedAt: new Date() } },
      { new: true },
    ).lean<PaymentDeviceDoc & { _id: Types.ObjectId }>();
    if (!device) throw ApiError.notFound('Device not found, or it has been revoked');
    return { device: presentDevice(device), secret };
  }

  /** Revocation is final: the credential stops working on the next request. */
  async revoke(id: Types.ObjectId, reason: string, actor: DeviceActor) {
    const device = await PaymentDeviceModel.findOneAndUpdate(
      { _id: id, status: 'active' },
      { $set: { status: 'revoked', revokedAt: new Date(), revokedBy: actor.id, revokedReason: reason } },
      { new: true },
    ).lean<PaymentDeviceDoc & { _id: Types.ObjectId }>();
    if (!device) throw ApiError.notFound('Device not found, or it is already revoked');
    return presentDevice(device);
  }

  async list() {
    const devices = await PaymentDeviceModel.find().sort({ createdAt: -1 }).lean<(PaymentDeviceDoc & { _id: Types.ObjectId })[]>();
    return devices.map(presentDevice);
  }

  /**
   * Authenticates a reporting device. Returns null for every failure - unknown
   * id, wrong secret, revoked - so a prober cannot tell which it was.
   */
  async authenticate(deviceId: string, secret: string) {
    if (!deviceId || !secret) return null;
    const device = await PaymentDeviceModel.findOne({ deviceId: deviceId.trim(), status: 'active' })
      .select('+tokenHash')
      .lean<(PaymentDeviceDoc & { _id: Types.ObjectId }) | null>();
    if (!device) return null;

    const presented = Buffer.from(hashToken(secret));
    const stored = Buffer.from(device.tokenHash);
    if (presented.length !== stored.length || !crypto.timingSafeEqual(presented, stored)) return null;

    await PaymentDeviceModel.updateOne({ _id: device._id }, { $set: { lastSeenAt: new Date() } }, { timestamps: false });
    return device;
  }

  /** Counters for the reconciliation screen; never fails the request. */
  async recordOutcome(id: Types.ObjectId, accepted: boolean) {
    await PaymentDeviceModel.updateOne(
      { _id: id },
      { $inc: accepted ? { eventsAccepted: 1 } : { eventsRejected: 1 }, $set: { lastEventAt: new Date() } },
      { timestamps: false },
    );
  }
}

export const paymentDeviceService = new PaymentDeviceService();
