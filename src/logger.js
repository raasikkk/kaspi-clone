import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.join(__dirname, '..', 'logs');

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

const getLogFile = () => {
  const now = new Date();
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOGS_DIR, `${date}.log`);
};

const formatTimestamp = () => {
  return new Date().toISOString();
};

const writeLine = (level, tag, message, extra) => {
  const ts = formatTimestamp();
  let line = `[${ts}] [${level}] [${tag}] ${message}`;
  if (extra !== undefined) {
    line += typeof extra === 'string' ? ` ${extra}` : ` ${JSON.stringify(extra)}`;
  }
  line += '\n';

  // Write to file
  try {
    fs.appendFileSync(getLogFile(), line);
  } catch (err) {
    console.error('Failed to write log:', err.message);
  }

  // Also output to console
  if (level === 'ERROR') {
    console.error(line.trimEnd());
  } else {
    console.log(line.trimEnd());
  }
};

export const logger = {
  info: (tag, message, extra) => writeLine('INFO', tag, message, extra),
  warn: (tag, message, extra) => writeLine('WARN', tag, message, extra),
  error: (tag, message, extra) => writeLine('ERROR', tag, message, extra),
};
