import axios, { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import type { ApiErrorBody, ApiEnvelope, PageMeta } from '@/types/api';

const ACCESS_TOKEN_KEY = 'pos.accessToken';
const STORE_KEY = 'pos.storeId';

export const tokenStore = {
  get: () => localStorage.getItem(ACCESS_TOKEN_KEY),
  set: (token: string) => localStorage.setItem(ACCESS_TOKEN_KEY, token),
  clear: () => localStorage.removeItem(ACCESS_TOKEN_KEY),
};

export const storeIdStore = {
  get: () => localStorage.getItem(STORE_KEY),
  set: (id: string) => localStorage.setItem(STORE_KEY, id),
  clear: () => localStorage.removeItem(STORE_KEY),
};

/** A normalised error every screen can render without unwrapping axios. */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level messages from a Zod failure, keyed by path. */
  get fieldErrors(): Record<string, string> {
    if (!Array.isArray(this.details)) return {};
    const out: Record<string, string> = {};
    for (const issue of this.details as { path?: string; message?: string }[]) {
      if (issue.path && issue.message) out[issue.path] = issue.message;
    }
    return out;
  }
}

export const http: AxiosInstance = axios.create({
  baseURL: '/api',
  withCredentials: true,
  timeout: 30_000,
});

http.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = tokenStore.get();
  if (token) config.headers.Authorization = `Bearer ${token}`;

  // The active store travels as a header; the backend still verifies the caller
  // actually owns it, so this is a convenience rather than a trust boundary.
  const storeId = storeIdStore.get();
  if (storeId) config.headers['x-store-id'] = storeId;

  return config;
});

let refreshPromise: Promise<string> | null = null;
let onSessionExpired: (() => void) | null = null;

export const setSessionExpiredHandler = (handler: () => void) => {
  onSessionExpired = handler;
};

async function refreshAccessToken(): Promise<string> {
  // A single in-flight refresh is shared by every queued request, so a burst of
  // 401s does not trigger a burst of refreshes (which token rotation would
  // treat as replay and punish by revoking the whole family).
  if (!refreshPromise) {
    refreshPromise = axios
      .post<ApiEnvelope<{ accessToken: string }>>('/api/auth/refresh', {}, { withCredentials: true })
      .then((res) => {
        const token = res.data.data.accessToken;
        tokenStore.set(token);
        return token;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

http.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiErrorBody>) => {
    const original = error.config as InternalAxiosRequestConfig & { _retried?: boolean };
    const status = error.response?.status ?? 0;

    const isAuthEndpoint = original?.url?.includes('/auth/refresh') || original?.url?.includes('/auth/login');

    if (status === 401 && original && !original._retried && !isAuthEndpoint) {
      original._retried = true;
      try {
        const token = await refreshAccessToken();
        original.headers.Authorization = `Bearer ${token}`;
        return http(original);
      } catch {
        tokenStore.clear();
        onSessionExpired?.();
      }
    }

    const body = error.response?.data;
    if (body && 'error' in body) {
      throw new ApiError(body.error.code, body.error.message, status, body.error.details);
    }

    if (error.code === 'ECONNABORTED') {
      throw new ApiError('TIMEOUT', 'The request took too long. Check your connection and try again.', 0);
    }

    throw new ApiError(
      'NETWORK',
      status === 0 ? 'Cannot reach the server. Is it running?' : error.message,
      status,
    );
  },
);

/** Unwraps `{ success, data }` so callers work with the payload directly. */
export async function get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const res = await http.get<ApiEnvelope<T>>(url, { params });
  return res.data.data;
}

/** Same as `get`, but keeps the pagination meta. */
export async function getPaginated<T>(url: string, params?: Record<string, unknown>): Promise<{ items: T[]; meta: PageMeta }> {
  const res = await http.get<ApiEnvelope<T[]>>(url, { params });
  return {
    items: res.data.data,
    meta: res.data.meta ?? { page: 1, limit: res.data.data.length, total: res.data.data.length, totalPages: 1 },
  };
}

/**
 * Downloads a generated file (data export). The browser saves it; nothing is
 * stored on the server, so this is a normal authenticated POST that streams.
 */
export async function postDownload(url: string, body?: unknown): Promise<{ blob: Blob; filename: string }> {
  const res = await http.post<Blob>(url, body, { responseType: 'blob' });
  const disposition = String(res.headers['content-disposition'] ?? '');
  const match = /filename="?([^"]+)"?/.exec(disposition);
  return { blob: res.data, filename: match?.[1] ?? 'export' };
}

export async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await http.post<ApiEnvelope<T>>(url, body);
  return res.data.data;
}

export async function patch<T>(url: string, body?: unknown): Promise<T> {
  const res = await http.patch<ApiEnvelope<T>>(url, body);
  return res.data.data;
}

export async function del<T>(url: string): Promise<T> {
  const res = await http.delete<ApiEnvelope<T>>(url);
  return res.data.data;
}
