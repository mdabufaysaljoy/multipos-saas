/**
 * Moves SMS gateway credentials from environment variables into platform
 * settings.
 *
 * They used to be read from `process.env` once at module load, so rotating a
 * key meant a redeploy. They now live in the database where a platform admin
 * can change them at runtime. This copies whatever the environment currently
 * holds so an existing deployment keeps sending without interruption.
 *
 * Idempotent: a workspace that already has a stored key is left alone, so
 * re-running this can never overwrite a key set through the admin UI with a
 * stale one from the environment.
 *
 * Run with:  npm run migrate:sms-credentials -w server
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { PlatformSettingsModel } from '../models/PlatformSettings';

export async function migrateSmsCredentials(): Promise<{ moved: boolean; reason: string }> {
  const existing = await PlatformSettingsModel.findOne({ key: 'platform' }).select('+sms.apiKey').lean();

  if (existing?.sms?.apiKey) {
    return { moved: false, reason: 'a gateway key is already stored; environment values ignored' };
  }

  const apiKey = process.env.ALPHA_SMS_API_KEY ?? '';
  if (!apiKey) {
    return { moved: false, reason: 'no ALPHA_SMS_API_KEY in the environment; nothing to move' };
  }

  await PlatformSettingsModel.updateOne(
    { key: 'platform' },
    {
      $set: {
        'sms.provider': 'alpha',
        'sms.apiKey': apiKey,
        'sms.baseUrl': process.env.ALPHA_SMS_BASE_URL || 'https://api.sms.net.bd',
        'sms.senderId': process.env.ALPHA_SMS_SENDER_ID ?? '',
        'sms.enabled': true,
      },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );

  return { moved: true, reason: 'copied from the environment' };
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const result = await migrateSmsCredentials();
  // Never log the key itself.
  logger.info('SMS credential migration complete', result);
  await mongoose.disconnect();
}

if (process.argv[1]?.includes('migrateSmsCredentials')) {
  main().catch((error) => {
    logger.error('SMS credential migration failed', { error: String(error) });
    process.exit(1);
  });
}
