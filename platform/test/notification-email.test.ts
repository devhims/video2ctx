import { renderMonitorAlertEmail, renderNotificationOptInEmail } from '../src/lib/email-templates';
import { queueMonitorAlertEmail } from '../src/lib/notification-delivery';
import { handleQueue } from '../src/queues';

describe('monitor notification email', () => {
  test('every product template shows the embedded logo', async () => {
    const { renderDigestEmail, renderMagicLinkEmail, renderScaleInquiryEmail } = await import('../src/lib/email-templates');
    const rendered = await Promise.all([
      renderMonitorAlertEmail({ recipientName: 'A', monitorLabel: 'M', videoTitle: 'V', videoUrl: 'https://youtube.com/watch?v=1', settingsUrl: 'https://x.test/s', unsubscribeUrl: 'https://x.test/u' }),
      renderNotificationOptInEmail({ recipientName: 'A', confirmationUrl: 'https://x.test/c' }),
      renderDigestEmail({ recipientName: 'A', cadence: 'daily', notifications: [{ title: 'T', body: 'B' }], dashboardUrl: 'https://x.test/d', unsubscribeUrl: 'https://x.test/u' }),
      renderScaleInquiryEmail({ fullName: 'A', role: 'R', companyName: 'C', email: 'a@c.test', companySize: '10', monthlyUsage: 'under-10000', useCase: 'U' }),
      renderMagicLinkEmail({ url: 'https://x.test/verify?token=abc' }),
    ]);
    for (const { html } of rendered) {
      expect(html).toContain('src="cid:video2ctx-logo"');
      // Decorative: the wordmark beside the logo already names the product.
      expect(html).toMatch(/<img[^>]*alt=""[^>]*src="cid:video2ctx-logo"|<img[^>]*src="cid:video2ctx-logo"[^>]*alt=""/);
    }
  });

  test('renders the sign-in link with its expiry in HTML and text', async () => {
    const { renderMagicLinkEmail } = await import('../src/lib/email-templates');
    const message = await renderMagicLinkEmail({ url: 'https://x.test/verify?token=a&b=<c>' });
    expect(message.html).toContain('Sign in to video2ctx');
    expect(message.html).toContain('href="https://x.test/verify?token=a&amp;b=&lt;c&gt;"');
    expect(message.text).toContain('https://x.test/verify?token=a&b=<c>');
    expect(message.text).toContain('This link expires in 15 minutes and can be used once.');
  });

  test('renders a consent message that makes the pending state explicit', async () => {
    const message = await renderNotificationOptInEmail({
      recipientName: 'Member',
      confirmationUrl: 'https://video2ctx.dev/dashboard?section=settings&emailConsent=signed',
    });
    expect(message.html).toContain('Approve monitor emails');
    expect(message.text).toContain('Email alerts remain off until');
  });

  test('renders a branded HTML and plain-text message with safe user content', async () => {
    const message = await renderMonitorAlertEmail({
      recipientName: 'Ari <script>alert(1)</script>',
      monitorLabel: 'Design Weekly',
      videoTitle: 'A practical <guide> & review',
      videoUrl: 'https://www.youtube.com/watch?v=video-1',
      settingsUrl: 'https://video2ctx.dev/dashboard?section=settings',
      unsubscribeUrl: 'https://video2ctx.dev/unsubscribe',
    });

    expect(message.html).toContain('New video from Design Weekly');
    expect(message.html).toContain('Watch on YouTube');
    expect(message.html).toContain('&lt;guide&gt;');
    expect(message.html).not.toContain('<script>alert(1)</script>');
    expect(message.text).toContain('A practical <guide> & review');
    expect(message.text).toContain('Notification settings');
  });

  test('queues to the signed-in account email with a per-video idempotency key', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const env = notificationEnv({ email: 'member@customer.test', name: 'Member', email_alerts: 1, email_alerts_verified_at: Date.now() }, sent);

    const queued = await queueMonitorAlertEmail(env, {
      userId: 'user-1', monitorId: 'monitor-1', monitorLabel: 'Creator name', videoId: 'video-1', videoTitle: 'New upload',
    });

    expect(queued).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'monitor-alert',
      to: 'member@customer.test',
      idempotencyKey: 'monitor-alert:monitor-1:video-1',
    });
  });

  test.each([
    { email: 'member@customer.test', name: 'Member', email_alerts: 0, email_alerts_verified_at: null },
    { email: 'member@customer.test', name: 'Member', email_alerts: 1, email_alerts_verified_at: null },
    { email: 'local-beta@example.test', name: 'Local demo', email_alerts: 1, email_alerts_verified_at: Date.now() },
  ])('does not queue disabled or local-demo email', async (account) => {
    const sent: Array<Record<string, unknown>> = [];
    const queued = await queueMonitorAlertEmail(notificationEnv(account, sent), {
      userId: 'user-1', monitorId: 'monitor-1', monitorLabel: 'Creator', videoId: 'video-1', videoTitle: 'Upload',
    });
    expect(queued).toBe(false);
    expect(sent).toHaveLength(0);
  });

  test('sends through the verified notification subdomain with support as Reply-To', async () => {
    const delivered: Array<Record<string, unknown>> = [];
    const ack = vi.fn();
    const retry = vi.fn();
    const env = {
      EMAIL_FROM: 'noreply@notify.video2ctx.dev',
      EMAIL_REPLY_TO: 'support@video2ctx.dev',
      DB: {
        prepare: (sql: string) => ({
          bind: () => sql.startsWith('SELECT')
            ? { first: async () => null }
            : { run: async () => ({ success: true }) },
        }),
      },
      EMAIL: {
        send: async (message: Record<string, unknown>) => {
          delivered.push(message);
          return { messageId: 'email-1' };
        },
      },
    } as unknown as Env;
    const body = {
      type: 'monitor-alert' as const,
      idempotencyKey: 'monitor-alert:monitor-1:video-1',
      userId: 'user-1',
      to: 'founder@video2ctx.dev',
      subject: 'Delivery test',
      html: '<p>Delivery test</p>',
      text: 'Delivery test',
    };

    await handleQueue({
      queue: 'all-things-youtube-email',
      messages: [{ body, attempts: 1, ack, retry }],
    } as unknown as MessageBatch<unknown>, env);

    expect(delivered).toEqual([expect.objectContaining({
      from: { email: 'noreply@notify.video2ctx.dev', name: 'video2ctx' },
      replyTo: 'support@video2ctx.dev',
      to: 'founder@video2ctx.dev',
    })]);
    expect(delivered[0]).not.toHaveProperty('attachments');
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  test('uses a per-message sender and attaches the logo the HTML references, keeping support as Reply-To', async () => {
    const delivered: Array<Record<string, unknown>> = [];
    const env = {
      EMAIL_FROM: 'noreply@notify.video2ctx.dev',
      EMAIL_REPLY_TO: 'support@video2ctx.dev',
      DB: {
        prepare: (sql: string) => ({
          bind: () => sql.startsWith('SELECT')
            ? { first: async () => null }
            : { run: async () => ({ success: true }) },
        }),
      },
      EMAIL: {
        send: async (message: Record<string, unknown>) => {
          delivered.push(message);
          return { messageId: 'email-2' };
        },
      },
    } as unknown as Env;
    const body = {
      type: 'welcome' as const,
      idempotencyKey: 'welcome:user-1',
      userId: 'user-1',
      to: 'member@customer.test',
      from: { email: 'himanshu@notify.video2ctx.dev', name: 'Himanshu from video2ctx' },
      subject: 'Welcome to video2ctx',
      html: '<img src="cid:video2ctx-logo" alt="video2ctx"><p>Welcome</p>',
      text: 'Welcome',
    };

    await handleQueue({
      queue: 'all-things-youtube-email',
      messages: [{ body, attempts: 1, ack: vi.fn(), retry: vi.fn() }],
    } as unknown as MessageBatch<unknown>, env);

    expect(delivered).toEqual([expect.objectContaining({
      from: { email: 'himanshu@notify.video2ctx.dev', name: 'Himanshu from video2ctx' },
      replyTo: 'support@video2ctx.dev',
      attachments: [expect.objectContaining({ disposition: 'inline', contentId: 'video2ctx-logo', filename: 'video2ctx-logo.png', type: 'image/png' })],
    })]);
    const logo = (delivered[0]?.attachments as Array<{ content: Uint8Array }>)[0]!.content;
    expect([...logo.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG signature
  });
});

function notificationEnv(account: { email: string; name: string; email_alerts: number; email_alerts_verified_at: number | null }, sent: Array<Record<string, unknown>>): Env {
  return {
    APP_ORIGIN: 'https://video2ctx.dev',
    BETTER_AUTH_SECRET: 'test-secret-with-enough-entropy',
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => account }),
      }),
    },
    EMAIL_TASKS: {
      send: async (message: Record<string, unknown>) => { sent.push(message); },
    },
  } as unknown as Env;
}
