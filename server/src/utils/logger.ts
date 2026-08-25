import { isProd } from '../config/env';

type Level = 'debug' | 'info' | 'warn' | 'error';

const emit = (level: Level, message: string, meta?: unknown) => {
  if (level === 'debug' && isProd) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (meta !== undefined) fn(line, meta);
  else fn(line);
};

export const logger = {
  debug: (m: string, meta?: unknown) => emit('debug', m, meta),
  info: (m: string, meta?: unknown) => emit('info', m, meta),
  warn: (m: string, meta?: unknown) => emit('warn', m, meta),
  error: (m: string, meta?: unknown) => emit('error', m, meta),
};
