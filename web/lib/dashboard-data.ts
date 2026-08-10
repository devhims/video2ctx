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
}

export interface DashboardAccountData {
  projects: DashboardProject[];
  monitors: DashboardMonitor[];
  usage: DashboardUsage | null;
}

type DashboardRequest = (path: string) => Promise<unknown>;

export async function loadDashboardAccountData(request: DashboardRequest): Promise<DashboardAccountData> {
  const [projectData, monitorData, usage] = await Promise.all([
    request('/v1/projects').catch(() => ({ projects: [] })) as Promise<{ projects: DashboardProject[] }>,
    request('/v1/monitors').catch(() => ({ monitors: [] })) as Promise<{ monitors: DashboardMonitor[] }>,
    request('/v1/usage').catch(() => null) as Promise<DashboardUsage | null>,
  ]);

  return { projects: projectData.projects, monitors: monitorData.monitors, usage };
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
