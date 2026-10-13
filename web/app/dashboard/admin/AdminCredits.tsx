'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CheckCircleIcon, CoinsIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import { grantCredits, lookupCreditAccount, type CreditAccount, type CreditGrantInput, type CreditGrantResult, type CreditUser } from '../../../lib/admin-credits';
import { PlatformApiError } from '../../../lib/platform-request';
import { CREDIT_BALANCE_EVENT } from '../../../lib/dashboard-data';
import styles from './AdminCredits.module.css';

const number = new Intl.NumberFormat('en-US');
type PendingGrant = { input: CreditGrantInput; user: CreditUser };

export default function AdminCredits({ adminUserId }: { adminUserId: string }) {
  const [query, setQuery] = useState('');
  const [account, setAccount] = useState<CreditAccount | null>(null);
  const [amount, setAmount] = useState('10000');
  const [pending, setPending] = useState<PendingGrant | null>(null);
  const [result, setResult] = useState<CreditGrantResult | null>(null);
  const [busy, setBusy] = useState<'lookup' | 'grant' | 'refresh' | null>(null);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const lock = useRef(false);
  const mounted = useRef(true);
  const lookupController = useRef<AbortController | null>(null);
  const pendingHeading = useRef<HTMLHeadingElement>(null);
  const amountInput = useRef<HTMLInputElement>(null);
  const storageKey = `admin-credit-grant:${adminUserId}`;
  const credits = Number(amount);
  const validAmount = /^\d+$/.test(amount) && Number.isInteger(credits) && credits >= 1 && credits <= 1_000_000;

  // Preserve the complete original payload, including optional notes from older
  // dashboards, so a recovered request still matches its original receipt.
  useEffect(() => {
    mounted.current = true;
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as PendingGrant | null;
      if (saved?.input && saved.user && typeof saved.input.requestId === 'string'
        && (saved.input.reason === undefined || typeof saved.input.reason === 'string') && typeof saved.user.email === 'string'
        && saved.input.userId === saved.user.id && Number.isInteger(saved.input.credits)
        && saved.input.credits > 0 && saved.input.credits <= 1_000_000) {
        setPending(saved); setAccount({ user: saved.user, grants: [] });
        setQuery(saved.user.email); setAmount(String(saved.input.credits));
      }
    } catch { /* The form still works when browser storage is unavailable. */ }
    return () => { mounted.current = false; lookupController.current?.abort(); };
  }, [storageKey]);

  useEffect(() => { if (pending && !busy) pendingHeading.current?.focus(); }, [pending, busy]);

  function remember(value: PendingGrant) {
    try { sessionStorage.setItem(storageKey, JSON.stringify(value)); }
    catch { /* In-memory request IDs still protect retries in this view. */ }
  }

  function forget(requestId: string) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as PendingGrant | null;
      // A completion can outlive its panel. Do not clear a newer grant saved
      // by the replacement panel while this response was in flight.
      if (saved?.input?.requestId === requestId) sessionStorage.removeItem(storageKey);
    } catch { /* Leave an unconfirmed request intact when storage cannot be read. */ }
  }

  function publishBalance(user: CreditUser) {
    if (user.id === adminUserId) window.dispatchEvent(new CustomEvent<number>(CREDIT_BALANCE_EVENT, { detail: user.creditBalance }));
  }

  async function lookup(event: FormEvent) {
    event.preventDefault();
    if (lock.current || pending) return;
    lock.current = true; setBusy('lookup'); setError(''); setRefreshError(''); setAccount(null); setResult(null);
    const controller = new AbortController();
    lookupController.current = controller;
    try {
      const found = await lookupCreditAccount(query.trim(), controller.signal);
      if (!mounted.current) return;
      setAccount(found);
      requestAnimationFrame(() => amountInput.current?.focus());
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not find this account.');
    } finally { lock.current = false; if (mounted.current) setBusy(null); }
  }

  async function refreshAccount(userId: string) {
    try {
      const fresh = await lookupCreditAccount(userId);
      if (!mounted.current) return;
      setAccount(fresh); publishBalance(fresh.user); setRefreshError('');
      setResult(current => current ? { ...current, user: fresh.user } : null);
    } catch {
      // The grant is already confirmed. A failed read must never offer to
      // submit it again or discard the balance returned by the mutation.
      if (mounted.current) setRefreshError('Credits were added, but the latest account data could not be loaded. Refresh the balance to check again.');
    }
  }

  async function retryRefresh() {
    if (!account || lock.current || pending) return;
    lock.current = true; setBusy('refresh');
    try { await refreshAccount(account.user.id); }
    finally { lock.current = false; if (mounted.current) setBusy(null); }
  }

  async function addCredits(event: FormEvent) {
    event.preventDefault();
    if (!account || lock.current || !validAmount) return;
    const draft = pending ?? { user: account.user, input: {
      userId: account.user.id, requestId: crypto.randomUUID(), credits,
    } };
    lock.current = true; setBusy('grant'); setError(''); setRefreshError(''); setResult(null); setPending(draft); remember(draft);
    try {
      const response = await grantCredits(draft.input);
      forget(draft.input.requestId);
      if (!mounted.current) return;
      publishBalance(response.user); setPending(null); setResult(response); setAmount('');
      setAccount(current => ({ user: response.user, grants: [response.grant, ...(current?.grants ?? []).filter(grant => grant.id !== response.grant.id)].slice(0, 10) }));
      setBusy('refresh');
      await refreshAccount(response.user.id);
    } catch (cause) {
      if (!mounted.current) return;
      // Authentication rejects a retry before checking the original receipt.
      // Keep its ID through 401/403, connection failures and server errors.
      if (cause instanceof PlatformApiError && [404, 409, 422].includes(cause.status)) {
        setPending(null); forget(draft.input.requestId);
      }
      setError(cause instanceof Error ? cause.message : 'Could not confirm this grant. Retry to check its result.');
    } finally { lock.current = false; if (mounted.current) setBusy(null); }
  }

  return <section className={styles.panel} aria-labelledby='credits-title'>
    <header className={styles.intro}><div className={styles.eyebrow}><CoinsIcon size={16} aria-hidden='true' />Account credits</div>
      <h2 id='credits-title'>Manage credits</h2><p>Find an account, check its balance, and add credits. The balance updates automatically.</p>
    </header>
    <form className={styles.lookup} onSubmit={lookup}>
      <label htmlFor='credit-user'>User ID or email</label>
      <div className={styles.lookupRow}><input id='credit-user' type='text' autoComplete='off' spellCheck={false} maxLength={320}
        placeholder='Search by exact email or user ID' value={query} onChange={event => setQuery(event.target.value)} required disabled={!!busy || !!pending} />
        <button type='submit' disabled={!!busy || !!pending || !query.trim()}><MagnifyingGlassIcon size={16} aria-hidden='true' />{busy === 'lookup' ? 'Finding account…' : 'Find account'}</button>
      </div>
    </form>
    {error && <p role='alert' className={styles.error}>{error}</p>}
    {busy === 'lookup' && <p role='status' className={styles.hint}>Looking up the account and its balance…</p>}
    {!account && !busy && <div className={styles.empty}><CoinsIcon size={28} weight='light' aria-hidden='true' /><h3>Start with an account</h3><p>Search for a person to see their current credits and add more.</p></div>}
    {account && <>
      {pending && !busy && <div className={styles.recovery}>
        <h3 tabIndex={-1} ref={pendingHeading}>Confirm the grant result</h3>
        <p>An earlier attempt may already be saved. Retry the same grant to confirm it without adding credits twice.</p>
      </div>}
      <table className={styles.accountTable} aria-label='Account credit management' aria-busy={!!busy}>
        <colgroup><col className={styles.userColumn} /><col className={styles.balanceColumn} /><col className={styles.addColumn} /></colgroup>
        <thead><tr><th scope='col'>User</th><th scope='col'>Current credits</th><th scope='col'>Add credits</th></tr></thead>
        <tbody><tr>
          <td><div className={styles.identity}><span className={styles.avatar} aria-hidden='true'>{(account.user.name || account.user.email).slice(0, 1).toUpperCase()}</span>
            <div><h3>{account.user.name || 'Unnamed account'}</h3><p>{account.user.email}</p><code>{account.user.id}</code></div>
          </div></td>
          <td><div className={styles.balance}><span className={styles.mobileLabel}>Current credits</span>
            <strong aria-label='Current credit balance' aria-live='polite'>{number.format(account.user.creditBalance)}</strong>
            <span>{pending ? 'Last viewed balance' : busy === 'refresh' ? 'Refreshing…' : 'Available to use'}</span>
          </div></td>
          <td><form className={styles.grantForm} onSubmit={event => void addCredits(event)}>
            <label className={styles.amountLabel} htmlFor='credit-amount'>Credits to add</label>
            <div className={styles.addControls}><input ref={amountInput} id='credit-amount' type='number' inputMode='numeric'
              min={1} max={1_000_000} step={1} required placeholder='0' value={amount} disabled={!!busy || !!pending} aria-describedby='credit-amount-hint' onChange={event => setAmount(event.target.value)} />
              <button type='submit' className={styles.primary} disabled={!!busy || !validAmount}>{busy === 'grant' ? 'Adding…' : busy === 'refresh' ? 'Refreshing…' : pending ? 'Retry grant' : 'Add'}</button></div>
            <div className={styles.presets} aria-label='Suggested credit amounts'>{[1000, 5000, 10000].map(value => <button key={value} type='button'
              disabled={!!busy || !!pending} aria-pressed={credits === value} onClick={() => setAmount(String(value))}>+{number.format(value)}</button>)}</div>
            <p id='credit-amount-hint' className={styles.hint}>{!amount && result ? 'Choose an amount to add more credits.' : !validAmount ? 'Enter 1 to 1,000,000 whole credits.' : pending ? `Original amount: ${number.format(credits)} credits` : <>After adding: <strong>{number.format(account.user.creditBalance + credits)}</strong></>}</p>
          </form></td>
        </tr></tbody>
      </table>
      {result && <div className={styles.success} role='status'><CheckCircleIcon size={20} weight='fill' aria-hidden='true' /><div>
        <h3>{number.format(result.grant.credits)} credits added</h3><p>{result.replayed ? 'No extra credits were added on retry. ' : ''}Current balance: {number.format(result.user.creditBalance)} credits.</p>
      </div></div>}
      {refreshError && <div className={styles.refreshError}><p role='alert'>{refreshError}</p><button type='button' disabled={!!busy} onClick={() => void retryRefresh()}>Refresh balance</button></div>}
      <section className={styles.history} aria-labelledby='credit-history-title'><h3 id='credit-history-title'>Recent dashboard grants <span>Last 10</span></h3>
        {account.grants.length ? <ol>{account.grants.map(grant => <li key={grant.id}>
          <div><strong>+{number.format(grant.credits)} credits</strong><small>Admin {grant.adminUserId}</small></div>
          <time dateTime={new Date(grant.createdAt).toISOString()}>{new Date(grant.createdAt).toLocaleString()}</time>
        </li>)}</ol> : <p className={styles.hint}>No dashboard credit grants for this account yet.</p>}
      </section>
    </>}
  </section>;
}
