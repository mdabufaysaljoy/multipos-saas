import crypto from 'crypto';

/**
 * Amazon SNS message signature verification.
 *
 * bKash delivers payment notifications through Amazon SNS. A message is only
 * genuine if its signature verifies against the certificate AWS publishes at
 * `SigningCertURL` - and that URL must itself be an AWS SNS host, or anyone
 * could sign a message with their own certificate and point at it.
 *
 * Verifying the signature proves AWS delivered the message. It does NOT prove
 * which topic sent it (anyone can create an SNS topic), so callers must also
 * match `TopicArn` against the topic they subscribed to.
 */

export interface SnsMessage {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
}

/** The fields AWS signs, in the order it signs them, per message type. */
const SIGNED_FIELDS: Record<string, (keyof SnsMessage)[]> = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
  UnsubscribeConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
};

const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

/** An https URL on an AWS SNS host - the only place certificates or confirmations may come from. */
export function isAwsSnsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && SNS_HOST.test(url.hostname) && !url.username && !url.password && !url.port;
  } catch {
    return false;
  }
}

/** Parses a raw body into an SNS message shape, or null. */
export function parseSnsMessage(raw: unknown): SnsMessage | null {
  let value: unknown = raw;
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  const required: (keyof SnsMessage)[] = ['Type', 'MessageId', 'TopicArn', 'Message', 'Timestamp', 'SignatureVersion', 'Signature', 'SigningCertURL'];
  if (!required.every((key) => typeof message[key] === 'string')) return null;
  if (!SIGNED_FIELDS[message.Type as string]) return null;
  return message as unknown as SnsMessage;
}

/** The exact string AWS signed. */
export function canonicalSnsString(message: SnsMessage): string {
  return SIGNED_FIELDS[message.Type]
    .filter((key) => typeof message[key] === 'string')
    .map((key) => `${key}\n${message[key]}\n`)
    .join('');
}

export type CertFetcher = (url: string) => Promise<string>;

export async function verifySnsSignature(message: SnsMessage, fetchCert: CertFetcher): Promise<boolean> {
  if (!SIGNED_FIELDS[message.Type]) return false;
  // Checked BEFORE any request is made, so a forged URL is never fetched.
  if (!isAwsSnsUrl(message.SigningCertURL) || !new URL(message.SigningCertURL).pathname.endsWith('.pem')) return false;
  if (message.Type !== 'Notification' && !isAwsSnsUrl(message.SubscribeURL)) return false;

  const algorithm = message.SignatureVersion === '1' ? 'RSA-SHA1' : message.SignatureVersion === '2' ? 'RSA-SHA256' : null;
  if (!algorithm) return false;

  try {
    const certificate = await fetchCert(message.SigningCertURL);
    const verifier = crypto.createVerify(algorithm);
    verifier.update(canonicalSnsString(message), 'utf8');
    return verifier.verify(certificate, message.Signature, 'base64');
  } catch {
    return false;
  }
}

const certificateCache = new Map<string, Promise<string>>();

/** Fetches (and caches) an AWS signing certificate. Refuses anything that is not an AWS SNS URL. */
export const fetchAwsCertificate: CertFetcher = (url) => {
  if (!isAwsSnsUrl(url)) return Promise.reject(new Error('Refusing to fetch a certificate from a non-AWS host'));
  let pending = certificateCache.get(url);
  if (!pending) {
    pending = fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' }).then(async (response) => {
      if (!response.ok) throw new Error(`Certificate fetch failed with ${response.status}`);
      const pem = await response.text();
      if (!pem.includes('BEGIN CERTIFICATE')) throw new Error('The signing certificate is not a PEM certificate');
      return pem;
    });
    // A failed fetch must not be cached forever.
    pending.catch(() => certificateCache.delete(url));
    certificateCache.set(url, pending);
  }
  return pending;
};

/** Confirms an SNS subscription by visiting its SubscribeURL (AWS hosts only). */
export async function confirmSnsSubscription(url: string): Promise<void> {
  if (!isAwsSnsUrl(url)) throw new Error('Refusing to confirm a subscription on a non-AWS host');
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!response.ok) throw new Error(`Subscription confirmation failed with ${response.status}`);
}
