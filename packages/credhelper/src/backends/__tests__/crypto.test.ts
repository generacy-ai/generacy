import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, generateMasterKey } from '../crypto.js';

describe('crypto', () => {
  const masterKey = generateMasterKey();

  it('round-trips encrypt/decrypt', () => {
    const plaintext = 'super-secret-value';
    const encrypted = encrypt(plaintext, masterKey);
    const decrypted = decrypt(encrypted, masterKey);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different IVs per call', () => {
    const a = encrypt('same', masterKey);
    const b = encrypt('same', masterKey);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('produces base64-encoded fields', () => {
    const entry = encrypt('test', masterKey);
    expect(() => Buffer.from(entry.ciphertext, 'base64')).not.toThrow();
    expect(() => Buffer.from(entry.iv, 'base64')).not.toThrow();
    expect(() => Buffer.from(entry.authTag, 'base64')).not.toThrow();
  });

  it('fails to decrypt with wrong key', () => {
    const encrypted = encrypt('test', masterKey);
    const wrongKey = generateMasterKey();
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it('fails to decrypt with tampered ciphertext', () => {
    const encrypted = encrypt('test', masterKey);
    encrypted.ciphertext = Buffer.from('tampered').toString('base64');
    expect(() => decrypt(encrypted, masterKey)).toThrow();
  });

  it('generateMasterKey returns 32 bytes', () => {
    const key = generateMasterKey();
    expect(key.length).toBe(32);
  });
});
