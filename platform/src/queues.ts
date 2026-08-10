import type { EmailMessage, TaskMessage } from './types';
import { indexPrivateDocument } from './lib/search';
import { now, safeErrorLog, sha256 } from './lib/http';

const PERMANENT_EMAIL_ERRORS = new Set([
  'E_VALIDATION_ERROR', 'E_FIELD_MISSING', 'E_SENDER_NOT_VERIFIED',
  'E_RECIPIENT_NOT_ALLOWED', 'E_RECIPIENT_SUPPRESSED', 'E_SENDER_DOMAIN_NOT_AVAILABLE',
  'E_CONTENT_TOO_LARGE', 'E_HEADER_NOT_ALLOWED', 'E_HEADER_USE_API_FIELD',
  'E_HEADER_VALUE_INVALID', 'E_HEADER_VALUE_TOO_LONG', 'E_HEADER_NAME_INVALID',
  'E_HEADERS_TOO_LARGE', 'E_HEADERS_TOO_MANY',
]);

export async function handleQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      if (batch.queue.includes('email')) await sendEmail(message.body as EmailMessage, env);
      else await runTask(message.body as TaskMessage, env);
      message.ack();
    } catch (error) {
      const code = errorCode(error);
      if (batch.queue.includes('email') && PERMANENT_EMAIL_ERRORS.has(code)) {
        console.error({ event: 'permanent_email_failure', code, ...safeErrorLog(error) });
        message.ack();
      } else {
        message.retry({ delaySeconds: Math.min(900, 2 ** message.attempts * 10) });
      }
    }
  }
}

async function sendEmail(input: EmailMessage, env: Env): Promise<void> {
  const existing = await env.DB.prepare('SELECT status FROM email_deliveries WHERE idempotency_key=?')
    .bind(input.idempotencyKey).first<{ status: string }>();
  if (existing?.status === 'sent' || existing?.status === 'suppressed') return;
  const recipientHash = await sha256(input.to.toLowerCase());
  await env.DB.prepare(
    `INSERT INTO email_deliveries
     (idempotency_key,user_id,recipient_hash,template,status,attempt_count,updated_at)
     VALUES (?,?,?,?, 'sending',1,?)
     ON CONFLICT(idempotency_key) DO UPDATE SET attempt_count=attempt_count+1,status='sending',updated_at=excluded.updated_at`
  ).bind(input.idempotencyKey, input.userId ?? null, recipientHash, input.type, now()).run();
  try {
    const response = await env.EMAIL.send({
      to: input.to,
      from: { email: env.EMAIL_FROM, name: 'all-things-youtube' },
      subject: input.subject,
      html: input.html,
      text: input.text,
      ...(input.unsubscribeUrl ? {
        headers: {
          'List-Unsubscribe': `<${input.unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      } : {}),
    });
    await env.DB.prepare(
      `UPDATE email_deliveries SET status='sent',provider_message_id=?,last_error=NULL,updated_at=? WHERE idempotency_key=?`
    ).bind(response.messageId, now(), input.idempotencyKey).run();
  } catch (error) {
    const code = errorCode(error);
    await env.DB.prepare(
      `UPDATE email_deliveries SET status=?,last_error=?,updated_at=? WHERE idempotency_key=?`
    ).bind(PERMANENT_EMAIL_ERRORS.has(code) ? 'suppressed' : 'failed', `${code}: ${errorMessage(error)}`, now(), input.idempotencyKey).run();
    throw error;
  }
}

async function runTask(task: TaskMessage, env: Env): Promise<void> {
  const eventId = await sha256(task.idempotencyKey);
  const exists = await env.DB.prepare('SELECT 1 FROM processed_events WHERE source=? AND event_id=?')
    .bind('queue', eventId).first();
  if (exists) return;

  if (task.type === 'index-document') {
    const payload = task.payload as unknown as Parameters<typeof indexPrivateDocument>[1];
    await indexPrivateDocument(env, payload);
  } else if (task.type === 'snapshot-statistics') {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO analytics_snapshots
       (provider,entity_type,entity_id,captured_at,view_count) VALUES (?,'video',?,?,?)`
    ).bind(String(task.payload.provider ?? 'youtube'), String(task.payload.entityId), now(), Number(task.payload.viewCount ?? 0)).run();
  } else if (task.type === 'delete-user-search') {
    const instanceId = String(task.payload.instanceId);
    try {
      await env.AI_SEARCH.delete(instanceId);
    } catch (error) {
      console.warn({ event: 'search_instance_delete', ...safeErrorLog(error) });
    }
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO processed_events (source,event_id,processed_at,payload_hash) VALUES ('queue',?,?,?)`
  ).bind(eventId, now(), await sha256(JSON.stringify(task.payload))).run();
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error && 'code' in error) return String(error.code);
  return 'UNKNOWN';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}
