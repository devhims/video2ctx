import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderScaleInquiryEmail } from '../src/lib/email-templates';
import { submitScaleInquiry, type ScaleInquiryInput } from '../src/lib/scale-inquiries';

const VALID_ID = 'b1538658-9ca9-4e46-8d1f-b8f2041ba072';

describe('Scale inquiries', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('stores a qualified inquiry and queues one internal notification', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const database = inquiryDatabase();
    const siteverify = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      success: true,
      action: 'scale_inquiry',
    }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', siteverify);

    const result = await submitScaleInquiry(
      inquiryEnv(database, sent),
      inquiryRequest(),
      validInquiry(),
    );

    expect(result).toEqual({ accepted: true, id: VALID_ID });
    expect(database.inserts).toHaveLength(1);
    expect(database.inserts[0]).toEqual(expect.arrayContaining([
      VALID_ID,
      'Mira Shah',
      'Founder',
      'Context Labs',
      'mira@context.test',
    ]));
    expect(sent).toEqual([expect.objectContaining({
      type: 'scale-inquiry',
      idempotencyKey: `scale-inquiry:${VALID_ID}`,
      to: 'support@video2ctx.dev',
      replyTo: 'mira@context.test',
      subject: 'Scale inquiry from Context Labs',
    })]);
    expect(siteverify).toHaveBeenCalledOnce();
    expect(siteverify.mock.calls[0]![1]?.body).toEqual(expect.stringContaining('turnstile-token'));
  });

  test('uses the same idempotency key when a client retries', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const database = inquiryDatabase();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: true,
      action: 'scale_inquiry',
    }), { headers: { 'Content-Type': 'application/json' } })));
    const env = inquiryEnv(database, sent);

    await submitScaleInquiry(env, inquiryRequest(), validInquiry());
    await submitScaleInquiry(env, inquiryRequest(), validInquiry());

    expect(database.inserts).toHaveLength(1);
    expect(sent.map((message) => message.idempotencyKey)).toEqual([
      `scale-inquiry:${VALID_ID}`,
      `scale-inquiry:${VALID_ID}`,
    ]);
  });

  test('keeps local development testable without a Turnstile widget', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const database = inquiryDatabase();
    const env = inquiryEnv(database, sent);
    Object.assign(env, { ENVIRONMENT: 'development', TURNSTILE_SECRET: 'production-secret-is-ignored-locally' });

    await expect(submitScaleInquiry(
      env,
      new Request('http://localhost:8790/v1/scale-inquiries'),
      { ...validInquiry(), turnstileToken: '' },
    )).resolves.toMatchObject({ accepted: true, id: VALID_ID });
    expect(database.inserts).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  test('rejects invalid fields before consuming security or storage work', async () => {
    await expect(submitScaleInquiry(
      {} as Env,
      inquiryRequest(),
      { ...validInquiry(), email: 'not-an-email' },
    )).rejects.toMatchObject({ status: 422, code: 'INVALID_SCALE_INQUIRY' });
  });

  test('rejects a failed Turnstile result without storing or emailing', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const database = inquiryDatabase();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: false,
    }), { headers: { 'Content-Type': 'application/json' } })));

    await expect(submitScaleInquiry(
      inquiryEnv(database, sent),
      inquiryRequest(),
      validInquiry(),
    )).rejects.toMatchObject({ status: 422, code: 'INVALID_SCALE_INQUIRY' });
    expect(database.inserts).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  test('renders prospect content safely in the internal email', async () => {
    const rendered = await renderScaleInquiryEmail({
      fullName: 'Mira <script>alert(1)</script>',
      role: 'Founder',
      companyName: 'Context & Co',
      email: 'mira@context.test',
      companySize: '2-10',
      monthlyUsage: '50000-250000',
      useCase: 'We are building <video> research tools for product teams.',
    });

    expect(rendered.html).toContain('Context &amp; Co');
    expect(rendered.html).not.toContain('<script>alert(1)</script>');
    expect(rendered.text).toContain('50,000-250,000');
  });
});

function validInquiry(): ScaleInquiryInput {
  return {
    id: VALID_ID,
    fullName: 'Mira Shah',
    role: 'Founder',
    companyName: 'Context Labs',
    email: 'mira@context.test',
    companySize: '2-10',
    monthlyUsage: '50000-250000',
    useCase: 'We are building a research product that analyses creator videos for product teams.',
    turnstileToken: 'turnstile-token',
  };
}

function inquiryRequest(): Request {
  return new Request('https://api.video2ctx.dev/v1/scale-inquiries', {
    method: 'POST',
    headers: { 'cf-connecting-ip': '203.0.113.10' },
  });
}

function inquiryEnv(database: ReturnType<typeof inquiryDatabase>, sent: Array<Record<string, unknown>>): Env {
  return {
    ENVIRONMENT: 'production',
    EMAIL_REPLY_TO: 'support@video2ctx.dev',
    TURNSTILE_SECRET: 'turnstile-secret',
    LANDING_RATE_LIMIT_SALT: 'rate-limit-salt',
    INQUIRY_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    DB: database.binding,
    EMAIL_TASKS: { send: async (message: Record<string, unknown>) => { sent.push(message); } },
  } as unknown as Env;
}

function inquiryDatabase() {
  const ids = new Set<string>();
  const inserts: unknown[][] = [];
  const binding = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        first: async () => {
          if (sql.startsWith('SELECT id')) return ids.has(String(values[0])) ? { id: values[0] } : null;
          if (sql.startsWith('SELECT COUNT')) return { count: 0 };
          return null;
        },
        run: async () => {
          if (sql.startsWith('INSERT INTO scale_inquiries')) {
            ids.add(String(values[0]));
            inserts.push(values);
          }
          return { success: true };
        },
      }),
    }),
  } as unknown as D1Database;
  return { binding, inserts };
}
