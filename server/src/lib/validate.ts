import { GatewayError } from '../core/errors.js';

/**
 * Minimal request validation.
 *
 * Hand-rolled instead of pulling in a schema library: the surface here is small
 * and the error messages need to name the offending field for the dashboard.
 */

function fail(field: string, expected: string): never {
  throw GatewayError.badRequest(`Field "${field}" must be ${expected}`, field);
}

export function str(value: unknown, field: string, opts: { min?: number; max?: number } = {}): string {
  if (typeof value !== 'string') fail(field, 'a string');
  const trimmed = opts.min === undefined ? value.trim() : value;
  if (opts.min !== undefined && trimmed.length < opts.min) fail(field, `at least ${opts.min} characters`);
  if (opts.max !== undefined && trimmed.length > opts.max) fail(field, `at most ${opts.max} characters`);
  return trimmed;
}

export function optionalStr(value: unknown, field: string, max = 2000): string | undefined {
  if (value === undefined || value === null) return undefined;
  return str(value, field, { max });
}

export function int(value: unknown, field: string, opts: { min?: number; max?: number } = {}): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) fail(field, 'an integer');
  if (opts.min !== undefined && parsed < opts.min) fail(field, `at least ${opts.min}`);
  if (opts.max !== undefined && parsed > opts.max) fail(field, `at most ${opts.max}`);
  return parsed;
}

export function bool(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  fail(field, 'a boolean');
}

export function optionalBool(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  return bool(value, field);
}

export function strArray(value: unknown, field: string, maxItems = 500): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(field, 'an array of strings');
  if (value.length > maxItems) fail(field, `at most ${maxItems} items`);
  return value.map((item, index) => str(item, `${field}[${index}]`, { max: 500 }));
}

export function record(value: unknown, field: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) fail(field, 'an object of string values');
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') out[key] = item;
    else fail(`${field}.${key}`, 'a string');
  }
  return out;
}

export function requireUrl(value: unknown, field: string): string {
  const raw = str(value, field, { min: 1, max: 2000 });
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail(field, 'an absolute URL, e.g. https://api.example.com/v1');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    fail(field, 'an http or https URL');
  }
  return raw.replace(/\/+$/, '');
}

export function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(field, `one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Strict-enough email shape: something@domain.tld, no spaces, bounded length. */
export function email(value: unknown, field: string): string {
  const raw = str(value, field, { min: 5, max: 320 });
  if (!EMAIL_PATTERN.test(raw)) fail(field, 'a valid email address');
  return raw.toLowerCase();
}

/**
 * Password policy, enforced in one place and mirrored by the dashboard form:
 * at least 8 characters with at least one letter and one digit.
 */
export function password(value: unknown, field: string): string {
  const raw = str(value, field, { min: 8, max: 200 });
  if (!/[A-Za-z]/.test(raw) || !/[0-9]/.test(raw)) {
    fail(field, 'at least 8 characters including a letter and a digit');
  }
  return raw;
}
