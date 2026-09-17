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
/** One object already in storage, as reported by the provider. */
export interface StoredObject {
  key: string;
  bytes: number;
  /** When the provider exposes it. */
  createdAt?: Date;
}

export interface StorageProvider {
  readonly name: string;
  save(input: { buffer: Buffer; originalName: string; mimeType: string; folder: string }): Promise<StoredFile>;
  delete(key: string): Promise<void>;
  getUrl(key: string): string;

  /**
   * Every object under `prefix`, with its size.
   *
   * Optional because not every backend can enumerate cheaply. A provider that
   * cannot MUST leave this undefined rather than returning a partial list -
   * the storage backfill refuses to run instead of silently computing a usage
   * figure that is too low.
   *
   * Implementations must report size from metadata (a HEAD or stat), never by
   * downloading the object.
   */
  list?(prefix: string): Promise<StoredObject[]>;

  /** Size of a single object, from metadata. Used to verify a known key. */
  stat?(key: string): Promise<StoredObject | null>;
}
