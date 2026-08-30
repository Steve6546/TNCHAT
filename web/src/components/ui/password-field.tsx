import { Eye, EyeOff } from 'lucide-react';
import { useState, type InputHTMLAttributes } from 'react';

import { cn } from '../../lib/utils';
import { Input } from './input';

/**
 * Password input with a visibility toggle.
 *
 * Long generated credentials are easy to mistype and impossible to proof-read
 * through dots. The toggle is placed at the inline-start so it sits at the
 * trailing edge in RTL as well as LTR.
 *
 * The button is `type="button"` on purpose: inside a form, a bare <button>
 * submits, so a user clicking the eye would log themselves out or save a
 * half-filled form.
 */
export function PasswordField({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <Input {...props} type={visible ? 'text' : 'password'} className={cn('ps-10', className)} />
      <button
        type="button"
        onClick={() => setVisible((current) => !current)}
        className="absolute inset-y-0 start-0 flex w-10 items-center justify-center rounded-s-md text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:text-foreground"
        aria-label={visible ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
        title={visible ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
        tabIndex={-1}
      >
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}
