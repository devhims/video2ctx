import {
  confirmEmailAlerts,
  DEFAULT_NOTIFICATION_PREFERENCES,
  getNotificationPreferences,
  saveNotificationPreferences,
} from '../src/lib/notification-preferences';

type PreferenceRow = {
  in_app: number;
  email_alerts: number;
  email_alerts_requested_at: number | null;
  email_alerts_verified_at: number | null;
  email_digest: string;
  unsubscribed_at: number | null;
};

describe('notification preferences', () => {
  test('defaults email delivery off without a pending confirmation', async () => {
    const { env } = preferenceEnv(null);
    await expect(getNotificationPreferences(env, 'user-1')).resolves.toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
  });

  test('enabling email requests confirmation but does not activate monitor delivery', async () => {
    const { env, sent } = preferenceEnv(null);

    const saved = await saveNotificationPreferences(env, 'user-1', { emailAlerts: true });

    expect(saved).toMatchObject({ inApp: true, emailAlerts: false, emailAlertsPending: true, emailDigest: 'off' });
    expect(saved.emailAlertsRequestedAt).toEqual(expect.any(Number));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'notification-opt-in',
      to: 'member@customer.test',
      subject: 'Confirm email alerts for video2ctx',
    });
  });

  test('activates delivery only after the signed-in confirmation step', async () => {
    const { env, sent } = preferenceEnv(null);
    await saveNotificationPreferences(env, 'user-1', { emailAlerts: true });
    const confirmationUrl = confirmationUrlFromMessage(sent[0]);
    const confirmation = new URL(confirmationUrl).searchParams.get('emailConsent');

    const confirmed = await confirmEmailAlerts(env, 'user-1', confirmation ?? '');

    expect(confirmed).toEqual({ inApp: true, emailAlerts: true, emailAlertsPending: false, emailDigest: 'off' });
  });

  test('turning email off clears active and pending consent', async () => {
    const { env } = preferenceEnv({
      in_app: 1,
      email_alerts: 1,
      email_alerts_requested_at: null,
      email_alerts_verified_at: Date.now(),
      email_digest: 'weekly',
      unsubscribed_at: null,
    });

    const saved = await saveNotificationPreferences(env, 'user-1', { emailAlerts: false });

    expect(saved).toEqual({ inApp: true, emailAlerts: false, emailAlertsPending: false, emailDigest: 'off' });
  });
});

function confirmationUrlFromMessage(message: Record<string, unknown> | undefined): string {
  const html = String(message?.html ?? '');
  const match = /href="([^"]*emailConsent=[^"]+)"/.exec(html);
  if (!match) throw new Error('Confirmation URL not found in message.');
  return match[1]!.replace(/&amp;/g, '&');
}

function preferenceEnv(initial: PreferenceRow | null): { env: Env; sent: Array<Record<string, unknown>> } {
  let row = initial ? { ...initial } : null;
  const sent: Array<Record<string, unknown>> = [];
  const account = { email: 'member@customer.test', name: 'Member' };

  const env = {
    APP_ORIGIN: 'https://video2ctx.dev',
    BETTER_AUTH_SECRET: 'test-secret-with-enough-entropy-for-hmac',
    EMAIL_TASKS: { send: async (message: Record<string, unknown>) => { sent.push(message); } },
    DB: {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          first: async () => sql.includes('FROM user') ? account : row,
          run: async () => {
            if (sql.includes('VALUES (?,? ,0')) {
              row = {
                in_app: Number(values[1]), email_alerts: 0, email_digest: 'off',
                unsubscribed_at: (values[2] as number | null) ?? null,
                email_alerts_requested_at: Number(values[3]), email_alerts_verified_at: null,
              };
            } else if (sql.startsWith('UPDATE notification_preferences')) {
              row = row ? {
                ...row, email_alerts: 1, email_digest: 'off', unsubscribed_at: null,
                email_alerts_requested_at: null, email_alerts_verified_at: Number(values[0]),
              } : row;
            } else {
              row = {
                in_app: Number(values[1]), email_alerts: Number(values[2]), email_digest: String(values[3]),
                unsubscribed_at: (values[4] as number | null) ?? null,
                email_alerts_requested_at: (values[5] as number | null) ?? null,
                email_alerts_verified_at: (values[6] as number | null) ?? null,
              };
            }
            return { success: true };
          },
        }),
      }),
    },
  } as unknown as Env;

  return { env, sent };
}
