import type { PosShift, PosShiftDetail } from '@/types/posShift';
import { get, getPaginated, post } from './client';

type Query = Record<string, unknown>;

export const posShiftsApi = {
  current: () => get<PosShiftDetail | null>('/pos-shifts/current'),
  open: (body: { openingFloatMinor: number; note?: string }) => post<PosShiftDetail>('/pos-shifts', body),
  movement: (id: string, body: { type: 'pay_in' | 'pay_out'; amountMinor: number; reason: string }) =>
    post<PosShiftDetail>(`/pos-shifts/${id}/cash-movements`, body),
  close: (id: string, body: { countedCashMinor: number; note?: string }) =>
    post<PosShiftDetail>(`/pos-shifts/${id}/close`, body),
  list: (params?: Query) => getPaginated<PosShift>('/pos-shifts', params),
  get: (id: string) => get<PosShiftDetail>(`/pos-shifts/${id}`),
};
