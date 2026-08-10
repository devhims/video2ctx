'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { authClient } from '../../lib/auth-client';
import type { DashboardUser } from '../../lib/server-session';

type DashboardSessionContextValue = {
  user: DashboardUser | null;
  demoEnabled: boolean;
  signOut(): Promise<void>;
};

const DashboardSessionContext = createContext<DashboardSessionContextValue | null>(null);

export function DashboardSessionProvider({
  children,
  initialUser,
  demoEnabled,
}: {
  children: React.ReactNode;
  initialUser: DashboardUser | null;
  demoEnabled: boolean;
}) {
  const router = useRouter();
  const [user, setUser] = useState(initialUser);

  useEffect(() => setUser(initialUser), [initialUser]);

  const signOut = useCallback(async () => {
    await authClient.signOut();
    setUser(null);
    router.replace('/');
    router.refresh();
  }, [router]);

  const value = useMemo(() => ({ user, demoEnabled, signOut }), [demoEnabled, signOut, user]);
  return <DashboardSessionContext.Provider value={value}>{children}</DashboardSessionContext.Provider>;
}

export function useDashboardSession(): DashboardSessionContextValue {
  const value = useContext(DashboardSessionContext);
  if (!value) throw new Error('useDashboardSession must be used inside DashboardSessionProvider');
  return value;
}
