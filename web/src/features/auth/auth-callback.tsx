import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, KeyRound, MailCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { Logo } from '../../components/shared/logo';
import { Spinner } from '../../components/shared/spinner';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Label } from '../../components/ui/label';
import { PasswordField } from '../../components/ui/password-field';
import { updateSupabasePassword } from '../../lib/api';
import { errorMessage } from '../../lib/utils';

/**
 * Landing for the links Supabase emails out: email confirmation and password
 * recovery. Both arrive at `/#access_token=…&type=…` on this origin (the
 * project's configured Site URL), so this component reads the fragment,
 * clears it, and routes:
 *
 *   - type=signup    → "email confirmed" + a path to sign in;
 *   - type=recovery  → a real reset-password form, driven by the access token;
 *   - anything else  → an honest error with a way back.
 */

interface HashPayload {
  accessToken: string | null;
  type: string | null;
}

function parseHash(): HashPayload {
  const raw = window.location.hash.replace(/^#/, '');
  if (raw === '') return { accessToken: null, type: null };
  const params = new URLSearchParams(raw);
  return {
    accessToken: params.get('access_token'),
    type: params.get('type'),
  };
}

function passwordProblem(value: string): string | null {
  if (value.length < 8) return 'يجب أن تتكون كلمة المرور من 8 أحرف على الأقل';
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
    return 'يجب أن تحتوي كلمة المرور على حرف واحد ورقم واحد على الأقل';
  }
  return null;
}

export function AuthCallbackPage() {
  const navigate = useNavigate();
  const [payload] = useState<HashPayload>(() => parseHash());
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [clientError, setClientError] = useState('');
  const [resetDone, setResetDone] = useState(false);

  const reset = useResetMutation(payload.accessToken, setResetDone);

  // Clear the fragment after mount, never during render: react-router patches
  // history.replaceState, so calling it mid-render updates router state while
  // React is rendering and takes the whole tree down.
  useEffect(() => {
    if (payload.accessToken !== null || payload.type !== null) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, [payload.accessToken, payload.type]);

  if (payload.type === 'recovery' && payload.accessToken !== null) {
    const handleSubmit = (event: FormEvent) => {
      event.preventDefault();
      setClientError('');
      const problem = passwordProblem(newPassword);
      if (problem) {
        setClientError(problem);
        return;
      }
      if (newPassword !== confirmation) {
        setClientError('كلمتا المرور غير متطابقتين');
        return;
      }
      try {
        reset.mutate(newPassword);
      } catch (error) {
        setClientError(errorMessage(error));
      }
    };

    return (
      <AuthShell
        title="تعيين كلمة مرور جديدة"
        description="اختر كلمة مرور جديدة لحسابك في لوحة التحكم"
      >
        {resetDone ? (
          <ResetSuccess />
        ) : (
          <form className="space-y-5" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <Label htmlFor="reset-password">كلمة المرور الجديدة</Label>
              <PasswordField
                id="reset-password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                required
                minLength={8}
              />
              <p className="text-xs text-muted-foreground">8 أحرف على الأقل، وتتضمن حرفاً ورقماً.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="reset-confirmation">تأكيد كلمة المرور</Label>
              <PasswordField
                id="reset-confirmation"
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                required
                minLength={8}
              />
            </div>
            {clientError || reset.error ? (
              <p className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-500">
                {clientError || errorMessage(reset.error)}
              </p>
            ) : null}
            <Button type="submit" className="w-full" disabled={reset.isPending}>
              {reset.isPending ? <Spinner label="جارٍ الحفظ" /> : <>{'حفظ كلمة المرور'}<ArrowLeft /></>}
            </Button>
          </form>
        )}
      </AuthShell>
    );
  }

  if (payload.type === 'signup' && payload.accessToken !== null) {
    return (
      <AuthShell title="تم تأكيد البريد الإلكتروني" description="حسابك جاهز الآن — سجّل الدخول للمتابعة">
        <div className="space-y-5 text-center">
          <MailCheck className="mx-auto size-12 text-emerald-500" />
          <p className="text-sm leading-6 text-muted-foreground">
            تم تفعيل بريدك الإلكتروني بنجاح. من هذه اللحظة تستطيع الدخول ببريدك وكلمة المرور.
          </p>
          <Button className="w-full" onClick={() => navigate('/login', { replace: true })}>
            {'الذهاب إلى تسجيل الدخول'}<ArrowLeft />
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="رابط غير صالح" description="هذا الرابط منتهي أو مستخدم من قبل">
      <div className="space-y-5 text-center">
        <p className="text-sm leading-6 text-muted-foreground">
          روابط التفعيل والاسترجاع تُستخدم مرة واحدة. اطلب رابطاً جديداً من شاشة الدخول.
        </p>
        <Button variant="outline" className="w-full" onClick={() => navigate('/login', { replace: true })}>
          العودة إلى تسجيل الدخول
        </Button>
      </div>
    </AuthShell>
  );
}

function AuthShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_-20%,rgba(113,113,122,0.18),transparent_42%)]" />
      <div className="relative w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Logo />
        </div>
        <Card className="shadow-2xl shadow-black/10 dark:shadow-black/30">
          <CardHeader className="text-center">
            <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-lg border border-border bg-muted">
              <KeyRound className="size-5 text-muted-foreground" />
            </div>
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
      </div>
    </main>
  );
}

function ResetSuccess() {
  return (
    <div className="space-y-5 text-center">
      <CheckCircle2 className="mx-auto size-12 text-emerald-500" />
      <p className="text-sm leading-6 text-muted-foreground">
        تم تحديث كلمة المرور بنجاح. سجّل الدخول بكلمة المرور الجديدة.
      </p>
      <Button className="w-full" onClick={() => window.location.assign('/login')}>
        الذهاب إلى تسجيل الدخول
      </Button>
    </div>
  );
}

function useResetMutation(accessToken: string | null, onDone: (done: boolean) => void) {
  return useMutation({
    mutationFn: async (password: string) => {
      if (!accessToken) throw new Error('رابط الاسترجاع لا يحمل رمزاً صالحاً');
      await updateSupabasePassword(accessToken, password);
    },
    onSuccess: () => onDone(true),
  });
}
