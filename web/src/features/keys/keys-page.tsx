import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { CopyButton } from '../../components/shared/copy-button';
import { EmptyState } from '../../components/shared/empty-state';
import { ErrorState } from '../../components/shared/error-state';
import { PageHeader } from '../../components/shared/page-header';
import { Spinner } from '../../components/shared/spinner';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Input, Textarea } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '../../components/ui/sheet';
import { Skeleton } from '../../components/ui/skeleton';
import { Switch } from '../../components/ui/switch';
import { useToast } from '../../components/ui/toast';
import { endpoints, queryKeys, relayEndpoint } from '../../lib/api';
import type { ApiKeyItem } from '../../lib/types';
import { errorMessage, formatDate, toEpochMs } from '../../lib/utils';

/**
 * Client API keys — the credentials applications send to the gateway.
 *
 * The plaintext key is returned by the create call and never again, so it is
 * shown once in a dialog that cannot be dismissed by accident: closing it is
 * the only way out, and the key is unrecoverable after that.
 */

const EMPTY_FORM = { name: '', group: 'default', modelLimit: '', expiresAt: '' };

interface KeyFormState {
  name: string;
  group: string;
  modelLimit: string;
  expiresAt: string;
}

/**
 * Everything a client application needs, ready to paste.
 *
 * The key alone is useless without the address to send it to, and the two are
 * always retyped together — so they are copied together.
 */
function keyWithEndpoint(key: string): string {
  return `API Key: ${key}\nEndpoint: ${relayEndpoint()}`;
}

function isExpired(key: ApiKeyItem): boolean {
  return key.expiresAt != null && key.expiresAt > 0 && key.expiresAt < Date.now();
}

function statusTone(key: ApiKeyItem): 'success' | 'danger' | 'warning' | 'neutral' {
  if (key.status !== 'active') return 'neutral';
  return isExpired(key) ? 'danger' : 'success';
}

function statusLabel(key: ApiKeyItem): string {
  if (key.status !== 'active') return 'معطّل';
  return isExpired(key) ? 'منتهي' : 'نشط';
}

