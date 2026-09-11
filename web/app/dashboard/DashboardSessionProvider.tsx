'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { authClient } from '../../lib/auth-client';
import type { DashboardUser } from '../../lib/server-session';

type DashboardSessionContextValue = {
  user: DashboardUser | null;
  demoEnabled: boolean;
  agentAccess: boolean;
  signOut(): Promise<void>;
};

const DashboardSessionContext = createContext<DashboardSessionContextValue | null>(null);

export function DashboardSessionProvider({
  children,
  initialUser,
  initialAgentAccess = false,
  demoEnabled,
}: {
  children: React.ReactNode;
  initialUser: DashboardUser | null;
  initialAgentAccess?: boolean;
  demoEnabled: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [agentAccess, setAgentAccess] = useState(initialAgentAccess);
  const [user, setUser] = useState(initialUser);

  useEffect(() => setUser(initialUser), [initialUser]);
  useEffect(() => setAgentAccess(initialAgentAccess), [initialAgentAccess]);

  useEffect(() => {
    if (!user) { setAgentAccess(false); return; }
    const controller = new AbortController();
    const check = async () => {
      try {
        const response = await fetch('/api/platform/v1/agent/access', { credentials: 'include', cache: 'no-store', signal: controller.signal });
        const allowed = response.ok && (await response.json()).enabled === true;
        if (!controller.signal.aborted) setAgentAccess(allowed);
      } catch { if (!controller.signal.aborted) setAgentAccess(false); }
    };
    void check();
    window.addEventListener('focus', check);
    return () => { controller.abort(); window.removeEventListener('focus', check); };
  }, [user?.id, pathname]);

  const signOut = useCallback(async () => {
    await authClient.signOut();
    setUser(null);
    setAgentAccess(false);
    router.replace('/');
    router.refresh();
  }, [router]);

  const value = useMemo(() => ({ user, demoEnabled, agentAccess: !!user && agentAccess, signOut }), [demoEnabled, agentAccess, signOut, user]);
  return <DashboardSessionContext.Provider value={value}>{children}</DashboardSessionContext.Provider>;
}

export function useDashboardSession(): DashboardSessionContextValue {
  const value = useContext(DashboardSessionContext);
  if (!value) throw new Error('useDashboardSession must be used inside DashboardSessionProvider');
  return value;
}
