'use client';

import { useState } from 'react';
import { GithubLogoIcon, GoogleLogoIcon } from '@phosphor-icons/react';
import { loginPath } from '../../lib/login-redirect';
import styles from './login.module.css';

export default function LoginForm({ returnTo, hasError }: { returnTo: string; hasError: boolean }) {
  const [pending, setPending] = useState<'google' | 'github' | null>(null);
  const [error, setError] = useState(hasError ? 'This sign-in attempt could not be completed. Please try again.' : '');

  async function signIn(method: 'google' | 'github') {
    if (pending) return;
    setPending(method);
    setError('');
    try {
      const callbackURL = new URL(returnTo, window.location.origin).href;
      const errorCallbackURL = new URL(loginPath(returnTo), window.location.origin).href;
      const response = await fetch('/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callbackURL, errorCallbackURL, provider: method }),
      });
      if (!response.ok) throw new Error(response.status === 429 ? 'Too many attempts. Please wait a moment and try again.' : 'Sign-in is unavailable right now. Please try again.');
      const data = await response.json() as { url?: string };
      if (!data.url) throw new Error(`Could not connect to ${method === 'google' ? 'Google' : 'GitHub'}. Please try again.`);
      window.location.assign(data.url);
      return;
    } catch (cause) {
      setError(cause instanceof TypeError ? 'Could not connect. Check your connection and try again.' : cause instanceof Error ? cause.message : 'Could not sign in. Please try again.');
    }
    setPending(null);
  }

  return <div className={styles.formContent}>
    <div className={styles.providers} role='group' aria-label='Sign-in options' aria-busy={!!pending}>
      <button className={styles.provider} type='button' disabled={!!pending} onClick={() => void signIn('google')}>
        <GoogleLogoIcon size={19} weight='bold' aria-hidden='true' />{pending === 'google' ? 'Connecting to Google…' : 'Continue with Google'}
      </button>
      <button className={styles.provider} type='button' disabled={!!pending} onClick={() => void signIn('github')}>
        <GithubLogoIcon size={19} weight='fill' aria-hidden='true' />{pending === 'github' ? 'Connecting to GitHub…' : 'Continue with GitHub'}
      </button>
    </div>
    {pending && <p className={styles.hint} role='status'>Redirecting to {pending === 'google' ? 'Google' : 'GitHub'}…</p>}
    {error && <p className={styles.error} role='alert'>{error}</p>}
  </div>;
}
