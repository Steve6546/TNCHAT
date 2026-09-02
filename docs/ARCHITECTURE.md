# ARCHITECTURE — AI Command Center (TNCHAT)

> بوابة توجيه للنماذج اللغوية مع لوحة تحكم عربية. منطق البوابة منقول بأمانة من
> [QuantumNous/new-api](https://github.com/QuantumNous/new-api)، والواجهة
> والإدارة مكتوبتان من الصفر. منذ 0.3.0: قاعدة البيانات والحسابات عبر
> **Supabase** (Postgres + Auth)، والجلسات بلا انتهاء.
>
> هذا المستند يصف **الحالة الحالية** بعد تنفيذ الإصدار 0.3.0 — لا خطة عمل.
> للتشغيل والأوامر: [README.md](../README.md). للقواعد الملزمة:
> [AGENTS.md](../AGENTS.md).

---

## 1. الأصل: ما نُقل من new-api فعلياً

النقل تم بسحب المستودع (`_ref_new_api`) وقراءة الملفات، لا من الذاكرة. هذه
خريطة الأصل → المكان الحالي:

| المصدر في new-api | ما نُقل | المكان الحالي |
| --- | --- | --- |
| `middleware/auth.go` (`TokenAuth`) | قبول `Authorization: Bearer sk-xxx` / `x-api-key`؛ تجريد بادئة `sk-` | `server/src/gateway/token-auth.ts` — مع تخزين المفتاح **مُهشّأ sha256** بدل النص الصريح |
| `middleware/distributor.go` | اختيار القناة: Affinity → Ability lookup → Priority tiers → Weighted random | `server/src/gateway/distributor.ts` — بنفس ثوابت الخوارزمية |
| `model/ability.go` | `getPriority()` ترتّب الشرائح **تنازلياً**؛ كل إعادة محاولة تنزل شريحة؛ `sum(weight + 10)` | `server/src/gateway/ability-index.ts` + `distributor.ts` |
| `relay/helper/model_mapped.go` | سلسلة إعادة توجيه النموذج + **كشف الدوران** | `server/src/gateway/model-mapping.ts` |
| `relay/channel/adapter.go` | واجهة `Adaptor` | `server/src/adapters/types.ts` |
| `controller/relay.go` | حلقة إعادة المحاولة، وتخطيها عند أخطاء بعينها (413) | `server/src/gateway/relay.ts` |
| `relaykit` streaming contract | `FinalizeStreamResponse` **إجباري** في النهاية | مُنفَّذ في `finally` بكل مسار تدفّق |
| `model/channel.go` | `GetNextEnabledKey()` — تعدد المفاتيح لكل قناة | `server/src/gateway/upstream.ts` |

**التزام بالصراحة:** التحويل Claude ⇄ OpenAI مُصنَّف `Fair` في المصفوفة
الرسمية ومُنفَّذ في الاتجاهين. التحويل عبر Gemini مُصنَّف `Discouraged` —
**غير مُنفَّذ عن قصد**، وتوثيق الحدّ أصحّ من ادّعاء الاكتمال.

---

## 2. القرارات المحسومة

| البند | القرار | السبب |
| --- | --- | --- |
| الباك إند | **Node 22 + TypeScript + Fastify 5** | لغة واحدة للمشروع كله، وSSE streaming ممتاز. أسماء المفاهيم مطابقة للأصل لتسهيل أي مقارنة لاحقة |
| قاعدة البيانات | **Supabase Postgres** عبر `postgres-js` + **Drizzle ORM** | المشروع أونلاين فقط بقرار صريح: لا وضع محلي ولا محرّك ثانٍ. `prepare: false` لتوافق PgBouncer |
| حسابات لوحة التحكم | **Supabase Auth** (بريد + كلمة مرور + استرجاع بالبريد) | لا كلمة مرور إدارة واحدة تُخزَّن محلياً؛ الاسترجاع يتم برسالة Supabase المدمجة |
| الجلسات | **رمز HMAC موقَّع بلا انتهاء** في `sessionStorage` | تنتهي بتسجيل الخروج أو بإغلاق التبويب — لا عدّادات ولا `exp`، حُذف نظام المدة كلياً |
| الواجهة | **Vite 7 + React 19 + TypeScript + Tailwind 4** | `@tailwindcss/vite` |
| المكوّنات | **shadcn/ui** (Radix)، ومنسوخة إلى `web/src/components/ui/` | أساس صلب بلا تبعية وقت تشغيل |
| إدارة الحالة | **Zustand** (stores منفصلة) + **TanStack Query** لبيانات السيرفر | Zustand لحالة الواجهة، Query للبيانات القادمة من السيرفر |
| البروتوكولات | **Anthropic + OpenAI** بالاتجاهين + streaming + Claude Code pass-through | يكفي Claude Desktop وClaude Code وأي عميل OpenAI |
| البيانات | **صفر بيانات وهمية.** الـ seed الوحيد هو مخطط الجداول | كل بطاقة معروضة تأتي من `GET` حقيقي |
| التشغيل | **منفذ واحد.** الواجهة تُبنى إلى `web/dist` ويخدمها خادم البوابة نفسه | لا خادم ثانٍ، ولا بروكسي تطوير، ولا تعارض منافذ |

---

## 3. البنية الحالية

```
TNCHAT/
├── scripts/acc.mjs            المشغّل الموحّد — كل الأوامر تمرّ من هنا
├── server/                    بوابة Fastify 5 + Supabase Postgres/Drizzle
│   └── src/
│       ├── index.ts           نقطة الدخول
│       ├── app.ts             مصنع Fastify (قابل للاختبار عبر app.inject)
│       ├── config.ts          تحميل .env + التحقق  ← المصدر الوحيد للإعداد
│       ├── adapters/          types.ts + index.ts  (openaiCompatible(kind, label))
│       ├── auth/              supabase.ts — عميل Supabase Auth (تسجيل/دخول/استرجاع)
│       ├── convert/           dto/ · claude-to-openai.ts · openai-to-claude.ts
│       ├── core/              errors.ts (GatewayError) · formats.ts
│       ├── db/                schema.ts · migrate.ts · bootstrap.ts · index.ts
│       ├── gateway/           token-auth · distributor · model-mapping
│       │                      ability-index · relay · upstream · dashboard-auth
│       ├── routes/            relay · admin-auth · admin-channels
│       │                      admin-keys · admin-stats · health · spa
│       └── lib/               crypto · secrets · json · validate · rate-limit
├── web/                       لوحة التحكم (Vite React)
│   └── src/
│       ├── app.tsx            الموجّه: / · /models · /keys · /settings
│       ├── components/
│       │   ├── ui/            مكوّنات shadcn المنسوخة + password-field + toast
│       │   ├── shared/        page-header · empty-state · error-state
│       │   │                  copy-button · spinner · logo
│       │   └── layout/        app-shell (الشريط الجانبي)
│       ├── features/
│       │   ├── auth/          login-page — دخول · إنشاء حساب · استرجاع كلمة المرور
│       │   ├── channels/      channels-page · model-cards   (/models)
│       │   ├── keys/          keys-page                     (/keys)
│       │   ├── overview/      overview-page · requests-chart
│       │   └── settings/      settings-page · setup-guide
│       ├── lib/               api · types · utils · session
│       └── stores/            auth-store · theme-store · model-cards-store
└── docs/
    └── ARCHITECTURE.md        ← هذا الملف
```

---

## 4. مسار الطلب

```
عميل (Claude Code / Cherry Studio / أي عميل OpenAI)
 │
 ▼  POST /v1/messages   |   POST /v1/chat/completions
┌──────────────────────────────────────────────────────────┐
│ 1. TokenAuth       → مفتاح العميل مُهشّأ sha256،          │
│                      يُتحقَّق من المجموعة والنماذج         │
│ 2. AbilityIndex    → (مجموعة، نموذج) ← قائمة قنوات O(1)  │
│ 3. Distributor     → ارتباط ثابت → شرائح أولوية          │
│                      → عشوائي موزون                       │
│ 4. ModelMapping    → سلسلة إعادة توجيه + كشف الدوران     │
│ 5. Adaptor         → بناء الرابط والترويسات              │
│ 6. Convert         → تحويل الجسم إلى صيغة المزوّد         │
│ 7. Upstream        → نداء + تدفّق SSE                     │
│ 8. Retry           → عند الفشل: القناة التالية،          │
│                      وشريحة أولوية أقل                    │
│ 9. RequestLog      → تسجيل الرموز والزمن والنتيجة        │
└──────────────────────────────────────────────────────────┘
 │
 ▼
MiniMax · Anthropic · OpenAI · أي API متوافق مع OpenAI · مخصّص
```

فهارس التوجيه تُبنى مرة واحدة في `rebuild()` ولا تُفرز ولا تُصفَّى لكل طلب.

---

## 5. مخطط قاعدة البيانات

| الجدول | الحقول الأساسية | ملاحظة |
| --- | --- | --- |
| `channels` | id, name, type, base_url, keys (مشفر), models (JSON), model_mapping (JSON), group, priority, weight, enabled, status, last_latency_ms, last_tested_at | القناة = مزوّد علوي واحد |
| `abilities` | group, model, channel_id, enabled, priority, weight | مُولَّد تلقائياً عند كل تغيير قناة |
| `api_keys` | id, key_hash, key_preview, name, group, model_limit, status, expires_at, last_used_at, created_at | **لا يُخزَّن المفتاح نصاً صريحاً** |
| `request_logs` | id, key_id, channel_id, model, upstream_model, tokens, status, latency_ms, is_stream, created_at | مصدر الإحصائيات الحقيقية |
| `settings` | key, value (JSON) | التفضيلات |

**قاعدتان ثابتتان:**

- **الطوابع الزمنية بالميلي ثانية** — أعمدة `bigint` تُملأ بقيمة
  `extract(epoch from now()) * 1000`.
- **الترقية موضعية** — `migrate.ts` يحمل مصفوفة `DDL`/`ALTERS` عديمة الأثر
  (`IF NOT EXISTS` وكتل `DO … duplicate column`)، فتترقّى قاعدة قديمة في مكانها
  بدل أن تفشل عند الإقلاع، و`verifySchema()` يقارن المخطط الحيّ بـ `schema.ts`
  عبر `information_schema` عند كل إقلاع.

---

## 6. نظام التصميم — Linear / Vercel Minimal

### القاعدة الذهبية

> **لا زر إلا وله وظيفة حقيقية تنتهي بنقطة نهاية فعلية.** أي زر لا يستطيع
> استدعاء endpoint لا يوجد في الواجهة.

### Design tokens

```css
/* الشكل الهندسي */
--radius: 0.5rem;              /* 8px — الأزرار والحقول */
--radius-card: 0.75rem;        /* 12px — البطاقات */

/* الألوان — مقياس zinc محايد، بلا أي لون علامة تجارية */
light:  bg #ffffff · surface #fafafa · border #e4e4e7 · text #18181b · muted #71717a
dark:   bg #09090b · surface #111113 · border #27272a · text #fafafa · muted #a1a1aa

/* الحالة — أضيف في 0.2.0 */
--success:  light #059669  ·  dark #10b981

/* الحركة — تحويلات وشفافية فقط */
--dur-fast: 120ms;  --dur: 160ms;  --ease: cubic-bezier(0.16, 1, 0.3, 1);
/* لا حركة تتجاوز 200ms. لا اهتزاز، لا نبض، لا توهج */

/* الطباعة */
h1 24/500 · h2 18/500 · h3 15/500 · body 14/400 · caption 12/400
/* وزنان فقط: 400 و 500. لا 600، لا 700 */
```

### أنماط الأزرار

| الاسم | الحالة | المواصفة | أين يُستخدم |
| --- | --- | --- | --- |
| **Primary** | الإجراء الرئيسي الوحيد في الشاشة | `h-9 px-4 text-sm font-medium rounded-md` · light: `bg-zinc-950 text-zinc-50` · dark: `bg-zinc-50 text-zinc-950` | «مفتاح جديد»، «إضافة نموذج» |
| **Secondary** | إجراء ثانوي | `bg-white border border-zinc-200` · dark: `bg-zinc-900 border-zinc-800` | «إلغاء» |
| **Ghost** | إجراءات السياق | `hover:bg-zinc-100` بلا حدود | أزرار الأيقونات في الصفوف |
| **Destructive** | حذف فقط | `bg-red-600 text-white hover:bg-red-700` | حذف قناة/مفتاح (مع تأكيد) |

**قواعد صارمة:**

1. **Primary واحد فقط** لكل شاشة — الباقي secondary أو ghost.
2. كل زر يدعم `loading` (Spinner يحل محل النص) و`disabled`.
3. أي زر يغيّر حالة السيرفر يُظهر رسالة نتيجة (`useToast`) — لا صمتاً أبداً.
4. لا أيقونة بلا `aria-label`، لا زر أيقونة بلا `title`.
5. مفتاح التبديل (`Switch`) يستخدم `--success` عند التشغيل، لا `--primary`
   (كان يتحوّل إلى الأبيض في الوضع الداكن لأن `--primary` هو لون النص نفسه).

**مستبعد صراحةً:** Aceternity UI و Magic UI (توهج وتدرجات وShimmer) — تناقض
الهوية Minimal وتُبطئ الواجهة.

---

## 7. الحدود المعروفة

| الحدّ | الأثر | الحالة |
| --- | --- | --- |
| المشروع أونلاين فقط | لا يعمل بلا إنترنت ولا بلا مشروع Supabase نشط | **قرار واعٍ** — لا وضع محلي ولا محرّك ثانٍ |
| الجلسات بلا انتهاء | رمز مسرّب يبقى صالحاً حتى يغيَّر `SESSION_SECRET` | **قرار واعٍ** — الرمز في `sessionStorage` فقط ولا يخرج من التبويب |
| تحويل Claude ⇄ OpenAI مُصنَّف `Fair` | بعض الخصائص قد لا تحفظ دلالتها بالكامل | مُخفَّف بـ pass-through: طلبات Claude Code تمرّ كما أُرسلت |
| التحويل عبر Gemini مُصنَّف `Discouraged` | غير مدعوم | **قرار واعٍ** — لا يُنفَّذ بدل ادّعاء الكمال |
| `FinalizeStreamResponse` في نهاية التدفّق | usage ناقص أو تدفّق لا يُغلق | `finally` إجباري في كل مسار تدفّق + اختبار |
| مفاتيح المزوّدين نصاً صريحاً | خطر أمني | تشفير AES-256-GCM بمفتاح من `MASTER_KEY` |
| SSE يقطع الاتصال عند أخطاء الـ upstream | عميل معلّق | `STREAMING_TIMEOUT_MS` + حدث خطأ بصيغة العميل |
| الواجهة تعرض أصفاراً عند غياب البيانات | يبدو كبيانات وهمية | Empty State صريحة: «لا توجد طلبات بعد» |

---

## 8. الأوامر

كل شيء يمرّ من `scripts/acc.mjs` — مسار واحد، يعمل على Windows رغم وجود `&`
ومسافة في اسم المجلد، لأنه لا يمرّر أي مسار عبر الصدفة.

```bash
node scripts/acc.mjs start   # الأمر الوحيد الذي تحتاجه: تثبيت ← بناء ← تشغيل
node scripts/acc.mjs dev     # تشغيل مع إعادة تحميل تلقائي
node scripts/acc.mjs check   # فحص الأنواع + الاختبارات — ما تشغّله CI
node scripts/acc.mjs test    # مجموعة الاختبارات
node scripts/acc.mjs build   # فحص الأنواع ثم بناء الخادم والواجهة
node scripts/acc.mjs db      # تطبيق مخطط قاعدة البيانات على Supabase
node scripts/acc.mjs reset   # حذف مفتاح التشفير المولَّد محلياً (يسأل أولاً)
```

**لا تستخدم** `pnpm -r typecheck` أو `pnpm -r lint` — لا وجود لهما. الفحص
الوحيد هو `check`.
