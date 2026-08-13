import type { EmailMessage } from '../types';
import { renderMonitorAlertEmail } from './email-templates';
import { unsubscribeToken } from './digests';

interface MonitorAlertInput {
  userId: string;
  monitorId: string;
  monitorLabel: string;
  videoId: string;
  videoTitle: string;
}

export async function queueMonitorAlertEmail(env: Env, input: MonitorAlertInput): Promise<boolean> {
  const account = await env.DB.prepare(
    `SELECT u.email,u.name,COALESCE(p.email_alerts,0) AS email_alerts,p.email_alerts_verified_at
     FROM user u LEFT JOIN notification_preferences p ON p.user_id=u.id
     WHERE u.id=?`
  ).bind(input.userId).first<{ email: string; name: string; email_alerts: number; email_alerts_verified_at: number | null }>();
  if (!account?.email_alerts || !account.email_alerts_verified_at || account.email.endsWith('@example.test')) return false;

  const token = await unsubscribeToken(env, input.userId);
  const unsubscribeUrl = `${env.APP_ORIGIN}/api/platform/v1/email/unsubscribe?user=${encodeURIComponent(input.userId)}&token=${encodeURIComponent(token)}`;
  const settingsUrl = `${env.APP_ORIGIN}/dashboard?section=settings`;
  const videoUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(input.videoId)}`;
  const content = await renderMonitorAlertEmail({
    recipientName: account.name,
    monitorLabel: input.monitorLabel,
    videoTitle: input.videoTitle,
    videoUrl,
    settingsUrl,
    unsubscribeUrl,
  });
  const message: EmailMessage = {
    type: 'monitor-alert',
    idempotencyKey: `monitor-alert:${input.monitorId}:${input.videoId}`,
    userId: input.userId,
    to: account.email,
    subject: `New video from ${input.monitorLabel}`,
    html: content.html,
    text: content.text,
    unsubscribeUrl,
  };
  await env.EMAIL_TASKS.send(message, { contentType: 'json' });
  return true;
}
