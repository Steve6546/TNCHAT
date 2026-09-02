import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { apiKeys } from '../db/schema.js';
import { GatewayError } from '../core/errors.js';
import { hashApiKey, normalizeApiKey } from '../lib/crypto.js';
import { parseStringList } from '../lib/json.js';

/**
 * Client API key authentication, ported from `middleware/auth.go`.
 *
 * The header precedence matters for real clients: Claude Desktop and the
 * Anthropic SDK send `x-api-key`, OpenAI clients send `Authorization: Bearer`.
 * Accepting both on the same route is what lets one key work everywhere.
 *
 * Only the SHA-256 hash is stored, so a database leak does not hand over
 * working credentials.
 */

export interface AuthContext {
  keyId: number;
  keyName: string;
  group: string;
  /** Empty means unrestricted. */
  modelLimit: string[];
}

/**
 * Extract the key from a request.
 * Returns null when no credential is present at all, so callers can decide
 * whether to 401 or fall through.
 */
export function extractApiKey(headers: Record<string, unknown>, query: Record<string, unknown>): string | null {
  const read = (value: unknown): string | null => {
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return null;
  };

  const anthropicKey = read(headers['x-api-key']);
  if (anthropicKey) return normalizeApiKey(anthropicKey);

  const authorization = read(headers['authorization']);
  if (authorization) return normalizeApiKey(authorization);

  const queryKey = read(query['key']);
  if (queryKey) return normalizeApiKey(queryKey);

  return null;
}

export async function authenticate(rawKey: string | null): Promise<AuthContext> {
  if (!rawKey) {
    throw GatewayError.unauthorized('Missing API key. Send Authorization: Bearer sk-... or x-api-key.');
  }

  const normalized = normalizeApiKey(rawKey);
  if (normalized === '') {
    throw GatewayError.unauthorized();
  }

  const hash = hashApiKey(normalized);
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash)).limit(1);
  const row = rows[0];

  if (!row) throw GatewayError.unauthorized();
  if (row.status !== 'active') {
    throw GatewayError.forbidden('This API key has been disabled');
  }
  if (row.expiresAt != null && row.expiresAt < Date.now()) {
    throw GatewayError.forbidden('This API key has expired');
  }

  await db.update(apiKeys).set({ lastUsedAt: Date.now() }).where(eq(apiKeys.id, row.id));

  return {
    keyId: row.id,
    keyName: row.name,
    group: row.group,
    modelLimit: parseStringList(row.modelLimit),
  };
}

export function assertModelAllowed(auth: AuthContext, model: string): void {
  if (auth.modelLimit.length === 0) return;
  if (auth.modelLimit.includes(model)) return;
  throw GatewayError.forbidden(`This API key is not allowed to use model "${model}"`);
}

export { hashApiKey, normalizeApiKey };
