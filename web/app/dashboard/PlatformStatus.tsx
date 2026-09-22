'use client';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { platformRequest, isAbortError } from '../../lib/platform-request';

export function PlatformStatus({ path }: { path: string }) {
  const pathname = usePathname();
  const [state, setState] = useState<'checking' | 'healthy' | 'unavailable'>('checking');
  useEffect(() => {
    if (pathname !== path) return;
    const controller = new AbortController();
    let checking = false;
    const check = async () => {
      if (checking || document.visibilityState !== 'visible') return;
      checking = true;
      try {
        const result = await platformRequest<{ status?: string }>('/health', { cache: 'no-store', signal: controller.signal });
        if (!controller.signal.aborted) setState(result.status === 'ok' ? 'healthy' : 'unavailable');
      } catch (cause) {
        if (!isAbortError(cause)) setState('unavailable');
      } finally { checking = false; }
    };
    void check();
    const interval = window.setInterval(() => void check(), 5 * 60_000);
    document.addEventListener('visibilitychange', check);
    return () => { controller.abort(); window.clearInterval(interval); document.removeEventListener('visibilitychange', check); };
  }, [pathname, path]);
  return <span className={`sync-state ${state}`} role='status' aria-live='polite'><i />{state === 'healthy' ? 'Platform online' : state === 'checking' ? 'Checking platform' : 'Platform unavailable'}</span>;
}
