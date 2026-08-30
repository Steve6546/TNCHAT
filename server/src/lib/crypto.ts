import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Field-level encryption for upstream provider keys.
 *
 * Upstream API keys are the highest-value secret in this system: leaking one
 * lets an attacker spend someone else's money. They are never stored in
 * plaintext and are decrypted only for the duration of an outbound request.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function deriveKey(masterKey: string): Buffer {
  return createHash('sha256').update(masterKey, 'utf8').digest();
}

/** Format: v1.<iv_b64>.<tag_b64>.<ciphertext_b64> */
export function encryptSecret(plaintext: string, masterKey: string): string {
  if (plaintext === '') return '';
  const key = deriveKey(masterKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`;
}

export function decryptSecret(payload: string, masterKey: string): string {
  if (payload === '') return '';
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Malformed encrypted secret');
  }
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const key = deriveKey(masterKey);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

const KEY_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Client-facing key. Shape matches what new-api clients already expect:
 * `sk-` prefix, then a random body. Only the first segment (before `-`) is
 * significant for lookup, which is why the body contains no dashes.
 */
export function generateApiKey(byteLength = 32): string {
  const bytes = randomBytes(byteLength);
  let body = '';
  for (const byte of bytes) {
    body += KEY_ALPHABET[byte % KEY_ALPHABET.length];
  }
  return `sk-${body}`;
}

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

/** Strip the `sk-` prefix and any suffix segments, matching new-api's parsing. */
export function normalizeApiKey(raw: string): string {
  let key = raw.trim();
  if (key.toLowerCase().startsWith('bearer ')) key = key.slice(7).trim();
  if (key.startsWith('sk-')) key = key.slice(3);
  return key.split('-')[0] ?? key;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function randomId(): string {
  return randomBytes(8).toString('hex');
}
