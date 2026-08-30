import { useEffect, useState } from 'react';

import { cn } from '../../lib/utils';

/**
 * A countdown that visibly moves.
 *
 * Tick alignment matters: a naive `setInterval(…, 1000)` drifts and can skip a
 * second after the tab is throttled, which makes the display look broken
 * exactly when someone is watching it. Both the deadline and the current time
 * are re-read on every tick instead.
 */

export function useCountdown(deadline: number | null): number {
  const [remaining, setRemaining] = useState(() =>
    deadline === null ? 0 : Math.max(0, deadline - Date.now()),
  );

  useEffect(() => {
    if (deadline === null) {
      setRemaining(0);
      return;
    }

    const tick = () => setRemaining(Math.max(0, deadline - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadline]);

  return remaining;
}

/** Milliseconds → `HH:MM:SS`, zero-padded, never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

const WARN_BELOW_MS = 5 * 60 * 1000;

interface CountdownProps {
  deadline: number | null;
  className?: string;
  onExpire?: () => void;
  expiredLabel?: string;
}

export function Countdown({ deadline, className, onExpire, expiredLabel }: CountdownProps) {
  const remaining = useCountdown(deadline);
  const expired = deadline !== null && remaining === 0;

  useEffect(() => {
    if (expired && onExpire) onExpire();
  }, [expired, onExpire]);

  if (deadline === null) return null;

  if (expired) {
    return (
      <span className={cn('tabular-nums text-red-500', className)} dir="ltr">
        {expiredLabel ?? 'انتهت الجلسة'}
      </span>
    );
  }

  return (
    <span
      className={cn(
        'tabular-nums transition-colors duration-300',
        remaining < WARN_BELOW_MS ? 'text-amber-500' : undefined,
        className,
      )}
      dir="ltr"
    >
      {formatCountdown(remaining)}
    </span>
  );
}
