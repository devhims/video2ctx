'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRightIcon, CheckCircleIcon, CoinsIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
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
  const [reason, setReason] = useState('');
  const [review, setReview] = useState(false);
  const [pending, setPending] = useState<PendingGrant | null>(null);
  const [result, setResult] = useState<CreditGrantResult | null>(null);
  const [busy, setBusy] = useState<'lookup' | 'grant' | null>(null);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const mounted = useRef(true);
  const lookupController = useRef<AbortController | null>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const amountInput = useRef<HTMLInputElement>(null);
  const storageKey = `admin-credit-grant:${adminUserId}`;
  const credits = Number(amount);
  const validAmount = /^\d+$/.test(amount) && Number.isInteger(credits) && credits >= 1 && credits <= 1_000_000;

  // Keep an unresolved request across navigation/reload. Retrying its ID only
  // reads the original receipt if the first response was lost after committing.
  useEffect(() => {
    mounted.current = true;
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as PendingGrant | null;
      if (saved?.input && saved.user && typeof saved.input.requestId === 'string'
        && typeof saved.input.reason === 'string' && typeof saved.user.email === 'string'
        && saved.input.userId === saved.user.id && Number.isInteger(saved.input.credits)
        && saved.input.credits > 0 && saved.input.credits <= 1_000_000) {
        setPending(saved); setAccount({ user: saved.user, grants: [] });
        setAmount(String(saved.input.credits)); setReason(saved.input.reason); setReview(true);
      }
    } catch { /* The form still works when browser storage is unavailable. */ }
    return () => { mounted.current = false; lookupController.current?.abort(); };
  }, [storageKey]);

  useEffect(() => { if (review) reviewHeading.current?.focus(); }, [review]);

  function remember(value: PendingGrant | null) {
    try {
      if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
      else sessionStorage.removeItem(storageKey);
    } catch { /* In-memory request IDs still protect retries in this view. */ }
  }

  async function lookup(event: FormEvent) {
    event.preventDefault();
    if (lock.current || pending) return;
    lock.current = true; setBusy('lookup'); setError(''); setAccount(null); setResult(null); setReview(false);
    const controller = new AbortController();
    lookupController.current = controller;
    try {
      const found = await lookupCreditAccount(query.trim(), controller.signal);
      if (!mounted.current) return;
      setAccount(found); setReason('');
      requestAnimationFrame(() => amountInput.current?.focus());
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not find this account.');
    } finally { lock.current = false; if (mounted.current) setBusy(null); }
  }

  function preview(event: FormEvent) {
    event.preventDefault();
    if (!account || !validAmount || lock.current) return;
    setError(''); setReview(true);
  }

  async function confirmGrant() {
    if (!account || lock.current || !validAmount) return;
    const draft = pending ?? { user: account.user, input: {
      userId: account.user.id, requestId: crypto.randomUUID(), credits, reason: reason.trim(),
    } };
    lock.current = true; setBusy('grant'); setError(''); setPending(draft); remember(draft);
    try {
      const response = await grantCredits(draft.input);
      remember(null);
      if (!mounted.current) return;
      if (response.user.id === adminUserId) window.dispatchEvent(new CustomEvent<number>(CREDIT_BALANCE_EVENT, { detail: response.user.creditBalance }));
      setPending(null); setReview(false); setResult(response);
      setAccount(current => ({ user: response.user, grants: [response.grant, ...(current?.grants ?? []).filter(grant => grant.id !== response.grant.id)].slice(0, 10) }));
    } catch (cause) {
      if (!mounted.current) return;
      // Only a definite rejection permits changing the draft. Network and server
      // failures may have committed, so keep the original payload and request ID.
      if (cause instanceof PlatformApiError && [401, 403, 404, 409, 422].includes(cause.status)) {
        setPending(null); remember(null);
      }
      setError(cause instanceof Error ? cause.message : 'Could not confirm this grant. Retry to check its result.');
    } finally { lock.current = false; if (mounted.current) setBusy(null); }
  }

  return <section className={styles.panel} aria-labelledby='credits-title'>
    <header className={styles.intro}><div className={styles.eyebrow}><CoinsIcon size={16} aria-hidden='true' />Account credits</div>
      <h2 id='credits-title'>Add credits</h2><p>Give an account extra credits. Find the person first, then review the amount.</p>
    </header>
    <form className={styles.lookup} onSubmit={lookup}>
      <label htmlFor='credit-user'>User ID or email</label>
      <div className={styles.lookupRow}><input id='credit-user' type='text' autoComplete='off' spellCheck={false} maxLength={320}
        placeholder='Paste a user ID or exact email' value={query} onChange={event => setQuery(event.target.value)} required disabled={!!busy || !!pending} />
        <button type='submit' disabled={!!busy || !!pending || !query.trim()}><MagnifyingGlassIcon size={16} aria-hidden='true' />{busy === 'lookup' ? 'Finding account…' : 'Find account'}</button>
      </div>
    </form>
    {error && <p role='alert' className={styles.error}>{error}</p>}
    {busy === 'lookup' && <p role='status' className={styles.hint}>Looking up the account and its balance…</p>}
    {!account && !busy && <div className={styles.empty}><CoinsIcon size={28} weight='light' aria-hidden='true' /><h3>Start with an account</h3><p>The name, email and current balance will appear here before you add credits.</p></div>}
    {account && <>
      <div className={styles.account}>
        <div className={styles.identity}><span className={styles.avatar} aria-hidden='true'>{(account.user.name || account.user.email).slice(0, 1).toUpperCase()}</span>
          <div><h3>{account.user.name || 'Unnamed account'}</h3><p>{account.user.email}</p><code>{account.user.id}</code></div>
        </div>
        <div className={styles.balance}><span>{pending ? 'Previously viewed balance' : 'Available credits'}</span><strong>{number.format(account.user.creditBalance)}</strong></div>
      </div>
      {result ? <div className={styles.success} role='status'>
        <CheckCircleIcon size={24} weight='fill' aria-hidden='true' /><div><h3>{number.format(result.grant.credits)} credits added</h3>
          <p>{result.replayed ? 'The original grant is confirmed. No extra credits were added on retry.' : `Added to ${result.user.email}.`} Current balance: {number.format(result.user.creditBalance)} credits.</p>
          <button type='button' onClick={() => { setResult(null); setReason(''); requestAnimationFrame(() => amountInput.current?.focus()); }}>Add more credits</button>
        </div>
      </div> : review ? <section className={styles.review} aria-labelledby='credit-review-title'>
        <h3 id='credit-review-title' tabIndex={-1} ref={reviewHeading}>{pending ? 'Confirm the grant result' : 'Review credit grant'}</h3>
        <p>{pending ? 'This grant may already be saved. Retry to confirm it safely without adding credits twice.' : <>Add <strong>{number.format(credits)} credits</strong> to <strong>{account.user.email}</strong>?</>}</p>
        <div className={styles.calculation} aria-label='Expected balance'>
          <div><span>Current</span><strong>{number.format(account.user.creditBalance)}</strong></div><span aria-hidden='true'>+</span>
          <div><span>Adding</span><strong>{number.format(credits)}</strong></div><ArrowRightIcon size={18} aria-hidden='true' />
          <div><span>Expected balance</span><strong>{number.format(account.user.creditBalance + credits)}</strong></div>
        </div>
        {reason.trim() && <p className={styles.reason}><span>Reason</span>{reason.trim()}</p>}
        <p className={styles.hint}>The balance can change if the account spends credits while you review.</p>
        <div className={styles.actions}>
          <button type='button' className={styles.primary} disabled={!!busy} onClick={() => void confirmGrant()}>{busy === 'grant' ? 'Confirming…' : pending ? 'Retry grant' : `Confirm ${number.format(credits)} credits`}</button>
          {!pending && <button type='button' disabled={!!busy} onClick={() => { setReview(false); setError(''); requestAnimationFrame(() => amountInput.current?.focus()); }}>Back to editing</button>}
        </div>
      </section> : <form className={styles.grantForm} onSubmit={preview}>
        <div className={styles.amountHeading}><label htmlFor='credit-amount'>Credits to add</label><span>Added to the current balance</span></div>
        <div className={styles.amountField}><CoinsIcon size={22} aria-hidden='true' /><input ref={amountInput} id='credit-amount' type='number' inputMode='numeric'
          min={1} max={1_000_000} step={1} required value={amount} aria-describedby='credit-amount-hint' onChange={event => setAmount(event.target.value)} /><span>credits</span></div>
        <div className={styles.presets} aria-label='Suggested credit amounts'>{[1000, 5000, 10000].map(value => <button key={value} type='button'
          aria-pressed={credits === value} onClick={() => setAmount(String(value))}>+{number.format(value)}</button>)}</div>
        <p id='credit-amount-hint' className={styles.hint}>{validAmount ? <>Expected balance <strong>{number.format(account.user.creditBalance + credits)} credits</strong></> : 'Enter a whole number from 1 to 1,000,000.'}</p>
        <label htmlFor='credit-reason'>Reason <span className={styles.optional}>Optional</span></label>
        <textarea id='credit-reason' rows={2} maxLength={500} placeholder='e.g. Testing allowance or support credit' value={reason} onChange={event => setReason(event.target.value)} />
        <div className={styles.actions}><button type='submit' className={styles.primary} disabled={!validAmount}>Review grant<ArrowRightIcon size={16} aria-hidden='true' /></button></div>
      </form>}
      <section className={styles.history} aria-labelledby='credit-history-title'><h3 id='credit-history-title'>Recent dashboard grants <span>Last 10</span></h3>
        {account.grants.length ? <ol>{account.grants.map(grant => <li key={grant.id}>
          <div><strong>+{number.format(grant.credits)} credits</strong><p>{grant.reason || 'No reason provided'}</p><small>Admin {grant.adminUserId}</small></div>
          <time dateTime={new Date(grant.createdAt).toISOString()}>{new Date(grant.createdAt).toLocaleString()}</time>
        </li>)}</ol> : <p className={styles.hint}>No dashboard credit grants for this account yet.</p>}
      </section>
    </>}
  </section>;
}
