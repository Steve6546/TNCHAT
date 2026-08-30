import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, BarChart3, Box, Clock3, Database, Gauge, RotateCw, Send, Sparkles, Trash2 } from 'lucide-react';
import { lazy, Suspense, useState, type ReactNode } from 'react';

import { EmptyState } from '../../components/shared/empty-state';
import { ErrorState } from '../../components/shared/error-state';
import { PageHeader } from '../../components/shared/page-header';
import { Spinner } from '../../components/shared/spinner';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Skeleton } from '../../components/ui/skeleton';
import { useToast } from '../../components/ui/toast';
import { endpoints, queryKeys, type LogScope } from '../../lib/api';
import { cn, errorMessage, formatCompact, formatDate, formatDay, formatNumber, formatPercent } from '../../lib/utils';

// Recharts is ~40% of the bundle and is only useful once traffic exists.
const RequestsChart = lazy(() => import('./requests-chart'));

function MetricCard({ title, value, detail, icon: Icon, loading }: { title: string; value: string; detail: string; icon: typeof Activity; loading: boolean }) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{title}</p>
          <Icon className="size-4 text-muted-foreground" />
        </div>
        {loading ? <Skeleton className="mt-4 h-8 w-24" /> : <div className="mt-3 text-2xl font-medium tracking-tight" dir="ltr">{value}</div>}
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

