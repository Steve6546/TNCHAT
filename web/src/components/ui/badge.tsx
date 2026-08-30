import * as React from 'react';

import { cn } from '../../lib/utils';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: 'neutral' | 'success' | 'danger' | 'warning';
}

export function Badge({ className, tone = 'neutral', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center rounded-full border px-2 text-xs font-medium',
        tone === 'neutral' && 'border-border bg-secondary text-secondary-foreground',
        tone === 'success' && 'border-emerald-500/20 bg-emerald-500/10 text-emerald-500',
        tone === 'danger' && 'border-red-500/20 bg-red-500/10 text-red-500',
        tone === 'warning' && 'border-amber-500/20 bg-amber-500/10 text-amber-500',
        className,
      )}
      {...props}
    />
  );
}
