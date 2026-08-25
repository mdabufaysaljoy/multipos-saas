import { env } from '../../config/env';
import { LocalStorageProvider } from './local.provider';
import type { StorageProvider } from './StorageProvider';

const build = (): StorageProvider => {
  switch (env.STORAGE_DRIVER) {
    case 's3':
    case 'cloudinary':
      // Implementations land in phase 2; falling back keeps development working
      // rather than crashing on a config value that is not wired up yet.
      return new LocalStorageProvider();
    case 'local':
    default:
      return new LocalStorageProvider();
  }
};

export const storage: StorageProvider = build();
export type { StorageProvider, StoredFile } from './StorageProvider';
