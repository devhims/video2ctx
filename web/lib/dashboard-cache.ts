import type { DashboardAccountData } from './dashboard-data.ts';

export type AccountResource = keyof DashboardAccountData;
export const ACCOUNT_PATHS: Record<AccountResource, string> = {
  apiKeys: '/api/auth/api-key/list',
  projects: '/v1/projects', monitors: '/v1/monitors', usage: '/v1/usage', billing: '/v1/billing',
  notifications: '/v1/notifications', notificationPreferences: '/v1/notification-preferences',
};
export type ResourceResult<T> = { data: T; error?: never; updatedAt?: number } | { data?: never; error: string; updatedAt?: number };
export type AccountSeeds = { [K in AccountResource]?: Promise<ResourceResult<DashboardAccountData[K]>> };
export type ResourceSnapshot<T> = { data: T | undefined; error: string; loading: boolean; updatedAt: number };
const FRESH_MS = 60_000;

export async function readAccountResource<K extends AccountResource>(key: K, request: (path: string) => Promise<unknown>): Promise<DashboardAccountData[K]> {
  const response = await request(ACCOUNT_PATHS[key]);
  if (key === 'apiKeys') {
    const keys = (response as { apiKeys?: unknown } | null)?.apiKeys;
    if (!Array.isArray(keys)) throw new Error('The API returned an invalid API keys response.');
    // Only display metadata crosses the RSC boundary, never key material.
    return keys.map(({id, name, start, prefix, createdAt, lastRequest}) => ({id, name, start, prefix, createdAt, lastRequest})) as DashboardAccountData[K];
  }
  if (key === 'projects' || key === 'monitors' || key === 'notifications') {
    const data = (response as Record<string, unknown> | null)?.[key];
    if (!Array.isArray(data)) throw new Error(`The API returned an invalid ${key} response.`);
    return data as DashboardAccountData[K];
  }
  return response as DashboardAccountData[K];
}

// A provider owns this cache. Nothing private is shared between users or requests.
export function createDashboardCache(request: (path: string) => Promise<unknown>, seeds: AccountSeeds = {}) {
  const listeners = new Set<() => void>();
  const snapshots = new Map<AccountResource, ResourceSnapshot<unknown>>();
  const pending = new Map<AccountResource, Promise<void>>();
  const versions = new Map<AccountResource, number>();
  const initial = { data: undefined, error: '', loading: true, updatedAt: 0 };
  const emit = () => listeners.forEach(listener => listener());
  function read<K extends AccountResource>(key: K): ResourceSnapshot<DashboardAccountData[K]> {
    return (snapshots.get(key) ?? initial) as ResourceSnapshot<DashboardAccountData[K]>;
  }
  function load(key: AccountResource, force = false, serverSeed?: Promise<ResourceResult<DashboardAccountData[AccountResource]>>): Promise<void> {
    const running = pending.get(key);
    if (running && !force) return running;
    if (force) versions.set(key, (versions.get(key) ?? 0) + 1);
    const previous = read(key);
    if (!force && previous.updatedAt && Date.now() - previous.updatedAt < FRESH_MS) return Promise.resolve();
    const version = versions.get(key) ?? 0;
    snapshots.set(key, { ...previous, loading: true, error: '' });
    const seed = force ? undefined : serverSeed ?? seeds[key];
    delete seeds[key];
    let task!: Promise<void>;
    task = (async () => {
      try {
        let result: ResourceResult<DashboardAccountData[AccountResource]> = seed ? await seed : { data: await readAccountResource(key, request) };
        if (result.updatedAt && Date.now() - result.updatedAt >= FRESH_MS) result = { data: await readAccountResource(key, request) };
        if ('error' in result && result.error !== undefined) throw new Error(result.error);
        if ((versions.get(key) ?? 0) === version) snapshots.set(key, { data: result.data, error: '', loading: false, updatedAt: Date.now() });
      } catch (cause) {
        if ((versions.get(key) ?? 0) === version) snapshots.set(key, { ...previous, loading: false, error: cause instanceof Error ? cause.message : 'Could not load account data.' });
      } finally { if (pending.get(key) === task) pending.delete(key); emit(); }
    })();
    pending.set(key, task);
    emit();
    return task;
  }
  function set<K extends AccountResource>(key: K, value: DashboardAccountData[K] | ((current: DashboardAccountData[K] | undefined) => DashboardAccountData[K])) {
    versions.set(key, (versions.get(key) ?? 0) + 1);
    const data = typeof value === 'function' ? value(read(key).data) : value;
    snapshots.set(key, { data, error: '', loading: false, updatedAt: Date.now() });
    emit();
  }
  function initialize<K extends AccountResource>(key: K, result: ResourceResult<DashboardAccountData[K]>) {
    // A streamed page must never replace a mutation or an existing browser read.
    if (snapshots.has(key) || pending.has(key)) return;
    delete seeds[key];
    snapshots.set(key, { data: result.data, error: result.error ?? '', loading: false, updatedAt: result.updatedAt ?? Date.now() });
    emit();
  }
  // Hydration always starts from the same empty snapshot as the server render.
  function readServer<K extends AccountResource>(_key: K): ResourceSnapshot<DashboardAccountData[K]> { return initial; }
  return { read, readServer, load, set, initialize, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}
