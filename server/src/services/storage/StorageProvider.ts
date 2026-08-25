export interface StoredFile {
  /** Publicly reachable URL. */
  url: string;
  /** Driver-specific handle used for deletion. */
  key: string;
  size: number;
  mimeType: string;
}

/**
 * Image storage is abstracted so the app is never welded to the local disk.
 * Swapping in S3 or Cloudinary means adding an implementation and changing
 * STORAGE_DRIVER - no call site changes.
 */
export interface StorageProvider {
  readonly name: string;
  save(input: { buffer: Buffer; originalName: string; mimeType: string; folder: string }): Promise<StoredFile>;
  delete(key: string): Promise<void>;
  getUrl(key: string): string;
}
