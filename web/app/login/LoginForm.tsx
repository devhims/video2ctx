'use client';

import { useState, type FormEvent } from 'react';
import { ArrowRightIcon, EnvelopeSimpleIcon, GoogleLogoIcon } from '@phosphor-icons/react';
import { loginPath } from '../../lib/login-redirect';
import styles from './login.module.css';

export default function LoginForm({ returnTo, hasError }: { returnTo: string; hasError: boolean }) {
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState<'google' | 'email' | null>(null);
  const [sentTo, setSentTo] = useState('');
  const [error, setError] = useState(hasError ? 'This sign-in attempt could not be completed. Please try again.' : '');

  async function signIn(method: 'google' | 'email') {
    if (pending) return;
    setPending(method);
    setError('');
    try {
      const callbackURL = new URL(returnTo, window.location.origin).href;
      const errorCallbackURL = new URL(loginPath(returnTo), window.location.origin).href;
      const response = await fetch(`/api/auth/sign-in/${method === 'google' ? 'social' : 'magic-link'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callbackURL, errorCallbackURL, ...(method === 'google' ? { provider: 'google' } : { email: email.trim() }) }),
      });
      if (!response.ok) throw new Error(response.status === 429 ? 'Too many attempts. Please wait a moment and try again.' : 'Sign-in is unavailable right now. Please try again.');
      if (method === 'google') {
        const data = await response.json() as { url?: string };
        if (!data.url) throw new Error('Could not connect to Google. Please try again.');
        window.location.assign(data.url);
        return;
      }
      setSentTo(email.trim());
    } catch (cause) {
      setError(cause instanceof TypeError ? 'Could not connect. Check your connection and try again.' : cause instanceof Error ? cause.message : 'Could not sign in. Please try again.');
    }
    setPending(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void signIn('email');
  }

  return <div className={styles.formContent}>
    <button className={styles.google} type='button' disabled={!!pending} onClick={() => void signIn('google')}>
      <GoogleLogoIcon size={19} weight='bold' aria-hidden='true' />{pending === 'google' ? 'Connecting to Google…' : 'Continue with Google'}
    </button>
    <div className={styles.divider}><span />or continue with email<span /></div>
    {sentTo ? <div className={styles.sent} role='status'>
      <EnvelopeSimpleIcon size={25} aria-hidden='true' />
      <h3>Check your inbox</h3>
      <p>We sent a sign-in link to <strong>{sentTo}</strong>. Open it to continue to your workspace.</p>
      <button type='button' disabled={!!pending} onClick={() => setSentTo('')}>Use a different email or try again</button>
    </div> : <form className={styles.form} onSubmit={submit} aria-label='Email sign-in'>
      <label htmlFor='login-email'>Email address</label>
      <input id='login-email' name='email' type='email' autoComplete='email' placeholder='you@example.com' required disabled={!!pending} value={email} onChange={event => setEmail(event.target.value)} />
      <button className={styles.submit} type='submit' disabled={!!pending}>{pending === 'email' ? 'Sending link…' : 'Continue with email'}<ArrowRightIcon size={17} aria-hidden='true' /></button>
      <p className={styles.hint}>We’ll email you a sign-in link. No password needed.</p>
    </form>}
    {error && <p className={styles.error} role='alert'>{error}</p>}
  </div>;
}
