import type { EmailMessage } from '../types';
import { renderNotificationOptInEmail } from './email-templates';
import { ApiError, base64Url, now } from './http';

const EMAIL_ALERT_CONFIRMATION_TTL_MS = 24 * 60 * 60_000;

export interface NotificationPreferences {
  inApp: boolean;
  emailAlerts: boolean;
  emailAlertsPending: boolean;
  emailAlertsRequestedAt?: number;
  emailDigest: 'off' | 'daily' | 'weekly';
}

type NotificationPreferenceRow = {
  in_app: number;
  email_alerts: number;
  email_alerts_requested_at: number | null;
  email_alerts_verified_at: number | null;
  email_digest: string;
  unsubscribed_at: number | null;
};

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  inApp: true,
  emailAlerts: false,
  emailAlertsPending: false,
  emailDigest: 'off',
};

export async function getNotificationPreferences(env: Env, userId: string): Promise<NotificationPreferences> {
  const row = await loadPreferenceRow(env, userId);
  if (!row) return DEFAULT_NOTIFICATION_PREFERENCES;
  const emailAlerts = Boolean(row.email_alerts && row.email_alerts_verified_at);
  const emailAlertsPending = !emailAlerts && row.email_alerts_requested_at !== null;
  return {
    inApp: Boolean(row.in_app),
    emailAlerts,
    emailAlertsPending,
    ...(emailAlertsPending && row.email_alerts_requested_at !== null
      ? { emailAlertsRequestedAt: row.email_alerts_requested_at }
      : {}),
    emailDigest: digestCadence(row.email_digest),
  };
}

export async function saveNotificationPreferences(
  env: Env,
  userId: string,
  input: { inApp?: boolean; emailAlerts?: boolean },
): Promise<NotificationPreferences> {
  const currentRow = await loadPreferenceRow(env, userId);
  const current = preferencesFromRow(currentRow);

  if (input.emailAlerts === true && !current.emailAlerts) {
    return requestEmailAlertConfirmation(env, userId, input.inApp ?? current.inApp, currentRow);
  }

  const emailAlerts = input.emailAlerts === false ? false : current.emailAlerts;
  const inApp = input.inApp ?? current.inApp;
  const timestamp = now();
  await env.DB.prepare(
    `INSERT INTO notification_preferences
     (user_id,in_app,email_alerts,email_digest,unsubscribed_at,email_alerts_requested_at,email_alerts_verified_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       in_app=excluded.in_app,email_alerts=excluded.email_alerts,email_digest=excluded.email_digest,
       unsubscribed_at=excluded.unsubscribed_at,email_alerts_requested_at=excluded.email_alerts_requested_at,
       email_alerts_verified_at=excluded.email_alerts_verified_at,updated_at=excluded.updated_at`
  ).bind(
    userId,
    inApp ? 1 : 0,
    emailAlerts ? 1 : 0,
    emailAlerts ? current.emailDigest : 'off',
    emailAlerts ? null : timestamp,
    emailAlerts ? null : input.emailAlerts === false ? null : current.emailAlertsRequestedAt ?? null,
    emailAlerts ? currentRow?.email_alerts_verified_at ?? timestamp : null,
    timestamp,
  ).run();

  return getNotificationPreferences(env, userId);
}

export async function confirmEmailAlerts(
  env: Env,
  userId: string,
  confirmation: string,
): Promise<NotificationPreferences> {
  const [rawRequestedAt, suppliedToken, ...extra] = confirmation.split('.');
  const requestedAt = Number(rawRequestedAt);
  if (extra.length || !Number.isSafeInteger(requestedAt) || !suppliedToken) {
    throw new ApiError(422, 'EMAIL_ALERT_CONFIRMATION_INVALID', 'This email confirmation link is invalid.');
  }

  const account = await env.DB.prepare('SELECT email FROM user WHERE id=?')
    .bind(userId).first<{ email: string }>();
  const row = await loadPreferenceRow(env, userId);
  if (!account || !row || row.email_alerts_requested_at !== requestedAt) {
    throw new ApiError(409, 'EMAIL_ALERT_CONFIRMATION_STALE', 'This email confirmation link is no longer valid. Request a new one in Settings.');
  }
  const timestamp = now();
  if (requestedAt > timestamp || timestamp - requestedAt > EMAIL_ALERT_CONFIRMATION_TTL_MS) {
    throw new ApiError(409, 'EMAIL_ALERT_CONFIRMATION_EXPIRED', 'This email confirmation link has expired. Request a new one in Settings.');
  }

  const expectedToken = await emailAlertConfirmationToken(env, userId, account.email, requestedAt);
  if (!constantTimeEqual(expectedToken, suppliedToken)) {
    throw new ApiError(422, 'EMAIL_ALERT_CONFIRMATION_INVALID', 'This email confirmation link is invalid.');
  }

  await env.DB.prepare(
    `UPDATE notification_preferences
     SET email_alerts=1,email_digest='off',unsubscribed_at=NULL,
         email_alerts_requested_at=NULL,email_alerts_verified_at=?,updated_at=?
     WHERE user_id=? AND email_alerts_requested_at=?`
  ).bind(timestamp, timestamp, userId, requestedAt).run();
  return getNotificationPreferences(env, userId);
}

