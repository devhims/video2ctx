import { ApiError, now } from './http';

export const MONITOR_INTERVALS = [60, 360, 720, 1440, 4320, 10080] as const;
export const DEFAULT_MONITOR_INTERVAL_MINUTES = 1440;
export const INITIAL_MONITOR_DELAY_MS = 60_000;

export interface MonitorScheduleConfig {
  monitorId: string;
  userId: string;
  intervalMinutes: number;
  nextCheckAt: number;
}

type MonitorScheduleRow = {
  id: string;
  user_id: string;
  enabled: number;
  interval_minutes: number;
};

export interface MonitorAlarmTransaction {
  put(key: string, value: MonitorScheduleConfig): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface MonitorAlarmStorage {
  get<T>(key: string): Promise<T | undefined>;
  transaction<T>(closure: (transaction: MonitorAlarmTransaction) => Promise<T>): Promise<T>;
}

export interface MonitorSchedulerActions {
  loadMonitor(monitorId: string, userId: string): Promise<MonitorScheduleRow | null>;
  enqueue(config: MonitorScheduleConfig): Promise<void>;
  recordNextCheck(config: MonitorScheduleConfig): Promise<void>;
}

export class MonitorSchedulerCore {
  constructor(
    private readonly storage: MonitorAlarmStorage,
    private readonly actions: MonitorSchedulerActions,
    private readonly clock: () => number = now,
  ) {}

  async configure(config: MonitorScheduleConfig): Promise<MonitorScheduleConfig> {
    const normalized = { ...config, intervalMinutes: monitorIntervalMinutes(config.intervalMinutes) };
    await this.storage.transaction(async (transaction) => {
      await transaction.put('config', normalized);
      await transaction.setAlarm(normalized.nextCheckAt);
    });
    return normalized;
  }

  async cancel(): Promise<void> {
    await this.storage.transaction(async (transaction) => cancelTransaction(transaction));
  }

  async alarm(): Promise<void> {
    const config = await this.storage.get<MonitorScheduleConfig>('config');
    if (!config) return;

    const monitor = await this.actions.loadMonitor(config.monitorId, config.userId);
    if (!monitor || !monitor.enabled) {
      await this.cancel();
      return;
    }

    const dueConfig = {
      ...config,
      intervalMinutes: monitorIntervalMinutes(monitor.interval_minutes),
    };
    await this.actions.enqueue(dueConfig);

    const nextConfig = {
      ...dueConfig,
      nextCheckAt: nextMonitorCheckAt(dueConfig.nextCheckAt, dueConfig.intervalMinutes, this.clock()),
    };
    await this.actions.recordNextCheck(nextConfig);
    await this.configure(nextConfig);
  }
}

export function monitorIntervalMinutes(value: unknown): number {
  const interval = typeof value === 'number' ? value : Number(value);
  if (!MONITOR_INTERVALS.some((allowed) => allowed === interval)) {
    throw new ApiError(422, 'INVALID_MONITOR_INTERVAL', 'Choose a supported monitoring interval.');
  }
  return interval;
}

export function initialMonitorCheckAt(timestamp = now()): number {
  return timestamp + INITIAL_MONITOR_DELAY_MS;
}

export function nextMonitorCheckAt(previousCheckAt: number, intervalMinutes: number, timestamp = now()): number {
  const intervalMs = monitorIntervalMinutes(intervalMinutes) * 60_000;
  const elapsedIntervals = Math.max(1, Math.floor((timestamp - previousCheckAt) / intervalMs) + 1);
  return previousCheckAt + elapsedIntervals * intervalMs;
}

export function monitorCadence(intervalMinutes: number): string {
  return intervalMinutes === 1440 ? 'daily' : `${intervalMinutes}m`;
}

export async function configureMonitorSchedule(env: Env, config: MonitorScheduleConfig): Promise<void> {
  const stub = env.MONITOR_SCHEDULER.getByName(config.monitorId);
  await stub.configure(JSON.stringify(config));
}

export async function cancelMonitorSchedule(env: Env, monitorId: string): Promise<void> {
  await env.MONITOR_SCHEDULER.getByName(monitorId).cancel();
}

export async function reconcileMonitorSchedules(env: Env, timestamp = now()): Promise<void> {
  const result = await env.DB.prepare(
    `SELECT id,user_id,interval_minutes FROM monitors
     WHERE enabled=1 AND next_check_at IS NULL ORDER BY created_at LIMIT 100`
  ).all<{ id: string; user_id: string; interval_minutes: number }>();

  for (const monitor of result.results) {
    const config = {
      monitorId: monitor.id,
      userId: monitor.user_id,
      intervalMinutes: monitorIntervalMinutes(monitor.interval_minutes),
      nextCheckAt: initialMonitorCheckAt(timestamp),
    };
    await configureMonitorSchedule(env, config);
    await env.DB.prepare('UPDATE monitors SET next_check_at=? WHERE id=? AND user_id=?')
      .bind(config.nextCheckAt, monitor.id, monitor.user_id).run();
  }
}

function cancelTransaction(transaction: MonitorAlarmTransaction): Promise<void> {
  return Promise.all([
    transaction.delete('config'),
    transaction.deleteAlarm(),
  ]).then(() => undefined);
}
