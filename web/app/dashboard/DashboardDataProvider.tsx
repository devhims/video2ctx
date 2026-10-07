'use client';

import { createContext, use, useCallback, useContext, useEffect, useState, useRef, useSyncExternalStore, type ReactNode, type SetStateAction } from 'react';
import { createDashboardCache, type AccountResource, type AccountSeeds, type ResourceResult, type ResourceSnapshot } from '../../lib/dashboard-cache';
import { platformRequest } from '../../lib/platform-request';
import { CREDIT_BALANCE_EVENT, type DashboardAccountData } from '../../lib/dashboard-data';
import { createCreditRefresher, type CreditRefresher } from '../../lib/credit-refresh';

const Context = createContext<ReturnType<typeof createDashboardCache> | null>(null);
const DraftContext = createContext<Map<string, unknown> | null>(null);
const CreditContext = createContext<CreditRefresher | null>(null);
export function DashboardDataProvider({ children, seeds }: { children: ReactNode; seeds?: AccountSeeds }) {
  const [cache] = useState(() => createDashboardCache(platformRequest, { ...seeds }));
  const [drafts] = useState(() => new Map<string, unknown>());
  const [credits] = useState(() => createCreditRefresher(cache));
  useEffect(() => {
    // Another tab or view may have spent credits. Returning to this tab re-reads
    // the current balance once; it does not poll or wait for later settlement.
    const visible = () => { if (document.visibilityState === 'visible') void credits.refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [credits]);
  useEffect(() => {
    const balanceChanged = (event: Event) => {
      const balance = (event as CustomEvent<number>).detail;
      for (const key of ['usage', 'billing'] as const) {
        const data = cache.read(key).data;
        if (data) cache.set(key, { ...data, creditBalance: balance });
      }
    };
    window.addEventListener(CREDIT_BALANCE_EVENT, balanceChanged);
    return () => window.removeEventListener(CREDIT_BALANCE_EVENT, balanceChanged);
  }, [cache]);
  return <Context.Provider value={cache}><DraftContext.Provider value={drafts}><CreditContext.Provider value={credits}>{children}</CreditContext.Provider></DraftContext.Provider></Context.Provider>;
}

export function useCreditRefresh() {
  const credits = useContext(CreditContext);
  if (!credits) throw new Error('DashboardDataProvider is missing');
  return credits;
}

// Research survives route navigation, but never persists beyond this user's
// provider or a full document reload. ResearchHost retains active operations.
export function useDashboardDraft<T>(key: string, initial: T) {
  const drafts = useContext(DraftContext);
  if (!drafts) throw new Error('DashboardDataProvider is missing');
  const [value, setValue] = useState<T>(() => drafts.has(key) ? drafts.get(key) as T : initial);
  useEffect(() => { drafts.set(key, value); }, [drafts, key, value]);
  return [value, setValue] as const;
}

export function useAccountResource<K extends AccountResource>(key: K, fallback: DashboardAccountData[K], initialResult?: ResourceResult<DashboardAccountData[K]>, serverSeed?: Promise<ResourceResult<DashboardAccountData[K]>>) {
  const cache = useContext(Context);
  if (!cache) throw new Error('DashboardDataProvider is missing');
  const fallbackRef = useRef(fallback);
  const initial = useRef<ResourceSnapshot<DashboardAccountData[K]>>(initialResult
    ? { data: initialResult.data, error: initialResult.error ?? '', loading: false, updatedAt: initialResult.updatedAt ?? 0 }
    : cache.readServer(key));
  const snapshot = useSyncExternalStore(cache.subscribe,
    () => { const current = cache.read(key); return current.updatedAt || current.error ? current : initial.current; },
    () => initial.current);
  useEffect(() => {
    if (initialResult) cache.initialize(key, initialResult);
    void cache.load(key, false, serverSeed);
    const refresh = () => { if (document.visibilityState === 'visible') void cache.load(key); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [cache, key]);
  const setData = useCallback((value: SetStateAction<DashboardAccountData[K]>) => {
    cache.set(key, current => typeof value === 'function' ? (value as (value: DashboardAccountData[K]) => DashboardAccountData[K])(current ?? fallbackRef.current) : value);
  }, [cache, key]);
  const refresh = useCallback(() => cache.load(key, true), [cache, key]);
  return { ...snapshot, data: snapshot.data ?? fallback, ready: snapshot.data !== undefined, setData, refresh };
}

export function useStreamedAccountResource<K extends AccountResource>(key: K, fallback: DashboardAccountData[K], promise: Promise<ResourceResult<DashboardAccountData[K]>>) {
  const cache = useContext(Context);
  if (!cache) throw new Error('DashboardDataProvider is missing');
  const cached = useSyncExternalStore(cache.subscribe, () => cache.read(key), () => cache.readServer(key));
  // React use may be conditional. Warm navigation keeps existing data visible;
  // cold rendering suspends only this card until its server result arrives.
  const initial = cached.data !== undefined || cached.error ? undefined : use(promise);
  return useAccountResource(key, fallback, initial, promise);
}

export function useDashboardCache() {
  const cache = useContext(Context);
  if (!cache) throw new Error('DashboardDataProvider is missing');
  return cache;
}

// The sidebar and project page consume the same in-flight read and saved data.
export function useProjectDetail(id: string | null) {
  const cache = useDashboardCache().projectDetails;
  const snapshot = useSyncExternalStore(cache.subscribe, () => cache.read(id), () => cache.read(null));
  useEffect(() => {
    if (!id) return;
    void cache.load(id);
    const refresh = () => { if (document.visibilityState === 'visible') void cache.load(id); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [cache, id]);
  return { ...snapshot, refresh: () => id ? cache.load(id, true) : Promise.resolve() };
}
