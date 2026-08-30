import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isGatewayError } from '../core/errors.js';
import { LOG_SCOPES, parseOkFilter } from './admin-stats.js';

/**
 * The "successful requests only" filter and the log-clearing scope both arrive
 * as query strings from the dashboard. Parsed loosely they would silently do
 * the wrong thing — an unfiltered table presented as filtered, or a typo
 * widening a delete instead of narrowing it.
 */

test('an absent ok filter means every row', () => {
  assert.equal(parseOkFilter(undefined), undefined);
  assert.equal(parseOkFilter(null), undefined);
  assert.equal(parseOkFilter(''), undefined);
});

test('ok=1 keeps successes and ok=0 keeps failures', () => {
  assert.equal(parseOkFilter('1'), true);
  assert.equal(parseOkFilter('true'), true);
  assert.equal(parseOkFilter('0'), false);
  assert.equal(parseOkFilter('false'), false);
});

test('any other ok value is rejected rather than ignored', () => {
  assert.throws(() => parseOkFilter('success'), isGatewayError);
  assert.throws(() => parseOkFilter('2'), isGatewayError);
});

test('log clearing is limited to errors and everything', () => {
  assert.deepEqual([...LOG_SCOPES], ['errors', 'all']);
});
