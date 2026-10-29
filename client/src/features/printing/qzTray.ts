import { get, post } from '@/api/client';
import type { PrintAgentProfile } from './printAgent';

/**
 * QZ Tray as a print agent profile. Behaviour is unchanged from when it was the
 * only agent: the connection itself lives in `printAgent.ts`, this file only
 * says how QZ Tray is identified and reached.
 *
 * Requests are signed by the SERVER (the private key never reaches the
 * browser). Without a configured key QZ runs unsigned and asks the user to
 * allow the site on every session - fine for development, never a
 * "trust everything" hack. That prompt, and its greyed-out "Remember" box, is
 * why NanoPrint exists as an alternative; see docs/NANOPRINT_SETUP.md.
 */
export const qzAgent: PrintAgentProfile = {
  id: 'qz',
  label: 'QZ Tray',
  download: 'qz.io/download',
  supportsPixel: true,
  configure(qz, onSigned) {
    qz.security.setCertificatePromise((resolve) => {
      get<{ configured: boolean; certificate: string | null }>('/printing/qz/certificate')
        .then((result) => {
          onSigned(result.configured);
          // An empty certificate = unsigned (anonymous) mode.
          resolve(result.configured && result.certificate ? result.certificate : '');
        })
        .catch(() => {
          onSigned(false);
          resolve('');
        });
    });
    qz.security.setSignatureAlgorithm('SHA512');
    qz.security.setSignaturePromise((toSign) => (resolve) => {
      post<{ configured: boolean; signature: string | null }>('/printing/qz/sign', { request: toSign })
        .then((result) => resolve(result.signature ?? ''))
        .catch(() => resolve(''));
    });
  },
  connectOptions: () => ({ retries: 1, delay: 1 }),
};
