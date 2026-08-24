import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import {
  createDeviceIdentity,
  deviceColumns,
  deviceFromRow,
  hasOwnDevice,
  legacyDevice,
} from '../src/deviceIdentity.js';
import { computeXSign, ecSign } from '../src/crypto.js';
import { entranceCookie } from '../src/helpers.js';

describe('Per-cashier device identity', () => {
  it('gives every cashier a distinct device', () => {
    const a = createDeviceIdentity();
    const b = createDeviceIdentity();

    assert.notEqual(a.deviceId, b.deviceId);
    assert.notEqual(a.installId, b.installId);
    assert.notEqual(a.pkTag, b.pkTag);
    assert.notEqual(a.pk, b.pk);
  });

  it('derives pkTag as the md5 of pk, the way Kaspi expects', () => {
    const device = createDeviceIdentity();
    assert.equal(device.pkTag, crypto.createHash('md5').update(device.pk).digest('hex'));
    assert.equal(device.pkTag.length, 32);
  });

  it('survives a round trip through the keys row', () => {
    const original = createDeviceIdentity();
    const restored = deviceFromRow(deviceColumns(original));

    assert.equal(restored.deviceId, original.deviceId);
    assert.equal(restored.installId, original.installId);
    assert.equal(restored.pinHash, original.pinHash);
    // Публичные поля выводятся из приватного ключа — значит ключ восстановлен
    // тот же самый, а не просто скопированы строки.
    assert.equal(restored.pk, original.pk);
    assert.equal(restored.pkTag, original.pkTag);
    assert.equal(restored.x509, original.x509);
  });

  // ECDSA подписывает со случайным k, поэтому две подписи одних и тех же байт
  // не совпадают. Сравнивать можно только проверяемость публичным ключом.
  const verifies = (data, signatureB64, device) =>
    crypto
      .createVerify('SHA256')
      .update(data)
      .verify(
        crypto.createPublicKey({ key: Buffer.from(device.x509, 'base64'), format: 'der', type: 'spki' }),
        Buffer.from(signatureB64, 'base64'),
      );

  it('keeps the private key usable for signing after the round trip', () => {
    const original = createDeviceIdentity();
    const restored = deviceFromRow(deviceColumns(original));

    const payload = 'kaspi-signed-payload';
    assert.equal(verifies(payload, ecSign(payload, restored.privateKey), original), true);
  });

  it('does not store the device private key in the clear', () => {
    const device = createDeviceIdentity();
    const raw = device.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    assert.notEqual(deviceColumns(device).device_privkey, raw);
  });

  it('falls back to the shared device for a cashier linked before the switch', () => {
    const legacy = legacyDevice();

    for (const row of [null, {}, { device_id: 'D1' }, { device_privkey: 'x' }]) {
      assert.equal(hasOwnDevice(row), false);
      assert.equal(deviceFromRow(row).deviceId, legacy.deviceId);
    }
  });

  it('signs with the cashier device, and identically to before when given none', () => {
    const url = 'https://mtoken.kaspi.kz/v08/organizations/org-context-otp';
    const xsh = 'url,X-Time,X-App-Ver';
    const headers = { 'X-Time': '2026-08-20T10:00:00.000+0500', 'X-App-Ver': '4.115' };
    const device = createDeviceIdentity();

    // Подписывается sha256 от канонического текста — воспроизводим его, чтобы
    // проверить подпись публичным ключом.
    const signed = crypto
      .createHash('sha256')
      .update(`url:${url.toLowerCase()}\nx-time:${headers['X-Time']}\nx-app-ver:${headers['X-App-Ver']}`, 'utf8')
      .digest();

    // Своим устройством подписано именно им, а не общим ключом.
    const own = computeXSign(url, headers, xsh, undefined, device.privateKey);
    assert.equal(verifies(signed, own, device), true);
    assert.equal(verifies(signed, own, legacyDevice()), false);

    // Без устройства подпись обязана остаться на прежнем общем ключе, иначе
    // уже привязанные кассы перестанут проходить проверку у Kaspi.
    assert.equal(verifies(signed, computeXSign(url, headers, xsh), legacyDevice()), true);
  });

  it('puts the cashier device into the entrance cookie', () => {
    const device = createDeviceIdentity();
    const cookie = entranceCookie(undefined, device);

    assert.match(cookie, new RegExp(`deviceId=${device.deviceId}`));
    assert.match(cookie, new RegExp(`installId=${device.installId}`));
    assert.match(cookie, new RegExp(`pkTag=${device.pkTag}`));
    // Без устройства — прежнее общее, для касс, привязанных до перехода.
    assert.match(entranceCookie(), new RegExp(`deviceId=${legacyDevice().deviceId}`));
  });
});
