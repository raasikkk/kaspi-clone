import fs from 'fs';
import path from 'path';

import { STATE_DIR } from './config.js';

const WEBHOOKS_FILE = path.join(STATE_DIR, 'webhooks.json');

// Optional: configure webhooks entirely via an env var (handy on Railway /
// serverless where there's no convenient file to edit). If WEBHOOKS_JSON is a
// valid JSON array it takes precedence over webhooks.json.
let envWebhooks = null;
if (process.env.WEBHOOKS_JSON) {
  try {
    const parsed = JSON.parse(process.env.WEBHOOKS_JSON);
    if (Array.isArray(parsed)) envWebhooks = parsed;
    else console.error('[WEBHOOK STORE] WEBHOOKS_JSON is not a JSON array — ignoring');
  } catch (err) {
    console.error('[WEBHOOK STORE] WEBHOOKS_JSON is not valid JSON — ignoring:', err.message);
  }
}

let cachedWebhooks = null;
let lastModifiedTime = 0;
let lastCheckTime = 0;
const CACHE_TTL_MS = 5000;

/**
 * Читает вебхуки из WEBHOOKS_JSON (env) или webhooks.json.
 * При ошибке чтения/парсинга возвращает [].
 */
export const loadWebhooks = () => {
  if (envWebhooks) return envWebhooks;

  const now = Date.now();
  if (cachedWebhooks && now - lastCheckTime < CACHE_TTL_MS) {
    return cachedWebhooks;
  }

  try {
    lastCheckTime = now;
    if (!fs.existsSync(WEBHOOKS_FILE)) {
      cachedWebhooks = [];
      return [];
    }
    const stat = fs.statSync(WEBHOOKS_FILE);
    const mtime = stat.mtimeMs;
    if (cachedWebhooks && mtime === lastModifiedTime) {
      return cachedWebhooks;
    }
    const raw = fs.readFileSync(WEBHOOKS_FILE, 'utf8');
    const hooks = JSON.parse(raw);
    if (!Array.isArray(hooks)) {
      cachedWebhooks = [];
      return [];
    }
    cachedWebhooks = hooks;
    lastModifiedTime = mtime;
    return hooks;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[WEBHOOK STORE] Error reading webhooks.json:', err.message);
    }
    return cachedWebhooks || [];
  }
};

/**
 * Возвращает вебхуки, подписанные на указанное событие.
 */
export const getWebhooksByEvent = (event) => {
  return loadWebhooks().filter((hook) => hook.url && Array.isArray(hook.events) && hook.events.includes(event));
};
