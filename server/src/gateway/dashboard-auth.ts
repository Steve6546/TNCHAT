import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/**
 * Dashboard session tokens.
 *
 * A token is `<base64url payload>.<hmac>` signed with the session secret.
 * It carries *who* is logged in (the Supabase user id and email) and nothing
 * else: by decision there is **no server-side expiry**. A session ends only
 * when the user signs out, or when the browser tab closes — the token lives
 * in `sessionStorage`, which the browser drops with the tab.
 *
 * Signing with the session secret, never with MASTER_KEY: sharing key
 * material between "encrypt provider credentials at rest" and "sign dashboard
 * tokens" would mean one leak compromises both.
 */

export interface DashboardIdentity {
  sub: string;
  email: string;
}

interface TokenPayload {
  sub: string;
  email: string;
}

function sign(payload: string): string {
  return createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

export function issueDashboardToken(identity: DashboardIdentity): string {
  const payload: TokenPayload = { sub: identity.sub, email: identity.email };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifyToken(token: string | null): DashboardIdentity | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts as [string, string];

  const expected = sign(body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    if (typeof payload.sub !== 'string' || payload.sub === '') return null;
    return { sub: payload.sub, email: typeof payload.email === 'string' ? payload.email : '' };
  } catch {
    return null;
  }
}

export function extractDashboardToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token === '' ? null : token;
}
