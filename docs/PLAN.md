# AI Command Center — خطة التنفيذ الكاملة

> مركز تحكم مركزي للذكاء الاصطناعي. منطق البوابة (Gateway) منقول بأمانة من مشروع  
> [QuantumNous/new-api](https://github.com/QuantumNous/new-api) مع واجهة جديدة كلياً.
>
> تاريخ التخطيط: 2026-08-30 · الحالة: **خطة معتمدة، بانتظار أمر البدء**

---


## 1. ما استخرجته فعلياً من شيفرة New API

لم أعمل من الذاكرة — سحبت المستودع (`_ref_new_api`) وقرأت الملفات المؤثرة. هذه هي الحقائق التي سيُبنى عليها التنفيذ:

| المصدر (ملف فعلي)                        | ما استخرجته                                                                                                                                                                                                | كيف سينتقل إلينا                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `router/relay-router.go:13-193`          | كل مسارات الـ relay: `/v1/messages` (Claude)، `/v1/chat/completions`، `/v1/models`، `/v1beta/models/*` مع سلسلة Middleware بالترتيب: CORS → Decompress → Stats → TokenAuth → RateLimit → Distribute        | نفس الترتيب، نفس المسارات                                                       |
| `middleware/auth.go:354` (`TokenAuth`)   | يقبل `Authorization: Bearer sk-xxx` **أو** `x-api-key` (Claude) **أو** `?key=` (Gemini) **أو** `mj-api-secret`. ينزع بادئة `sk-` ثم يقسم على `-` ويأخذ الجزء الأول. ثم `ValidateUserToken`                 | منقول حرفياً + تخزين المفتاح **مُهشّأ** sha256 بدل النص الصريح                  |
| `middleware/distributor.go:33-171`       | اختيار القناة: Affinity ( sticky ) → Ability lookup → Priority tiers → Weighted random                                                                                                                     | منقول مع نفس ثوابت الخوارزمية                                                   |
| `model/ability.go:63-141` (عبر DeepWiki) | `getPriority()` ترتّب الشرائح **تنازلياً**؛ المحاولة الأولى تستخدم الأعلى؛ **كل إعادة محاولة تنزل شريحة** للـ failover. الوزن العشوائي: `sum(weight + 10)` ← random ← طرح متسلسل                           | منقول بالأرقام نفسها (الـ +10 offset مانع لتجويع الأوزان الصفرية)               |
| `model/channel.go:199-236`               | `GetNextEnabledKey()` — قناة واحدة قد تحمل عدة مفاتيح: Round-Robin (`MultiKeyPollingIndex`) أو Random، مع تخطي المفاتيح المعطّلة                                                                           | منقول                                                                           |
| `relay/helper/model_mapped.go:13-57`     | **هذا هو جوهر Model Mapping**: سلسلة إعادة توجيه متتابعة للنموذج + **كشف الدوران** (`model_mapping_contains_cycle`)                                                                                        | منقول سطراً بسطر — أهم قطعة منطق في المشروع                                     |
| `relay/channel/adapter.go:17-34`         | واجهة `Adaptor`: `Init / GetRequestURL / SetupRequestHeader / ConvertOpenAIRequest / ConvertClaudeRequest / DoRequest / DoResponse / GetModelList / GetChannelName`                                        | نفس الواجهة في TypeScript                                                       |
| `relay/claude_handler.go:24-230`         | دورة حياة طلب Claude: `InitChannelMeta` → `ModelMappedHelper` → `GetAdaptor` → تعبئة `max_tokens` → تحويل → `RemoveDisabledFields` → `ParamOverride` → `DoRequest` → `DoResponse` → `PostTextConsumeQuota` | نفس السلسلة                                                                     |
| `controller/relay.go:71-210`             | حلقة إعادة المحاولة: `RetryTimes`، تخطي الإعادة عند `ErrOptionWithSkipRetry` (مثل 413)، **واسترداد الحصة (refund) عند فشل كل المحاولات**                                                                   | منقول                                                                           |
| `relaykit/README.md:16-33`               | مصفوفة التحويل الرسمية: Claude ↔ OpenAI = **`Fair`** في الاتجاهين. أي: قابل للتحويل لكن بعض الخصائص تحتاج مواءمة. التحويل عبر Gemini = `Discouraged`                                                       | **التزام بالصراحة**: سنغطي Claude ↔ OpenAI فقط، وسنوثّق الحدود بدل ادعاء الكمال |
| `relaykit` streaming contract            | `NewResponseStreamState` → `ConvertStreamStreamChunk` لكل حدث → `FinalizeStreamResponse` **إجبارياً** في النهاية (بعض المحوّلات تُصدر حدث الإنهاء أو الـ usage النهائي هناك فقط)                           | منقول — وهذه أهم نقطة يخطئ فيها أي تطبيق سطحي                                   |

### النتيجة: خريطة البوابة المستهدفة

```
Claude Desktop / Cherry Studio / أي عميل OpenAI
        │
        ▼  POST /v1/messages  |  POST /v1/chat/completions
┌───────────────────────────────────────────────────────────┐
│ 1. TokenAuth      → sk-xxx (أو x-api-key) → api_keys       │
│ 2. Distribute     → model/group → abilities → priority     │
│                     → weighted random → affinity           │
│ 3. ModelMapping   → سلسلة إعادة توجيه + كشف دوران          │
│ 4. Adaptor        → تحويل البروتوكول (Claude ⇄ OpenAI)     │
│ 5. Upstream       → fetch + SSE pipe                       │
│ 6. Relay loop     → إعادة محاولة (تنزيل شريحة) + refund    │
│ 7. Usage          → عدّاد التوكنات + تسجيل                 │
└───────────────────────────────────────────────────────────┘
        │
        ▼
   MiniMax · Claude · OpenAI · أي مزود OpenAI-compatible
```

---

## 2. القرارات المحسومة

| البند           | القرار                                                             | السبب                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| الباك إند       | **Node 22 + TypeScript + Fastify**                                 | Go غير مثبت على جهازك. TS يمنحك لغة واحدة للمشروع كله، وSSE streaming فيه ممتاز. أسماء المفاهيم والملفات ستبقى مطابقة للأصل لتسهيل أي مقارنة أو نقل لاحق |
| قاعدة البيانات  | **SQLite** عبر `better-sqlite3` + **Drizzle ORM**                  | ملف واحد `server/data/app.db`، صفر إعداد، يحفظ فعلياً                                                                                                    |
| الواجهة         | **Vite + React 19 + TypeScript + Tailwind CSS v4**                 | `@tailwindcss/vite` + `npx shadcn@latest init -t vite`                                                                                                   |
| مكونات          | **shadcn/ui** (Radix) + إضافات منتقاة                              | أساس صلب، ثم استعارة أساليب جاهزة                                                                                                                        |
| إدارة الحالة    | **Zustand** (stores منفصلة لكل نطاق) + TanStack Query لجلب السيرفر | Zustand لحالة الواجهة/التفضيلات، Query للبيانات القادمة من السيرفر                                                                                       |
| البروتوكولات v1 | **Anthropic + OpenAI** بالاتجاهين + streaming                      | يكفي Claude Desktop وCherry Studio وأي عميل OpenAI                                                                                                       |
| البيانات        | **صفر بيانات وهمية**. الـ seed الوحيد هو حساب الإدارة الأول        | كل بطاقة معروضة تأتي من `GET` حقيقي                                                                                                                      |

---


## 3. بنية المشروع

```
Web App & Server/
├── PLAN.md                       ← هذا الملف
├── README.md
├── package.json                  (pnpm workspace root)
├── pnpm-workspace.yaml
├── .env.example
│
├── server/                       ← بوابة الذكاء (Node/TS)
│   ├── package.json
│   ├── tsconfig.json
│   ├── drizzle.config.ts
│   ├── data/app.db               (يُنشأ تلقائياً)
│   └── src/
│       ├── index.ts              نقطة الدخول
│       ├── app.ts                مصنع Fastify (قابل للاختبار)
│       ├── config.ts             env + تحقق zod
│       ├── db/
│       │   ├── schema.ts         جداول Drizzle
│       │   ├── migrate.ts
│       │   └── bootstrap.ts      إنشاء حساب الإدارة الأول (ليس بيانات وهمية)
│       ├── core/
│       │   ├── errors.ts         NewAPIError + ErrOptionWithSkipRetry
│       │   ├── formats.ts        RelayFormat enum
│       │   └── keys.ts           مولّد sk- + sha256
│       ├── gateway/
│       │   ├── token-auth.ts     ← middleware/auth.go
│       │   ├── distributor.ts    ← middleware/distributor.go
│       │   ├── model-mapping.ts  ← relay/helper/model_mapped.go
│       │   ├── ability-index.ts  ← model/ability.go (فهرس في الذاكرة)
│       │   ├── relay.ts          ← controller/relay.go
│       │   ├── upstream.ts       fetch + SSE + timeouts
│       │   └── usage.ts          التوكنات والحصة
│       ├── convert/
│       │   ├── dto/claude.ts · openai.ts
│       │   ├── claude-to-openai.ts
│       │   ├── openai-to-claude.ts
│       │   └── stream-state.ts   ← ResponseStreamState + Finalize
│       ├── adapters/
│       │   ├── types.ts          ← relay/channel/adapter.go
│       │   ├── openai.ts · anthropic.ts · minimax.ts · generic.ts
│       ├── routes/
│       │   ├── relay.ts          /v1/*
│       │   ├── admin-channels.ts · admin-keys.ts · admin-stats.ts
│       │   └── health.ts
│       └── lib/                  logger · crypto · sse
│
└── web/                          ← لوحة التحكم (Vite React)
    ├── vite.config.ts
    ├── components.json
    └── src/
        ├── main.tsx · App.tsx
        ├── styles/globals.css    Design tokens
        ├── lib/                  api-client · format · cn
        ├── store/                auth · channels · keys · stats · ui (Zustand)
        ├── components/ui/        مكونات shadcn
        ├── components/           app-shell · sidebar · stat-card · empty-state
        └── pages/                Overview · Models · Keys · Settings · Login
```

### مخطط قاعدة البيانات

| الجدول         | الحقول الأساسية                                                                                                                                   | ملاحظة                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `channels`     | id, name, type, base_url, keys (JSON), models (JSON), model_mapping (JSON), group, priority, weight, enabled, status, response_ms, last_tested_at | القناة = مزود علوي واحد                              |
| `abilities`    | group, model, channel_id, enabled, priority, weight                                                                                               | مُولّد تلقائياً عند كل تغيير قناة — نفس فكرة New API |
| `api_keys`     | id, key_hash, name, group, model_limit, status, expires_at, created_at                                                                            | **لا نخزّن المفتاح نصاً صريحاً**                     |
| `request_logs` | id, key_id, channel_id, model, upstream_model, prompt_tokens, completion_tokens, cached_tokens, status, latency_ms, is_stream, created_at         | مصدر الإحصائيات الحقيقية                             |
| `settings`     | key, value (JSON)                                                                                                                                 | التفضيلات                                            |

فهرس `abilities` يُبنى في الذاكرة عند الإقلاع ويُحدَث عند كل تعديل قناة — يمنح اختياراً لـ O(1) بدل استعلام متكرر.

---

## 4. نظام التصميم — Linear / Vercel Minimal

### القاعدة الذهبية

> **لا زر إلا وله وظيفة حقيقية تنتهي بنقطة نهاية فعلية.** أي زر لا يستطيع استدعاء endpoint سيُحذف من التصميم.

### Design tokens

```css
/* الشكل الهندسي */
--radius: 0.5rem;              /* 8px — الأزرار والحقول */
--radius-card: 0.75rem;        /* 12px — البطاقات */
--border: 1px solid hsl(var(--border));

/* الألوان — مقياس zinc محايد، بلا أي لون علامة تجارية واحد */
light:  bg #ffffff · surface #fafafa · border #e4e4e7 · text #18181b · muted #71717a
dark:   bg #09090b · surface #111113 · border #27272a · text #fafafa · muted #a1a1aa

/* الحركة — تحويلات وشفافية فقط */
--dur-fast: 120ms;  --dur: 160ms;  --ease: cubic-bezier(0.16, 1, 0.3, 1);
/* لا حركة تتجاوز 200ms. لا اهتزاز، لا نبض، لا توهج */

/* الطباعة */
font: Inter (عبر fontsource، مستضاف محلياً)
h1 24/500 · h2 18/500 · h3 15/500 · body 14/400 · caption 12/400
/* وزنان فقط: 400 و 500. لا 600، لا 700 */
```


### أنماط الأزرار (المواصفة النهائية)

| الاسم           | الحالة                           | المواصفة البصرية                                                                                                                                                                                                                      | أين يُستخدم                 |
| --------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **Primary**     | الإجراء الرئيسي الوحيد في الشاشة | `h-9 px-4 text-sm font-medium rounded-md` · light: `bg-zinc-950 text-zinc-50 hover:bg-zinc-800` · dark: `bg-zinc-50 text-zinc-950 hover:bg-zinc-200` · ظل داخلي علوي 1px للّمعان · `focus-visible:ring-2 ring-zinc-400 ring-offset-2` | "إنشاء مفتاح"، "حفظ القناة" |
| **Secondary**   | إجراء ثانوي                      | `bg-white border border-zinc-200 hover:bg-zinc-50` · dark: `bg-zinc-900 border-zinc-800 hover:bg-zinc-800`                                                                                                                            | "إلغاء"، "اختبار الاتصال"   |
| **Ghost**       | إجراءات السياق                   | `hover:bg-zinc-100 dark:hover:bg-zinc-800` بلا حدود                                                                                                                                                                                   | أزرار الأيقونات في الجداول  |
| **Destructive** | حذف فقط                          | `bg-red-600 text-white hover:bg-red-700`                                                                                                                                                                                              | حذف قناة/مفتاح (مع تأكيد)   |
| **Link**        | تنقّل                            | `text-zinc-600 underline-offset-4 hover:underline`                                                                                                                                                                                    | روابط ثانوية                |

**قواعد صارمة للأزرار:**

1. **Primary واحد فقط** لكل شاشة — الباقي secondary أو ghost.
2. كل زر يدعم حالة `loading` (Spinner يحل محل النص) و`disabled` (opacity 50 + `cursor-not-allowed`).
3. أي زر يغيّر حالة السيرفر يظهر رسالة نتيجة (toast)، لا صمتاً أبداً.
4. أزرار النسخ تستخدم أنيميشن تحقّق ↔ نسخ (مستعار من Cult UI).
5. لا أيقونة بلا `aria-label`، لا زر أيقونة بلا `tooltip`.


### المكتبات التي سنستعير منها أساليب جاهزة

بحثت في أبرز المكتبات مفتوحة المصدر؛ هذه هي المنتقاة، مع ما نأخذه من كل واحدة **بالضبط**:

| المكتبة                | الترخيص | ما سنأخذه                                                                                                                                 | أمر التثبيت                                                                                                                                      |
| ---------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **shadcn/ui** (الأساس) | MIT     | Button, Card, Dialog, Sheet, Input, Label, Select, Switch, Table, Tabs, Badge, Tooltip, Separator, Skeleton, Sonner (toast), DropdownMenu | `pnpm dlx shadcn@latest add button card dialog sheet input label select switch table tabs badge tooltip separator skeleton sonner dropdown-menu` |
| **Origin UI**          | MIT     | حقول الإدخال بمُلحقات داخلية (prefix/suffix)، مجموعات الأزرار المنقسمة، Select متقدم                                                      | `pnpm dlx shadcn@latest add https://originui.com/r/comp-01.json`                                                                                 |
| **shadcn/ui Charts**   | MIT     | مخطط الاستهلاك الزمني في Overview (Recharts، مُنسّق عبر CSS variables فيتبع الوضع الليلي تلقائياً)                                        | `pnpm dlx shadcn@latest add chart`                                                                                                               |
| **Tremor**             | MIT     | بطاقات KPI (رقم كبير + دلتا + sparkline) — معايرة خصيصاً للوحات البيانات                                                                  | استلهام + `recharts`، نستخدم مكوّننا المبني على shadcn Card                                                                                      |
| **Cult UI**            | MIT     | زر النسخ بتحوّل أيقونة سلس، وحالة التفكير/التدفق في صفحة النماذج                                                                          | `pnpm dlx shadcn@latest add https://www.cult-ui.com/r/copy-button.json`                                                                          |
| **Motion Primitives**  | MIT     | انتقالات الصفحات الخفيفة وحركات الظهور التدريجي                                                                                           | `pnpm dlx shadcn@latest add https://motion-primitives.com/c/text-effect.json`                                                                    |

**ما نستبعده صراحةً:** Aceternity UI و Magic UI (توهج وتدرجات وShimmer) — لأنها تناقض الهوية Minimal وتُبطئ الواجهة. نحتفظ بها كخيار تحويل لاحق إن غيّرت رأيك.

---


## 5. مراحل التنفيذ

| #     | المرحلة              | المخرجات                                                                                               | التحقق                                                                                    |
| ----- | -------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| **0** | التهيئة              | pnpm workspace، `server/` + `web/`، tsconfig، eslint، prettier، `.env.example`                         | `pnpm -r typecheck` يمرّ                                                                  |
| **1** | طبقة البيانات        | schema Drizzle + migrations + bootstrap الإدارة                                                        | `pnpm db:migrate` ينشئ `app.db`؛ جدول `api_keys` يحقق الاستعلام بالـ hash                 |
| **2** | محرك التحويل         | DTOs Claude/OpenAI + المحوّلان + StreamState                                                           | اختبارات وحدة: Claude→OpenAI→Claude ثابت (round-trip)، وأحداث SSE تُنهى بـ usage صحيح     |
| **3** | المهايئات + Upstream | openai · anthropic · minimax · generic + SSE pipe مع timeouts                                          | طلب حقيقي لكل مهايئ (بمفتاحك) يرد 200                                                     |
| **4** | خط البوابة           | token-auth → distributor (priority/weight/affinity) → model-mapping (كشف دوران) → relay retry → usage  | سكربت اختبار: قناتان بنفس النموذج + أوزان مختلفة → توزيع 100 طلب يقترب من النسبة المتوقعة |
| **5** | REST الإدارة         | `/api/channels` CRUD + test، `/api/keys` CRUD، `/api/stats`، `/api/health`                             | كل مسار موثّق في `README.md` مع مثال curl                                                 |
| **6** | هيكل الواجهة         | Design tokens، App-shell، Sidebar، الوضع الليلي، موجّه الصفحات                                         | لا توجد أي قيمة ثابتة معروضة في الواجهة                                                   |
| **7** | الصفحات              | Overview (KPI + مخطط + حالة النماذج) · Models (إضافة في <دقيقتين) · Keys (إنشاء ونسخ بنقرة) · Settings | كل صفحة مرتبطة بـ endpoint حقيقي؛ فراغ السيرفر = Empty State صادق، لا أرقام مزيفة         |
| **8** | المراجعة والتقوية    | مراجعة كود كاملة، معالجة الأخطاء، التحقق من التناقضات                                                  | القائمة في القسم 7 أدناه                                                                  |

### تفصيل المرحلة 7 — لأنها جوهر طلبك

**صفحة Models (الهدف: إضافة نموذج جديد في أقل من دقيقتين)**  
النموذج مكوّن من 4 حقول فقط، في نافذة جانبية واحدة:

1. **Model Name** — الاسم الذي سيراه العميل
2. **Base URL** — عنوان المزود العلوي
3. **API Key** — مفتاح المزود (يُخزّن مشفّراً)
4. **Model Mapping** — اختياري، محرّر `(من) → (إلى)` بسيط

ثم زرّان فقط: **اختبار الاتصال** (ينفّذ طلباً حقيقياً ويعرض زمن الاستجابة) و**حفظ**.  
كل شيء آخر (النوع، المجموعة، الأولوية، الوزن) له قيم افتراضية ذكية مخفية تحت "خيارات متقدمة".

**صفحة Keys** — زر Primary واحد: "إنشاء مفتاح". النتيجة بطاقة واحدة تحتوي المفتاح كاملاً + زر نسخ بتحوّل أيقونة + تحذير بأنه يُعرض مرة واحدة فقط.

**صفحة Overview** — ثلاثة أرقام فقط (طلبات اليوم، التوكنات المستهلكة، متوسط زمن الاستجابة) + مخطط زمني واحد + جدول حالة النماذج الفعلي. لا شيء أكثر.

---

## 6. المخاطر المعروفة وكيف سأعالجها

| الخطر                                                            | الأثر                                                                | المعالجة                                                                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| تحويل Claude ⇄ OpenAI مصنّف **`Fair`** في مصفوفة New API الرسمية | بعض الخصائص (أدوات معقدة، صور، reasoning) قد لا تحفظ دلالتها بالكامل | سننفّذ المسارين الأساسيين بدقة، ونوثّق الحدود في README، ونضيف اختبارات golden على الحالات الشائعة |
| نسيان `FinalizeStreamResponse` في نهاية التدفق                   | usage ناقص أو تدفق لا يُغلق                                          | `finally` block إجباري في كل مسار streaming + اختبار يقرأ التدفق حتى `done`                        |
| تخزين مفتاح المزود نصاً صريحاً                                   | خطر أمني                                                             | تشفير على مستوى الحقل (AES-256-GCM بمفتاح من `MASTER_KEY`)                                         |
| SSE يقطع الاتصال عند أخطاء الـ upstream                          | عميل معلّق                                                           | مهلة تدفق (`STREAMING_TIMEOUT`) + حدث خطأ بصيغة المتوقع من العميل                                  |
| الواجهة تعرض أصفاراً عند غياب البيانات                           | يبدو كبيانات وهمية                                                   | Empty State صريحة: "لا توجد طلبات بعد"                                                             |

---

## 7. قائمة قبول التسليم (لن أقول "انتهى" قبل أن تتحقق كلها)

- [ ] `pnpm install && pnpm dev` يشغّل السيرفر والواجهة معاً بأمر واحد
- [ ] `curl` حقيقي على `/v1/messages` بصيغة Anthropic يردّ بصيغة Anthropic
- [ ] `curl` حقيقي على `/v1/chat/completions` بصيغة OpenAI يردّ بصيغة OpenAI
- [ ] التدفق (stream) يعمل في الاتجاهين ويُغلق بحدث إنهاء صحيح
- [ ] Model Mapping يعيد التوجيه ويكشف الدوران ولا يعلّق
- [ ] اختيار القناة يحترم الأولوية والأوزان؛ إعادة المحاولة تنزل شريحة الأولوية
- [ ] مفتاح `sk-` يُنشأ من الواجهة ويعمل فوراً في Claude Desktop
- [ ] صفر سطر بيانات وهمية: لا أرقام ثابتة، لا مصفوفات تجريبية في كود الواجهة
- [ ] لا زر في الواجهة without وظيفة حقيقية
- [ ] الوضع الليلي/النهاري يعمل على كل عنصر، بما في ذلك المخططات
- [ ] `pnpm -r typecheck` و`pnpm -r lint` بلا أخطاء

---

## 8. ما أحتاجه منك للبدء

1. **مفتاح مزود واحد على الأقل** (MiniMax أو OpenAI أو Anthropic) لاختبار التوجيه الحقيقي. إن لم يتوفر الآن، سأبني كل شيء وأختبر الـ pipeline بمزود وهمي محلي قابل للتشغيل — لكنه ليس بيانات وهمية في الواجهة، بل خادم اختبار حقيقي.
2. تأكيدك على هذه الخطة، ثم أبدأ بالمرحلة 0 فوراً.
