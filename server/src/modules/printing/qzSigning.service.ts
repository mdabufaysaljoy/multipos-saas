import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';

/**
 * QZ Tray request signing.
 *
 * QZ Tray trusts a website when each request it receives is signed with a key
 * whose certificate QZ trusts. The key stays HERE on the server; the browser
 * only ever receives the public certificate and signatures of the exact
 * request strings QZ asked it to sign.
 */
interface SigningMaterial {
  certificate: string;
  privateKey: KeyObject;
}

let cached: SigningMaterial | null | undefined;

const pem = (inline: string | undefined, file: string | undefined): string | null => {
  if (inline && inline.trim()) return inline.replace(/\\n/g, '\n').trim();
  if (file) return fs.readFileSync(file, 'utf8').trim();
  return null;
};

function load(): SigningMaterial | null {
  if (cached !== undefined) return cached;
  try {
    const certificate = pem(env.QZ_CERTIFICATE, env.QZ_CERTIFICATE_PATH);
    const key = pem(env.QZ_PRIVATE_KEY, env.QZ_PRIVATE_KEY_PATH);
    if (!certificate || !key) {
      cached = null;
      return cached;
    }
    cached = { certificate, privateKey: createPrivateKey(key) };
  } catch (error) {
    // A misconfigured key must not take the API down; printing falls back to unsigned.
    logger.error('QZ Tray signing is configured but the certificate or key could not be loaded', { error: String(error) });
    cached = null;
  }
  return cached;
}

export const qzSigning = {
  isConfigured: () => load() !== null,
  certificate: () => load()?.certificate ?? null,
  /** RSA-SHA512 signature (base64) - QZ is told to expect SHA512. */
  sign(request: string): string | null {
    const material = load();
    if (!material) return null;
    return createSign('RSA-SHA512').update(request, 'utf8').sign(material.privateKey, 'base64');
  },
  /** Test hook only. */
  reset() {
    cached = undefined;
  },
};
