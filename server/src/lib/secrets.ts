import { config } from '../config.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { parseStringList } from './json.js';

/**
 * Provider credentials at rest.
 *
 * `channels.keys` holds a JSON array of AES-256-GCM encrypted strings. These
 * two helpers are the only places that touch that column, so the
 * encrypt/decrypt pair can never drift apart and a corrupt entry can never
 * throw its way into a request.
 */

/** Decrypt stored provider keys. Entries that fail to decrypt are dropped. */
export function decryptKeyList(raw: string | null | undefined): string[] {
  return parseStringList(raw)
    .map((entry) => {
      try {
        return decryptSecret(entry, config.masterKey);
      } catch {
        return '';
      }
    })
    .filter((key) => key !== '');
}

export function encryptKeyList(keys: readonly string[]): string {
  return JSON.stringify(keys.map((key) => encryptSecret(key, config.masterKey)));
}
