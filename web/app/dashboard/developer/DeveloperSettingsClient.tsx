'use client';

import { platformRequest } from '../../../lib/platform-request';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { redirect, useRouter } from 'next/navigation';
import { KeyIcon, PlusIcon } from '@phosphor-icons/react';
import { authClient } from '../../../lib/auth-client';
import { loadDashboardAccountData, type DashboardProject } from '../../../lib/dashboard-data';
import { DashboardHeader } from '../DashboardHeader';
import pageStyles from '../DashboardPages.module.css';
import styles from './DeveloperSettings.module.css';
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
    const data = await loadDashboardAccountData(platformRequest);
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

  if (!displayUser) redirect('/login?returnTo=%2Fdashboard%2Fdeveloper');

  return <main className='workspace-shell'>
    <DashboardSidebar
      activeSection='developer'
      projects={projects}
      onNavigate={navigateToDashboard}
      onNewProject={() => navigateToDashboard('projects')}
      onOpenProject={() => navigateToDashboard('projects')}
      onSignIn={() => router.push('/login?returnTo=%2Fdashboard%2Fdeveloper')}
      accountName={displayUser.name ?? displayUser.email}
      credits={credits}
      onSignOut={() => void signOut()}
    />
    <div className={`workspace-main ${pageStyles.pages}`}>
      <DashboardHeader title='API keys'>
        {localPreview && <span className='developer-preview-badge'>Local preview</span>}
        <a className={pageStyles.headerLink} href='/api/platform/docs' target='_blank' rel='noreferrer'>API reference ↗</a>
      </DashboardHeader>

      <section className={styles.page} aria-label='Manage API keys'>
        <section aria-labelledby='create-key-title'>
          <header className={styles.intro}>
            <h2 id='create-key-title'>Create an API key</h2>
            <p>Connect your scripts and integrations to video2ctx.</p>
          </header>
          <form onSubmit={createKey} className={styles.form} aria-describedby={localPreview ? 'developer-preview-note' : 'key-access-note'}>
            <label htmlFor='api-key-name'>Key name</label>
            <div className={styles.inputRow}>
              <input id='api-key-name' maxLength={32} required value={name} onChange={(event) => setName(event.target.value)} placeholder='e.g. Production integration' />
              <button disabled={localPreview || loading || !name.trim()} title={localPreview ? 'Sign in to create a real API key' : undefined}><PlusIcon size={16} aria-hidden='true' />{loading ? 'Creating…' : 'Create key'}</button>
            </div>
            <p id='key-access-note' className={styles.formNote}><KeyIcon size={14} aria-hidden='true' /><span>Uses your account credits. Active until revoked.</span></p>
          </form>
          <p className={styles.hint} id={localPreview ? 'developer-preview-note' : undefined}>{localPreview ? 'Sign in to create and manage API keys.' : 'Keep keys server-side. Never include them in browser code or source control.'}</p>
          {createdSecret && <div className={styles.secret} role='status'>
            <strong>Copy this key now</strong>
            <p>The full value will not be shown again.</p>
            <div><code>{createdSecret}</code><button onClick={() => void copySecret()}>Copy key</button></div>
          </div>}
          {error && <p className='alert error' role='alert'>{error}</p>}
        </section>

        <section className={styles.keys} aria-labelledby='active-keys-title'>
          <header className={styles.listHeading}>
            <h2 id='active-keys-title'>Active keys <span>{keys.length}</span></h2>
            <span>Only key prefixes are shown</span>
          </header>
          <div className={styles.keyList}>
            {keys.map((key) => <article key={key.id} className={styles.keyRow}>
              <span className={styles.keyIcon}><KeyIcon size={19} aria-hidden='true' /></span>
              <div className={styles.keyIdentity}>
                <strong>{key.name ?? 'Unnamed key'}</strong>
                <code>{key.start ?? key.prefix ?? 'aty_…'}</code>
                <dl><div><dt>Created</dt><dd>{formatDate(key.createdAt)}</dd></div><div><dt>Last used</dt><dd>{key.lastRequest ? formatDate(key.lastRequest) : 'Never'}</dd></div></dl>
              </div>
              <button className={styles.revoke} disabled={loading} onClick={() => void revoke(key)} aria-label={`Revoke ${key.name ?? 'unnamed key'}`}>Revoke</button>
            </article>)}
            {!keys.length && <div className={styles.empty}>
              <span className={styles.keyIcon}><KeyIcon size={21} aria-hidden='true' /></span>
              <div><h3>{localPreview ? 'Your keys will appear here' : 'No API keys yet'}</h3><p>{localPreview ? 'Sign in to see your integrations.' : 'Create a key above to connect your first integration.'}</p></div>
            </div>}
          </div>
        </section>

        <details className={styles.guide}>
          <summary>How to use a key</summary>
          <p>Send your key in the authorization header.</p>
          <code className={styles.codeSample}>Authorization: Bearer aty_…</code>
          <p><code>X-API-Key</code> is also supported. Keys cannot manage billing, connections, other keys, or your account.</p>
          <a href='/api/platform/docs' target='_blank' rel='noreferrer'>Read the API reference ↗</a>
        </details>
      </section>
    </div>
  </main>;
}

function formatDate(value: Date | string): string {
  return new Date(value).toLocaleString();
}
