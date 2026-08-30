import { abilityIndex } from './ability-index.js';
import type { Ability, SelectionSet } from './ability-index.js';

/**
 * Channel selection.
 *
 * Selection order:
 *   1. affinity — reuse the channel that last served this (key, group, model)
 *      so upstream prompt caches keep hitting.
 *   2. priority tiers, highest first. Each retry drops one tier, which is what
 *      turns "retry" into real failover onto a cheaper or slower backup.
 *   3. weighted random within the chosen tier.
 */

/**
 * Weight offset, carried over from the original implementation.
 * Without it a channel with weight 0 could never be selected, which would make
 * the weight field behave as an on/off switch rather than a ratio.
 */
const WEIGHT_OFFSET = 10;

const AFFINITY_TTL_MS = 10 * 60 * 1000;
const AFFINITY_MAX_ENTRIES = 5_000;

/** `\u001f` is a unit separator: legal in a string, absent from real names. */
const SEP = '';

interface AffinityEntry {
  channelId: number;
  expiresAt: number;
}

/**
 * key → channel last served. Read on every request, written only after a
 * successful upstream response.
 */
const affinity = new Map<string, AffinityEntry>();

function affinityKey(identity: string, group: string, model: string): string {
  return `${identity}${SEP}${group}${SEP}${model}`;
}

export function getPreferredChannel(
  identity: string,
  group: string,
  model: string,
): number | null {
  const key = affinityKey(identity, group, model);
  const entry = affinity.get(key);
  if (!entry) return null;

  if (entry.expiresAt < Date.now()) {
    affinity.delete(key);
    return null;
  }
  return entry.channelId;
}

/** Called only after a successful upstream response. */
export function recordChannelAffinity(
  identity: string,
  group: string,
  model: string,
  channelId: number,
): void {
  // A Map iterates in insertion order, so the first key is always the oldest.
  // Evicting from the front is a FIFO cache with no scan.
  while (affinity.size >= AFFINITY_MAX_ENTRIES) {
    const oldest = affinity.keys().next();
    if (oldest.done) break;
    affinity.delete(oldest.value);
  }

  affinity.set(affinityKey(identity, group, model), {
    channelId,
    expiresAt: Date.now() + AFFINITY_TTL_MS,
  });
}

/** Drop every affinity pointing at a channel that just failed. */
export function clearChannelAffinity(channelId: number): void {
  for (const [key, entry] of affinity) {
    if (entry.channelId === channelId) affinity.delete(key);
  }
}

/**
 * Weighted random pick.
 *
 * sum = Σ(weight + offset); pick r in [0, sum); subtract each (weight + offset);
 * select the first candidate that drives r to <= 0. The offset is what lets a
 * zero-weight channel still receive traffic instead of never being chosen.
 */
function weightedPick(candidates: Ability[]): Ability | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;

  const total = candidates.reduce((sum, ability) => sum + ability.weight + WEIGHT_OFFSET, 0);
  let remaining = Math.floor(Math.random() * total);

  for (const ability of candidates) {
    remaining -= ability.weight + WEIGHT_OFFSET;
    if (remaining <= 0) return ability;
  }
  return candidates[candidates.length - 1] ?? null;
}

export interface SelectionResult {
  ability: Ability;
  /** Index of the priority tier actually used. 0 = highest. */
  tierIndex: number;
  /** True when the choice came from sticky affinity rather than the wheel. */
  viaAffinity: boolean;
}

export function selectChannel(
  group: string,
  model: string,
  retryIndex: number,
  preferredChannelId?: number | null,
): SelectionResult | null {
  const set: SelectionSet | undefined = abilityIndex.selectionSet(group, model);
  if (!set || set.enabledCount === 0) return null;

  if (preferredChannelId != null) {
    for (const ability of set.byTier.values()) {
      const preferred = ability.find((candidate) => candidate.channelId === preferredChannelId);
      if (preferred) return { ability: preferred, tierIndex: 0, viaAffinity: true };
    }
  }

  if (set.tiers.length === 0) return null;

  // Retries walk down the tier list; the last tier is reused once exhausted.
  const tierIndex = Math.min(retryIndex, set.tiers.length - 1);
  const priority = set.tiers[tierIndex]!;
  const picked = weightedPick(set.byTier.get(priority) ?? []);
  if (!picked) return null;

  return { ability: picked, tierIndex, viaAffinity: false };
}
