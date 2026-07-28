/**
 * Deliberately tiny logger. One line per event, prefixed, no dependencies.
 *
 * Rule that outlives this file: log ids, never content. Names, photos, notes and
 * story text are the most private things a family owns.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): LogLevel {
  const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
  return raw in LEVEL_ORDER ? (raw as LogLevel) : 'info';
}

export type Logger = {
  debug: (message: string, fields?: Record<string, unknown>) => void;
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
  child: (scope: string) => Logger;
};

function format(scope: string, message: string, fields?: Record<string, unknown>): string {
  const time = new Date().toISOString();
  const extras =
    fields && Object.keys(fields).length > 0
      ? ' ' +
        Object.entries(fields)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' ')
      : '';
  return `${time} [${scope}] ${message}${extras}`;
}

export function createLogger(scope = 'worker'): Logger {
  const emit = (level: LogLevel) => (message: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;
    const line = format(scope, message, fields);
    // eslint-disable-next-line no-console
    if (level === 'error') console.error(line);
    // eslint-disable-next-line no-console
    else if (level === 'warn') console.warn(line);
    // eslint-disable-next-line no-console
    else console.log(line);
  };

  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (childScope: string) => createLogger(`${scope}:${childScope}`),
  };
}

export const log = createLogger();
