import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

// Runtime state (device identity, keypair, tracked payments, webhooks) lives
// here. In containers / on Railway, point STATE_DIR at a MOUNTED VOLUME so it
// survives redeploys — otherwise the device identity regenerates on every
// deploy and Kaspi treats the gateway as a brand-new device, invalidating the
// merchant's session. Defaults to the app root for local dev.
const STATE_DIR = process.env.STATE_DIR || ROOT_DIR;
try {
  fs.mkdirSync(STATE_DIR, { recursive: true });
} catch {
  /* directory already exists */
}
export { STATE_DIR };

export const PORT = process.env.PORT || 3000;

// ─── ECDSA P-256 keypair (persisted to keypair.json) ───

const KEYPAIR_FILE = path.join(STATE_DIR, 'keypair.json');

let ecKeyPair;
if (fs.existsSync(KEYPAIR_FILE)) {
  const saved = JSON.parse(fs.readFileSync(KEYPAIR_FILE, 'utf8'));
  ecKeyPair = {
    privateKey: crypto.createPrivateKey({ key: Buffer.from(saved.privateKey, 'base64'), format: 'der', type: 'pkcs8' }),
    publicKey: crypto.createPublicKey({ key: Buffer.from(saved.publicKey, 'base64'), format: 'der', type: 'spki' }),
  };
  console.log('Loaded ECDSA keypair from keypair.json');
} else {
  ecKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const saved = {
    privateKey: ecKeyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicKey: ecKeyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
  fs.writeFileSync(KEYPAIR_FILE, JSON.stringify(saved, null, 2));
  console.log('Generated new ECDSA keypair → saved to keypair.json');
}

export { ecKeyPair };

// Uncompressed EC public key point (base64)
const pubKeyDer = ecKeyPair.publicKey.export({ type: 'spki', format: 'der' });
const x509B64 = pubKeyDer.toString('base64');
const uncompressedPoint = pubKeyDer.slice(pubKeyDer.length - 65);
const pkB64 = uncompressedPoint.toString('base64');
const pkTagHash = crypto.createHash('md5').update(pkB64).digest('hex');

// ─── Device identity (persisted to device.json) ───

const DEVICE_FILE = path.join(STATE_DIR, 'device.json');

let deviceId, installId, pinHash;
if (fs.existsSync(DEVICE_FILE)) {
  const saved = JSON.parse(fs.readFileSync(DEVICE_FILE, 'utf8'));
  ({ deviceId, installId, pinHash } = saved);
  console.log('Loaded device identity from device.json');
} else {
  deviceId = crypto.randomUUID().toUpperCase();
  installId = crypto.randomUUID().toUpperCase();
  pinHash = crypto.createHash('md5').update(crypto.randomBytes(16)).digest('hex');
  fs.writeFileSync(DEVICE_FILE, JSON.stringify({ deviceId, installId, pinHash }, null, 2));
  console.log('Generated new device identity → saved to device.json');
}

export const DEVICE = {
  deviceId,
  installId,
  pk: pkB64,
  pkTag: pkTagHash,
  pinHash,
  x509: x509B64,
};

console.log('  pk:', DEVICE.pk);
console.log('  x509:', DEVICE.x509);
console.log('  pkTag:', DEVICE.pkTag);

// ─── Kaspi Base URLs ───

export const KASPI_ENTRANCE_URL = 'https://entrance-pay.kaspi.kz';
export const KASPI_MTOKEN_URL = 'https://mtoken.kaspi.kz';
export const KASPI_QRPAY_URL = 'https://qrpay.kaspi.kz';

// ─── App version & device constants ───
// Defaults match a known-good Kaspi Pay client. Override via .env if needed.
// ⚠️ The Kaspi API validates these parameters and may reject unknown values.

export const APP = {
  version: process.env.APP_VERSION || '4.115',
  build: process.env.APP_BUILD || '1115',
  platform: process.env.APP_PLATFORM || 'iOS',
  platformVer: process.env.APP_PLATFORM_VER || '18.5',
  locale: process.env.APP_LOCALE || 'ru-RU',
  model: process.env.APP_MODEL || 'iPhone17,3',
  brand: process.env.APP_BRAND || 'Apple',
  deviceName: process.env.APP_DEVICE_NAME || 'iPhone',
  screenW: process.env.APP_SCREEN_W || '393.0',
  screenH: process.env.APP_SCREEN_H || '852.0',
  cfNetwork: process.env.APP_CFNETWORK || 'CFNetwork/3826.500.131',
  darwin: process.env.APP_DARWIN || 'Darwin/24.5.0',
};

export const UA_NATIVE = `Kaspi%20Pay/${APP.build} ${APP.cfNetwork} ${APP.darwin}`;
export const UA_BROWSER = `Mozilla/5.0 (iPhone; CPU iPhone OS ${APP.platformVer.replace('.', '_')} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148`;

export const ENTRANCE_HEADERS_BASE = {
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'Accept-Language': 'ru',
  'Accept-Encoding': 'gzip, deflate, br',
  Origin: KASPI_ENTRANCE_URL,
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
  'User-Agent': UA_BROWSER,
};

export { ROOT_DIR };

export const DATABASE_URL = process.env.DATABASE_URL || '';

if (!process.env.ADMIN_SECRET_KEY || process.env.ADMIN_SECRET_KEY.trim() === '') {
  if (process.env.NODE_ENV !== 'test' && process.env.TOKEN_SECRET_KEY !== 'a'.repeat(64)) {
    console.error('FATAL: ADMIN_SECRET_KEY environment variable is not set or is empty.');
    console.error('Please configure ADMIN_SECRET_KEY in your .env file to secure admin endpoints.');
    process.exit(1);
  }
}

export const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || '';
