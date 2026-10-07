import { BRANDING } from '../../../config/branding';
import { escapeHtml, oneLine } from './format';
import { brandedEmail, paragraph } from './layout';

/**
 * Account-security mail: not billing, not marketing, and never wallet-billed.
 *
 * It uses the same branded shell as every other transactional email, with the
 * footer line corrected - a password-reset notice is not a "Subscription &
 * Billing Notification".
 */

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export interface PasswordResetEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * The reset code, big enough to read off a phone and copy by hand.
 *
 * There is deliberately no link. The code is typed back into the page the
 * person already has open, so nothing reset-related ever travels in a URL
 * where it could land in browser history, a proxy log or a referrer header.
 */
export function passwordResetEmail(input: { code: string; expiresInMinutes: number; supportEmail?: string }): PasswordResetEmail {
  const brand = BRANDING.productName;
  const minutes = input.expiresInMinutes;
  const codeBlock = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px 0;">
  <tr><td align="center" bgcolor="#f9fafb" style="border:1px solid #e5e7eb;border-radius:10px;padding:18px 12px;">
    <div style="font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280;">Your reset code</div>
    <div style="margin-top:8px;font-family:${FONT};font-size:34px;line-height:40px;font-weight:700;letter-spacing:8px;color:#111827;">${escapeHtml(input.code)}</div>
    <div style="margin-top:8px;font-family:${FONT};font-size:13px;line-height:18px;color:#6b7280;">Expires in ${minutes} minutes</div>
  </td></tr>
</table>`;

  const warning = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px 0;">
  <tr><td bgcolor="#fffbeb" style="border:1px solid #fde68a;border-radius:10px;padding:14px 16px;">
    <p style="margin:0;font-family:${FONT};font-size:14px;line-height:21px;color:#92400e;">
      <strong>If you did not ask to reset your password, ignore this email.</strong> Your password has not changed and
      your account is still safe. Nobody from ${escapeHtml(brand)} will ever ask you for this code - not by phone, not
      by message, not by email. Do not share it with anyone.
    </p>
  </td></tr>
</table>`;

  return {
    subject: oneLine(`${input.code} is your ${brand} password reset code`),
    html: brandedEmail({
      preheader: `Your ${brand} password reset code expires in ${minutes} minutes.`,
      title: 'Reset your password',
      intro: `Enter this code on the ${brand} password reset screen to choose a new password.`,
      bodyHtml: `${codeBlock}${paragraph('The code works once. Asking for a new one replaces it, and setting a new password signs you out everywhere else.')}${warning}`,
      footerNote: `Account security notice from ${brand}`,
      ...(input.supportEmail ? { supportEmail: input.supportEmail } : {}),
    }),
    text: [
      `${input.code} is your ${brand} password reset code.`,
      ``,
      `Enter it on the password reset screen to choose a new password. It expires in ${minutes} minutes and works once.`,
      ``,
      `If you did not ask to reset your password, ignore this email - your password has not changed.`,
      `Nobody from ${brand} will ever ask you for this code. Do not share it with anyone.`,
    ].join('\n'),
  };
}
