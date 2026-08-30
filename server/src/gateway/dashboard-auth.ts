import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { settings } from '../db/schema.js';
import { GatewayError } from '../core/errors.js';
import { constantTimeEqual } from '../lib/crypto.js';

/**
 * Dashboard authentication.
 *
 * Separate from the relay API keys on purpose: a dashboard session can mint
 * relay keys and read every provider credential, so it needs a different
 * credential and a short lifetime.
 */

export const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
export const TOKEN_TTL_HOURS = TOKEN_TTL_MS / (60 * 60 * 1000);
const SETTINGS_KEY = 'admin_password_hash';

export function hashPassword(password: string, salt = randomBytes(16).toString('hex')): string {
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expected] = parts as [string, string, string];
  const actual = scryptSync(password, salt, 64);
  const expectedBuf = Buffer.from(expected, 'hex');
  if (expectedBuf.length !== actual.length) return false;
  return timingSafeEqual(expectedBuf, actual);
}

export function getStoredPasswordHash(): string | null {
  const row = db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).get();
  return row?.value ?? null;
}

export function setAdminPassword(password: string): void {
  const value = hashPassword(password);
  db.insert(settings)
    .values({ key: SETTINGS_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

export function isPasswordConfigured(): boolean {
  return getStoredPasswordHash() !== null || config.adminPassword !== '';
}

/**
 * Bootstrap credential: ADMIN_PASSWORD from the environment is honoured when no
 * password has been set yet, so a fresh deployment is not locked out. Once a
 * password is stored in the database, the environment value is ignored.
 */
export interface IssuedToken {
  token: string;
  /** Epoch milliseconds — the instant this token stops being accepted. */
  expiresAt: number;
}

export function login(password: string): IssuedToken {
  const stored = getStoredPasswordHash();

  if (stored === null) {
    // constantTimeEqual length-checks first; timingSafeEqual throws on a length
    // mismatch, which would leak the expected password length.
    if (config.adminPassword === '' || !constantTimeEqual(password, config.adminPassword)) {
      throw GatewayError.unauthorized('Invalid password');
    }
  } else if (!verifyPassword(password, stored)) {
    throw GatewayError.unauthorized('Invalid password');
  }

  return issueToken();
}

interface TokenPayload {
  sub: string;
  exp: number;
}

/**
 * Sign with the session secret, never with MASTER_KEY.
 *
 * Sharing key material between "encrypt provider credentials at rest" and
 * "sign dashboard tokens" would mean one leak compromises both.
 */
function sign(payload: string): string {
  return createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

function issueToken(): IssuedToken {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload: TokenPayload = { sub: 'admin', exp: expiresAt };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: `${body}.${sign(body)}`, expiresAt };
}

export function verifyToken(token: string | null): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [body, signature] = parts as [string, string];

  const expected = sign(body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    return payload.sub === 'admin' && payload.exp > Date.now();
  } catch {
    return false;
  }
}

export function extractDashboardToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token === '' ? null : token;
}
