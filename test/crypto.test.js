import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Set TOKEN_SECRET_KEY before importing crypto module
process.env.TOKEN_SECRET_KEY = 'a'.repeat(64);

const { encryptSecret, decryptSecret, computeTokenSnMac, computeXSU } = await import('../src/crypto.js');

describe('encryptSecret / decryptSecret', () => {
  it('should round-trip a secret buffer', () => {
    const original = Buffer.from('my-super-secret-value');
    const encrypted = encryptSecret(original);
    const decrypted = decryptSecret(encrypted);
    assert.deepStrictEqual(decrypted, original);
  });

  it('should produce different ciphertexts for the same input (random IV)', () => {
    const original = Buffer.from('test');
    const a = encryptSecret(original);
    const b = encryptSecret(original);
    assert.notEqual(a, b);
  });

  it('should fail to decrypt tampered data', () => {
    const encrypted = encryptSecret(Buffer.from('secret'));
    const buf = Buffer.from(encrypted, 'base64');
    buf[20] ^= 0xff; // tamper with ciphertext
    assert.throws(() => decryptSecret(buf.toString('base64')));
  });
});

describe('computeTokenSnMac', () => {
  it('should return 6-digit string', () => {
    const secret = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const result = computeTokenSnMac('TSN12345', secret);
    assert.match(result, /^\d{6}$/);
  });

  it('should return 000000 when secret is null', () => {
    const result = computeTokenSnMac('TSN12345', null);
    assert.equal(result, '000000');
  });
});

describe('computeXSU', () => {
  it('should return md5 hex of lowercased url', () => {
    const result = computeXSU('https://example.com/Path');
    assert.match(result, /^[0-9a-f]{32}$/);
  });

  it('should be case-insensitive', () => {
    const a = computeXSU('HTTPS://EXAMPLE.COM');
    const b = computeXSU('https://example.com');
    assert.equal(a, b);
  });
});
