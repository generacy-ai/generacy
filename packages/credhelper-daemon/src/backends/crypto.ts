import crypto from 'node:crypto';
import { z } from 'zod';

export interface EncryptedEntry {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export const EncryptedEntrySchema = z.object({
  ciphertext: z.string(),
  iv: z.string(),
  authTag: z.string(),
});

export function encrypt(plaintext: string, masterKey: Buffer): EncryptedEntry {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

export function decrypt(entry: EncryptedEntry, masterKey: Buffer): string {
  const iv = Buffer.from(entry.iv, 'base64');
  const authTag = Buffer.from(entry.authTag, 'base64');
  const ciphertext = Buffer.from(entry.ciphertext, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf-8');
}

export function generateMasterKey(): Buffer {
  return crypto.randomBytes(32);
}
