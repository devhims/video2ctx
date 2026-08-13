export interface DashboardUsage {
  plan: 'free' | 'pro';
  includedCredits: number;
  creditGrant: 'onboarding' | 'monthly';
  creditBalance: number;
}

export interface DashboardProject {
  id: string;
  name: string;
  description?: string;
  item_count?: number;
}

export interface DashboardMonitor {
  id: string;
  provider: 'youtube';
  kind: string;
  target: string;
  enabled: number;
  last_checked_at?: number;
  interval_minutes?: number;
  next_check_at?: number;
}

export interface DashboardNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  data_json: string;
  read_at?: number | null;
  created_at: number;
}

export interface DashboardNotificationPreferences {
  inApp: boolean;
  emailAlerts: boolean;
  emailAlertsPending: boolean;
  emailAlertsRequestedAt?: number;
  emailDigest: 'off' | 'daily' | 'weekly';
}

export const DEFAULT_NOTIFICATION_PREFERENCES: DashboardNotificationPreferences = {
  inApp: true,
  emailAlerts: false,
  emailAlertsPending: false,
  emailDigest: 'off',
};

export interface DashboardAccountData {
  projects: DashboardProject[];
  monitors: DashboardMonitor[];
  usage: DashboardUsage | null;
  notifications: DashboardNotification[];
  notificationPreferences: DashboardNotificationPreferences;
}

type DashboardRequest = (path: string) => Promise<unknown>;

export async function loadDashboardAccountData(request: DashboardRequest): Promise<DashboardAccountData> {
  const [projectData, monitorData, usage, notificationData, notificationPreferences] = await Promise.all([
    request('/v1/projects').catch(() => ({ projects: [] })) as Promise<{ projects: DashboardProject[] }>,
    request('/v1/monitors').catch(() => ({ monitors: [] })) as Promise<{ monitors: DashboardMonitor[] }>,
    request('/v1/usage').catch(() => null) as Promise<DashboardUsage | null>,
    request('/v1/notifications').catch(() => ({ notifications: [] })) as Promise<{ notifications: DashboardNotification[] }>,
    request('/v1/notification-preferences').catch(() => DEFAULT_NOTIFICATION_PREFERENCES) as Promise<DashboardNotificationPreferences>,
  ]);

  return {
    projects: projectData.projects,
    monitors: monitorData.monitors,
    usage,
    notifications: notificationData.notifications,
    notificationPreferences,
  };
}

export const CREDIT_BALANCE_EVENT = 'video2ctx:credit-balance';
export const DELETE_ACCOUNT_CONFIRMATION = 'DELETE';

export function canDeleteAccount(value: string): boolean {
  return value === DELETE_ACCOUNT_CONFIRMATION;
}

export function creditBalanceFromHeaders(headers: Headers): number | undefined {
  const value = headers.get('X-Credits-Remaining');
  if (!value || !/^\d+$/.test(value)) return undefined;
  const balance = Number(value);
  return Number.isSafeInteger(balance) ? balance : undefined;
}

export function publishCreditBalance(headers: Headers): void {
  const balance = creditBalanceFromHeaders(headers);
  if (balance === undefined) return;
  window.dispatchEvent(new CustomEvent<number>(CREDIT_BALANCE_EVENT, { detail: balance }));
}
