import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Class-name merge used by every component that accepts a `className`. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Turns any thrown value into a sentence worth showing.
 *
 * `ApiError` already carries the server's own message; anything else would
 * otherwise reach the screen as "Error: [object Object]".
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'تعذّر إكمال العملية';
}

/*
 * Numbering system is pinned to `latn` on purpose: this dashboard mixes Arabic
 * labels with Latin model names and latencies, and Arabic-Indic digits inside
 * an LTR token count read inconsistently.
 */

const NUMBER = new Intl.NumberFormat('ar', { numberingSystem: 'latn' });

const DATE_TIME = new Intl.DateTimeFormat('ar', {
  dateStyle: 'medium',
  timeStyle: 'short',
  numberingSystem: 'latn',
});

const DAY_ONLY = new Intl.DateTimeFormat('ar', {
  month: 'short',
  day: 'numeric',
  numberingSystem: 'latn',
});

export function formatNumber(value: number | null | undefined): string {
  if (value == null) return '—';
  return NUMBER.format(value);
}

/** Every timestamp in this API is epoch **milliseconds**, matching `Date`. */
export function formatDate(value: number | null | undefined): string {
  if (value == null || value === 0) return '—';
  return DATE_TIME.format(new Date(value));
}

/** `2026-08-30` (a stats bucket label) → a short axis label. */
export function formatDay(value: string): string {
  return DAY_ONLY.format(new Date(`${value}T00:00:00`));
}

/** Thousands separators would overflow narrow cards, so big values collapse. */
export function formatCompact(value: number | null | undefined): string {
  if (value == null) return '—';
  if (Math.abs(value) < 10_000) return NUMBER.format(value);
  if (Math.abs(value) < 1_000_000) return `${(value / 1000).toFixed(0)}K`;
  if (Math.abs(value) < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${(value / 1_000_000_000).toFixed(1)}B`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} ثانية`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} دقيقة`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)} ساعة`;
  return `${(seconds / 86_400).toFixed(1)} يوم`;
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function formatPercent(ratio: number | null | undefined): string {
  if (ratio == null) return '—';
  return `${(ratio * 100).toFixed(1)}%`;
}

/** `datetime-local` input value → epoch milliseconds, or `null` when blank. */
export function toEpochMs(value: string): number | null {
  if (value === '') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Epoch ms → `YYYY-MM-DDTHH:mm` in local time, for a datetime-local input. */
export function toLocalInput(value: number | null | undefined): string {
  if (value == null || value === 0) return '';
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
