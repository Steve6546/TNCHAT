/**
 * Session lifetime, read from the token itself.
 *
 * The dashboard token is `<base64url payload>.<hmac>` and the payload carries
 * `exp` as epoch milliseconds. Decoding it on the client means the countdown
 * stays correct across reloads and browser tabs without an extra round trip —
 * the browser already holds the authoritative expiry, because the server put it
 * there and signed it.
 *
 * This reads the payload only. It never validates the signature; that is the
 * server's job on every request, and a tampered token is rejected there.
 */

const SESSION_FALLBACK_MS = 12 * 60 * 60 * 1000;

export function sessionExpiry(token: string | null): number | null {
  if (!token) return null;

  const [body, ...rest] = token.split('.');
  if (!body || rest.length === 0) return null;

  try {
    // base64url → base64, then decode; atob rejects the url-safe alphabet.
    const normalised = body.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(normalised.padEnd(Math.ceil(normalised.length / 4) * 4, '='));
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/** Full session length, used before a session exists (the login screen). */
export const SESSION_LENGTH_MS = SESSION_FALLBACK_MS;

/**
 * How far the server clock is ahead of this browser's, in milliseconds.
 *
 * Measured once, at login, from the `serverTime` the server sends alongside
 * the token. Every deadline is expressed on the server's clock, so a browser
 * that is minutes wrong would otherwise show a countdown that is minutes wrong
 * in the other direction.
 */
export function clockSkew(serverTimeIso: string | undefined): number {
  if (!serverTimeIso) return 0;
  const serverTime = Date.parse(serverTimeIso);
  if (Number.isNaN(serverTime)) return 0;
  return serverTime - Date.now();
}

/**
 * The instant this session dies, re-expressed on the browser's own clock so
 * `Date.now()` can be subtracted from it directly.
 *
 * `expiresAt` is what the server states in the login response and is
 * authoritative. The token payload is the fallback for a session that was
 * already open before that field existed — it carries the same instant, only
 * unsigned and uncorrected.
 */
export function sessionDeadline(
  expiresAt: number | null,
  token: string | null,
  skewMs = 0,
): number | null {
  const instant = expiresAt ?? sessionExpiry(token);
  return instant === null ? null : instant - skewMs;
}
