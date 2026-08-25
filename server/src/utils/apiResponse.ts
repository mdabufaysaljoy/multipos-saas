import type { Response } from 'express';

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export const ok = <T>(res: Response, data: T, meta?: Record<string, unknown>) =>
  res.status(200).json({ success: true, data, ...(meta ? { meta } : {}) });

export const created = <T>(res: Response, data: T) =>
  res.status(201).json({ success: true, data });

export const noContent = (res: Response) => res.status(204).send();

export const paginated = <T>(res: Response, items: T[], meta: PageMeta) =>
  res.status(200).json({ success: true, data: items, meta });

export const buildPageMeta = (page: number, limit: number, total: number): PageMeta => ({
  page,
  limit,
  total,
  totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
});
