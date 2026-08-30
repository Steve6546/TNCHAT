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
