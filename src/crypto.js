import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ecKeyPair, STATE_DIR } from './config.js';

// Ключ ECDH держим на смонтированном томе (STATE_DIR), рядом с keypair.json и
// device.json, чтобы он переживал редеплой.
const ECDH_FILE = path.join(STATE_DIR, 'ecdh-keypair.json');

// Разовый перенос ключа со старого места рядом с кодом.
const LEGACY_ECDH_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ecdh-keypair.json');
if (!fs.existsSync(ECDH_FILE) && fs.existsSync(LEGACY_ECDH_FILE)) {
  try {
    fs.copyFileSync(LEGACY_ECDH_FILE, ECDH_FILE);
    console.log('Migrated ecdh-keypair.json into STATE_DIR');
  } catch (e) {
    console.error('Could not migrate ecdh-keypair.json:', e.message);
  }
}

// ─── ECDH ───

const vtokenSuite = 'OCRA-1:HOTP-SHA256-6:QH64-T1M';

// ─── AES-256-GCM encryption for vtokenSecret ───

if (!process.env.TOKEN_SECRET_KEY) {
  console.error('FATAL: TOKEN_SECRET_KEY environment variable is not set.');
  console.error('Generate one with: echo "TOKEN_SECRET_KEY=$(openssl rand -hex 32)" > .env');
  process.exit(1);
}
const ENCRYPTION_KEY = Buffer.from(process.env.TOKEN_SECRET_KEY, 'hex');

export const encryptSecret = (secretBuffer) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(secretBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
};

export const decryptSecret = (tokenB64) => {
  const buf = Buffer.from(tokenB64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
};

let lastEcdhKeyPair = null;

export const generateECDH = () => {
  lastEcdhKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  // Persist ECDH private key so refresh (SignInLite) can reuse it
  const saved = {
    privateKey: lastEcdhKeyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicKey: lastEcdhKeyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
  fs.writeFileSync(ECDH_FILE, JSON.stringify(saved, null, 2));
  const spki = lastEcdhKeyPair.publicKey.export({ type: 'spki', format: 'der' });
  return spki.toString('base64');
};

export const completeECDH = (serverX509B64) => {
  if (!lastEcdhKeyPair) throw new Error('No ECDH keypair generated');
  const serverPubKey = crypto.createPublicKey({
    key: Buffer.from(serverX509B64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const secret = crypto.diffieHellman({
    privateKey: lastEcdhKeyPair.privateKey,
    publicKey: serverPubKey,
  });
  console.log('ECDH shared secret derived, length:', secret.length);
  lastEcdhKeyPair = null;
  return secret;
};

// ECDH-пара на кассу: ничего не пишет на диск, ключ живёт в сессии привязки и
// сохраняется в строку кассы (в отличие от файловых generateECDH ниже).
export const generateECDHPair = () => {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey: pair.privateKey,
    publicB64: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
};

export const completeECDHWith = (serverX509B64, privateKey) => {
  const serverPubKey = crypto.createPublicKey({
    key: Buffer.from(serverX509B64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  return crypto.diffieHellman({ privateKey, publicKey: serverPubKey });
};

export const exportECDHPrivate = (privateKey) =>
  encryptSecret(privateKey.export({ type: 'pkcs8', format: 'der' }));

export const importECDHPrivate = (encrypted) =>
  crypto.createPrivateKey({ key: decryptSecret(encrypted), format: 'der', type: 'pkcs8' });

export const completeECDHWithSaved = (serverX509B64) => {
  if (!fs.existsSync(ECDH_FILE)) throw new Error('No saved ECDH keypair (ecdh-keypair.json missing)');
  const saved = JSON.parse(fs.readFileSync(ECDH_FILE, 'utf8'));
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(saved.privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const serverPubKey = crypto.createPublicKey({
    key: Buffer.from(serverX509B64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const secret = crypto.diffieHellman({ privateKey, publicKey: serverPubKey });
  console.log('ECDH (saved key) shared secret derived, length:', secret.length);
  return secret;
};

// ─── Helpers ───

const hexToBytes = (hex) => {
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substring(i, i + 2), 16));
  }
  return Buffer.from(bytes);
};

// ─── OCRA-1 TOTP (matches Kaspi vtoken) ───

export const computeTokenSnMac = (tokenSN, secret) => {
  if (!secret) return '000000';

  const timeStep = BigInt(Date.now()) / BigInt(30000);
  const timeHex = timeStep.toString(16);

  const qHex = Buffer.from(tokenSN || '00000000')
    .toString('hex')
    .substring(0, 64);

  const suiteBytes = Buffer.from(vtokenSuite);
  const separator = Buffer.from([0x00]);

  const qPadded = qHex.padEnd(256, '0');
  const qBytes = hexToBytes(qPadded);

  const tPadded = timeHex.padStart(16, '0');
  const tBytes = hexToBytes(tPadded);

  const dataBuffer = Buffer.concat([suiteBytes, separator, qBytes, tBytes]);

  const hash = crypto.createHmac('sha256', secret).update(dataBuffer).digest();

  // Dynamic truncation (RFC 4226)
  const offset = hash[hash.length - 1] & 0x0f;
  const binCode =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);

  return (binCode % 1000000).toString().padStart(6, '0');
};

// ─── ECDSA signing ───

// Ключ приходит параметром (своё устройство у каждой кассы). Умолчание —
// глобальный ключ из keypair.json.
export const ecSign = (data, privateKey = ecKeyPair.privateKey) => {
  const sign = crypto.createSign('SHA256');
  sign.update(data);
  sign.end();
  return sign.sign(privateKey).toString('base64');
};

export const signDataPayload = (dataB64, privateKey) => ecSign(dataB64, privateKey);

export const computeXSU = (url) => crypto.createHash('md5').update(url.toLowerCase()).digest('hex');

// Канонический текст подписи Kaspi: по одной строке `имя:значение` на каждый
// заголовок из X-SH, имена в нижнем регистре, порядок — строго как в X-SH.
// Для `url` берётся полный URL в нижнем регистре (та же нормализация, что в
// computeXSU). Тело запроса, если оно есть, дописывается последней строкой.
// Подписывается sha256 от этого текста.
export const computeXSign = (url, headers, xshList, body, privateKey) => {
  const lines = xshList.split(',').map((name) => {
    if (name === 'url') return 'url:' + url.toLowerCase();
    return name.toLowerCase() + ':' + (headers[name] || '');
  });

  let signText = lines.join('\n');
  if (body) signText += '\n' + body;

  const hash = crypto.createHash('sha256').update(signText, 'utf8').digest();
  return ecSign(hash, privateKey);
};
