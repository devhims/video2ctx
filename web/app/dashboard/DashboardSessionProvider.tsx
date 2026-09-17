'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { authClient } from '../../lib/auth-client';
import type { DashboardUser } from '../../lib/server-session';

type DashboardSessionContextValue = {
  user: DashboardUser | null;
  demoEnabled: boolean;
  agentAccess: boolean;
  adminAccess: boolean;
  signOut(): Promise<void>;
};

const DashboardSessionContext = createContext<DashboardSessionContextValue | null>(null);

export function DashboardSessionProvider({
  children,
  initialUser,
  initialAgentAccess = false,
  initialAdminAccess = false,
  demoEnabled,
}: {
  children: React.ReactNode;
  initialUser: DashboardUser | null;
  initialAgentAccess?: boolean;
  initialAdminAccess?: boolean;
  demoEnabled: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [agentAccess, setAgentAccess] = useState(initialAgentAccess);
  const [adminAccess, setAdminAccess] = useState(initialAdminAccess);
  const [user, setUser] = useState(initialUser);

  useEffect(() => setUser(initialUser), [initialUser]);
  useEffect(() => setAgentAccess(initialAgentAccess), [initialAgentAccess]);
  useEffect(() => setAdminAccess(initialAdminAccess), [initialAdminAccess]);

  useEffect(() => {
    if (!user) { setAgentAccess(false); setAdminAccess(false); return; }
    const controller = new AbortController();
    let generation = 0;
    const checkAccess = async (path: string) => {
      try {
        const response = await fetch(path, { credentials: 'include', cache: 'no-store', signal: controller.signal });
        return response.ok && (await response.json()).enabled === true;
      } catch { return false; }
    };
    const check = async () => {
      const current = ++generation;
      const [agent, admin] = await Promise.all([
        checkAccess('/api/platform/v1/agent/access'), checkAccess('/api/platform/v1/admin/access'),
      ]);
      if (!controller.signal.aborted && current === generation) { setAgentAccess(agent); setAdminAccess(admin); }
    };
    void check();
    window.addEventListener('focus', check);
    window.addEventListener('agent-access-changed', check);
    return () => { controller.abort(); window.removeEventListener('focus', check); window.removeEventListener('agent-access-changed', check); };
  }, [user?.id, pathname]);

  const signOut = useCallback(async () => {
    await authClient.signOut();
    setUser(null);
    setAgentAccess(false);
    setAdminAccess(false);
    router.replace('/');
    router.refresh();
  }, [router]);

  const value = useMemo(() => ({ user, demoEnabled, agentAccess: !!user && agentAccess, adminAccess: !!user && adminAccess, signOut }), [demoEnabled, agentAccess, adminAccess, signOut, user]);
  return <DashboardSessionContext.Provider value={value}>{children}</DashboardSessionContext.Provider>;
}

export function useDashboardSession(): DashboardSessionContextValue {
  const value = useContext(DashboardSessionContext);
  if (!value) throw new Error('useDashboardSession must be used inside DashboardSessionProvider');
  return value;
}