export function OverviewPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [onlySuccesses, setOnlySuccesses] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  // The filter is part of the key, otherwise toggling it would serve the
  // previous view's cached rows.
  const stats = useQuery({
    queryKey: [...queryKeys.stats, onlySuccesses],
    queryFn: () => endpoints.statsOverview(onlySuccesses ? { ok: true } : {}),
    refetchInterval: 60_000,
  });

  const clearLogs = useMutation({
    mutationFn: (scope: LogScope) => endpoints.clearLogs(scope),
    onSuccess: (result) => {
      toast.success(`تم حذف ${formatNumber(result.deleted)} سجلّاً`);
      setConfirmClear(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.stats });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (stats.isError) {
    return (
      <>
        <PageHeader title="نظرة عامة" description="مراقبة حركة البوابة وأداء النماذج" />
        <ErrorState message={errorMessage(stats.error)} onRetry={() => void stats.refetch()} />
      </>
    );
  }

  const data = stats.data?.data;
  const hasTraffic = Boolean(data && data.lifetime.requests > 0);
  const chartData = data?.series.map((item) => ({ ...item, label: formatDay(item.day) })) ?? [];

  return (
    <>
      <PageHeader
        title="نظرة عامة"
        description="مؤشرات حقيقية ومباشرة من سجل طلبات البوابة"
        action={
          <Button variant="outline" onClick={() => void stats.refetch()} disabled={stats.isFetching}>
            <RotateCw className={stats.isFetching ? 'animate-spin' : ''} />
            تحديث
          </Button>
        }
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="طلبات اليوم" value={formatNumber(data?.today.requests ?? 0)} detail={`${formatNumber(data?.lifetime.requests ?? 0)} طوال الوقت`} icon={Send} loading={stats.isLoading} />
        <MetricCard title="رموز اليوم" value={formatCompact(data?.today.tokens ?? 0)} detail={`${formatCompact(data?.today.promptTokens ?? 0)} إدخال · ${formatCompact(data?.today.completionTokens ?? 0)} إخراج`} icon={Database} loading={stats.isLoading} />
        <MetricCard title="متوسط الاستجابة" value={`${formatNumber(data?.today.avgLatencyMs ?? 0)} ms`} detail="متوسط زمن طلبات اليوم" icon={Gauge} loading={stats.isLoading} />
        <MetricCard title="نسبة النجاح" value={formatPercent(data?.today.successRate)} detail="من إجمالي طلبات اليوم" icon={Activity} loading={stats.isLoading} />
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(340px,1fr)]">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>حجم الطلبات</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">آخر 14 يوماً مسجلاً</p>
            </div>
            <BarChart3 className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="p-0">
            {stats.isLoading ? (
              <div className="p-5"><Skeleton className="h-72 w-full" /></div>
            ) : chartData.length === 0 ? (
              <EmptyState compact icon={Sparkles} title="لا توجد حركة بعد" description="ستظهر الطلبات هنا بمجرد مرور أول طلب عبر البوابة." />
            ) : (
              <Suspense fallback={<div className="p-5"><Skeleton className="h-72 w-full" /></div>}>
                <RequestsChart data={chartData} />
              </Suspense>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>النماذج الأكثر استخداماً</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">وفق جميع السجلات</p>
            </div>
            <Box className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="p-0">
            {stats.isLoading ? (
              <div className="space-y-3 p-5">{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-10 w-full" />)}</div>
            ) : !data?.byModel.length ? (
              <EmptyState compact icon={Box} title="لا توجد نماذج مستخدمة" description="ستظهر إحصاءات النماذج بعد استقبال الطلبات." />
            ) : (
              <div className="divide-y divide-border">
                {data.byModel.slice(0, 6).map((model) => (
                  <div key={model.name} className="flex items-center justify-between gap-4 px-5 py-3.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium" dir="ltr">{model.name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{formatCompact(model.tokens)} رمز</p>
                    </div>
                    <div className="text-left">
                      <p className="text-sm font-medium" dir="ltr">{formatNumber(model.requests)}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">طلب</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      <Card className="mt-4">
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>أحدث الطلبات</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {onlySuccesses ? 'آخر 25 طلباً ناجحاً' : 'آخر 25 طلباً عبر البوابة'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div
              className="flex items-center gap-0.5 rounded-md border border-border p-0.5"
              role="group"
              aria-label="تصفية السجلات"
            >
              <FilterTab active={!onlySuccesses} onClick={() => setOnlySuccesses(false)}>
                الكل
              </FilterTab>
              <FilterTab active={onlySuccesses} onClick={() => setOnlySuccesses(true)}>
                الناجحة فقط <span dir="ltr">200</span>
              </FilterTab>
            </div>
            <Button variant="outline" size="sm" onClick={() => setConfirmClear(true)} disabled={!hasTraffic}>
              <Trash2 />
              مسح السجلات
            </Button>
            <Clock3 className="size-4 text-muted-foreground" />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {stats.isLoading ? (
            <div className="space-y-3 p-5">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-11 w-full" />)}</div>
          ) : !hasTraffic ? (
            <EmptyState compact icon={Activity} title="لا توجد طلبات حتى الآن" description="لا نعرض بيانات تجريبية. ستظهر الطلبات الحقيقية هنا فور تسجيلها." />
          ) : !data?.recent.length ? (
            <EmptyState compact icon={Activity} title="لا توجد طلبات ناجحة" description="كل الطلبات الخمسة والعشرين الأخيرة فشلت. ألغِ الفلتر لعرضها." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-right text-sm">
                <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-5 py-3 font-medium">الحالة</th>
                    <th className="px-5 py-3 font-medium">النموذج</th>
                    <th className="px-5 py-3 font-medium">القناة</th>
                    <th className="px-5 py-3 font-medium">الرموز</th>
                    <th className="px-5 py-3 font-medium">الزمن</th>
                    <th className="px-5 py-3 font-medium">التاريخ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.recent.map((request) => (
                    <tr key={request.id} className="transition-colors duration-150 hover:bg-muted/30">
                      <td className="px-5 py-3"><Badge tone={request.ok ? 'success' : 'danger'}>{request.ok ? 'ناجح' : `خطأ ${request.statusCode}`}</Badge></td>
                      <td className="max-w-56 truncate px-5 py-3 font-medium" dir="ltr">{request.model}</td>
                      <td className="px-5 py-3 text-muted-foreground">{request.channelName || '—'}</td>
                      <td className="px-5 py-3 tabular-nums" dir="ltr">{formatNumber(request.totalTokens)}</td>
                      <td className="px-5 py-3 tabular-nums text-muted-foreground" dir="ltr">{request.latencyMs} ms</td>
                      <td className="whitespace-nowrap px-5 py-3 text-muted-foreground">{formatDate(request.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Clear logs ────────────────────────────────────────── */}
      <Dialog open={confirmClear} onOpenChange={(open) => !open && setConfirmClear(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>مسح السجلات</DialogTitle>
            <DialogDescription>
              حذف الأخطاء يزيل الصفوف الفاشلة فقط (مثل 502 و 503) ويُبقي الطلبات الناجحة. حذف
              الكل يُصفّر كل أرقام هذه الشاشة. لا يؤثر أي منهما على التوجيه أو القنوات.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="destructive"
              onClick={() => clearLogs.mutate('errors')}
              disabled={clearLogs.isPending}
            >
              {clearLogs.isPending ? <Spinner label="جارٍ الحذف" /> : 'حذف الأخطاء فقط'}
            </Button>
            <Button
              variant="outline"
              className="text-red-500"
              onClick={() => clearLogs.mutate('all')}
              disabled={clearLogs.isPending}
            >
              حذف كل السجلات
            </Button>
            <Button variant="outline" onClick={() => setConfirmClear(false)}>
              إلغاء
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function FilterTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded px-2 py-1 text-xs transition-colors duration-150',
        active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}
