import { now } from './http';
import { getProvider } from '../providers';
import { queueMonitorAlertEmail } from './notification-delivery';

export interface MonitorRow {
  id: string;
  user_id: string;
  provider: string;
  kind: string;
  target: string;
  query_json: string;
  cadence: string;
  interval_minutes: number;
  enabled: number;
  last_checked_at: number | null;
  last_cursor: string | null;
  next_check_at: number | null;
  created_at: number;
}

export async function checkMonitor(env: Env, monitorId: string, userId: string): Promise<void> {
  const monitor = await env.DB.prepare(
    'SELECT * FROM monitors WHERE id=? AND user_id=? AND enabled=1'
  ).bind(monitorId, userId).first<MonitorRow>();
  if (!monitor) return;

  const provider = getProvider(monitor.provider);
  const newest = monitor.kind === 'channel'
    ? (await provider.getChannelVideos(env, monitor.target, undefined, 'latest')).value.videos[0]
    : (await provider.search(env, monitor.target, { type: 'video', sort: 'date' })).value.results[0];
  const checkedAt = now();

  if (newest?.type !== 'video') {
    await env.DB.prepare('UPDATE monitors SET last_checked_at=? WHERE id=? AND user_id=?')
      .bind(checkedAt, monitor.id, monitor.user_id).run();
    return;
  }

  if (!monitor.last_cursor || newest.id === monitor.last_cursor) {
    await env.DB.prepare('UPDATE monitors SET last_cursor=?, last_checked_at=? WHERE id=? AND user_id=?')
      .bind(newest.id, checkedAt, monitor.id, monitor.user_id).run();
    return;
  }

  const query = monitorQuery(monitor.query_json);
  const label = typeof query.label === 'string' && query.label.trim()
    ? query.label.trim()
    : monitor.kind === 'channel' ? 'a monitored channel' : monitor.target;
  const notificationTitle = monitor.kind === 'channel' ? `New video from ${label}` : `New video matching ${label}`;

  // Queue before advancing the cursor. If the following D1 batch fails, a retry
  // uses the same email idempotency key and cannot produce a duplicate message.
  await queueMonitorAlertEmail(env, {
    userId: monitor.user_id,
    monitorId: monitor.id,
    monitorLabel: label,
    videoId: newest.id,
    videoTitle: newest.title,
  });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO notifications (id,user_id,type,title,body,data_json,created_at)
       VALUES (?,?,'monitor_match',?,?,?,?)`
    ).bind(
      crypto.randomUUID(), monitor.user_id, notificationTitle, newest.title,
      JSON.stringify({ monitorId: monitor.id, provider: monitor.provider, videoId: newest.id, target: monitor.target }),
      checkedAt,
    ),
    env.DB.prepare('UPDATE monitors SET last_cursor=?, last_checked_at=? WHERE id=? AND user_id=?')
      .bind(newest.id, checkedAt, monitor.id, monitor.user_id),
  ]);
}

function monitorQuery(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
