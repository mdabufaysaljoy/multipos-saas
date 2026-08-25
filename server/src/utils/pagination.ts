import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../config/constants';

export interface PageInput {
  page?: number;
  limit?: number;
}

export interface ResolvedPage {
  page: number;
  limit: number;
  skip: number;
}

export function resolvePage(input: PageInput): ResolvedPage {
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(input.limit ?? DEFAULT_PAGE_SIZE)));
  return { page, limit, skip: (page - 1) * limit };
}

/** Escapes a user-supplied search string for safe use inside a RegExp. */
export const escapeRegex = (input: string): string => input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const searchRegex = (term: string) => new RegExp(escapeRegex(term.trim()), 'i');
