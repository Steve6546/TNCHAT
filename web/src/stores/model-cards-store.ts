import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * The model catalogue behind the channel form's cards.
 *
 * This is a per-browser preference, not server state: a channel keeps whatever
 * models were saved with it, and the catalogue is only a shortcut for picking
 * those names again on the next channel. That is why it lives in
 * `localStorage` rather than behind an endpoint.
 */

export interface ModelPreset {
  /** The name a client sends. Becomes the left side of a generated mapping. */
  alias: string;
  /** One line of context, so the list is not just a column of names. */
  hint: string;
}

export const MODEL_PRESETS: ModelPreset[] = [
  { alias: 'claude-opus-5', hint: 'Opus 5 — الأعلى قدرة' },
  { alias: 'claude-sonnet-4', hint: 'Sonnet 4 — متوازن' },
  { alias: 'claude-3-7-sonnet', hint: 'Sonnet 3.7 — تفكير موسّع' },
  { alias: 'claude-3-5-sonnet', hint: 'Sonnet 3.5 — الأكثر استخداماً' },
  { alias: 'claude-3-5-haiku', hint: 'Haiku 3.5 — سريع واقتصادي' },
  { alias: 'gpt-4o', hint: 'GPT-4o — متعدد الوسائط' },
  { alias: 'gpt-4o-mini', hint: 'GPT-4o mini — خفيف' },
  { alias: 'MiniMax-M1', hint: 'MiniMax — نافذة سياق طويلة' },
];

interface ModelCardsState {
  cards: ModelPreset[];
  addCard: (card: ModelPreset) => void;
  updateCard: (alias: string, next: ModelPreset) => void;
  removeCard: (alias: string) => void;
}

/**
 * Bump whenever `MODEL_PRESETS` changes.
 *
 * Migration appends presets the operator has not seen instead of replacing the
 * list, so a renamed hint or a deliberately deleted card survives an upgrade
 * while genuinely new models still appear.
 */
export const MODEL_CARDS_VERSION = 1;

/** Pure so the upgrade path can be reasoned about (and tested) on its own. */
export function migrateModelCards(persisted: unknown, version: number): { cards: ModelPreset[] } {
  const saved = (persisted as { cards?: ModelPreset[] } | undefined)?.cards;
  if (saved === undefined) return { cards: MODEL_PRESETS };
  if (version >= MODEL_CARDS_VERSION) return { cards: saved };

  const known = new Set(saved.map((card) => card.alias));
  return { cards: [...saved, ...MODEL_PRESETS.filter((card) => !known.has(card.alias))] };
}

export const useModelCardsStore = create<ModelCardsState>()(
  persist(
    (set) => ({
      cards: MODEL_PRESETS,
      addCard: (card) => set((state) => ({ cards: [...state.cards, card] })),
      updateCard: (alias, next) =>
        set((state) => ({
          cards: state.cards.map((card) => (card.alias === alias ? next : card)),
        })),
      removeCard: (alias) =>
        set((state) => ({ cards: state.cards.filter((card) => card.alias !== alias) })),
    }),
    {
      name: 'acc-model-cards',
      version: MODEL_CARDS_VERSION,
      storage: createJSONStorage(() => localStorage),
      // Only `cards` is persisted; the actions come from the live store via
      // the default shallow merge, which is why the cast is safe.
      migrate: (persisted, version) => migrateModelCards(persisted, version) as ModelCardsState,
    },
  ),
);
