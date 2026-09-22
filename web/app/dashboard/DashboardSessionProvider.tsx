'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { platformRequest, PlatformApiError } from '../../lib/platform-request';
import { authClient } from '../../lib/auth-client';
import type { DashboardUser } from '../../lib/server-session';

type DashboardSessionContextValue = {
  user: DashboardUser | null;
  demoEnabled: boolean;
  agentAccess: boolean;
  adminAccess: boolean;
  accessReady: boolean;
  isSigningOut: boolean;
  signOut(): Promise<void>;
};

const DashboardSessionContext = createContext<DashboardSessionContextValue | null>(null);

export function DashboardSessionProvider({
  children,
  initialUser,
  accessSeed,
  demoEnabled,
}: {
  children: React.ReactNode;
  initialUser: DashboardUser | null;
  accessSeed: Promise<{agentAccess?: boolean; adminAccess?: boolean; error: string}>;
  demoEnabled: boolean;
}) {
  const [agentAccess, setAgentAccess] = useState(false);
  const [adminAccess, setAdminAccess] = useState(false);
  const [user, setUser] = useState(initialUser);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState('');
  const [accessError, setAccessError] = useState('');
  const [serverAccessFailed, setServerAccessFailed] = useState(false);
  const [accessReady, setAccessReady] = useState(false);

  useEffect(() => setUser(initialUser), [initialUser]);


  useEffect(() => {
    if (!user) { setAgentAccess(false); setAdminAccess(false); setAccessError(''); setAccessReady(true); return; }
    const controller = new AbortController();
    let generation = 0;
    const checkAccess = async (path: string) => {
      try {
        const result = await platformRequest<{ enabled: unknown }>(path, { cache: 'no-store', signal: controller.signal });
        if (typeof result.enabled !== 'boolean') throw new Error('The API returned an invalid access response.');
        return result.enabled;
      } catch (cause) {
        if (cause instanceof PlatformApiError && [401, 403].includes(cause.status)) return false;
        throw cause;
      }
    };

    const check = async () => {
      const current = ++generation;
      const [agent, admin] = await Promise.allSettled([
        checkAccess('/v1/agent/access'), checkAccess('/v1/admin/access'),
      ]);
      if (!controller.signal.aborted && current === generation) {
        setAccessReady(true);
        if (agent.status === 'fulfilled') setAgentAccess(agent.value);
        if (admin.status === 'fulfilled') setAdminAccess(admin.value);
        const failure = [agent, admin].find(result => result.status === 'rejected');
        setAccessError(failure?.status === 'rejected' ? (failure.reason instanceof Error ? failure.reason.message : 'Access could not be checked.') : '');
      }
    };
    // Server reads start alongside the page, without holding up the shell.
    // A focus refresh wins over an older seed if they overlap.
    void accessSeed.then(result => {
      if (controller.signal.aborted || generation) return;
      if (result.agentAccess !== undefined) setAgentAccess(result.agentAccess);
      if (result.adminAccess !== undefined) setAdminAccess(result.adminAccess);
      setAccessError(result.error);
      setServerAccessFailed(Boolean(result.error));
      setAccessReady(true);
    });
    window.addEventListener('focus', check);
    window.addEventListener('agent-access-changed', check);
    return () => { controller.abort(); window.removeEventListener('focus', check); window.removeEventListener('agent-access-changed', check); };
  }, [user?.id, accessSeed]);

  const signOut = useCallback(async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    setSignOutError('');
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message ?? 'Could not sign out. Please try again.');
      // Keep the current screen intact until the new document loads. This also
      // discards cached authenticated routes instead of flashing a signed-out UI.
      window.location.replace('/');
    } catch (cause) {
      setSignOutError(cause instanceof Error ? cause.message : 'Could not sign out. Please try again.');
      setIsSigningOut(false);
    }
  }, [isSigningOut]);

  const value = useMemo(() => ({ user, demoEnabled, isSigningOut, accessReady, agentAccess: !!user && agentAccess, adminAccess: !!user && adminAccess, signOut }), [demoEnabled, agentAccess, adminAccess, accessReady, isSigningOut, signOut, user]);
  return <DashboardSessionContext.Provider value={value}>{children}{accessError && <div className='dashboard-signout-error' role='alert'>{accessError} <button onClick={() => serverAccessFailed ? window.location.reload() : window.dispatchEvent(new Event('agent-access-changed'))}>Retry</button></div>}{signOutError && <div className='dashboard-signout-error' role='alert'>{signOutError}</div>}</DashboardSessionContext.Provider>;
}

export function useDashboardSession(): DashboardSessionContextValue {
  const value = useContext(DashboardSessionContext);
  if (!value) throw new Error('useDashboardSession must be used inside DashboardSessionProvider');
  return value;
}
