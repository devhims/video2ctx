'use client';

import { type FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  decideDeviceAuthorization,
  verifyDeviceAuthorization,
  type DeviceAuthorizationStatus,
} from '../../lib/device-authorization';

type User = { id: string; email: string; name?: string | null };

export default function DeviceAuthorizationClient({
  initialUser,
  initialUserCode,
}: {
  initialUser: User | null;
  initialUserCode: string;
}) {
  const [userCode, setUserCode] = useState(initialUserCode.trim().toUpperCase());
  const [status, setStatus] = useState<DeviceAuthorizationStatus>();
  const [checking, setChecking] = useState(false);
  const [decision, setDecision] = useState<'approve' | 'deny'>();
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');

  const verify = async (code = userCode) => {
    const normalized = code.trim().toUpperCase();
    if (!normalized) return;
    setChecking(true);
    setMessage('');
    try {
      const authorization = await verifyDeviceAuthorization(normalized);
      setUserCode(authorization.userCode);
      setStatus(authorization.status);
      const url = new URL(window.location.href);
      url.searchParams.set('user_code', authorization.userCode);
      window.history.replaceState({}, '', url);
    } catch (cause) {
      setStatus(undefined);
      setMessage(cause instanceof Error ? cause.message : 'Could not verify this device code.');
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    if (initialUserCode) void verify(initialUserCode);
    // The initial URL code is intentionally claimed once when this page loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUserCode]);

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    void verify();
  };

  const decide = async (nextDecision: 'approve' | 'deny') => {
    setDecision(nextDecision);
    setMessage('');
    try {
      await decideDeviceAuthorization(nextDecision, userCode);
      setStatus(nextDecision === 'approve' ? 'approved' : 'denied');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : `Could not ${nextDecision} this device.`);
    } finally {
      setDecision(undefined);
    }
  };

  const google = async () => {
    const response = await fetch('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', callbackURL: window.location.href }),
    });
    const payload = await response.json() as { url?: string };
    if (payload.url) window.location.href = payload.url;
    else setMessage('Could not start Google sign-in.');
  };

  const magic = async (event: FormEvent) => {
    event.preventDefault();
    const response = await fetch('/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, callbackURL: window.location.href }),
    });
    setMessage(response.ok
      ? 'Check your inbox, then return here to approve the CLI.'
      : 'Could not send the sign-in link.');
  };

  const completed = status === 'approved' || status === 'denied';

  return <main className="min-h-screen bg-[#f4f2ed] px-5 py-10 text-[#171714]">
    <section className="mx-auto max-w-xl overflow-hidden rounded-3xl border border-black/10 bg-white shadow-[0_24px_80px_rgba(0,0,0,.08)]">
      <header className="flex items-center justify-between border-b border-black/10 px-7 py-5">
        <Link href="/" className="text-sm font-semibold tracking-[-.02em]">video2ctx</Link>
        {initialUser ? <span className="max-w-60 truncate text-xs text-black/55">{initialUser.email}</span> : null}
      </header>

      <div className="px-7 py-8 sm:px-10 sm:py-10">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[.16em] text-black/45">CLI authorization</p>
        <h1 className="text-3xl font-semibold tracking-[-.04em]">Connect this device</h1>
        <p className="mt-3 max-w-lg text-sm leading-6 text-black/60">
          Approving gives the video2ctx CLI read access to hosted YouTube data and usage, plus access to create and manage monitors. It cannot manage API keys, billing, connected accounts, or account deletion.
        </p>

        <form className="mt-8" onSubmit={submitCode}>
          <label className="block text-xs font-semibold uppercase tracking-[.12em] text-black/45" htmlFor="device-code">Device code</label>
          <div className="mt-2 flex gap-2">
            <input
              id="device-code"
              className="min-w-0 flex-1 rounded-xl border border-black/15 bg-[#faf9f6] px-4 py-3 font-mono text-lg tracking-[.12em] outline-none focus:border-black/50"
              value={userCode}
              onChange={(event) => setUserCode(event.target.value.toUpperCase())}
              placeholder="ABCD-EFGH"
              autoComplete="one-time-code"
            />
            <button className="rounded-xl bg-black px-5 text-sm font-medium text-white disabled:opacity-40" disabled={!userCode.trim() || checking}>
              {checking ? 'Checking…' : 'Continue'}
            </button>
          </div>
        </form>

        {status === 'pending' && !initialUser ? <section className="mt-8 rounded-2xl border border-black/10 bg-[#faf9f6] p-5">
          <h2 className="font-semibold">Sign in to continue</h2>
          <p className="mt-1 text-sm text-black/55">Use the account you want this CLI session to access.</p>
          <button className="mt-4 w-full rounded-xl border border-black/15 bg-white px-4 py-3 text-sm font-medium" onClick={() => void google()}>
            Continue with Google
          </button>
          <div className="my-4 flex items-center gap-3 text-xs text-black/35"><span className="h-px flex-1 bg-black/10"/>or<span className="h-px flex-1 bg-black/10"/></div>
          <form onSubmit={magic} className="flex gap-2">
            <input className="min-w-0 flex-1 rounded-xl border border-black/15 bg-white px-4 py-3 text-sm" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
            <button className="rounded-xl bg-black px-4 text-sm font-medium text-white">Email link</button>
          </form>
        </section> : null}

        {status === 'pending' && initialUser ? <section className="mt-8 rounded-2xl border border-black/10 bg-[#faf9f6] p-5">
          <h2 className="font-semibold">Authorize video2ctx CLI?</h2>
          <p className="mt-1 text-sm text-black/55">Only approve if you started this login on your own device.</p>
          <div className="mt-5 flex gap-3">
            <button className="flex-1 rounded-xl border border-black/15 bg-white px-4 py-3 text-sm font-medium disabled:opacity-40" disabled={Boolean(decision)} onClick={() => void decide('deny')}>Deny</button>
            <button className="flex-1 rounded-xl bg-black px-4 py-3 text-sm font-medium text-white disabled:opacity-40" disabled={Boolean(decision)} onClick={() => void decide('approve')}>Approve</button>
          </div>
        </section> : null}

        {completed ? <section className="mt-8 rounded-2xl border border-black/10 bg-[#faf9f6] p-5">
          <h2 className="font-semibold">{status === 'approved' ? 'Device approved' : 'Request denied'}</h2>
          <p className="mt-1 text-sm text-black/55">{status === 'approved' ? 'You can return to the terminal. This page may be closed.' : 'No CLI session was granted.'}</p>
        </section> : null}

        {message ? <p className="mt-5 text-sm text-[#9c2f20]" role="status">{message}</p> : null}
      </div>
    </section>
  </main>;
}
