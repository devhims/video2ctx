import { renderWelcomeEmail } from '../src/lib/email-templates';
import { queueWelcomeEmail } from '../src/lib/notification-delivery';

const urls = {
  dashboardUrl: 'https://www.video2ctx.dev/dashboard',
  agentUrl: 'https://www.video2ctx.dev/dashboard/sessions',
};

describe('welcome email', () => {
  test('greets by first name, states the credit grant and escapes user content', async () => {
    const message = await renderWelcomeEmail({ recipientName: 'Ari <script>x</script> Lee', starterCredits: 1000, ...urls });

    expect(message.html).toContain('Hi Ari,');
    expect(message.html).toContain('1,000 free credits');
    expect(message.html).not.toContain('<script>x</script>');
    expect(message.text).toContain("I'm Himanshu, the developer behind video2ctx.");
    expect(message.text).toContain('Himanshu Gupta');
    expect(message.text).toContain('Founder, video2ctx');
    expect(message.text).toContain('npx skills add devhims/video2ctx');
    expect(message.text).toContain('Claude Code, Codex');
    expect(message.text).toContain(urls.agentUrl);
  });

  test('falls back to a neutral greeting when the account has no name', async () => {
    const message = await renderWelcomeEmail({ recipientName: '  ', starterCredits: 1000, ...urls });

    expect(message.text).toContain('Hi there,');
    expect(message.text).toContain('Welcome to video2ctx.');
  });

  test('ships a dark scheme alongside the light default', async () => {
    const { html } = await renderWelcomeEmail({ recipientName: 'Ari', starterCredits: 1000, ...urls });

    expect(html).toContain('name="color-scheme" content="light dark"');
    expect(html).toContain('@media (prefers-color-scheme:dark)');
    expect(html).toContain('[data-ogsc] .v-ink');
    expect(html).toContain('src="cid:video2ctx-logo"');
    expect(html).toMatch(/<img[^>]*alt=""[^>]*src="cid:video2ctx-logo"|<img[^>]*src="cid:video2ctx-logo"[^>]*alt=""/);
    expect(html).not.toContain('<svg');
  });
});

describe('welcome email queueing', () => {
  function welcomeEnv(send = vi.fn(async () => undefined)) {
    return {
      env: {
        APP_ORIGIN: 'https://www.video2ctx.dev',
        STARTER_ONBOARDING_CREDITS: '1000',
        WELCOME_EMAIL_FROM: 'himanshu@notify.video2ctx.dev',
        EMAIL_TASKS: { send },
      } as unknown as Env,
      send,
    };
  }

  test('queues a personal note once per account', async () => {
    const { env, send } = welcomeEnv();

    expect(await queueWelcomeEmail(env, { id: 'user-1', email: 'ari@customer.test', name: 'Ari Lee' })).toBe(true);

    expect(send).toHaveBeenCalledOnce();
    const [message, options] = send.mock.calls[0] as unknown as [Record<string, any>, unknown];
    expect(options).toEqual({ contentType: 'json' });
    expect(message).toMatchObject({
      type: 'welcome',
      idempotencyKey: 'welcome:user-1',
      userId: 'user-1',
      to: 'ari@customer.test',
      from: { email: 'himanshu@notify.video2ctx.dev', name: 'Himanshu from video2ctx' },
      subject: 'Welcome to video2ctx, Ari',
    });
    expect(message.unsubscribeUrl).toBeUndefined();
    expect(message.html).toContain('https://www.video2ctx.dev/dashboard/sessions');
    expect(message.text).toContain('1,000 free credits');
  });

  test('uses a neutral subject when the account has no name', async () => {
    const { env, send } = welcomeEnv();

    await queueWelcomeEmail(env, { id: 'user-2', email: 'link@customer.test', name: '' });

    expect((send.mock.calls[0] as unknown as [Record<string, any>])[0].subject).toBe('Welcome to video2ctx');
  });

  test('skips test accounts', async () => {
    const { env, send } = welcomeEnv();

    expect(await queueWelcomeEmail(env, { id: 'user-3', email: 'auth-1@example.test', name: 'Test' })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
