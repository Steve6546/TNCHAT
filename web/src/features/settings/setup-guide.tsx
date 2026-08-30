import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { CopyButton } from '../../components/shared/copy-button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/card';
import { relayEndpoint } from '../../lib/api';

/**
 * How to point an application at this gateway.
 *
 * Every address here is derived from the page the operator is actually looking
 * at, so the guide stays correct when the dashboard is reached over a LAN
 * address or a tunnelled hostname instead of `127.0.0.1`.
 */

function CodeBlock({ title, code }: { title: string; code: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/50 px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        <CopyButton value={code} label="نسخ" className="h-7 px-2 text-[11px]" />
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-6" dir="ltr">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** One `label / value` line, with the value copyable and pinned to Latin text. */
function ValueRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 py-2 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="flex items-center gap-2">
        <code dir="ltr" className="rounded border border-border bg-muted px-2 py-1 text-xs">
          {value}
        </code>
        <CopyButton value={value} label="نسخ" className="h-7 px-2 text-[11px]" />
      </span>
    </div>
  );
}

function Step({ index, title, children }: { index: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-medium"
        dir="ltr"
      >
        {index}
      </span>
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs leading-6 text-muted-foreground">{children}</p>
      </div>
    </li>
  );
}

const TROUBLESHOOTING: { code: string; meaning: string; fix: string }[] = [
  {
    code: '401',
    meaning: 'المفتاح مفقود أو غير صحيح.',
    fix: 'أرسل المفتاح في ترويسة Authorization أو x-api-key، وتأكد أن المفتاح لم يُحذف.',
  },
  {
    code: '403',
    meaning: 'المفتاح لا يسمح باستخدام هذا النموذج.',
    fix: 'يظهر فقط مع المفاتيح القديمة التي حُدّدت لها نماذج. أنشئ مفتاحاً جديداً — النماذج تُحدَّد من القنوات.',
  },
  {
    code: '503',
    meaning: 'لا توجد قناة مُفعّلة تعلن عن هذا النموذج.',
    fix: 'أضف النموذج إلى القناة من صفحة إدارة النماذج، وتأكد أن القناة مُفعّلة.',
  },
  {
    code: '502',
    meaning: 'المزوّد العلوي لا يستجيب أو أعاد خطأً.',
    fix: 'اضغط زر الفحص بجانب القناة لمعرفة السبب، وتحقق من صحة Base URL والمفتاح.',
  },
  {
    code: '429',
    meaning: 'المزوّد العلوي حدّد معدل الطلبات.',
    fix: 'أضف مفاتيح إضافية إلى القناة أو قناة أخرى تخدم نفس النموذج.',
  },
];

