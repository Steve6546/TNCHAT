import { useMutation, useQuery } from '@tanstack/react-query';
import { Moon, Server, ShieldCheck, Sun } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { ErrorState } from '../../components/shared/error-state';
import { PageHeader } from '../../components/shared/page-header';
import { Spinner } from '../../components/shared/spinner';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Label } from '../../components/ui/label';
import { PasswordField } from '../../components/ui/password-field';
import { Skeleton } from '../../components/ui/skeleton';
import { useToast } from '../../components/ui/toast';
import { endpoints, queryKeys } from '../../lib/api';
import { errorMessage, formatDuration } from '../../lib/utils';
import { useAuthStore } from '../../stores/auth-store';
import { useThemeStore } from '../../stores/theme-store';

/**
 * Settings: password rotation, appearance, and a read-only view of the running
 * configuration.
 *
 * The configuration block deliberately shows *sources* (`env` / `file` /
 * `generated`) rather than the secrets themselves — the operator needs to know
 * whether the master key is pinned without the page becoming a way to read it.
 */

export function SettingsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const logout = useAuthStore((state) => state.logout);
  const { theme, setTheme } = useThemeStore();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [clientError, setClientError] = useState('');

  const health = useQuery({
    queryKey: queryKeys.health,
    queryFn: endpoints.health,
    refetchInterval: 30_000,
  });

  const changePassword = useMutation({
    mutationFn: () => endpoints.changePassword(currentPassword, newPassword),
    onSuccess: () => {
      toast.success('تم تغيير كلمة المرور — سجّل الدخول من جديد');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      // Every existing session is signed with the old password-derived secret.
      logout();
      navigate('/login', { replace: true });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setClientError('');
    if (newPassword.length < 8) {
      setClientError('يجب أن تتكون كلمة المرور الجديدة من 8 أحرف على الأقل');
      return;
    }
    if (newPassword !== confirmPassword) {
      setClientError('كلمتا المرور غير متطابقتين');
      return;
    }
    changePassword.mutate();
  };

  const config = health.data?.config;

  return (
    <>
      <PageHeader title="الإعدادات" description="الأمان والمظهر وحالة الخادم الجاري" />

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>كلمة مرور المسؤول</CardTitle>
            <CardDescription>
              تغيير كلمة المرور ينهي جميع الجلسات الحالية، بما فيها هذه.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={handleSubmit}>
              <div className="space-y-2">
                <Label htmlFor="current-password">كلمة المرور الحالية</Label>
                <PasswordField
                  id="current-password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new-password">كلمة المرور الجديدة</Label>
                <PasswordField
                  id="new-password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  required
                  minLength={8}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm-password">تأكيد كلمة المرور</Label>
                <PasswordField
                  id="confirm-password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  required
                  minLength={8}
                />
              </div>

              {clientError || changePassword.error ? (
                <p className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-500">
                  {clientError || errorMessage(changePassword.error)}
                </p>
              ) : null}

              <Button type="submit" disabled={changePassword.isPending}>
                {changePassword.isPending ? <Spinner label="جارٍ الحفظ" /> : 'تحديث كلمة المرور'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>المظهر</CardTitle>
              <CardDescription>يُحفظ الاختيار في هذا المتصفح.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2">
                <Button
                  variant={theme === 'light' ? 'default' : 'outline'}
                  onClick={() => setTheme('light')}
                  className="flex-1"
                >
                  <Sun />
                  فاتح
                </Button>
                <Button
                  variant={theme === 'dark' ? 'default' : 'outline'}
                  onClick={() => setTheme('dark')}
                  className="flex-1"
                >
                  <Moon />
                  داكن
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle>حالة الخادم</CardTitle>
                <CardDescription>قراءة مباشرة من نقطة فحص الصحة</CardDescription>
              </div>
              <Server className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {health.isError ? (
                <ErrorState message={errorMessage(health.error)} onRetry={() => void health.refetch()} />
              ) : health.isLoading || !health.data || !config ? (
                <div className="space-y-3">
                  {Array.from({ length: 6 }, (_, index) => (
                    <Skeleton key={index} className="h-5 w-full" />
                  ))}
                </div>
              ) : (
                <dl className="space-y-2.5 text-sm">
                  <Row label="البيئة">
                    <Badge tone={config.environment === 'production' ? 'success' : 'neutral'}>
                      {config.environment}
                    </Badge>
                  </Row>
                  <Row label="المنفذ">
                    <span dir="ltr">{config.port}</span>
                  </Row>
                  <Row label="زمن التشغيل">
                    <span>{formatDuration(health.data.uptimeSeconds)}</span>
                  </Row>
                  <Row label="قاعدة البيانات">
                    <Badge tone={health.data.database === 'ok' ? 'success' : 'danger'}>
                      {health.data.database === 'ok' ? 'متصلة' : 'خطأ'}
                    </Badge>
                  </Row>
                  <Row label="أزواج التوجيه">
                    <span dir="ltr">{health.data.routingPairs}</span>
                  </Row>
                  <Row label="إعادة المحاولة">
                    <span dir="ltr">{config.retryTimes}</span>
                  </Row>
                  <Row label="مهلة الطلب">
                    <span dir="ltr">{config.requestTimeoutMs} ms</span>
                  </Row>
                  <Row label="مهلة التدفّق">
                    <span dir="ltr">{config.streamingTimeoutMs} ms</span>
                  </Row>
                  <Row label="مصدر مفتاح التشفير">
                    <span dir="ltr" className="text-muted-foreground">
                      {config.masterKeySource}
                    </span>
                  </Row>
                  <Row label="مصدر مفتاح الجلسة">
                    <span dir="ltr" className="text-muted-foreground">
                      {config.sessionSecretSource}
                    </span>
                  </Row>
                  <Row label="لوحة التحكم">
                    <Badge tone={config.servingDashboard ? 'success' : 'warning'}>
                      {config.servingDashboard ? 'مُخدَّمة' : 'غير مُخدَّمة'}
                    </Badge>
                  </Row>
                </dl>
              )}

              <p className="mt-4 flex items-start gap-2 rounded-md border border-border bg-muted/50 p-3 text-xs leading-6 text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-4 shrink-0" />
                المفاتيح السرية لا تظهر هنا أبداً — يُعرض مصدرها فقط.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/60 pb-2.5 last:border-0 last:pb-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}
