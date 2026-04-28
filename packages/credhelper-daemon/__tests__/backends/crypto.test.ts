import { encrypt, decrypt, generateMasterKey } from '../../src/backends/crypto.js';

describe('crypto', () => {
  it('encrypt/decrypt roundtrip', () => {
    const key = generateMasterKey();
    const plaintext = 'my-secret-credential-value';
    const entry = encrypt(plaintext, key);
    const result = decrypt(entry, key);
    expect(result).toBe(plaintext);
  });

  it('wrong key fails', () => {
    const key1 = generateMasterKey();
    const key2 = generateMasterKey();
    const entry = encrypt('secret', key1);
    expect(() => decrypt(entry, key2)).toThrow();
  });

  it('tampered ciphertext fails', () => {
    const key = generateMasterKey();
    const entry = encrypt('secret', key);
    // Flip a character in the base64 ciphertext
    const bytes = Buffer.from(entry.ciphertext, 'base64');
    bytes[0] ^= 0xff;
    const tampered = { ...entry, ciphertext: bytes.toString('base64') };
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it('tampered auth tag fails', () => {
    const key = generateMasterKey();
    const entry = encrypt('secret', key);
    // Flip a character in the base64 authTag
    const bytes = Buffer.from(entry.authTag, 'base64');
    bytes[0] ^= 0xff;
    const tampered = { ...entry, authTag: bytes.toString('base64') };
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it('different plaintexts produce different ciphertexts', () => {
    const key = generateMasterKey();
    const a = encrypt('same-plaintext', key);
    const b = encrypt('same-plaintext', key);
    // Random IV means ciphertext and iv must differ
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });

  it('generateMasterKey returns 32 bytes', () => {
    const key = generateMasterKey();
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
  });
});
