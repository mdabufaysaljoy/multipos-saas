import { BRANDING } from '../../../config/branding';
import { escapeHtml } from './format';

export interface EmailButton {
  label: string;
  url: string;
  secondary?: boolean;
}

export interface BrandedEmailInput {
  /** Short text shown by mail clients next to the subject. */
  preheader: string;
  title: string;
  intro: string;
  /** e.g. PAID - shown as a coloured pill beside the title. */
  statusLabel?: string;
  statusTone?: 'success' | 'warning';
  /** Already-escaped HTML for the body sections. */
  bodyHtml: string;
  buttons?: EmailButton[];
  supportEmail?: string;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** A titled block of label/value rows. Values are escaped here. */
export function detailsTable(title: string, rows: [string, string | null | undefined, { strong?: boolean; tone?: 'success' | 'danger' }?][]) {
  const visible = rows.filter(([, value]) => value !== null && value !== undefined && value !== '');
  if (visible.length === 0) return '';
  const cells = visible
    .map(([label, value, options]) => {
      const color = options?.tone === 'success' ? '#15803d' : options?.tone === 'danger' ? '#b91c1c' : '#111827';
      const weight = options?.strong ? '700' : '500';
      const border = options?.strong ? 'border-top:1px solid #e5e7eb;' : '';
      return `<tr>
  <td style="padding:6px 0;${border}font-family:${FONT};font-size:14px;line-height:20px;color:#6b7280;" valign="top">${escapeHtml(label)}</td>
  <td style="padding:6px 0 6px 12px;${border}font-family:${FONT};font-size:14px;line-height:20px;color:${color};font-weight:${weight};text-align:right;" valign="top">${escapeHtml(value)}</td>
</tr>`;
    })
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px 0;">
  <tr><td style="padding:0 0 6px 0;font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#374151;">${escapeHtml(title)}</td></tr>
  <tr><td style="border:1px solid #e5e7eb;border-radius:8px;padding:10px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${cells}</table>
  </td></tr>
</table>`;
}

export const paragraph = (text: string) =>
  `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:15px;line-height:24px;color:#374151;">${escapeHtml(text)}</p>`;

/**
 * The shared branded shell: header, title, body, buttons, footer.
 * Table-based with inline styles, 600px wide and fluid below that, so it holds
 * up in Gmail, Outlook, Apple Mail and on phones. The brand mark is text, so
 * nothing breaks when images are blocked.
 */
export function brandedEmail(input: BrandedEmailInput) {
  const brand = escapeHtml(BRANDING.productName);
  const primary = BRANDING.primaryColor;
  const initial = escapeHtml(BRANDING.productName.charAt(0).toUpperCase());
  const statusColor = input.statusTone === 'warning' ? '#b45309' : '#15803d';
  const statusBg = input.statusTone === 'warning' ? '#fef3c7' : '#dcfce7';
  const website = escapeHtml(BRANDING.websiteUrl);
  const year = new Date().getFullYear();

  const buttons = (input.buttons ?? [])
    .map((button) => {
      const bg = button.secondary ? '#ffffff' : primary;
      const fg = button.secondary ? primary : '#ffffff';
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-table;margin:0 8px 10px 0;">
  <tr><td align="center" bgcolor="${bg}" style="border-radius:8px;border:1px solid ${primary};">
    <a href="${escapeHtml(button.url)}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;color:${fg};text-decoration:none;border-radius:8px;">${escapeHtml(button.label)}</a>
  </td></tr>
</table>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(input.title)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f3f4f6;">${escapeHtml(input.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f4f6">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
    <tr><td style="padding:0 0 16px 4px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td bgcolor="${primary}" width="36" height="36" align="center" style="border-radius:8px;font-family:${FONT};font-size:18px;font-weight:700;color:#ffffff;">${initial}</td>
        <td style="padding-left:10px;font-family:${FONT};font-size:18px;font-weight:700;color:#111827;">${brand}</td>
      </tr></table>
    </td></tr>
    <tr><td bgcolor="#ffffff" style="border-radius:12px;border-top:4px solid ${primary};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="padding:28px 28px 8px 28px;">
          ${input.statusLabel ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px 0;"><tr><td bgcolor="${statusBg}" style="border-radius:999px;padding:4px 12px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.06em;color:${statusColor};">${escapeHtml(input.statusLabel)}</td></tr></table>` : ''}
          <h1 style="margin:0 0 8px 0;font-family:${FONT};font-size:24px;line-height:32px;font-weight:700;color:#111827;">${escapeHtml(input.title)}</h1>
          <p style="margin:0 0 24px 0;font-family:${FONT};font-size:15px;line-height:24px;color:#4b5563;">${escapeHtml(input.intro)}</p>
        </td></tr>
        <tr><td style="padding:0 28px 8px 28px;">${input.bodyHtml}</td></tr>
        ${buttons ? `<tr><td style="padding:0 28px 18px 28px;">${buttons}</td></tr>` : ''}
      </table>
    </td></tr>
    <tr><td style="padding:20px 8px 0 8px;font-family:${FONT};font-size:12px;line-height:18px;color:#6b7280;text-align:center;">
      <p style="margin:0 0 6px 0;">Subscription &amp; Billing Notification from ${brand}</p>
      ${input.supportEmail ? `<p style="margin:0 0 6px 0;">Questions? Contact <a href="mailto:${escapeHtml(input.supportEmail)}" style="color:${primary};text-decoration:none;">${escapeHtml(input.supportEmail)}</a></p>` : ''}
      <p style="margin:0 0 6px 0;"><a href="${website}" style="color:${primary};text-decoration:none;">${website.replace(/^https?:\/\//, '')}</a></p>
      <p style="margin:0;">&copy; ${year} ${brand}</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}