export function SetupGuide() {
  // The OpenAI SDK appends the path itself; the Anthropic SDK appends `/v1`.
  const openaiBase = relayEndpoint();
  const anthropicBase = openaiBase.replace(/\/v1$/, '');

  const curlExample = `curl ${openaiBase}/chat/completions \\
  -H "Authorization: Bearer sk-XXXXXXXX" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"claude-3-5-sonnet","messages":[{"role":"user","content":"مرحباً"}]}'`;

  const pythonExample = `from openai import OpenAI

client = OpenAI(
    base_url="${openaiBase}",
    api_key="sk-XXXXXXXX",
)

response = client.chat.completions.create(
    model="claude-3-5-sonnet",
    messages=[{"role": "user", "content": "مرحباً"}],
)

print(response.choices[0].message.content)`;

  const nodeExample = `import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '${openaiBase}',
  apiKey: 'sk-XXXXXXXX',
});

const response = await client.chat.completions.create({
  model: 'claude-3-5-sonnet',
  messages: [{ role: 'user', content: 'مرحباً' }],
});

console.log(response.choices[0].message.content);`;

  const claudeExample = `curl ${anthropicBase}/v1/messages \\
  -H "x-api-key: sk-XXXXXXXX" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"claude-3-5-sonnet","max_tokens":1024,
       "messages":[{"role":"user","content":"مرحباً"}]}'`;

  const claudeCodeExample = `export ANTHROPIC_BASE_URL="${anthropicBase}"
export ANTHROPIC_API_KEY="sk-XXXXXXXX"

claude`;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>ابدأ في ثلاث خطوات</CardTitle>
          <CardDescription>الترتيب مهم: القناة أولاً، ثم المفتاح، ثم تطبيقك.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-4">
            <Step index={1} title="أضف قناة (مزوّد علوي)">
              من صفحة <Link to="/models" className="text-foreground underline underline-offset-4">إدارة النماذج</Link>،
              أدخل Base URL ومفتاح المزوّد، ثم فعّل النماذج التي تريد الإعلان عنها من البطاقات.
              استخدم زر الفحص للتأكد أن الاتصال يعمل قبل المتابعة.
            </Step>
            <Step index={2} title="أنشئ مفتاح API">
              من صفحة <Link to="/keys" className="text-foreground underline underline-offset-4">مفاتيح API</Link>،
              أعطِ المفتاح اسماً وتاريخ انتهاء. سيظهر المفتاح مرة واحدة فقط — انسخه فوراً مع عنوان
              الخادم بالضغط على «نسخ المفتاح + Endpoint».
            </Step>
            <Step index={3} title="اربط تطبيقك">
              وجّه تطبيقك إلى العنوان أدناه وضع المفتاح في ترويسة Authorization. أي عميل متوافق مع
              OpenAI أو Anthropic يعمل دون تعديل إضافي.
            </Step>
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>العنوان والمصادقة</CardTitle>
          <CardDescription>
            مشتقّ من الخادم الذي يعمل الآن — لا حاجة لكتابة أي عنوان يدوياً.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <ValueRow label="عنوان OpenAI (للحزم التي تضيف المسار بنفسها)" value={openaiBase} />
            <ValueRow label="عنوان Anthropic / Claude" value={anthropicBase} />
            <ValueRow label="ترويسة المصادقة" value="Authorization: Bearer sk-XXXXXXXX" />
            <ValueRow label="ترويسة بديلة" value="x-api-key: sk-XXXXXXXX" />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">المسارات المتاحة</p>
            <ul className="space-y-1.5 text-xs text-muted-foreground">
              {[
                ['POST', '/v1/chat/completions', 'واجهة OpenAI للدردشة — الأكثر استخداماً'],
                ['POST', '/v1/completions', 'واجهة OpenAI للإكمال النصّي'],
                ['POST', '/v1/messages', 'واجهة Claude الأصلية'],
                ['GET', '/v1/models', 'النماذج المتاحة لهذا المفتاح الآن'],
              ].map(([method, path, note]) => (
                <li key={path} className="flex flex-wrap items-baseline gap-2">
                  <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground" dir="ltr">
                    {method}
                  </span>
                  <code dir="ltr" className="text-foreground">
                    {path}
                  </code>
                  <span>— {note}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs leading-6 text-muted-foreground">
              البوابة تترجم بين الصيغتين تلقائياً: يمكنك إرسال طلب بصيغة OpenAI إلى قناة Anthropic
              والعكس، دون أي تغيير في تطبيقك.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>أمثلة جاهزة</CardTitle>
          <CardDescription>
            استبدل <code dir="ltr">sk-XXXXXXXX</code> بمفتاحك، واسم النموذج بأحد النماذج المُفعّلة
            على قنواتك.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <CodeBlock title="cURL" code={curlExample} />
          <CodeBlock title="Python — حزمة openai" code={pythonExample} />
          <CodeBlock title="Node.js — حزمة openai" code={nodeExample} />
          <CodeBlock title="cURL — واجهة Claude" code={claudeExample} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>ربط التطبيقات الجاهزة</CardTitle>
          <CardDescription>ما يعمل مباشرة، وما يحتاج طبقة وسيطة.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium">Claude Code و Anthropic SDK</p>
            <p className="text-xs leading-6 text-muted-foreground">
              تدعم متغيّر البيئة <code dir="ltr">ANTHROPIC_BASE_URL</code> رسمياً، لذا تكفي هذه
              الأسطر لتوجيهها إلى البوابة:
            </p>
            <CodeBlock title="متغيّرات البيئة" code={claudeCodeExample} />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Claude Desktop</p>
            <p className="rounded-md border border-border bg-muted/50 p-3 text-xs leading-6 text-muted-foreground">
              تطبيق Claude Desktop لا يوفّر إعداداً لتغيير عنوان الخادم من داخل الواجهة، ولا يقبل
              مفاتيح طرف ثالث. لتوجيهه عبر البوابة ستحتاج طبقة وسيطة محلية (proxy) تعترض الطلبات
              وتعيد توجيهها، أو الاستعانة بأحد العملاء المبنية على Anthropic SDK والتي تقبل{' '}
              <code dir="ltr">ANTHROPIC_BASE_URL</code> كما في الأعلى.
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">أي تطبيق يقبل عنواناً مخصّصاً</p>
            <p className="text-xs leading-6 text-muted-foreground">
              كل تطبيق يسمح بتحديد Base URL — مثل Continue و Cline و Open WebUI و LibreChat وأدوات
              سطر الأوامر المعتمدة على OpenAI SDK — يعمل بإدخال العنوان والمفتاح أعلاه فقط.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>استكشاف الأخطاء</CardTitle>
          <CardDescription>ما تعنيه الرموز التي قد يرد بها الخادم.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3">
            {TROUBLESHOOTING.map((row) => (
              <li key={row.code} className="flex gap-3">
                <span
                  className="mt-0.5 h-6 shrink-0 rounded border border-border bg-secondary px-2 text-xs font-medium leading-6"
                  dir="ltr"
                >
                  {row.code}
                </span>
                <div className="space-y-0.5 text-xs leading-6">
                  <p>{row.meaning}</p>
                  <p className="text-muted-foreground">{row.fix}</p>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
