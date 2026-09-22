'use client';

import { createContext, useCallback, useContext, useEffect, useState, useRef, useSyncExternalStore, type ReactNode, type SetStateAction } from 'react';
import { createDashboardCache, type AccountResource, type AccountSeeds } from '../../lib/dashboard-cache';
import { platformRequest } from '../../lib/platform-request';
import { CREDIT_BALANCE_EVENT, type DashboardAccountData } from '../../lib/dashboard-data';

const Context = createContext<ReturnType<typeof createDashboardCache> | null>(null);
export function DashboardDataProvider({ children, seeds }: { children: ReactNode; seeds?: AccountSeeds }) {
  const [cache] = useState(() => createDashboardCache(platformRequest, { ...seeds }));
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
  return <Context.Provider value={cache}>{children}</Context.Provider>;
}

export function useAccountResource<K extends AccountResource>(key: K, fallback: DashboardAccountData[K]) {
  const cache = useContext(Context);
  if (!cache) throw new Error('DashboardDataProvider is missing');
  const fallbackRef = useRef(fallback);
  const snapshot = useSyncExternalStore(cache.subscribe, () => cache.read(key), () => cache.readServer(key));
  useEffect(() => {
    void cache.load(key);
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
