import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

import { cn } from '../../lib/utils';
import { Button } from '../ui/button';

/**
 * Copy button with a confirmation state.
 *
 * The icon swap is the whole point: with no visual change, a user copying an
 * API key cannot tell whether the click registered.
 */
export function CopyButton({
  value,
  label = 'نسخ',
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard access can be denied (insecure origin, permissions policy).
      // Fall back to a hidden textarea so the button still does its job.
      const field = document.createElement('textarea');
      field.value = value;
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.append(field);
      field.select();
      document.execCommand('copy');
      field.remove();
    }

    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => void copy()}
      className={cn('gap-1.5', className)}
      aria-label={copied ? 'تم النسخ' : label}
    >
      {copied ? <Check className="text-emerald-500" /> : <Copy />}
      {copied ? 'تم النسخ' : label}
    </Button>
  );
}
