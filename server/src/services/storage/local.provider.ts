import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import type { StorageProvider, StoredFile, StoredObject } from './StorageProvider';

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

  /**
   * Every file under `prefix`, with its size from `stat` - the local
   * equivalent of an object-store HEAD, so nothing is read into memory.
   */
  async list(prefix: string): Promise<StoredObject[]> {
    const root = path.resolve(process.cwd(), env.STORAGE_LOCAL_DIR);
    const start = path.resolve(root, prefix);

    // A prefix must never escape the storage root.
    if (!start.startsWith(root)) {
      logger.warn('Refused to list a path outside the storage root', { prefix });
      return [];
    }

    const found: StoredObject[] = [];

    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // Missing directory simply holds nothing.
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else {
          const stat = await fs.stat(full).catch(() => null);
          if (!stat) continue; // Deleted between listing and stat.
          found.push({ key: path.relative(root, full), bytes: stat.size, createdAt: stat.birthtime });
        }
      }
    };

    await walk(start);
    return found;
  }

  async stat(key: string): Promise<StoredObject | null> {
    const root = path.resolve(process.cwd(), env.STORAGE_LOCAL_DIR);
    const full = path.resolve(root, key);
    if (!full.startsWith(root)) return null;

    const stat = await fs.stat(full).catch(() => null);
    if (!stat || !stat.isFile()) return null;
    return { key, bytes: stat.size, createdAt: stat.birthtime };
  }

  getUrl(key: string): string {
    return `${this.publicBaseUrl.replace(/\/$/, '')}/${env.STORAGE_LOCAL_DIR}/${key}`;
  }
}
