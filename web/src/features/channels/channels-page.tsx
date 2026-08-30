import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ChevronDown, Pencil, Plus, ServerCog, Trash2, Waypoints, Zap } from 'lucide-react';
import { useState, type FormEvent } from 'react';

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
import { Input, Select, Textarea } from '../../components/ui/input';
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
import { endpoints, queryKeys } from '../../lib/api';
import {
  CHANNEL_TYPE_OPTIONS,
  type Channel,
  type ChannelPayload,
  type ChannelTestResult,
  type ChannelType,
  type ChannelTypeOption,
} from '../../lib/types';
import { cn, errorMessage, formatDate, formatLatency } from '../../lib/utils';
import { ModelCards } from './model-cards';

/**
 * Channels (labelled "Models" in the navigation).
 *
 * A channel is one upstream provider plus the models it can serve. The form
 * asks for four things by default — name, base URL, key, models — and hides
 * routing knobs behind "advanced", because the goal is adding a model in under
 * two minutes.
 */

const DEFAULT_FORM: ChannelFormState = {
  name: '',
  type: 'openai',
  baseUrl: '',
  keys: '',
  models: '',
  modelMapping: '',
  group: 'default',
  priority: '0',
  weight: '0',
  enabled: true,
};

interface ChannelFormState {
  name: string;
  type: ChannelType;
  baseUrl: string;
  keys: string;
  models: string;
  modelMapping: string;
  group: string;
  priority: string;
  weight: string;
  enabled: boolean;
}

/** Newline-separated text → trimmed, de-duplicated array. */
function toList(value: string): string[] {
  return [...new Set(value.split('\n').map((line) => line.trim()).filter((line) => line !== ''))];
}

/**
 * The only separator the mapping accepts.
 *
 * A plain space between two model names is the mistake this exists to catch:
 * it looks right, it saves, and it silently produces a channel that advertises
 * one model nobody can request.
 */
const MAPPING_ARROW = '->';

/** One mapping line → an error message, or `null` when the line is valid. */
function mappingLineError(line: string): string | null {
  if (!line.includes(MAPPING_ARROW)) {
    return `استخدم السهم ${MAPPING_ARROW} بدلاً من المسافة: «${line}» — مثال: claude-3-5-sonnet -> MiniMaxAI/MiniMax-M3`;
  }
  const [from, to] = line.split(MAPPING_ARROW).map((part) => part.trim());
  if (!from || !to) return `التحويل ناقص على جانب واحد على الأقل: «${line}»`;
  return null;
}

/** First offending line in a whole textarea, or `null` when it is clean. */
function firstMappingError(value: string): string | null {
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const error = mappingLineError(trimmed);
    if (error !== null) return error;
  }
  return null;
}

/**
 * Lenient parse for live form state: malformed lines are skipped rather than
 * thrown, so the cards keep working while a line is half-typed.
 */
function parseMapping(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || mappingLineError(trimmed) !== null) continue;
    const [from, to] = trimmed.split(MAPPING_ARROW).map((part) => part.trim());
    out[from!] = to!;
  }
  return out;
}

/** Same parse, but refuses to save a single malformed line. */
function toMapping(value: string): Record<string, string> {
  const error = firstMappingError(value);
  if (error !== null) throw new Error(error);
  return parseMapping(value);
}

function mappingToText(mapping: Record<string, string>): string {
  return Object.entries(mapping)
    .map(([from, to]) => `${from} -> ${to}`)
    .join('\n');
}

function statusTone(status: Channel['status']): 'neutral' | 'success' | 'danger' {
  if (status === 'healthy') return 'success';
  if (status === 'failing') return 'danger';
  return 'neutral';
}

function statusLabel(status: Channel['status']): string {
  if (status === 'healthy') return 'متصل';
  if (status === 'failing') return 'فاشل';
  return 'غير مُختبَر';
}

