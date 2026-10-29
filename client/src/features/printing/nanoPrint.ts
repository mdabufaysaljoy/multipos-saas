import { loadPrinterSettings } from './printerSettings';
import type { PrintAgentProfile } from './printAgent';

/**
 * NanoPrint as a print agent profile.
 *
 * NanoPrint (https://github.com/nanofactura/nanoprint) is a local print agent
 * that speaks the QZ Tray client protocol, so the official `qz-tray` client
 * drives it unchanged and the printed bytes are identical to QZ Tray's.
 *
 * What differs, and why a till might prefer it:
 *
 * - **No signing.** NanoPrint decides by the page's origin, not by a
 *   certificate. There is no key to buy, no `override.crt` to copy onto every
 *   computer, and nothing for the server to sign - the certificate and
 *   signature endpoints are not called at all.
 * - **"Remember this decision" works.** It asks once per site, and remembers
 *   the answer for https sites and http://localhost. QZ Tray greys that box out
 *   for unsigned requests, which is why it asks again on every print.
 * - **Raw ESC/POS only.** `type: 'pixel'` (the "Windows driver (image)"
 *   printer language) is refused, so that combination is blocked in Settings
 *   and by the print service.
 *
 * The identity object below is NanoPrint-specific and purely cosmetic: it is
 * what the prompt shows under the origin as "calls itself …". NanoPrint ignores
 * any other value in that field, and QZ Tray never sees it.
 */
export const nanoPrintAgent: PrintAgentProfile = {
  id: 'nanoprint',
  label: 'NanoPrint',
  download: 'github.com/nanofactura/nanoprint/releases',
  supportsPixel: false,
  configure(qz, onSigned) {
    // Signing does not apply to NanoPrint: the permission is per origin.
    onSigned(null);
    qz.security.setCertificatePromise((resolve) => {
      // Read at connect time, so changing the name in Settings takes effect on the next connection.
      resolve(JSON.stringify({ nanoprint: { name: loadPrinterSettings().nanoSiteName } }));
    });
    // NanoPrint accepts and ignores the signature. Resolving an empty string
    // locally keeps the server out of the print path entirely.
    qz.security.setSignaturePromise(() => (resolve) => resolve(''));
  },
  connectOptions: (settings) => {
    const secure = settings.nanoSecurePort;
    const insecure = settings.nanoInsecurePort;
    return {
      retries: 1,
      delay: 1,
      // Only passed when the ports were moved off NanoPrint's defaults, which
      // a till has to do when QZ Tray is installed alongside it: both programs
      // listen on the same ports and whichever starts first takes them.
      ...(secure || insecure
        ? { port: { ...(secure ? { secure: [secure] } : {}), ...(insecure ? { insecure: [insecure] } : {}) } }
        : {}),
    };
  },
};
