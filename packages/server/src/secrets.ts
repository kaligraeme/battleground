import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Reversible encryption for the few secrets the API must hand back verbatim
 * (a user's hypervisor password via `GET /user/credentials`). The key lives in
 * the state file, next to the ciphertext, as a Ludus server keeps its database
 * key next to its database: this keeps secrets out of plain sight, nothing more.
 */
export function newSecretKey(): string {
  return randomBytes(32).toString('base64');
}

export function encrypt(plaintext: string, keyB64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

export function decrypt(ciphertext: string, keyB64: string): string {
  const raw = Buffer.from(ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