async function requestEmailAlertConfirmation(
  env: Env,
  userId: string,
  inApp: boolean,
  currentRow: NotificationPreferenceRow | null,
): Promise<NotificationPreferences> {
  const account = await env.DB.prepare('SELECT email,name FROM user WHERE id=?')
    .bind(userId).first<{ email: string; name: string }>();
  if (!account || account.email.endsWith('@example.test')) {
    throw new ApiError(422, 'EMAIL_ALERT_CONFIRMATION_UNAVAILABLE', 'Email alerts require a signed-in account with a deliverable email address.');
  }

  const requestedAt = now();
  const token = await emailAlertConfirmationToken(env, userId, account.email, requestedAt);
  const confirmation = `${requestedAt}.${token}`;
  const confirmationUrl = `${env.APP_ORIGIN}/dashboard?section=settings&emailConsent=${encodeURIComponent(confirmation)}`;
  const content = await renderNotificationOptInEmail({ recipientName: account.name, confirmationUrl });

  await env.DB.prepare(
    `INSERT INTO notification_preferences
     (user_id,in_app,email_alerts,email_digest,unsubscribed_at,email_alerts_requested_at,email_alerts_verified_at,updated_at)
     VALUES (?,? ,0,'off',?,?,NULL,?)
     ON CONFLICT(user_id) DO UPDATE SET
       in_app=excluded.in_app,email_alerts=0,email_digest='off',
       email_alerts_requested_at=excluded.email_alerts_requested_at,email_alerts_verified_at=NULL,
       updated_at=excluded.updated_at`
  ).bind(userId, inApp ? 1 : 0, currentRow?.unsubscribed_at ?? null, requestedAt, requestedAt).run();

  const message: EmailMessage = {
    type: 'notification-opt-in',
    idempotencyKey: `notification-opt-in:${userId}:${requestedAt}`,
    userId,
    to: account.email,
    subject: 'Confirm email alerts for video2ctx',
    html: content.html,
    text: content.text,
  };
  await env.EMAIL_TASKS.send(message, { contentType: 'json' });
  return getNotificationPreferences(env, userId);
}

async function loadPreferenceRow(env: Env, userId: string): Promise<NotificationPreferenceRow | null> {
  return env.DB.prepare(
    `SELECT in_app,email_alerts,email_alerts_requested_at,email_alerts_verified_at,email_digest,unsubscribed_at
     FROM notification_preferences WHERE user_id=?`
  ).bind(userId).first<NotificationPreferenceRow>();
}

function preferencesFromRow(row: NotificationPreferenceRow | null): NotificationPreferences {
  if (!row) return DEFAULT_NOTIFICATION_PREFERENCES;
  const emailAlerts = Boolean(row.email_alerts && row.email_alerts_verified_at);
  const emailAlertsPending = !emailAlerts && row.email_alerts_requested_at !== null;
  return {
    inApp: Boolean(row.in_app),
    emailAlerts,
    emailAlertsPending,
    ...(emailAlertsPending && row.email_alerts_requested_at !== null
      ? { emailAlertsRequestedAt: row.email_alerts_requested_at }
      : {}),
    emailDigest: digestCadence(row.email_digest),
  };
}

async function emailAlertConfirmationToken(env: Env, userId: string, email: string, requestedAt: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.BETTER_AUTH_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const payload = `notification-email-opt-in:${userId}:${email.trim().toLowerCase()}:${requestedAt}`;
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))));
}

function constantTimeEqual(expected: string, supplied: string): boolean {
  const length = Math.max(expected.length, supplied.length);
  let difference = expected.length ^ supplied.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (expected.charCodeAt(index) || 0) ^ (supplied.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function digestCadence(value: string): NotificationPreferences['emailDigest'] {
  return value === 'daily' || value === 'weekly' ? value : 'off';
}
