/**
 * Parsers for the JSON columns we store as text.
 *
 * Several columns (`keys`, `models`, `model_mapping`, `model_limit`) hold JSON
 * in a SQLite TEXT column. Every read of those columns goes through here, for
 * two reasons:
 *
 *   1. One implementation instead of five near-identical copies. Before this
 *      module existed, `parseList`, `parseStringList` and `safeParseList` were
 *      three separate functions with the same body in three different files.
 *   2. A corrupt or hand-edited value must never throw at request time. A
 *      malformed `models` column should degrade to "this channel serves
 *      nothing", not take the gateway down.
 */

/** Read a JSON string array. Non-strings and empty strings are dropped. */
export function parseStringList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const parsed: unknown = parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === 'string' && item !== '');
}

/** Read a JSON object with string values. */
export function parseStringRecord(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  const parsed: unknown = parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
