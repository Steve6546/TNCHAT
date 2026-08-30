import { Input } from '../../components/ui/input';
import { Switch } from '../../components/ui/switch';
import { cn } from '../../lib/utils';

/**
 * Model catalogue for the channel form.
 *
 * A card is a name clients already ask for (`claude-3-5-sonnet`, `gpt-4o`, …).
 * Toggling one advertises that name on the channel and — when the provider
 * knows it under a different id — writes the `alias -> upstream` mapping. The
 * operator picks a card; the arrow syntax is produced by the form, never typed.
 */

export interface ModelPreset {
  /** The name a client sends. Left side of the generated mapping. */
  alias: string;
  /** One line of context, so the list is not just names. */
  hint: string;
}

export const MODEL_PRESETS: ModelPreset[] = [
  { alias: 'claude-sonnet-4', hint: 'Sonnet — الأحدث' },
  { alias: 'claude-3-5-sonnet', hint: 'Sonnet 3.5 — الأكثر استخداماً' },
  { alias: 'claude-3-5-haiku', hint: 'Haiku 3.5 — سريع واقتصادي' },
  { alias: 'claude-opus-4', hint: 'Opus — الأعلى قدرة' },
  { alias: 'gpt-4o', hint: 'GPT-4o — متعدد الوسائط' },
  { alias: 'gpt-4o-mini', hint: 'GPT-4o mini — خفيف' },
  { alias: 'MiniMax-M1', hint: 'MiniMax — نافذة سياق طويلة' },
];

interface ModelCardsProps {
  /** Names this channel currently advertises. */
  models: string[];
  mapping: Record<string, string>;
  /** Toggle a card on or off. `upstreamModel` is the id the provider expects. */
  onToggle: (alias: string, active: boolean, upstreamModel: string) => void;
  /** Change the upstream id of an already-active card. */
  onRetarget: (alias: string, upstreamModel: string) => void;
}

export function ModelCards({ models, mapping, onToggle, onRetarget }: ModelCardsProps) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {MODEL_PRESETS.map((preset) => {
        const active = models.includes(preset.alias);
        const upstream = mapping[preset.alias] ?? '';
        const rewritten = upstream.trim() !== '' && upstream.trim() !== preset.alias;

        return (
          <div
            key={preset.alias}
            className={cn(
              'rounded-lg border p-3 transition-colors duration-150',
              active ? 'border-primary/40 bg-accent/30' : 'border-border',
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium" dir="ltr">
                  {preset.alias}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">{preset.hint}</p>
              </div>
              <Switch
                checked={active}
                onCheckedChange={(next) => onToggle(preset.alias, next, upstream || preset.alias)}
                aria-label={active ? `إيقاف ${preset.alias}` : `تشغيل ${preset.alias}`}
              />
            </div>

            {active ? (
              <div className="mt-3 space-y-1.5">
                <label
                  htmlFor={`upstream-${preset.alias}`}
                  className="block text-xs text-muted-foreground"
                >
                  اسمه عند المزوّد
                </label>
                <Input
                  id={`upstream-${preset.alias}`}
                  dir="ltr"
                  className="h-8 text-xs"
                  value={upstream}
                  placeholder={preset.alias}
                  onChange={(event) => onRetarget(preset.alias, event.target.value)}
                />
                <p className="truncate text-[11px] text-muted-foreground" dir="ltr">
                  {rewritten ? `${preset.alias} -> ${upstream.trim()}` : 'بدون تحويل — يُرسل الاسم كما هو'}
                </p>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
