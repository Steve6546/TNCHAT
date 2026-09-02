import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { config } from '../config.js';
import { issueDashboardToken, verifyToken } from './dashboard-auth.js';

/**
 * Dashboard tokens are signature-only by decision: no expiry, no server-side
 * lifetime. The properties worth guarding are therefore (a) a legitimately
 * issued token verifies, (b) any payload tampering fails the signature, and
 * (c) a forged token signed with the wrong secret is refused — the signature
 * is the *only* thing standing between the dashboard and an attacker.
 */

function forgeToken(payload: unknown, secret: string = config.sessionSecret): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

test('a token issued by the server verifies and round-trips the identity', () => {
  const token = issueDashboardToken({ sub: 'user-123', email: 'a@b.co' });
  const identity = verifyToken(token);

  assert.ok(identity);
  assert.equal(identity.sub, 'user-123');
  assert.equal(identity.email, 'a@b.co');
});

test('a token signed with the wrong secret is refused', () => {
  const forged = forgeToken({ sub: 'user-123', email: 'a@b.co' }, 'not-the-session-secret');
  assert.equal(verifyToken(forged), null);
});

test('a tampered payload is refused even with a structurally valid token', () => {
  const token = issueDashboardToken({ sub: 'user-123', email: 'a@b.co' });
  const [body] = token.split('.');
  const tampered = Buffer.from(JSON.stringify({ sub: 'admin', email: 'x@y.z' })).toString('base64url');
  assert.notEqual(body, tampered);
  assert.equal(verifyToken(`${tampered}.${token.split('.')[1]}`), null);
});

test('malformed tokens are refused without throwing', () => {
  assert.equal(verifyToken(null), null);
  assert.equal(verifyToken(''), null);
  assert.equal(verifyToken('no-dots-here'), null);
  assert.equal(verifyToken('a.b.c'), null);
  assert.equal(verifyToken('not-base64..not-signature'), null);
});
