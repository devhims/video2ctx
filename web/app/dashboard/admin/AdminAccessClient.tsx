'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { platformRequest } from '../../../lib/platform-request';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PlusIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import { adminAccessRequest, type AgentAccessPage } from '../../../lib/admin-access';
import { loadDashboardAccountData, type DashboardProject } from '../../../lib/dashboard-data';
import { DashboardHeader } from '../DashboardHeader';
import { DashboardSidebar } from '../DashboardSidebar';
import { useDashboardSession } from '../DashboardSessionProvider';
import pageStyles from '../DashboardPages.module.css';
import styles from './AdminAccess.module.css';

export default function AdminAccessClient() {
  const router = useRouter();
  const { user, adminAccess, signOut } = useDashboardSession();
  const [email, setEmail] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<AgentAccessPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const [projects, setProjects] = useState<DashboardProject[]>([]);
  const [credits, setCredits] = useState<number>();

  useEffect(() => {
    if (!user || !adminAccess) { setPage(null); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError('');
    const timeout = setTimeout(() => {
      const query = new URLSearchParams({ q: search, limit: '50', offset: String(offset) });
      void adminAccessRequest<AgentAccessPage>(`?${query}`, { signal: controller.signal }).then(result => {
        if (controller.signal.aborted) return;
        if (!result.entries.length && offset > 0) { setOffset(Math.max(0, offset - 50)); return; }
        setPage(result);
      }).catch(cause => {
        if (!controller.signal.aborted) { setPage(null); setError(cause instanceof Error ? cause.message : 'Could not load Agent access.'); }
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, search ? 200 : 0);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [user?.id, adminAccess, search, offset, revision]);

  useEffect(() => {
    if (!user || !adminAccess) return;
    const controller = new AbortController();
    void loadDashboardAccountData(path => platformRequest(path, { signal: controller.signal })).then(data => {
      if (!controller.signal.aborted) { setProjects(data.projects); setCredits(data.usage?.creditBalance); }
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load account data.'); });
    return () => controller.abort();
  }, [user?.id, adminAccess]);

  async function updateAccess(address: string, enabled: boolean) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await adminAccessRequest('', { method: enabled ? 'POST' : 'DELETE', body: JSON.stringify({ email: address }) });
      setNotice(enabled ? `Agent access granted to ${address.trim()}.` : `Agent access removed for ${address.trim()}.`);
      if (enabled) { setEmail(''); setSearch(''); setOffset(0); }
      setRemoving(null); setRevision(value => value + 1);
      window.dispatchEvent(new Event('agent-access-changed'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update Agent access.');
    } finally { setBusy(false); }
  }

  function add(event: FormEvent) { event.preventDefault(); void updateAccess(email, true); }

  return <main className={'workspace-shell ' + pageStyles.pages}>
    <DashboardSidebar activeSection='admin' projects={projects}
      onNavigate={section => router.push(`/dashboard?section=${section}`)}
      onNewProject={() => router.push('/dashboard?section=projects')}
      onOpenProject={project => router.push(`/dashboard?section=projects&project=${encodeURIComponent(project.id)}`)}
      onSignIn={() => router.push('/dashboard')} accountName={user?.name ?? user?.email}
      credits={credits} onSignOut={() => void signOut()} />
    <div className='workspace-main'>
      <DashboardHeader title='Admin' />
      <section className={styles.content}>
        {!user || !adminAccess ? <div className={styles.empty}>
          <h2>Admin access required</h2><p>Sign in with an authorized admin account to manage Agent access.</p>
          <Link href='/dashboard'>Back to dashboard</Link>
        </div> : <>
          <header className={styles.intro}><h2>Agent access</h2><p>Choose who can try the Agent. This grants testing access only, with no admin permissions.</p></header>
          <form onSubmit={add} className={styles.form}>
            <label htmlFor='agent-access-email'>Email address</label>
            <div className={styles.inputRow}>
              <input id='agent-access-email' type='email' autoComplete='off' maxLength={320} required placeholder='name@example.com' value={email} onChange={event => setEmail(event.target.value)} disabled={busy} />
              <button type='submit' disabled={busy || !email.trim()}><PlusIcon size={16} aria-hidden='true' />{busy ? 'Saving…' : 'Grant access'}</button>
            </div>
            <p>Add an email before or after signup. The person must verify it and refresh their dashboard.</p>
          </form>
          {error && <p role='alert' className='alert error'>{error}</p>}
          <p role='status' aria-live='polite' className={styles.notice}>{notice}</p>
          <section aria-labelledby='approved-emails-title'>
            <div className={styles.listHeading}>
              <h2 id='approved-emails-title'>Approved emails {page && <span>{page.total}</span>}</h2>
              <label className={styles.search}><MagnifyingGlassIcon size={17} aria-hidden='true' /><span className='sr-only'>Search approved emails</span><input type='search' placeholder='Search emails' value={search} onChange={event => { setSearch(event.target.value); setOffset(0); setRemoving(null); }} /></label>
            </div>
            <div className={styles.list} aria-busy={loading}>
              {loading ? <p className={styles.empty} role='status'>Loading approved emails…</p> : page?.entries.map(entry => <article key={entry.email} className={styles.row}>
                <div className={styles.identity}><strong>{entry.email}</strong><span>Added {new Date(entry.createdAt).toLocaleDateString()}</span></div>
                {removing === entry.email ? <div className={styles.confirm}>
                  <span>Remove Agent access?</span>
                  <button type='button' className={styles.remove} disabled={busy} onClick={() => void updateAccess(entry.email, false)} aria-label={`Confirm removal for ${entry.email}`}>Remove</button>
                  <button type='button' disabled={busy} onClick={() => setRemoving(null)}>Cancel</button>
                </div> : <button type='button' className={styles.remove} disabled={busy} onClick={() => setRemoving(entry.email)} aria-label={`Remove access for ${entry.email}`}>Remove access</button>}
              </article>)}
              {!loading && page && !page.entries.length && <div className={styles.empty}><h3>{search ? 'No matching emails' : 'No approved emails yet'}</h3><p>{search ? 'Try a different email or clear the search.' : 'Add an email above to grant Agent access.'}</p></div>}
            </div>
            {page && page.total > 50 && <nav aria-label='Allowlist pages' className={styles.pagination}>
              <button disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button>
              <span>{offset + 1}–{Math.min(offset + 50, page.total)} of {page.total}</span>
              <button disabled={loading || offset + 50 >= page.total} onClick={() => setOffset(offset + 50)}>Next</button>
            </nav>}
          </section>
        </>}
      </section>
    </div>
  </main>;
}
