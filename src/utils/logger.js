const fs = require('fs');
const path = require('path');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

const LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];

const LOG_DIR =
  process.env.LOG_DIR || path.join(process.cwd(), 'data', 'logs');
const LOG_TO_STDOUT = process.env.LOG_TO_STDOUT !== 'false';
const LOG_TO_FILE = process.env.LOG_TO_FILE !== 'false';
const LOG_MAX_FILES = process.env.LOG_MAX_FILES || '14d';
const LOG_MAX_SIZE = process.env.LOG_MAX_SIZE || '20m';

let runtimeLevel =
  (process.env.LOG_LEVEL || 'info').toLowerCase() in
  Object.fromEntries(LEVELS.map((l) => [l, true]))
    ? (process.env.LOG_LEVEL || 'info').toLowerCase()
    : 'info';

if (!LEVELS.includes(runtimeLevel)) {
  runtimeLevel = 'info';
}

/**
 * Ensure log directory is writable. Returns false on permission/IO errors
 * so callers can fall back to stdout-only (common on TrueNAS host mounts).
 */
function ensureLogDir() {
  if (!LOG_TO_FILE) return false;
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    // Prove write access (dataset often owned by root while app runs as uid 1001)
    fs.accessSync(LOG_DIR, fs.constants.W_OK);
    return true;
  } catch (err) {
    // Defer console.warn until after process starts — use stderr so Docker shows it
    process.stderr.write(
      `[bookmarks-sync] Cannot write log dir "${LOG_DIR}" (${err.code || err.message}). ` +
        `File logging disabled; using stdout. ` +
        `On TrueNAS: chown -R 1001:1001 <host-data-path> (container user is uid 1001).\n`
    );
    return false;
  }
}

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    const rest = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    if (stack) {
      return `${timestamp} [${level}] ${message}${rest}\n${stack}`;
    }
    return `${timestamp} [${level}] ${message}${rest}`;
  })
);

// JSON lines on stdout — easy for Dozzle / log aggregators
const stdoutJsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

function buildTransports() {
  const transports = [];

  if (LOG_TO_STDOUT) {
    transports.push(
      new winston.transports.Console({
        // Prefer JSON for production/Dozzle; human-readable in non-production
        format:
          process.env.LOG_STDOUT_FORMAT === 'pretty' ||
          (process.env.NODE_ENV !== 'production' &&
            process.env.LOG_STDOUT_FORMAT !== 'json')
            ? consoleFormat
            : stdoutJsonFormat,
      })
    );
  }

  const fileOk = ensureLogDir();
  if (LOG_TO_FILE && fileOk) {
    transports.push(
      new DailyRotateFile({
        dirname: LOG_DIR,
        filename: 'app-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        maxSize: LOG_MAX_SIZE,
        maxFiles: LOG_MAX_FILES,
        level: 'silly', // level filtered by logger; keep files able to store all
        format: fileFormat,
      })
    );

    transports.push(
      new DailyRotateFile({
        dirname: LOG_DIR,
        filename: 'error-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        maxSize: LOG_MAX_SIZE,
        maxFiles: LOG_MAX_FILES,
        level: 'error',
        format: fileFormat,
      })
    );
  }

  if (transports.length === 0) {
    // Always keep at least console so logging never goes nowhere
    transports.push(new winston.transports.Console({ format: consoleFormat }));
  }

  return { transports, fileOk };
}

const { transports: initialTransports, fileOk: logDirWritable } = buildTransports();
const useFileLogs = LOG_TO_FILE && logDirWritable;

const logger = winston.createLogger({
  levels: winston.config.npm.levels,
  level: runtimeLevel,
  defaultMeta: { service: 'bookmarks-sync' },
  transports: initialTransports,
  exceptionHandlers: useFileLogs
    ? [
        new DailyRotateFile({
          dirname: LOG_DIR,
          filename: 'exceptions-%DATE%.log',
          datePattern: 'YYYY-MM-DD',
          zippedArchive: true,
          maxSize: LOG_MAX_SIZE,
          maxFiles: LOG_MAX_FILES,
          format: fileFormat,
        }),
        ...(LOG_TO_STDOUT
          ? [new winston.transports.Console({ format: stdoutJsonFormat })]
          : []),
      ]
    : [new winston.transports.Console({ format: stdoutJsonFormat })],
  rejectionHandlers: useFileLogs
    ? [
        new DailyRotateFile({
          dirname: LOG_DIR,
          filename: 'rejections-%DATE%.log',
          datePattern: 'YYYY-MM-DD',
          zippedArchive: true,
          maxSize: LOG_MAX_SIZE,
          maxFiles: LOG_MAX_FILES,
          format: fileFormat,
        }),
        ...(LOG_TO_STDOUT
          ? [new winston.transports.Console({ format: stdoutJsonFormat })]
          : []),
      ]
    : [new winston.transports.Console({ format: stdoutJsonFormat })],
  exitOnError: false,
});

function getLevel() {
  return logger.level;
}

function setLevel(level) {
  const next = String(level || '').toLowerCase();
  if (!LEVELS.includes(next)) {
    throw Object.assign(new Error(`Invalid log level: ${level}`), {
      code: 'VALIDATION',
    });
  }
  runtimeLevel = next;
  logger.level = next;
  // Keep all transports; winston filters by logger.level
  logger.transports.forEach((t) => {
    if (t.filename && String(t.filename).includes('error')) {
      // error-only file stays at error
      return;
    }
    if (t instanceof DailyRotateFile && t.level === 'error') {
      return;
    }
    // Console and app file follow global level via logger.level
  });
  logger.info(`Log level changed to ${next}`, { level: next });
  return next;
}

function getLogConfig() {
  return {
    level: getLevel(),
    levels: LEVELS,
    logDir: LOG_DIR,
    logToStdout: LOG_TO_STDOUT,
    logToFile: useFileLogs,
    logToFileRequested: LOG_TO_FILE,
    maxFiles: LOG_MAX_FILES,
    maxSize: LOG_MAX_SIZE,
  };
}

/**
 * Load persisted level from sync_meta after DB is ready.
 * Falls back to LOG_LEVEL env / current runtime.
 */
function loadLevelFromDb(getMetaFn) {
  try {
    const stored = getMetaFn && getMetaFn('log_level');
    if (stored && LEVELS.includes(String(stored).toLowerCase())) {
      setLevel(stored);
      return getLevel();
    }
  } catch (err) {
    logger.warn('Could not load log level from DB', { error: err.message });
  }
  return getLevel();
}

function saveLevelToDb(setMetaFn, level) {
  const next = setLevel(level);
  if (setMetaFn) {
    setMetaFn('log_level', next);
  }
  return next;
}

/** Morgan-compatible write stream → logger.http */
const morganStream = {
  write(message) {
    const line = String(message).trim();
    if (line) logger.http(line);
  },
};

module.exports = {
  logger,
  LEVELS,
  getLevel,
  setLevel,
  getLogConfig,
  loadLevelFromDb,
  saveLevelToDb,
  morganStream,
  LOG_DIR,
};
