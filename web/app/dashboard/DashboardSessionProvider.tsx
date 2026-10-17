'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { platformRequest, PlatformApiError } from '../../lib/platform-request';
import { authClient } from '../../lib/auth-client';
import type { DashboardUser } from '../../lib/server-session';
import { useErrorToast, useLoadErrorToast } from '../../lib/use-error-toast';

type DashboardSessionValue = {
  user: DashboardUser | null;
  agentAccess: boolean;
  adminAccess: boolean;
  accessReady: boolean;
  isSigningOut: boolean;
  signOut(): Promise<void>;
};

type Access = { agentAccess: boolean; adminAccess: boolean; accessReady: boolean };
const accessBeforeCheck: Access = { agentAccess: false, adminAccess: false, accessReady: false };

// Access arrives just after hydration starts. Changing context then would make React discard
// the server HTML of every boundary still hydrating below it and render the dashboard again,
// so access lives in a store each reader subscribes to once it has hydrated.
function createAccessStore() {
  let access = accessBeforeCheck;
  const listeners = new Set<() => void>();
  return {
    read: () => access,
    update(next: Partial<Access>) { access = { ...access, ...next }; listeners.forEach(listener => listener()); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

type DashboardSessionContextValue = Omit<DashboardSessionValue, keyof Access> & { access: ReturnType<typeof createAccessStore> };
const DashboardSessionContext = createContext<DashboardSessionContextValue | null>(null);

export function DashboardSessionProvider({
  children,
  initialUser,
  accessSeed,
}: {
  children: React.ReactNode;
  initialUser: DashboardUser | null;
  accessSeed: Promise<{agentAccess?: boolean; adminAccess?: boolean; error: string}>;
}) {
  const [access] = useState(createAccessStore);
  const [user, setUser] = useState(initialUser);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState('');
  const [accessError, setAccessError] = useState('');
  const [serverAccessFailed, setServerAccessFailed] = useState(false);

  useEffect(() => setUser(initialUser), [initialUser]);


  useEffect(() => {
    if (!user) { access.update({ agentAccess: false, adminAccess: false, accessReady: true }); setAccessError(''); return; }
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
        access.update({
          accessReady: true,
          ...(agent.status === 'fulfilled' ? { agentAccess: agent.value } : {}),
          ...(admin.status === 'fulfilled' ? { adminAccess: admin.value } : {}),
        });
        const failure = [agent, admin].find(result => result.status === 'rejected');
        setAccessError(failure?.status === 'rejected' ? (failure.reason instanceof Error ? failure.reason.message : 'Access could not be checked.') : '');
      }
    };
    // Server reads start alongside the page, without holding up the shell.
    // A focus refresh wins over an older seed if they overlap.
    void accessSeed.then(result => {
      if (controller.signal.aborted || generation) return;
      access.update({
        accessReady: true,
        ...(result.agentAccess !== undefined ? { agentAccess: result.agentAccess } : {}),
        ...(result.adminAccess !== undefined ? { adminAccess: result.adminAccess } : {}),
      });
      setAccessError(result.error);
      setServerAccessFailed(Boolean(result.error));
    });
    window.addEventListener('focus', check);
    window.addEventListener('agent-access-changed', check);
    return () => { controller.abort(); window.removeEventListener('focus', check); window.removeEventListener('agent-access-changed', check); };
  }, [user?.id, accessSeed, access]);

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

  useLoadErrorToast(accessError, 'Retry', () => serverAccessFailed ? window.location.reload() : window.dispatchEvent(new Event('agent-access-changed')));
  const { show: showSignOutError, clear: clearSignOutError } = useErrorToast();
  useEffect(() => { if (signOutError) showSignOutError(signOutError); else clearSignOutError(); }, [signOutError, showSignOutError, clearSignOutError]);
  const value = useMemo(() => ({ user, isSigningOut, access, signOut }), [access, isSigningOut, signOut, user]);
  return <DashboardSessionContext.Provider value={value}>{children}</DashboardSessionContext.Provider>;
}

export function useDashboardSession(): DashboardSessionValue {
  const value = useContext(DashboardSessionContext);
  if (!value) throw new Error('useDashboardSession must be used inside DashboardSessionProvider');
  const { access: store, ...session } = value;
  // Hydrate with the pre-check snapshot the server rendered, then update once hydrated.
  const access = useSyncExternalStore(store.subscribe, store.read, () => accessBeforeCheck);
  return { ...session, accessReady: access.accessReady, agentAccess: !!session.user && access.agentAccess, adminAccess: !!session.user && access.adminAccess };
}
