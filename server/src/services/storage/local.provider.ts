import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import type { StorageProvider, StoredFile } from './StorageProvider';

export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';

  constructor(
    private readonly rootDir = path.resolve(process.cwd(), env.STORAGE_LOCAL_DIR),
    private readonly publicBaseUrl = env.PUBLIC_BASE_URL,
  ) {}

  async save(input: { buffer: Buffer; originalName: string; mimeType: string; folder: string }): Promise<StoredFile> {
    const ext = path.extname(input.originalName).toLowerCase().slice(0, 10) || '.bin';
    // Random filename: user input never becomes a path component.
    const filename = `${crypto.randomUUID()}${ext}`;
    const folder = input.folder.replace(/[^a-zA-Z0-9/_-]/g, '');
    const dir = path.join(this.rootDir, folder);

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, filename), input.buffer);

    const key = path.posix.join(folder, filename);
    return { url: this.getUrl(key), key, size: input.buffer.byteLength, mimeType: input.mimeType };
  }

  async delete(key: string): Promise<void> {
    const target = path.resolve(this.rootDir, key);
    // Refuse to touch anything outside the storage root.
    if (!target.startsWith(path.resolve(this.rootDir))) {
      logger.warn('Refused to delete a file outside the storage root', { key });
      return;
    }
    await fs.rm(target, { force: true });
  }

  getUrl(key: string): string {
    return `${this.publicBaseUrl.replace(/\/$/, '')}/${env.STORAGE_LOCAL_DIR}/${key}`;
  }
}
