import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { config } from '../config.js';
import { TOKEN_TTL_HOURS, TOKEN_TTL_MS, verifyToken } from './dashboard-auth.js';

/**
 * The dashboard countdown is client-side, but the deadline it counts to is not:
 * it comes from `exp` inside the signed token. If the server ever stopped
 * checking that instant, the countdown would keep ticking against a session
 * the server had already abandoned — the exact bug this guards.
 */

function forge(exp: number): string {
  const body = Buffer.from(JSON.stringify({ sub: 'admin', exp })).toString('base64url');
  const signature = createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

test('a token is accepted right up to its expiry and refused after it', () => {
  assert.equal(verifyToken(forge(Date.now() + TOKEN_TTL_MS)), true);
  assert.equal(verifyToken(forge(Date.now() + 1_000)), true);
  assert.equal(verifyToken(forge(Date.now())), false);
  assert.equal(verifyToken(forge(Date.now() - 1)), false);
  assert.equal(verifyToken(forge(Date.now() - TOKEN_TTL_MS)), false);
});

test('the lifetime handed to the dashboard matches the one enforced here', () => {
  assert.equal(TOKEN_TTL_HOURS, 12);
  assert.equal(TOKEN_TTL_MS, 12 * 60 * 60 * 1000);
});

test('a token whose expiry was pushed forward is refused, signature or not', () => {
  // A tampered payload must fail the signature check rather than be trusted.
  const body = Buffer.from(
    JSON.stringify({ sub: 'admin', exp: Date.now() + TOKEN_TTL_MS * 10 }),
  ).toString('base64url');
  assert.equal(verifyToken(`${body}.not-a-real-signature`), false);
});
