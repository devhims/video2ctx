'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { authClient } from '../../../lib/auth-client';
import { loadDashboardAccountData, publishCreditBalance, type DashboardProject } from '../../../lib/dashboard-data';
import { DashboardSidebar, type DashboardSection } from '../DashboardSidebar';
import { useDashboardSession } from '../DashboardSessionProvider';

type ManagedApiKey = {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  createdAt: Date;
  lastRequest: Date | null;
};

export default function DeveloperSettingsClient() {
  const router = useRouter();
  const { user, demoEnabled, signOut } = useDashboardSession();
  const localPreview = !user && demoEnabled;
  const displayUser = user ?? (demoEnabled ? {
    id: 'local-preview',
    name: 'Local preview',
    email: 'local@video2ctx.dev',
  } : null);
  const [keys, setKeys] = useState<ManagedApiKey[]>([]);
  const [projects, setProjects] = useState<DashboardProject[]>([]);
  const [credits, setCredits] = useState<number>();
  const [name, setName] = useState('');
  const [createdSecret, setCreatedSecret] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const result = await authClient.apiKey.list();
    if (result.error) throw new Error(result.error.message ?? 'Could not load API keys.');
    setKeys(result.data?.apiKeys ?? []);
  }, []);

  const refreshSidebar = useCallback(async () => {
    const data = await loadDashboardAccountData(async (path) => {
      const headers = new Headers();
      if (['localhost', '127.0.0.1'].includes(window.location.hostname)) headers.set('x-demo-user', 'local-beta');
      const response = await fetch(`/api/platform${path}`, { credentials: 'include', headers });
      publishCreditBalance(response.headers);
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      return response.json();
    });
    setProjects(data.projects);
    setCredits(data.usage?.creditBalance);
  }, []);

  useEffect(() => {
    if (user) {
      void Promise.all([refresh(), refreshSidebar()]).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load API keys.'));
      return;
    }
    if (demoEnabled) void refreshSidebar().catch(() => undefined);
  }, [demoEnabled, refresh, refreshSidebar, user]);

  const navigateToDashboard = (section: DashboardSection) => {
    router.push(`/dashboard?section=${section}`);
  };

  const createKey = async (event: FormEvent) => {
    event.preventDefault();
    if (localPreview) return;
    const keyName = name.trim();
    if (!keyName) return;
    setLoading(true); setError(''); setCreatedSecret('');
    try {
      const result = await authClient.apiKey.create({ name: keyName });
      if (result.error) throw new Error(result.error.message ?? 'Could not create the API key.');
      setCreatedSecret(result.data?.key ?? '');
      setName('');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the API key.');
    } finally {
      setLoading(false);
    }
  };

  const revoke = async (key: ManagedApiKey) => {
    if (localPreview) return;
    if (!window.confirm(`Revoke “${key.name ?? key.start ?? 'API key'}”? Requests using it will stop immediately.`)) return;
    setLoading(true); setError('');
    try {
      const result = await authClient.apiKey.delete({ keyId: key.id });
      if (result.error) throw new Error(result.error.message ?? 'Could not revoke the API key.');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not revoke the API key.');
    } finally {
      setLoading(false);
    }
  };

  const copySecret = async () => {
    await navigator.clipboard.writeText(createdSecret);
  };

  if (!displayUser) {
    return <main className='developer-page developer-gate'>
      <Link href='/dashboard'>← Dashboard</Link>
      <p className='panel-label'>Developer access</p>
      <h1>Sign in to manage API keys</h1>
      <p>API keys inherit your plan and credit balance, so they can only be created from an authenticated browser session.</p>
      <Link className='button primary' href='/dashboard'>Sign in from the dashboard</Link>
    </main>;
  }

  return <main className='workspace-shell'>
    <DashboardSidebar
      activeSection='developer'
      projects={projects}
      onNavigate={navigateToDashboard}
      onNewProject={() => navigateToDashboard('projects')}
      onOpenProject={() => navigateToDashboard('projects')}
      onSignIn={() => router.push('/dashboard')}
      accountName={displayUser.name ?? displayUser.email}
      credits={credits}
      onSignOut={() => void signOut()}
    />
    <div className='workspace-main'>
      <header className='topbar'>
        <div><span className='topbar-context'>Research workspace</span><h1>API keys</h1></div>
        <div className='topbar-actions'>{localPreview && <span className='developer-preview-badge'>Local preview</span>}{credits !== undefined && <span className='credit-balance'>{credits} credits</span>}</div>
      </header>

      <section className='developer-page developer-page-embedded' aria-labelledby='developer-title'>
        <header className='developer-header'>
          <div>
            <p className='panel-label'>Developer access</p>
            <h1 id='developer-title'>Connect your own tools.</h1>
            <p>Create permanent API keys for scripts and integrations. Requests use the plan and credit balance attached to {displayUser.email}.</p>
          </div>
          <a href='/api/platform/docs' target='_blank' rel='noreferrer'>API reference <span aria-hidden='true'>↗</span></a>
        </header>

        <section className='developer-workbench' aria-labelledby='create-key-title'>
          <div className='developer-create'>
            <p className='developer-section-label'>Create a key</p>
            <h2 id='create-key-title'>Name this integration</h2>
            <p>A descriptive name makes it easier to identify and revoke the right credential later.</p>
            <form onSubmit={createKey} className='developer-key-form' aria-describedby={localPreview ? 'developer-preview-note' : undefined}>
              <label htmlFor='api-key-name'>Key name</label>
              <div><input id='api-key-name' maxLength={32} required value={name} onChange={(event) => setName(event.target.value)} placeholder='Production integration' /><button disabled={localPreview || loading || !name.trim()} title={localPreview ? 'Sign in to create a real API key' : undefined}>{loading ? 'Creating…' : 'Create key'}</button></div>
            </form>
            {localPreview && <p className='developer-preview-note' id='developer-preview-note'>Preview mode shows the complete layout without creating credentials. Sign in to manage real keys.</p>}
            {createdSecret && <div className='developer-secret' role='status'>
              <strong>Copy this key now</strong>
              <p>The full value will not be shown again.</p>
              <code>{createdSecret}</code>
              <button onClick={() => void copySecret()}>Copy key</button>
            </div>}
            {error && <p className='alert error' role='alert'>{error}</p>}
          </div>

          <aside className='developer-guide' aria-labelledby='use-key-title'>
            <p className='developer-section-label'>Authentication</p>
            <h2 id='use-key-title'>Use it as a Bearer token</h2>
            <p>Send the key in the authorization header. <code>X-API-Key</code> remains supported for existing integrations.</p>
            <code className='developer-code-sample'>Authorization: Bearer aty_…</code>
            <div className='developer-warning' role='note'>
              <strong>Permanent until revoked</strong>
              <p>Store keys in a secret manager, never in browser code or source control. Keys cannot manage billing, connections, other keys, or your account.</p>
            </div>
          </aside>
        </section>

        <section className='developer-keys' aria-labelledby='active-keys-title'>
          <header>
            <div><p className='panel-label'>Credentials</p><h2 id='active-keys-title'>Active keys</h2></div>
            <span>{keys.length} {keys.length === 1 ? 'key' : 'keys'}</span>
          </header>
          <div className='developer-key-list'>
            {keys.map((key) => <article key={key.id}>
              <div><strong>{key.name ?? 'Unnamed key'}</strong><code>{key.start ?? key.prefix ?? 'aty_…'}</code></div>
              <dl><div><dt>Created</dt><dd>{formatDate(key.createdAt)}</dd></div><div><dt>Last used</dt><dd>{key.lastRequest ? formatDate(key.lastRequest) : 'Never'}</dd></div><div><dt>Expiry</dt><dd>Never</dd></div></dl>
              <button disabled={loading} onClick={() => void revoke(key)}>Revoke</button>
            </article>)}
            {!keys.length && <div className='developer-empty'><strong>{localPreview ? 'No keys shown in preview' : 'No API keys yet'}</strong><p>{localPreview ? 'A signed-in session will show its active credentials here.' : 'Create your first key above when you are ready to connect an integration.'}</p></div>}
          </div>
        </section>
      </section>
    </div>
  </main>;
}

function formatDate(value: Date | string): string {
  return new Date(value).toLocaleString();
}
