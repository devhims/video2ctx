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
  const { user, signOut } = useDashboardSession();
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
    if (!user) return;
    void Promise.all([refresh(), refreshSidebar()]).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load API keys.'));
  }, [refresh, refreshSidebar, user]);

  const navigateToDashboard = (section: DashboardSection) => {
    router.push(`/dashboard?section=${section}`);
  };

  const createKey = async (event: FormEvent) => {
    event.preventDefault();
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

  if (!user) {
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
      accountName={user.name ?? user.email}
      credits={credits}
      onSignOut={() => void signOut()}
    />
    <div className='workspace-main'>
      <header className='topbar'>
        <div><span className='topbar-context'>Research workspace</span><h1>API keys</h1></div>
        <div className='topbar-actions'>{credits !== undefined && <span className='credit-balance'>{credits} credits</span>}<Link className='signin-button' href='/dashboard'><span>Dashboard</span><b aria-hidden='true'>←</b></Link></div>
      </header>

      <section className='developer-page developer-page-embedded'>
        <header className='developer-header'>
          <div><p className='panel-label'>Developer access</p><h1>Personal API keys</h1><p>Use permanent keys for your own scripts and integrations. They act as you for product data and workspace operations, and metered requests spend credits from {user.email}.</p></div>
          <a href='/api/platform/docs' target='_blank' rel='noreferrer'>Open API reference ↗</a>
        </header>

        <section className='developer-warning' role='note'>
          <strong>Permanent until revoked</strong>
          <p>Store keys in a secret manager, never in browser code or source control. The full value is shown only once. Keys cannot manage billing, connections, other keys, or your account.</p>
        </section>

        <section className='developer-card'>
          <h2>Use a key</h2>
          <p>Send it as a Bearer token. The older <code>X-API-Key</code> header remains supported for existing integrations.</p>
          <code>Authorization: Bearer aty_…</code>
        </section>

        <section className='developer-card'>
          <h2>Create a key</h2>
          <form onSubmit={createKey} className='developer-key-form'>
            <label htmlFor='api-key-name'>Key name</label>
            <div><input id='api-key-name' maxLength={32} required value={name} onChange={(event) => setName(event.target.value)} placeholder='Production integration' /><button disabled={loading || !name.trim()}>Create key</button></div>
          </form>
          {createdSecret && <div className='developer-secret' role='status'>
            <strong>Copy this key now</strong>
            <code>{createdSecret}</code>
            <button onClick={() => void copySecret()}>Copy key</button>
          </div>}
          {error && <p className='alert error' role='alert'>{error}</p>}
        </section>

        <section className='developer-card'>
          <h2>Active keys</h2>
          <div className='developer-key-list'>
            {keys.map((key) => <article key={key.id}>
              <div><strong>{key.name ?? 'Unnamed key'}</strong><code>{key.start ?? key.prefix ?? 'aty_…'}</code></div>
              <dl><div><dt>Created</dt><dd>{formatDate(key.createdAt)}</dd></div><div><dt>Last used</dt><dd>{key.lastRequest ? formatDate(key.lastRequest) : 'Never'}</dd></div><div><dt>Expiry</dt><dd>Never</dd></div></dl>
              <button disabled={loading} onClick={() => void revoke(key)}>Revoke</button>
            </article>)}
            {!keys.length && <p className='developer-empty'>No API keys yet.</p>}
          </div>
        </section>
      </section>
    </div>
  </main>;
}

function formatDate(value: Date | string): string {
  return new Date(value).toLocaleString();
}
