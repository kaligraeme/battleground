import { createHash, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function randomString(length: number, alphabet = ALPHANUMERIC): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/** 15-character lowercase id, the shape PocketBase record ids have. */
export function recordId(): string {
  return randomString(15, 'abcdefghijklmnopqrstuvwxyz0123456789');
}

/** API keys are `<userID>.<40 random characters>`, with exactly one dot. */
export function newApiKey(userID: string): string {
  return `${userID}.${randomString(40)}`;
}

/** API keys and session tokens are high-entropy, so a fast digest is an appropriate verifier. */
export function digest(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Passwords are human-chosen, so they get a slow, salted KDF. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function randomPassword(length = 15): string {
  return randomString(length);
}

/** A WireGuard-shaped key (32 random bytes, base64). Not a usable key pair: the range is simulated. */
export function fakeWireguardKey(): string {
  return randomBytes(32).toString('base64');
}