export function KeysPage() {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [form, setForm] = useState<KeyFormState>(EMPTY_FORM);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ApiKeyItem | null>(null);

  const keys = useQuery({ queryKey: queryKeys.keys, queryFn: endpoints.keys });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: queryKeys.keys });

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setSheetOpen(true);
  };

  const create = useMutation({
    mutationFn: async () => {
      const result = await endpoints.createKey({
        name: form.name.trim() || 'مفتاح جديد',
        group: form.group.trim() || 'default',
        modelLimit: form.modelLimit
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== ''),
        expiresAt: toEpochMs(form.expiresAt),
      });
      return result.key;
    },
    onSuccess: (key) => {
      setSheetOpen(false);
      // Deliberately not a toast: the key must be shown where it can be copied.
      setRevealed(key);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const toggle = useMutation({
    mutationFn: (key: ApiKeyItem) =>
      endpoints.updateKey(key.id, { status: key.status === 'active' ? 'disabled' : 'active' }),
    onSuccess: (_result, key) => {
      toast.success(key.status === 'active' ? 'تم تعطيل المفتاح' : 'تم تفعيل المفتاح');
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (id: number) => endpoints.deleteKey(id),
    onSuccess: () => {
      toast.success('تم حذف المفتاح');
      setPendingDelete(null);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (keys.isError) {
    return (
      <>
        <PageHeader title="مفاتيح API" description="مفاتيح يستخدمها عملاؤك للوصول إلى البوابة" />
        <ErrorState message={errorMessage(keys.error)} onRetry={() => void keys.refetch()} />
      </>
    );
  }

  const rows = keys.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="مفاتيح API"
        description="كل مفتاح يحدّد مجموعة ونماذج مسموحة للعميل"
        action={
          <Button onClick={openCreate}>
            <Plus />
            مفتاح جديد
          </Button>
        }
      />

      <Card>
        <CardContent className="p-0">
          {keys.isLoading ? (
            <div className="space-y-3 p-5">
              {Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} className="h-20 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title="لا توجد مفاتيح بعد"
              description="أنشئ مفتاحاً واحداً على الأقل ليتمكّن العميل من نداء البوابة."
              action={
                <Button onClick={openCreate}>
                  <Plus />
                  مفتاح جديد
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((key) => (
                <li key={key.id} className="flex flex-wrap items-start gap-4 p-5">
                  <div className="min-w-56 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">{key.name}</p>
                      <Badge tone={statusTone(key)}>{statusLabel(key)}</Badge>
                      <Badge>{key.group}</Badge>
                    </div>

                    <div className="mt-2 flex items-center gap-2">
                      <code
                        className="rounded border border-border bg-muted px-2 py-1 text-xs text-muted-foreground"
                        dir="ltr"
                      >
                        {key.keyPreview}
                      </code>
                      <span className="text-xs text-muted-foreground">يُعرض جزئياً فقط</span>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {key.modelLimit.length === 0 ? (
                        <span className="text-xs text-muted-foreground">كل النماذج مسموحة</span>
                      ) : (
                        key.modelLimit.map((model) => <Badge key={model}>{model}</Badge>)
                      )}
                    </div>

                    <p className="mt-2 text-xs text-muted-foreground">
                      {key.expiresAt ? `ينتهي ${formatDate(key.expiresAt)}` : 'بدون تاريخ انتهاء'} · آخر
                      استخدام {formatDate(key.lastUsedAt)}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-3">
                    <Switch
                      checked={key.status === 'active'}
                      onCheckedChange={() => toggle.mutate(key)}
                      aria-label={key.status === 'active' ? 'تعطيل المفتاح' : 'تفعيل المفتاح'}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setPendingDelete(key)}
                      aria-label="حذف المفتاح"
                      title="حذف"
                      className="text-muted-foreground hover:text-red-500"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── Create ─────────────────────────────────────────────── */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>مفتاح جديد</SheetTitle>
            <SheetDescription>سيظهر المفتاح مرة واحدة فقط بعد الإنشاء.</SheetDescription>
          </SheetHeader>

          <form
            className="flex-1 space-y-5 overflow-y-auto px-6 py-5"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="key-name">الاسم</Label>
              <Input
                id="key-name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="تطبيق الإنتاج"
                maxLength={120}
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="key-group">المجموعة</Label>
              <Input
                id="key-group"
                dir="ltr"
                value={form.group}
                onChange={(event) => setForm({ ...form, group: event.target.value })}
                placeholder="default"
                maxLength={120}
              />
              <p className="text-xs text-muted-foreground">
                توجيه الطلبات إلى القنوات التي تحمل نفس المجموعة.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="key-models">النماذج المسموحة</Label>
              <Textarea
                id="key-models"
                dir="ltr"
                value={form.modelLimit}
                onChange={(event) => setForm({ ...form, modelLimit: event.target.value })}
                placeholder={'gpt-4o-mini\nclaude-sonnet-4'}
              />
              <p className="text-xs text-muted-foreground">
                نموذج واحد في كل سطر. اتركه فارغاً للسماح بكل النماذج.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="key-expires">تاريخ الانتهاء</Label>
              <Input
                id="key-expires"
                type="datetime-local"
                dir="ltr"
                value={form.expiresAt}
                onChange={(event) => setForm({ ...form, expiresAt: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">اختياري — اتركه فارغاً لعدم الانتهاء.</p>
            </div>

            <SheetFooter className="px-0">
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? <Spinner label="جارٍ الإنشاء" /> : 'إنشاء المفتاح'}
              </Button>
              <Button type="button" variant="outline" onClick={() => setSheetOpen(false)}>
                إلغاء
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>

      {/* ── One-time reveal ────────────────────────────────────── */}
      <Dialog open={revealed !== null} onOpenChange={(open) => !open && setRevealed(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>انسخ المفتاح الآن</DialogTitle>
            <DialogDescription>
              هذه هي المرة الوحيدة التي يظهر فيها المفتاح كاملاً. بعد إغلاق هذه النافذة لا يمكن
              استرجاعه — سترى المعاينة فقط.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 rounded-lg border border-border bg-muted p-3">
            <code className="block break-all text-sm" dir="ltr">
              {revealed}
            </code>
            <p className="mt-2 text-xs text-muted-foreground" dir="ltr">
              Endpoint: {relayEndpoint()}
            </p>
          </div>

          <DialogFooter>
            <CopyButton
              value={keyWithEndpoint(revealed ?? '')}
              label="نسخ المفتاح + Endpoint"
              onCopied={() => toast.success('تم نسخ المفتاح مع رابط Endpoint')}
            />
            <Button variant="outline" onClick={() => setRevealed(null)}>
              تم، إغلاق
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirmation ────────────────────────────────── */}
      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>حذف «{pendingDelete?.name}»؟</DialogTitle>
            <DialogDescription>
              سيتوقف هذا المفتاح عن العمل فوراً. لا يمكن التراجع.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="destructive"
              onClick={() => pendingDelete && remove.mutate(pendingDelete.id)}
              disabled={remove.isPending}
            >
              {remove.isPending ? <Spinner label="جارٍ الحذف" /> : 'حذف نهائي'}
            </Button>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              إلغاء
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
