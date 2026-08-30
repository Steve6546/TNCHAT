import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, LockKeyhole, Timer } from 'lucide-react';
import { useCallback, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { Countdown } from '../../components/shared/countdown';
import { Logo } from '../../components/shared/logo';
import { Spinner } from '../../components/shared/spinner';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Label } from '../../components/ui/label';
import { PasswordField } from '../../components/ui/password-field';
import { endpoints, queryKeys } from '../../lib/api';
import { SESSION_LENGTH_MS } from '../../lib/session';
import { errorMessage } from '../../lib/utils';
import { useAuthStore } from '../../stores/auth-store';

export function LoginPage() {
  const token = useAuthStore((state) => state.token);
  const setToken = useAuthStore((state) => state.setToken);
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [clientError, setClientError] = useState('');

  // No session exists yet, so this previews how long one lasts. It restarts at
  // the full length when it runs out, because every new session starts fresh.
  const [sessionDeadline, setSessionDeadline] = useState(() => Date.now() + SESSION_LENGTH_MS);
  const restartSessionTimer = useCallback(() => {
    setSessionDeadline(Date.now() + SESSION_LENGTH_MS);
  }, []);

  const status = useQuery({
    queryKey: queryKeys.authStatus,
    queryFn: endpoints.authStatus,
    staleTime: 30_000,
  });

  const configured = status.data?.data.configured ?? true;
  const auth = useMutation({
    mutationFn: () => (configured ? endpoints.login(password) : endpoints.setup(password)),
    onSuccess: (response) => {
      setToken(response.data.token);
      navigate('/', { replace: true });
    },
  });

  if (token) return <Navigate to="/" replace />;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setClientError('');
    if (!configured && password.length < 8) {
      setClientError('يجب أن تتكون كلمة المرور من 8 أحرف على الأقل');
      return;
    }
    if (!configured && password !== confirmation) {
      setClientError('كلمتا المرور غير متطابقتين');
      return;
    }
    auth.mutate();
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
            <CardTitle className="text-base">{configured ? 'تسجيل الدخول' : 'إعداد لوحة التحكم'}</CardTitle>
            <CardDescription>
              {configured ? 'أدخل كلمة مرور المسؤول للمتابعة' : 'أنشئ كلمة مرور آمنة لحماية لوحة التحكم'}
            </CardDescription>
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
              <form className="space-y-4" onSubmit={handleSubmit}>
                <div className="space-y-2">
                  <Label htmlFor="password">كلمة المرور</Label>
                  <PasswordField
                    id="password"
                    autoComplete={configured ? 'current-password' : 'new-password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    minLength={configured ? 1 : 8}
                    autoFocus
                  />
                </div>
                {!configured ? (
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
                {clientError || auth.error ? (
                  <p className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-500">
                    {clientError || errorMessage(auth.error)}
                  </p>
                ) : null}
                <Button type="submit" className="w-full" disabled={auth.isPending}>
                  {auth.isPending ? <Spinner label="جارٍ التحقق" /> : <>{configured ? 'دخول' : 'إنشاء ومتابعة'}<ArrowLeft /></>}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
        <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <Timer className="size-3.5" />
          مدة الجلسة بعد الدخول
          <Countdown
            deadline={sessionDeadline}
            className="font-medium text-foreground"
            onExpire={restartSessionTimer}
          />
        </p>
      </div>
    </main>
  );
}
