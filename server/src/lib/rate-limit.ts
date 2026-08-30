/**
 * Fixed-window rate limiter for the dashboard auth endpoints.
 *
 * The dashboard password is the only credential an attacker can guess, and the
 * login endpoint is the only place to guess it. Without a limit, a weak
 * password is reachable by brute force no matter how it is hashed.
 *
 * Deliberately in-memory and deliberately simple: a single instance owns the
 * dashboard, so a shared store would add a dependency and a failure mode to
 * protect something a few lines already protect.
 */

interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
  ) {}

  /** True while the caller is still allowed through. */
  allow(key: string): boolean {
    const now = Date.now();
    const existing = this.windows.get(key);

    if (!existing || existing.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      this.evict(now);
      return true;
    }

    existing.count += 1;
    return existing.count <= this.maxAttempts;
  }

  /** Clear a key, e.g. after a successful login. */
  reset(key: string): void {
    this.windows.delete(key);
  }

  /** Whole seconds until the caller may try again; 0 when not blocked. */
  retryAfterSeconds(key: string): number {
    const entry = this.windows.get(key);
    if (!entry) return 0;
    return Math.max(0, Math.ceil((entry.resetAt - Date.now()) / 1000));
  }

  /** Drop expired windows so the map cannot grow without bound. */
  private evict(now: number): void {
    if (this.windows.size < 1_000) return;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}
