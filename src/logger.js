// Tiny structured logger. No dependency. Output mode auto-detects:
//
//   - TTY (interactive shell): pretty single-line with a level color.
//   - Non-TTY (piped, redirected to a file, run under a supervisor): JSON
//     lines suitable for ingest into a log collector.
//
// Override with LOG_FORMAT=json or LOG_FORMAT=pretty. Override level with
// LOG_LEVEL=debug|info|warn|error (default info).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', reset: '\x1b[0m' };

const explicitFormat = (process.env.LOG_FORMAT || '').toLowerCase();
const explicitLevel = (process.env.LOG_LEVEL || '').toLowerCase();

const minLevel = LEVELS[explicitLevel] ?? LEVELS.info;
const useJson = explicitFormat === 'json' || (!explicitFormat && !process.stdout.isTTY);

function emit(level, msg, fields) {
  if (LEVELS[level] < minLevel) return;
  const time = new Date().toISOString();
  if (useJson) {
    const obj = { time, level, msg, pid: process.pid };
    if (fields && typeof fields === 'object') Object.assign(obj, fields);
    process.stdout.write(JSON.stringify(obj) + '\n');
  } else {
    const color = COLORS[level] || '';
    const head = `${color}[${time} ${level.toUpperCase().padEnd(5)}]${COLORS.reset} ${msg}`;
    if (fields && Object.keys(fields).length > 0) {
      const tail = Object.entries(fields)
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ');
      process.stdout.write(`${head} ${COLORS.debug}${tail}${COLORS.reset}\n`);
    } else {
      process.stdout.write(`${head}\n`);
    }
  }
}

export const logger = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => {
    // Auto-extract stack from Error instances passed in fields.err
    if (fields?.err instanceof Error) {
      const { message, stack, name } = fields.err;
      fields = { ...fields, err: { name, message, stack } };
    }
    emit('error', msg, fields);
  },
  child: (defaults) => ({
    debug: (msg, fields) => emit('debug', msg, { ...defaults, ...fields }),
    info: (msg, fields) => emit('info', msg, { ...defaults, ...fields }),
    warn: (msg, fields) => emit('warn', msg, { ...defaults, ...fields }),
    error: (msg, fields) => {
      if (fields?.err instanceof Error) {
        const { message, stack, name } = fields.err;
        fields = { ...fields, err: { name, message, stack } };
      }
      emit('error', msg, { ...defaults, ...fields });
    },
  }),
};
