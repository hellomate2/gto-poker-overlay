// Tiny leveled logger. Debug output is silenced unless explicitly enabled, so
// the production bundle stays quiet. Flip the level from the devtools console
// with `localStorage.setItem('gto:logLevel', 'debug')`.

type Level = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };
const PREFIX = '[GTO]';

function currentLevel(): Level {
  try {
    const stored = localStorage.getItem('gto:logLevel') as Level | null;
    if (stored && stored in ORDER) return stored;
  } catch {
    // localStorage may be unavailable in a worker context.
  }
  return 'warn';
}

function enabled(level: Level): boolean {
  return ORDER[level] >= ORDER[currentLevel()];
}

export const log = {
  debug: (...args: unknown[]) => { if (enabled('debug')) console.debug(PREFIX, ...args); },
  info: (...args: unknown[]) => { if (enabled('info')) console.info(PREFIX, ...args); },
  warn: (...args: unknown[]) => { if (enabled('warn')) console.warn(PREFIX, ...args); },
  error: (...args: unknown[]) => { if (enabled('error')) console.error(PREFIX, ...args); },
};
