"use client";

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { searchAdminUsers, deleteAdminUser, type AdminUser, type AdminUserResults } from '../../../lib/admin-users';
import { PlatformApiError } from '../../../lib/platform-request';
import { useErrorToast } from '../../../lib/use-error-toast';
import styles from './AdminUsers.module.css';

export default function AdminUsers({ adminUserId }: { adminUserId: string }) {
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [results, setResults] = useState<AdminUserResults | null>(null);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<AdminUser | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const confirmInput = useRef<HTMLInputElement>(null);
  const toast = useErrorToast();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { if (selected) confirmInput.current?.focus(); }, [selected]);

  async function search(value: string, pageOffset = 0) {
    if (lock.current || !value.trim()) return;
    lock.current = true; setBusy(true); setError(''); setNotice(''); setSelected(null); setConfirmation(''); toast.clear();
    controller.current?.abort(); controller.current = new AbortController();
    try {
      const found = await searchAdminUsers(value.trim(), pageOffset, controller.current.signal);
      if (mounted.current) { setResults(found); setSearched(value.trim()); setOffset(pageOffset); }
    } catch (cause) {
      if (mounted.current) { setResults(null); setError(cause instanceof Error ? cause.message : 'Could not search users.'); }
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); void search(query); }
  async function remove() {
    if (lock.current || !selected || selected.status === 'deleted' || confirmation.trim().toLowerCase() !== selected.email.toLowerCase()) return;
    const target = selected;
    lock.current = true; setBusy(true); setError(''); setNotice(''); toast.clear();
    controller.current?.abort(); controller.current = new AbortController();
    try {
      await deleteAdminUser(target, {
        signal: controller.current.signal,
        onProgress: message => { if (mounted.current) setNotice(message); },
      });
      if (!mounted.current) return;
      setResults(current => current ? { ...current, users: current.users.filter(user => user.id !== target.id) } : null);
      setSelected(null); setConfirmation(''); setNotice(`Account deleted for ${target.email}. Its deletion record is retained. Search again to view the history.`);
    } catch (cause) {
      if (!mounted.current) return;
      setNotice('');
      if (cause instanceof PlatformApiError && cause.code === 'SUBSCRIPTION_ACTIVE') toast.show(cause.message);
      else setError(cause instanceof Error ? cause.message : 'Could not delete this account. Retry to finish cleanup.');
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  }

  return <section className={styles.panel} aria-labelledby="admin-users-title">
    <header><h2 id="admin-users-title">Users</h2><p>Find active and deleted accounts by user ID or email address. Each deleted signup has its own history record.</p></header>
    <form onSubmit={submit} className={styles.search}>
      <label htmlFor="admin-user-search">User ID or email</label>
      <div><input id="admin-user-search" type="search" autoComplete="off" maxLength={320} value={query} onChange={event => setQuery(event.target.value)} disabled={busy} placeholder="User ID or name@example.com" />
      <button type="submit" disabled={busy || !query.trim()}>{busy && !selected ? 'Searching…' : 'Search users'}</button></div>
    </form>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <p role="status" aria-live="polite" className={styles.notice}>{notice}</p>
    {results && <div aria-label="User search results" aria-busy={busy}>
      {results.users.map(user => <article key={user.id} className={styles.user} aria-label={user.email}>
        <div><h3>{user.name || user.email}</h3><p>{user.email}</p><code>{user.id}</code>
          <p>{user.status === 'deleted' ? 'Deleted account' : 'Active account'} · {user.plan === 'builder' ? 'Builder plan' : 'Starter plan'}</p>
          {user.signedUpAt !== undefined && <p>Signed up: {new Date(user.signedUpAt).toLocaleString()}</p>}
          {user.status === 'deleted' && <>
            <p>Deleted: {new Date(user.deletedAt!).toLocaleString()}</p>
            <p>Credits at deletion: {user.creditBalance.toLocaleString()}</p>
            <p>Deleted by: {user.deletionSource === 'admin' ? `Admin (${user.deletedByUserId})` : user.deletionSource === 'self' ? 'Account owner' : 'Database operation'}</p>
            {user.polarCustomerId && <p>Polar customer: <code>{user.polarCustomerId}</code></p>}
          </>}
        </div>
        {user.status === 'deleted' ? <span className={styles.hint}>Historical record. Deletion recorded.</span> : (user.isAdmin || user.id === adminUserId) ? <span className={styles.hint}>Admin account. Deletion is disabled.</span> : selected?.id !== user.id ?
          <button type="button" className={styles.danger} disabled={busy || !!selected} onClick={() => { setSelected(user); setConfirmation(''); setError(''); setNotice(''); toast.clear(); }}>Delete account</button> :
          <form className={styles.confirm} onSubmit={event => { event.preventDefault(); void remove(); }}>
            <h4>Delete this account permanently?</h4>
            <p>Removes the Polar customer, sessions, sources, projects and private files. Shared video assets stay available. Renewing subscriptions must be cancelled first. Deletion forfeits any remaining paid period. We retain an account deletion record and remaining credits to prevent repeat signup grants.</p>
            <label htmlFor="admin-delete-confirm">Type {user.email} to confirm</label>
            <input id="admin-delete-confirm" ref={confirmInput} type="text" autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} />
            <div><button className={styles.danger} type="submit" disabled={busy || confirmation.trim().toLowerCase() !== user.email.toLowerCase()}>{busy ? 'Deleting…' : 'Delete permanently'}</button>
            <button type="button" disabled={busy} onClick={() => { setSelected(null); setConfirmation(''); setError(''); toast.clear(); }}>Cancel</button></div>
          </form>}
      </article>)}
      {!results.users.length && <p className={styles.hint}>No matching users. Try another user ID or email.</p>}
      {(offset > 0 || results.nextOffset !== null) && <nav aria-label="User search pages" className={styles.pages}>
        <button disabled={busy || offset === 0 || !!selected} onClick={() => void search(searched, Math.max(0, offset - 25))}>Previous</button>
        <button disabled={busy || results.nextOffset === null || !!selected} onClick={() => void search(searched, results.nextOffset!)}>Next</button>
      </nav>}
    </div>}
  </section>;
}
