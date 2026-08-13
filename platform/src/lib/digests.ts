import type { EmailMessage } from '../types';
import { base64Url, now, sha256 } from './http';
import { renderDigestEmail } from './email-templates';

export async function queueDigests(env: Env, cadence: 'daily' | 'weekly'): Promise<void> {
  const users = await env.DB.prepare(
    `SELECT u.id,u.email,u.name FROM user u
     JOIN notification_preferences p ON p.user_id=u.id
     WHERE p.email_digest=? AND p.email_alerts=1 AND p.email_alerts_verified_at IS NOT NULL
       AND p.unsubscribed_at IS NULL`
  ).bind(cadence).all<{ id: string; email: string; name: string }>();
  const since = now() - (cadence === 'daily' ? 24 * 60 * 60_000 : 7 * 24 * 60 * 60_000);
  for (const user of users.results) {
    const notifications = await env.DB.prepare(
      `SELECT title,body,data_json,created_at FROM notifications
       WHERE user_id=? AND created_at>=? ORDER BY created_at DESC LIMIT 30`
    ).bind(user.id, since).all<{ title: string; body: string; data_json: string; created_at: number }>();
    if (!notifications.results.length) continue;
    const token = await unsubscribeToken(env, user.id);
    const unsubscribeUrl = `${env.APP_ORIGIN}/api/platform/v1/email/unsubscribe?user=${encodeURIComponent(user.id)}&token=${encodeURIComponent(token)}`;
    const content = await renderDigestEmail({
      recipientName: user.name,
      cadence,
      notifications: notifications.results,
      dashboardUrl: `${env.APP_ORIGIN}/dashboard`,
      unsubscribeUrl,
    });
    const message: EmailMessage = {
      type: cadence === 'daily' ? 'daily-digest' : 'weekly-digest',
      idempotencyKey: `digest:${cadence}:${user.id}:${new Date().toISOString().slice(0, 10)}`,
      userId: user.id,
      to: user.email,
      subject: `Your ${cadence} video2ctx digest`,
      html: content.html,
      text: content.text,
      unsubscribeUrl,
    };
    await env.EMAIL_TASKS.send(message, { contentType: 'json' });
  }
}

export async function unsubscribeToken(env: Env, userId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.BETTER_AUTH_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`unsubscribe:${userId}`))));
}

export async function unsubscribe(env: Env, userId: string, token: string): Promise<boolean> {
  const expected = await unsubscribeToken(env, userId);
  if ((await sha256(expected)) !== (await sha256(token))) return false;
  await env.DB.prepare(
    `INSERT INTO notification_preferences
     (user_id,in_app,email_alerts,email_digest,unsubscribed_at,email_alerts_requested_at,email_alerts_verified_at,updated_at)
     VALUES (?,1,0,'off',?,NULL,NULL,?)
     ON CONFLICT(user_id) DO UPDATE SET
       email_alerts=0,email_digest='off',unsubscribed_at=excluded.unsubscribed_at,
       email_alerts_requested_at=NULL,email_alerts_verified_at=NULL,updated_at=excluded.updated_at`
  ).bind(userId, now(), now()).run();
  return true;
}
