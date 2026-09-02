import { config } from '../config.js';
import { GatewayError } from '../core/errors.js';

/**
 * Supabase Auth (GoTrue) client.
 *
 * Dashboard accounts live entirely in Supabase: sign-up, sign-in, password
 * reset by email and sign-out all go through the project's Auth REST API.
 * The client talks to it with the project's anon key only — never a service
 * role key, which must not exist on this machine at all.
 *
 * Error mapping matters because these messages reach the dashboard verbatim:
 * a wrong credential must read as "wrong email or password", not as GoTrue's
 * `invalid_grant` internals.
 */

const authBase = `${config.supabaseUrl}/auth/v1`;

interface SupabaseErrorBody {
  error?: string;
  error_description?: string;
  msg?: string;
  message?: string;
  code?: string;
}

interface SupabaseSessionBody {
  access_token?: string;
  refresh_token?: string;
  user?: {
    id?: string;
    email?: string;
    email_confirmed_at?: string | null;
    confirmed_at?: string | null;
  } | null;
}

async function authFetch(
  path: string,
  init: { method?: string; body?: unknown; accessToken?: string },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    apikey: config.supabaseAnonKey,
    'Content-Type': 'application/json',
  };
  if (init.accessToken) headers['Authorization'] = `Bearer ${init.accessToken}`;

  let response: Response;
  try {
    response = await fetch(`${authBase}${path}`, {
      method: init.method ?? 'POST',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (error) {
    throw new GatewayError(
      `تعذّر الوصول إلى خدمة المصادقة: ${error instanceof Error ? error.message : String(error)}`,
      { statusCode: 502, code: 'api_error', cause: error },
    );
  }

  const text = await response.text().catch(() => '');
  let body: unknown = null;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

function messageOf(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null) {
    const record = body as SupabaseErrorBody;
    const raw = record.msg ?? record.message ?? record.error_description ?? record.error;
    if (typeof raw === 'string' && raw !== '') return raw;
  }
  return fallback;
}

/** Map GoTrue failures onto the error the dashboard should actually show. */
function authError(status: number, body: unknown, fallback: string): GatewayError {
  const message = messageOf(body, fallback);

  if (status === 400 && /invalid login credentials/i.test(message)) {
    return GatewayError.unauthorized('البريد الإلكتروني أو كلمة المرور غير صحيحة');
  }
  if (status === 400 && /already (registered|exists)/i.test(message)) {
    return GatewayError.badRequest('هذا البريد الإلكتروني مسجَّل بالفعل — سجّل الدخول بدلاً من إنشاء حساب');
  }
  if (status === 400 && /not confirmed/i.test(message)) {
    return GatewayError.forbidden('لم يتم تأكيد البريد الإلكتروني بعد — افتح رسالة التأكيد ثم سجّل الدخول');
  }
  if (status === 422 || (status === 400 && /password/i.test(message) && /should be at least|stronger/i.test(message))) {
    return GatewayError.badRequest(message, 'password');
  }
  if (status === 429) {
    return new GatewayError(`محاولات كثيرة — حاول بعد قليل. ${message}`, {
      statusCode: 429,
      code: 'rate_limit_error',
      skipRetry: true,
    });
  }
  if (status >= 500) {
    return new GatewayError(`خدمة المصادقة غير متاحة مؤقتاً: ${message}`, {
      statusCode: 502,
      code: 'api_error',
      upstream: body,
    });
  }
  return GatewayError.badRequest(message);
}

function requireSessionBody(body: unknown): SupabaseSessionBody {
  if (typeof body === 'object' && body !== null && 'access_token' in body) {
    return body as SupabaseSessionBody;
  }
  throw new GatewayError('استجابة غير متوقعة من خدمة المصادقة', {
    statusCode: 502,
    code: 'api_error',
    upstream: body,
  });
}

export interface SupabaseSession {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string;
}

function sessionOf(body: unknown): SupabaseSession {
  const session = requireSessionBody(body);
  if (!session.access_token || !session.user?.id) {
    throw new GatewayError('استجابة غير متوقعة من خدمة المصادقة', {
      statusCode: 502,
      code: 'api_error',
      upstream: body,
    });
  }
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token ?? '',
    userId: session.user.id,
    email: session.user.email ?? '',
  };
}

/**
 * Create an account. Returns a session when the project allows immediate
 * sign-in (email confirmation disabled), and `null` when Supabase sent a
 * confirmation email instead.
 */
export async function signUp(email: string, password: string): Promise<SupabaseSession | null> {
  const { status, body } = await authFetch('/signup', { body: { email, password } });

  if (status === 200 || status === 201) {
    if (typeof body === 'object' && body !== null && 'access_token' in body) {
      return sessionOf(body);
    }
    // No session in the response: the project requires email confirmation.
    return null;
  }

  throw authError(status, body, 'تعذّر إنشاء الحساب');
}

export async function signInWithPassword(email: string, password: string): Promise<SupabaseSession> {
  const { status, body } = await authFetch('/token?grant_type=password', {
    body: { email, password },
  });

  if (status !== 200) throw authError(status, body, 'تعذّر تسجيل الدخول');
  return sessionOf(body);
}

/**
 * Request a password-reset email. Always succeeds from the caller's point of
 * view — GoTrue deliberately does not reveal whether the address exists.
 */
export async function sendPasswordReset(email: string): Promise<void> {
  const { status, body } = await authFetch('/recover', { body: { email } });
  if (status !== 200) throw authError(status, body, 'تعذّر إرسال رسالة استرجاع كلمة المرور');
}

/** Invalidate the Supabase session server-side. Best-effort; never throws. */
export async function signOut(accessToken: string | undefined): Promise<void> {
  if (!accessToken) return;
  await authFetch('/logout', { method: 'POST', accessToken }).catch(() => undefined);
}
