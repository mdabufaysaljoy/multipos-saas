import { env, isProd } from '../../config/env';
import { logger } from '../../utils/logger';
import { LocalStorageProvider } from './local.provider';
import type { StorageProvider } from './StorageProvider';

const build = (): StorageProvider => {
  switch (env.STORAGE_DRIVER) {
    case 's3':
    case 'cloudinary': {
      // These adapters are not written yet. Silently falling back used to look
      // harmless, but in production it means an operator who configured S3 gets
      // files written to a container's local disk instead - lost on the next
      // deploy, with the storage ledger insisting they exist.
      const message =
        `STORAGE_DRIVER is "${env.STORAGE_DRIVER}", but only the "local" driver is implemented in this build.`;
      if (isProd) throw new Error(`${message} Refusing to start rather than write uploads to local disk.`);
      logger.warn(`${message} Falling back to local storage for development.`);
      return new LocalStorageProvider();
    }
    case 'local':
    default:
      return new LocalStorageProvider();
  }
};

export const storage: StorageProvider = build();
export type { StorageProvider, StoredFile, StoredObject } from './StorageProvider';
