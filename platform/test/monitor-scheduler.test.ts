import {
  DEFAULT_MONITOR_INTERVAL_MINUTES,
  MonitorSchedulerCore,
  initialMonitorCheckAt,
  monitorIntervalMinutes,
  nextMonitorCheckAt,
  type MonitorScheduleConfig,
  type MonitorAlarmTransaction,
  type MonitorSchedulerActions,
} from '../src/lib/monitor-scheduler';

describe('per-monitor alarm scheduling', () => {
  test('uses 24 hours as the default and accepts the supported intervals', () => {
    expect(DEFAULT_MONITOR_INTERVAL_MINUTES).toBe(1440);
    expect(monitorIntervalMinutes(60)).toBe(60);
    expect(monitorIntervalMinutes(10080)).toBe(10080);
    expect(() => monitorIntervalMinutes(15)).toThrow('supported monitoring interval');
  });

  test('schedules the first baseline check shortly after creation', () => {
    expect(initialMonitorCheckAt(1_000)).toBe(61_000);
  });

  test('advances an overdue alarm to the next future interval without replaying missed checks', () => {
    const hour = 60 * 60_000;
    expect(nextMonitorCheckAt(1_000, 60, 1_000 + hour * 3 + 10)).toBe(1_000 + hour * 4);
  });

  test('enqueues one idempotent check and atomically records the next alarm', async () => {
    const storage = new MemoryAlarmStorage();
    const enqueued: MonitorScheduleConfig[] = [];
    const recorded: MonitorScheduleConfig[] = [];
    const actions: MonitorSchedulerActions = {
      loadMonitor: vi.fn(async () => ({ id: 'monitor-1', user_id: 'user-1', enabled: 1, interval_minutes: 1440 })),
      enqueue: vi.fn(async (config) => { enqueued.push(config); }),
      recordNextCheck: vi.fn(async (config) => { recorded.push(config); }),
    };
    const scheduler = new MonitorSchedulerCore(storage, actions, () => 70_000);
    const initial = { monitorId: 'monitor-1', userId: 'user-1', intervalMinutes: 1440, nextCheckAt: 61_000 };

    await scheduler.configure(initial);
    await scheduler.alarm();

    expect(enqueued).toEqual([initial]);
    expect(recorded[0]?.nextCheckAt).toBe(61_000 + 1440 * 60_000);
    expect(storage.alarmAt).toBe(recorded[0]?.nextCheckAt);
    expect(storage.value?.nextCheckAt).toBe(recorded[0]?.nextCheckAt);
  });

  test('cancels itself when its D1 monitor has been removed', async () => {
    const storage = new MemoryAlarmStorage();
    const actions: MonitorSchedulerActions = {
      loadMonitor: vi.fn(async () => null),
      enqueue: vi.fn(),
      recordNextCheck: vi.fn(),
    };
    const scheduler = new MonitorSchedulerCore(storage, actions);
    await scheduler.configure({ monitorId: 'gone', userId: 'user-1', intervalMinutes: 1440, nextCheckAt: 61_000 });

    await scheduler.alarm();

    expect(storage.value).toBeUndefined();
    expect(storage.alarmAt).toBeNull();
    expect(actions.enqueue).not.toHaveBeenCalled();
  });
});

class MemoryAlarmStorage {
  value: MonitorScheduleConfig | undefined;
  alarmAt: number | null = null;

  async get<T>(_key: string): Promise<T | undefined> {
    return this.value as T | undefined;
  }

  async transaction<T>(closure: (transaction: MonitorAlarmTransaction) => Promise<T>): Promise<T> {
    const transaction: MonitorAlarmTransaction = {
      put: async (_key: string, value: MonitorScheduleConfig) => { this.value = value; },
      delete: async () => { const existed = Boolean(this.value); this.value = undefined; return existed; },
      setAlarm: async (scheduledTime: number | Date) => { this.alarmAt = Number(scheduledTime); },
      deleteAlarm: async () => { this.alarmAt = null; },
    };
    return closure(transaction);
  }
}
