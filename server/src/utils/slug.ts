import crypto from 'crypto';

export const slugify = (input: string): string =>
  input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'store';

/** Appends a short random suffix so slugs stay unique without a retry loop. */
export const uniqueSlug = (input: string): string =>
  `${slugify(input)}-${crypto.randomBytes(3).toString('hex')}`;

/** Derives an uppercase store/SKU code, e.g. "Denim Republic" -> "DENREP". */
export const codeFromName = (input: string, length = 6): string => {
  const letters = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (letters || 'STORE').slice(0, length).padEnd(3, 'X');
};
