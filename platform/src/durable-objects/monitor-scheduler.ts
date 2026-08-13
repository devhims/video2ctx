import { DurableObject } from 'cloudflare:workers';
import {
  MonitorSchedulerCore,
  type MonitorScheduleConfig,
  type MonitorSchedulerActions,
} from '../lib/monitor-scheduler';

export class MonitorScheduler extends DurableObject<Env> {
  private readonly scheduler: MonitorSchedulerCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const actions: MonitorSchedulerActions = {
      loadMonitor: (monitorId, userId) => this.env.DB.prepare(
        'SELECT id,user_id,enabled,interval_minutes FROM monitors WHERE id=? AND user_id=?'
      ).bind(monitorId, userId).first(),
      enqueue: async (config) => {
        await this.env.TASKS.send({
          type: 'run-monitor',
          idempotencyKey: `monitor:${config.monitorId}:${config.nextCheckAt}`,
          payload: {
            monitorId: config.monitorId,
            userId: config.userId,
            scheduledAt: config.nextCheckAt,
          },
        }, { contentType: 'json' });
      },
      recordNextCheck: async (config) => {
        await this.env.DB.prepare(
          'UPDATE monitors SET next_check_at=? WHERE id=? AND user_id=? AND enabled=1'
        ).bind(config.nextCheckAt, config.monitorId, config.userId).run();
      },
    };
    this.scheduler = new MonitorSchedulerCore(this.ctx.storage, actions);
  }

  async configure(configJson: string): Promise<string> {
    return JSON.stringify(await this.scheduler.configure(parseConfig(configJson)));
  }

  async cancel(): Promise<void> {
    await this.scheduler.cancel();
  }

  async alarm(): Promise<void> {
    await this.scheduler.alarm();
  }
}

function parseConfig(value: string): MonitorScheduleConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError('The monitor schedule must be valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('The monitor schedule must be an object.');
  }
  const config = parsed as Partial<MonitorScheduleConfig>;
  if (
    typeof config.monitorId !== 'string'
    || typeof config.userId !== 'string'
    || typeof config.intervalMinutes !== 'number'
    || typeof config.nextCheckAt !== 'number'
  ) {
    throw new TypeError('The monitor schedule is invalid.');
  }
  return config as MonitorScheduleConfig;
}
