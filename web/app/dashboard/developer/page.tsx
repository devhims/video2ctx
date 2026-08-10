'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { authClient } from '../../../lib/auth-client';

type ManagedApiKey = {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  createdAt: Date;
  lastRequest: Date | null;
};

export default function DeveloperSettingsPage() {
  const { data: session, isPending } = authClient.useSession();
  const [keys, setKeys] = useState<ManagedApiKey[]>([]);
  const [name, setName] = useState('');
  const [createdSecret, setCreatedSecret] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const result = await authClient.apiKey.list();
    if (result.error) throw new Error(result.error.message ?? 'Could not load API keys.');
    setKeys(result.data?.apiKeys ?? []);
  }, []);

  useEffect(() => {
    if (!session?.user) return;
    void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load API keys.'));
  }, [refresh, session?.user]);

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

  if (isPending) return <main className='developer-page'><p>Checking your session…</p></main>;
  if (!session?.user) {
    return <main className='developer-page developer-gate'>
      <a href='/dashboard'>← Dashboard</a>
      <p className='panel-label'>Developer access</p>
      <h1>Sign in to manage API keys</h1>
      <p>API keys inherit your plan and credit balance, so they can only be created from an authenticated browser session.</p>
      <a className='button primary' href='/dashboard'>Sign in from the dashboard</a>
    </main>;
  }

  return <main className='developer-page'>
    <header className='developer-header'>
      <div><a href='/dashboard'>← Dashboard</a><p className='panel-label'>Developer access</p><h1>Personal API keys</h1><p>Use permanent keys for your own scripts and integrations. They act as you for product data and workspace operations, and metered requests spend credits from {session.user.email}.</p></div>
      <a href='/api/platform/docs' target='_blank'>Open API reference ↗</a>
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
  </main>;
}

function formatDate(value: Date | string): string {
  return new Date(value).toLocaleString();
}