export function ChannelsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [form, setForm] = useState<ChannelFormState>(DEFAULT_FORM);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Channel | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [pingResults, setPingResults] = useState<Record<number, ChannelTestResult>>({});

  const channels = useQuery({ queryKey: queryKeys.channels, queryFn: endpoints.channels });
  const types = useQuery({ queryKey: queryKeys.channelTypes, queryFn: endpoints.channelTypes, staleTime: Infinity });

  // Both derived from the same text the textareas hold, so the cards and the
  // raw fields can never disagree.
  const formModels = toList(form.models);
  const formMapping = parseMapping(form.modelMapping);
  const mappingError = firstMappingError(form.modelMapping);

  const channelTypes: ChannelTypeOption[] =
    types.data?.data && types.data.data.length > 0 ? types.data.data : CHANNEL_TYPE_OPTIONS;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.channels });
    void queryClient.invalidateQueries({ queryKey: queryKeys.stats });
  };

  const openCreate = () => {
    setEditing(null);
    setForm(DEFAULT_FORM);
    setAdvancedOpen(false);
    setSheetOpen(true);
  };

  const openEdit = (channel: Channel) => {
    setEditing(channel);
    setForm({
      name: channel.name,
      type: channel.type,
      baseUrl: channel.baseUrl,
      // Keys are never returned by the API; leaving this blank keeps the
      // stored ones intact.
      keys: '',
      models: channel.models.join('\n'),
      modelMapping: mappingToText(channel.modelMapping),
      group: channel.group,
      priority: String(channel.priority),
      weight: String(channel.weight),
      enabled: channel.enabled,
    });
    setAdvancedOpen(false);
    setSheetOpen(true);
  };

  /**
   * One card toggle → both fields.
   *
   * Activating a card advertises the alias (so clients can request it) and
   * writes `alias -> upstream` only when the two names differ. Deactivating
   * removes both. The arrow is produced here, never typed.
   */
  const applyCard = (alias: string, active: boolean, upstreamModel: string) => {
    const nextMapping = { ...formMapping };
    const nextModels = active
      ? [...new Set([...formModels, alias])]
      : formModels.filter((model) => model !== alias);

    const target = upstreamModel.trim();
    if (!active || target === '' || target === alias) delete nextMapping[alias];
    else nextMapping[alias] = target;

    setForm({ ...form, models: nextModels.join('\n'), modelMapping: mappingToText(nextMapping) });
  };

  /**
   * Renaming a card has to carry its rewrite across: the old name may be the
   * key of a mapping entry, and leaving it behind would silently drop the
   * rewrite while the model keeps being advertised.
   */
  const renameModel = (from: string, to: string) => {
    const nextModels = [...new Set(formModels.map((model) => (model === from ? to : model)))];
    const nextMapping: Record<string, string> = {};
    for (const [alias, target] of Object.entries(formMapping)) {
      nextMapping[alias === from ? to : alias] = target;
    }
    setForm({ ...form, models: nextModels.join('\n'), modelMapping: mappingToText(nextMapping) });
  };

  const save = useMutation({
    mutationFn: async () => {
      const payload: ChannelPayload = {
        name: form.name.trim(),
        type: form.type,
        baseUrl: form.baseUrl.trim(),
        keys: toList(form.keys),
        models: toList(form.models),
        modelMapping: toMapping(form.modelMapping),
        group: form.group.trim() || 'default',
        priority: Number.parseInt(form.priority, 10) || 0,
        weight: Number.parseInt(form.weight, 10) || 0,
        enabled: form.enabled,
      };

      if (editing) return endpoints.updateChannel(editing.id, payload);
      return endpoints.createChannel(payload);
    },
    onSuccess: (_, __, ___) => {
      toast.success(editing ? 'تم حفظ القناة' : 'تمت إضافة القناة');
      setSheetOpen(false);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (id: number) => endpoints.deleteChannel(id),
    onSuccess: () => {
      toast.success('تم حذف القناة');
      setPendingDelete(null);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      endpoints.updateChannel(id, { enabled }),
    onSuccess: (_result, variables) => {
      toast.success(variables.enabled ? 'تم تمكين القناة' : 'تم تعطيل القناة');
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  /**
   * Sends a real request to the provider and reports the measured latency.
   * The result is also kept per channel so the row itself shows what came
   * back, without a round trip through a toast the user has to remember.
   */
  const test = async (channel: Channel) => {
    setTestingId(channel.id);
    try {
      const result = await endpoints.testChannel(channel.id);
      setPingResults((current) => ({ ...current, [channel.id]: result }));
      if (result.ok) {
        toast.success(`الاتصال ناجح · ${result.latencyMs ?? 0} ms`);
      } else {
        toast.error(`فشل الاتصال: ${result.message}`);
      }
      invalidate();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setTestingId(null);
    }
  };

  if (channels.isError) {
    return (
      <>
        <PageHeader title="إدارة النماذج" description="قنوات المزوّدين العلويين والنماذج التي تخدمها" />
        <ErrorState message={errorMessage(channels.error)} onRetry={() => void channels.refetch()} />
      </>
    );
  }

  const rows = channels.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="إدارة النماذج"
        description="كل قناة = مزوّد علوي واحد + النماذج التي يخدمها"
        action={
          <Button onClick={openCreate}>
            <Plus />
            إضافة نموذج
          </Button>
        }
      />

      <Card>
        <CardContent className="p-0">
          {channels.isLoading ? (
            <div className="space-y-3 p-5">
              {Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} className="h-20 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Waypoints}
              title="لا توجد نماذج بعد"
              description="أضف قناة واحدة على الأقل ليتمكّن العميل من استخدام البوابة."
              action={
                <Button onClick={openCreate}>
                  <Plus />
                  إضافة نموذج
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((channel) => {
                const ping = pingResults[channel.id];

                return (
                  <li key={channel.id} className="flex flex-wrap items-start gap-4 p-5">
                    <div className="min-w-56 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium">{channel.name}</p>
                        <Badge tone={statusTone(channel.status)}>{statusLabel(channel.status)}</Badge>
                        {!channel.enabled ? <Badge>معطّلة</Badge> : null}
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground" dir="ltr">
                        {channel.baseUrl}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {channel.models.length === 0 ? (
                          <span className="text-xs text-muted-foreground">لا توجد نماذج</span>
                        ) : (
                          channel.models.map((model) => (
                            <Badge key={model}>{model}</Badge>
                          ))
                        )}
                      </div>
                      {ping ? (
                        <p
                          className={cn(
                            'mt-2 flex flex-wrap items-center gap-x-1.5 text-xs',
                            ping.ok ? 'text-success' : 'text-destructive',
                          )}
                          dir="ltr"
                        >
                          <span>{ping.ok ? 'استجابة سليمة' : 'فشل الفحص'}</span>
                          {ping.statusCode !== undefined ? <span>· {ping.statusCode}</span> : null}
                          <span>· {formatLatency(ping.latencyMs)}</span>
                          {ping.model ? <span>· {ping.model}</span> : null}
                        </p>
                      ) : null}
                      {channel.lastError ? (
                        <p className="mt-2 text-xs text-red-500">{channel.lastError}</p>
                      ) : null}
                    </div>

                    <div className="flex shrink-0 items-center gap-4">
                      <div className="text-left">
                        <p className="text-xs text-muted-foreground">آخر استجابة</p>
                        <p className="text-sm tabular-nums" dir="ltr">
                          {channel.lastLatencyMs == null ? '—' : `${channel.lastLatencyMs} ms`}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {channel.lastTestedAt ? formatDate(channel.lastTestedAt) : 'لم يُختبر'}
                        </p>
                      </div>

                      <Switch
                        checked={channel.enabled}
                        onCheckedChange={(enabled) => toggle.mutate({ id: channel.id, enabled })}
                        aria-label={channel.enabled ? 'تعطيل القناة' : 'تمكين القناة'}
                      />

                      <div className="flex items-center">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => void test(channel)}
                          disabled={testingId === channel.id}
                          aria-label="فحص الاتصال"
                          title="فحص الاتصال"
                        >
                          {testingId === channel.id ? (
                            <Activity className="animate-pulse" />
                          ) : (
                            <Zap />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openEdit(channel)}
                          aria-label="تعديل القناة"
                          title="تعديل"
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setPendingDelete(channel)}
                          aria-label="حذف القناة"
                          title="حذف"
                          className="text-muted-foreground hover:text-red-500"
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── Create / edit ─────────────────────────────────────── */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{editing ? 'تعديل القناة' : 'إضافة نموذج'}</SheetTitle>
            <SheetDescription>
              أربعة حقول تكفي للبدء. باقي الإعدادات لها قيم افتراضية معقولة.
            </SheetDescription>
          </SheetHeader>

          <form
            className="flex-1 space-y-5 overflow-y-auto px-6 py-5"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              // The models field has no visible input any more, so "pick at
              // least one" has to be said here — the server would answer in
              // English and point at a field the user cannot see.
              if (formModels.length === 0) {
                toast.error('فعّل نموذجاً واحداً على الأقل من البطاقات');
                return;
              }
              // Caught here as well as in the mutation, so the field that is
              // wrong is the one the user is shown.
              if (mappingError !== null) {
                setAdvancedOpen(true);
                toast.error(mappingError);
                return;
              }
              try {
                save.mutate();
              } catch (error) {
                toast.error(errorMessage(error));
              }
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="channel-name">اسم القناة</Label>
              <Input
                id="channel-name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="MiniMax — الإنتاج"
                required
                maxLength={120}
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="channel-type">نوع المزوّد</Label>
              <Select
                id="channel-type"
                value={form.type}
                onChange={(event) => setForm({ ...form, type: event.target.value as ChannelType })}
              >
                {channelTypes.map((option: ChannelTypeOption) => (
                  <option key={option.kind} value={option.kind}>
                    {option.label}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                اختيار من الأنواع المدعومة فقط — لا يُقبل إدخال نوع يدوي.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="channel-url">Base URL</Label>
              <Input
                id="channel-url"
                dir="ltr"
                value={form.baseUrl}
                onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                placeholder="https://api.example.com/v1"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="channel-keys">مفاتيح API</Label>
              <Textarea
                id="channel-keys"
                dir="ltr"
                value={form.keys}
                onChange={(event) => setForm({ ...form, keys: event.target.value })}
                placeholder={editing ? 'اتركه فارغاً للإبقاء على المفاتيح الحالية' : 'مفتاح واحد في كل سطر'}
                required={!editing}
              />
              <p className="text-xs text-muted-foreground">
                تُخزَّن مشفّرة ولا تُعرض مرة أخرى.
              </p>
            </div>

            <div className="space-y-2">
              <div className="space-y-1">
                <p className="text-sm font-medium">النماذج التي تخدمها هذه القناة</p>
                <p className="text-xs text-muted-foreground">
                  فعّل بطاقة ليُعلن عن اسمها للعملاء، واكتب اسمها عند المزوّد إن اختلف. عدّل
                  البطاقات أو أضف غيرها بحرية — النظام يبرمج التحويل في الخلفية.
                </p>
              </div>
              <ModelCards
                models={formModels}
                mapping={formMapping}
                onToggle={applyCard}
                onRename={renameModel}
              />
            </div>

            <div className="rounded-lg border border-border">
              <button
                type="button"
                onClick={() => setAdvancedOpen(!advancedOpen)}
                className="flex w-full items-center gap-2 px-4 py-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
                aria-expanded={advancedOpen}
              >
                <ChevronDown className={cn('size-4 transition-transform', advancedOpen && 'rotate-180')} />
                <ServerCog className="size-4" />
                خيارات متقدمة
              </button>

              {advancedOpen ? (
                <div className="space-y-5 border-t border-border px-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="channel-mapping">تحويل النماذج (تحرير يدوي)</Label>
                    <Textarea
                      id="channel-mapping"
                      dir="ltr"
                      value={form.modelMapping}
                      onChange={(event) => setForm({ ...form, modelMapping: event.target.value })}
                      placeholder={'claude-3-5-sonnet -> MiniMaxAI/MiniMax-M3'}
                      aria-invalid={mappingError !== null}
                      className={mappingError !== null ? 'border-red-500 focus:border-red-500 focus:ring-red-500' : undefined}
                    />
                    {mappingError !== null ? (
                      <p className="text-xs text-red-500">{mappingError}</p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        سطر لكل تحويل بالصيغة <code dir="ltr">من -&gt; إلى</code>
                      </p>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="channel-priority">الأولوية</Label>
                      <Input
                        id="channel-priority"
                        dir="ltr"
                        type="number"
                        value={form.priority}
                        onChange={(event) => setForm({ ...form, priority: event.target.value })}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="channel-weight">الوزن</Label>
                      <Input
                        id="channel-weight"
                        dir="ltr"
                        type="number"
                        min={0}
                        value={form.weight}
                        onChange={(event) => setForm({ ...form, weight: event.target.value })}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="channel-group">المجموعة</Label>
                    <Input
                      id="channel-group"
                      dir="ltr"
                      value={form.group}
                      onChange={(event) => setForm({ ...form, group: event.target.value })}
                    />
                  </div>

                  <label className="flex items-center justify-between gap-3 text-sm">
                    <span>مُفعّلة</span>
                    <Switch
                      checked={form.enabled}
                      onCheckedChange={(enabled) => setForm({ ...form, enabled })}
                    />
                  </label>
                </div>
              ) : null}
            </div>

            <SheetFooter className="px-0">
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? <Spinner label="جارٍ الحفظ" /> : editing ? 'حفظ التغييرات' : 'إضافة القناة'}
              </Button>
              <Button type="button" variant="outline" onClick={() => setSheetOpen(false)}>
                إلغاء
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>

      {/* ── Delete confirmation ───────────────────────────────── */}
      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>حذف «{pendingDelete?.name}»؟</DialogTitle>
            <DialogDescription>
              سيؤدي هذا إلى حذف القناة ومفاتيحها. الطلبات المسجّلة سابقاً في السجلات تبقى كما هي.
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
