import type { EmailMessage } from '../types';
import { renderScaleInquiryEmail } from './email-templates';
import { ApiError, now, sha256, text } from './http';

export const COMPANY_SIZES = [
  '1',
  '2-10',
  '11-50',
  '51-200',
  '201-1000',
  '1000+',
] as const;

export const MONTHLY_USAGE_RANGES = [
  'under-10000',
  '10000-50000',
  '50000-250000',
  '250000-1000000',
  'over-1000000',
] as const;

const INQUIRY_LIMIT = 5;
const INQUIRY_WINDOW_MS = 24 * 60 * 60_000;
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface ScaleInquiryInput {
  id?: unknown;
  fullName?: unknown;
  role?: unknown;
  companyName?: unknown;
  email?: unknown;
  companySize?: unknown;
  monthlyUsage?: unknown;
  useCase?: unknown;
  turnstileToken?: unknown;
}

interface ScaleInquiry {
  id: string;
  fullName: string;
  role: string;
  companyName: string;
  email: string;
  companySize: typeof COMPANY_SIZES[number];
  monthlyUsage: typeof MONTHLY_USAGE_RANGES[number];
  useCase: string;
  turnstileToken: string;
}

export async function submitScaleInquiry(
  env: Env,
  request: Request,
  raw: ScaleInquiryInput,
): Promise<{ accepted: true; id?: string }> {
  const inquiry = parseInquiry(raw);
  const ip = clientIp(request, env.ENVIRONMENT);
  const rateKey = await visitorHash(env, ip);

  if (!env.INQUIRY_RATE_LIMITER) {
    if (env.ENVIRONMENT === 'production') throw unavailable();
  } else {
    const burst = await env.INQUIRY_RATE_LIMITER.limit({ key: rateKey });
    if (!burst.success) throw rateLimited();
  }

  await verifyTurnstile(env, inquiry.turnstileToken, ip);

  const existing = await env.DB.prepare(
    'SELECT id FROM scale_inquiries WHERE id=?1',
  ).bind(inquiry.id).first<{ id: string }>();

  if (!existing) {
    const recent = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM scale_inquiries WHERE ip_hash=?1 AND created_at>=?2',
    ).bind(rateKey, now() - INQUIRY_WINDOW_MS).first<{ count: number }>();
    if (Number(recent?.count ?? 0) >= INQUIRY_LIMIT) throw rateLimited();

    await env.DB.prepare(
      `INSERT INTO scale_inquiries
       (id,full_name,role,company_name,email,company_size,monthly_usage,use_case,ip_hash,status,created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'new',?10)`,
    ).bind(
      inquiry.id,
      inquiry.fullName,
      inquiry.role,
      inquiry.companyName,
      inquiry.email,
      inquiry.companySize,
      inquiry.monthlyUsage,
      inquiry.useCase,
      rateKey,
      now(),
    ).run();
  }

  // Local submissions exercise the complete validation and persistence path
  // without sending a real email through the remote Email Service binding.
  if (env.ENVIRONMENT === 'production') {
    const rendered = await renderScaleInquiryEmail(inquiry);
    const message: EmailMessage = {
      type: 'scale-inquiry',
      idempotencyKey: `scale-inquiry:${inquiry.id}`,
      to: env.EMAIL_REPLY_TO,
      replyTo: inquiry.email,
      subject: `Scale inquiry from ${inquiry.companyName}`,
      ...rendered,
    };
    await env.EMAIL_TASKS.send(message);
  }

  return { accepted: true, id: inquiry.id };
}

function parseInquiry(raw: ScaleInquiryInput): ScaleInquiry {
  const id = text(raw.id, 80);
  const fullName = text(raw.fullName, 100);
  const role = text(raw.role, 100);
  const companyName = text(raw.companyName, 120);
  const email = text(raw.email, 254).toLowerCase();
  const companySize = text(raw.companySize, 20);
  const monthlyUsage = text(raw.monthlyUsage, 30);
  const useCase = text(raw.useCase, 1200);
  const turnstileToken = text(raw.turnstileToken, 2048);

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw invalid('Refresh the page and try again.');
  }
  if (fullName.length < 2) throw invalid('Enter your full name.');
  if (role.length < 2) throw invalid('Enter your role.');
  if (companyName.length < 2) throw invalid('Enter your company name.');
  if (!isEmail(email)) throw invalid('Enter a valid work email.');
  if (!COMPANY_SIZES.includes(companySize as ScaleInquiry['companySize'])) {
    throw invalid('Choose your company size.');
  }
  if (!MONTHLY_USAGE_RANGES.includes(monthlyUsage as ScaleInquiry['monthlyUsage'])) {
    throw invalid('Choose your expected monthly usage.');
  }
  if (useCase.length < 20) throw invalid('Tell us a little more about what you are building.');

  return {
    id,
    fullName,
    role,
    companyName,
    email,
    companySize: companySize as ScaleInquiry['companySize'],
    monthlyUsage: monthlyUsage as ScaleInquiry['monthlyUsage'],
    useCase,
    turnstileToken,
  };
}

async function verifyTurnstile(env: Env, token: string, ip: string): Promise<void> {
  // Local development remains testable without a production widget. Unit
  // tests exercise Siteverify directly; production never takes this branch.
  if (env.ENVIRONMENT !== 'production') return;
  if (!env.TURNSTILE_SECRET || !token) throw invalid('Complete the security check and try again.');

  let response: Response;
  try {
    response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET,
        response: token,
        remoteip: ip,
        idempotency_key: crypto.randomUUID(),
      }),
    });
  } catch {
    throw unavailable();
  }

  if (!response.ok) throw unavailable();
  const result = await response.json<{
    success?: boolean;
    action?: string;
  }>();
  if (!result.success || result.action !== 'scale_inquiry') {
    throw invalid('The security check expired. Please try again.');
  }
}

function clientIp(request: Request, environment: string): string {
  const cloudflareIp = request.headers.get('cf-connecting-ip')?.trim();
  if (cloudflareIp) return cloudflareIp;
  if (environment === 'production') throw unavailable();
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1';
}

async function visitorHash(env: Env, ip: string): Promise<string> {
  if (!env.LANDING_RATE_LIMIT_SALT && env.ENVIRONMENT === 'production') throw unavailable();
  return sha256(`${env.LANDING_RATE_LIMIT_SALT || 'local-inquiry-salt'}:${ip}`);
}

function isEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function invalid(message: string): ApiError {
  return new ApiError(422, 'INVALID_SCALE_INQUIRY', message);
}

function rateLimited(): ApiError {
  return new ApiError(429, 'SCALE_INQUIRY_LIMIT_REACHED', 'We already received your request. Please wait before submitting another.');
}

function unavailable(): ApiError {
  return new ApiError(503, 'SCALE_INQUIRY_UNAVAILABLE', 'The inquiry form is temporarily unavailable. Please try again shortly.');
}
