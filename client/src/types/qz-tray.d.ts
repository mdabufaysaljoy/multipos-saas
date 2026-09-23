/**
 * Minimal declarations for the official QZ Tray client (npm `qz-tray`, 2.x).
 * Only the calls the printing service uses are declared.
 */
declare module 'qz-tray' {
  type Resolver<T> = (resolve: (value: T) => void, reject: (reason?: unknown) => void) => void;

  interface QzConfig {
    reconfigure(options: Record<string, unknown>): void;
  }

  interface QzPrintData {
    type: 'raw' | 'pixel';
    format: 'command' | 'image' | 'html' | 'pdf';
    flavor?: 'base64' | 'plain' | 'hex' | 'file';
    data: string;
    options?: Record<string, unknown>;
  }

  export interface Qz {
    version: string;
    websocket: {
      connect(options?: { retries?: number; delay?: number; host?: string | string[]; usingSecure?: boolean }): Promise<void>;
      disconnect(): Promise<void>;
      isActive(): boolean;
      setClosedCallbacks(callbacks: ((event: unknown) => void) | ((event: unknown) => void)[]): void;
      setErrorCallbacks(callbacks: ((event: unknown) => void) | ((event: unknown) => void)[]): void;
    };
    printers: {
      find(query?: string): Promise<string | string[]>;
      getDefault(): Promise<string>;
    };
    configs: {
      create(printer: string | { name: string }, options?: Record<string, unknown>): QzConfig;
    };
    print(config: QzConfig, data: (QzPrintData | string)[]): Promise<void>;
    security: {
      setCertificatePromise(handler: Resolver<string>, options?: { rejectOnFailure?: boolean }): void;
      setSignaturePromise(factory: (toSign: string) => Resolver<string>): void;
      setSignatureAlgorithm(algorithm: 'SHA1' | 'SHA256' | 'SHA512'): void;
    };
    api: {
      getVersion(): Promise<string>;
    };
  }

  const qz: Qz;
  export default qz;
}
