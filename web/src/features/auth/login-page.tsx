import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, LockKeyhole, Mail } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { Logo } from '../../components/shared/logo';
import { Spinner } from '../../components/shared/spinner';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { PasswordField } from '../../components/ui/password-field';
import { endpoints } from '../../lib/api';
import { errorMessage } from '../../lib/utils';
import { useAuthStore } from '../../stores/auth-store';

/**
 * Dashboard authentication: sign in, sign up, or recover a forgotten password.
 *
 * Accounts live in Supabase. The form enforces the same rules the server
 * enforces — a valid email shape, and a password of at least 8 characters
 * containing a letter and a digit — so the user never round-trips to the
 * server just to learn the password is weak.
 */

type Mode = 'signin' | 'signup' | 'forgot';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

function passwordProblem(value: string): string | null {
  if (value.length < 8) return 'يجب أن تتكون كلمة المرور من 8 أحرف على الأقل';
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
    return 'يجب أن تحتوي كلمة المرور على حرف واحد ورقم واحد على الأقل';
  }
  return null;
}

const COPY: Record<Mode, { title: string; description: string; submit: string }> = {
  signin: {
    title: 'تسجيل الدخول',
    description: 'أدخل بريدك الإلكتروني وكلمة المرور للمتابعة',
    submit: 'دخول',
  },
  signup: {
    title: 'إنشاء حساب',
    description: 'أنشئ حساباً جديداً للوصول إلى لوحة التحكم',
    submit: 'إنشاء الحساب',
  },
  forgot: {
    title: 'استرجاع كلمة المرور',
    description: 'أدخل بريدك الإلكتروني وسنرسل لك رابط إعادة التعيين',
    submit: 'إرسال رابط الاسترجاع',
  },
};

export function LoginPage() {
  const token = useAuthStore((state) => state.token);
  const setSession = useAuthStore((state) => state.setSession);
  const navigate = useNavigate();

  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [clientError, setClientError] = useState('');
  const [infoMessage, setInfoMessage] = useState('');

  // A cheap reachability probe: distinguishes "server is down" from "wrong
  // credentials" before the user types anything.
  const status = useQuery({
    queryKey: ['auth-status'],
    queryFn: endpoints.authStatus,
    staleTime: 30_000,
    retry: 1,
  });

  const copy = COPY[mode];

  const submit = useMutation({
    mutationFn: async () => {
      if (mode === 'signin') {
        const response = await endpoints.login(email.trim(), password);
        return { kind: 'session' as const, session: response.data };
      }
      if (mode === 'signup') {
        const response = await endpoints.signup(email.trim(), password);
        return { kind: 'signup' as const, response: response };
      }
      const response = await endpoints.recover(email.trim());
      return { kind: 'recover' as const, message: response.data.message };
    },
    onSuccess: (result) => {
      if (result.kind === 'session') {
        setSession(result.session);
        navigate('/', { replace: true });
        return;
      }
      if (result.kind === 'signup') {
        const data = result.response.data;
        if (data.needsConfirmation) {
          setInfoMessage(data.message);
          setMode('signin');
        } else {
          setSession(data);
          navigate('/', { replace: true });
        }
        return;
      }
      setInfoMessage(result.message);
      setMode('signin');
    },
  });

  if (token) return <Navigate to="/" replace />;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setClientError('');
    setInfoMessage('');

    if (!isValidEmail(email)) {
      setClientError('أدخل بريداً إلكترونياً صحيحاً');
      return;
    }
    if (mode !== 'forgot') {
      const problem = passwordProblem(password);
      if (problem) {
        setClientError(problem);
        return;
      }
    }
    if (mode === 'signup' && password !== confirmation) {
      setClientError('كلمتا المرور غير متطابقتين');
      return;
    }
    submit.mutate();
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setClientError('');
    setInfoMessage('');
    setConfirmation('');
  };

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
              <LockKeyhole className="size-5 text-muted-foreground" />
            </div>
            <CardTitle className="text-base">{copy.title}</CardTitle>
            <CardDescription>{copy.description}</CardDescription>
          </CardHeader>
          <CardContent>
            {status.isLoading ? (
              <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                <Spinner />
              </div>
            ) : status.isError ? (
              <div className="rounded-md border border-red-500/20 bg-red-500/10 p-3 text-sm leading-6 text-red-500">
                تعذّر الاتصال بالخادم. تأكد من تشغيله ثم أعد تحميل الصفحة.
              </div>
            ) : (
              <form className="space-y-5 pt-1" onSubmit={handleSubmit}>
                <div className="space-y-2">
                  <Label htmlFor="email">البريد الإلكتروني</Label>
                  <div className="relative">
                    <Mail className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="email"
                      type="email"
                      dir="ltr"
                      className="pl-9 text-left"
                      autoComplete="email"
                      placeholder="name@example.com"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      required
                      autoFocus
                    />
                  </div>
                </div>

                {mode !== 'forgot' ? (
                  <div className="space-y-2">
                    <Label htmlFor="password">كلمة المرور</Label>
                    <PasswordField
                      id="password"
                      autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      required
                      minLength={mode === 'signup' ? 8 : 1}
                    />
                    {mode === 'signup' ? (
                      <p className="text-xs text-muted-foreground">
                        8 أحرف على الأقل، وتتضمن حرفاً ورقماً.
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {mode === 'signup' ? (
                  <div className="space-y-2">
                    <Label htmlFor="confirmation">تأكيد كلمة المرور</Label>
                    <PasswordField
                      id="confirmation"
                      autoComplete="new-password"
                      value={confirmation}
                      onChange={(event) => setConfirmation(event.target.value)}
                      required
                      minLength={8}
                    />
                  </div>
                ) : null}

                {clientError || submit.error ? (
                  <p className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-500">
                    {clientError || errorMessage(submit.error)}
                  </p>
                ) : null}
                {infoMessage ? (
                  <p className="rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm leading-6 text-emerald-600 dark:text-emerald-400">
                    {infoMessage}
                  </p>
                ) : null}

                <Button type="submit" className="w-full" disabled={submit.isPending}>
                  {submit.isPending ? <Spinner label="جارٍ المعالجة" /> : <>{copy.submit}<ArrowLeft /></>}
                </Button>

                <div className="flex items-center justify-between pt-1 text-xs text-muted-foreground">
                  {mode === 'signin' ? (
                    <>
                      <button
                        type="button"
                        className="underline-offset-4 hover:text-foreground hover:underline"
                        onClick={() => switchMode('forgot')}
                      >
                        نسيت كلمة المرور؟
                      </button>
                      <button
                        type="button"
                        className="underline-offset-4 hover:text-foreground hover:underline"
                        onClick={() => switchMode('signup')}
                      >
                        إنشاء حساب جديد
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="mx-auto underline-offset-4 hover:text-foreground hover:underline"
                      onClick={() => switchMode('signin')}
                    >
                      {mode === 'signup' ? 'لدي حساب بالفعل — تسجيل الدخول' : 'العودة إلى تسجيل الدخول'}
                    </button>
                  )}
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
