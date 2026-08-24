import crypto from 'crypto';
import { DEVICE, ecKeyPair } from './config.js';
import { encryptSecret, decryptSecret } from './crypto.js';

// Device-identity на каждую кассу. Kaspi привязывает устройство к одному
// кассиру, поэтому общий на всех DEVICE недопустим. Хранится в строке keys,
// приватный ключ шифруется TOKEN_SECRET_KEY.

// pk / pkTag / x509 из публичного ключа, как в config.js (Kaspi сверяет pkTag).
const derivePublicFields = (publicKeyDer) => {
  const uncompressedPoint = publicKeyDer.subarray(publicKeyDer.length - 65);
  const pk = uncompressedPoint.toString('base64');
  return {
    pk,
    pkTag: crypto.createHash('md5').update(pk).digest('hex'),
    x509: publicKeyDer.toString('base64'),
  };
};

const publicDerOf = (privateKey) =>
  crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });

export const createDeviceIdentity = () => {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    deviceId: crypto.randomUUID().toUpperCase(),
    installId: crypto.randomUUID().toUpperCase(),
    pinHash: crypto.createHash('md5').update(crypto.randomBytes(16)).digest('hex'),
    privateKey: pair.privateKey,
    ...derivePublicFields(pair.publicKey.export({ type: 'spki', format: 'der' })),
  };
};

// Общее устройство из device.json — запасной вариант для касс без своей identity.
export const legacyDevice = () => ({
  ...DEVICE,
  privateKey: ecKeyPair.privateKey,
});

export const deviceColumns = (device) => {
  if (!device?.privateKey) {
    throw new Error('deviceColumns: device has no private key — nothing to persist');
  }
  return {
    device_id: device.deviceId,
    install_id: device.installId,
    device_pin_hash: device.pinHash,
    device_privkey: encryptSecret(device.privateKey.export({ type: 'pkcs8', format: 'der' })),
  };
};

export const deviceFromRow = (row) => {
  if (!row?.device_id || !row?.device_privkey) return legacyDevice();

  const privateKey = crypto.createPrivateKey({
    key: decryptSecret(row.device_privkey),
    format: 'der',
    type: 'pkcs8',
  });

  return {
    deviceId: row.device_id,
    installId: row.install_id,
    pinHash: row.device_pin_hash,
    privateKey,
    ...derivePublicFields(publicDerOf(privateKey)),
  };
};

export const hasOwnDevice = (row) => Boolean(row?.device_id && row?.device_privkey);
