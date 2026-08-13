'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCircle, X } from '@phosphor-icons/react';

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '';
const TURNSTILE_SCRIPT_ID = 'video2ctx-turnstile';

type SubmissionState = 'idle' | 'submitting' | 'success' | 'error';

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      theme: 'dark';
      size: 'flexible';
      appearance: 'interaction-only';
      callback: (token: string) => void;
      'error-callback': () => void;
      'expired-callback': () => void;
    },
  ): string;
  remove(widgetId: string): void;
  reset(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export function CraftScaleInquiry() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const widgetContainerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const requestIdRef = useRef('');
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<SubmissionState>('idle');
  const [error, setError] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const [securityReady, setSecurityReady] = useState(Boolean(TURNSTILE_SITE_KEY));

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    requestIdRef.current = crypto.randomUUID();
    const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    setSecurityReady(Boolean(TURNSTILE_SITE_KEY) || isLocal);
  }, [open]);

  useEffect(() => {
    if (!open || !TURNSTILE_SITE_KEY || !widgetContainerRef.current) return;
    let cancelled = false;

    const renderWidget = () => {
      if (cancelled || !window.turnstile || !widgetContainerRef.current || widgetIdRef.current) return;
      widgetIdRef.current = window.turnstile.render(widgetContainerRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        action: 'scale_inquiry',
        theme: 'dark',
        size: 'flexible',
        appearance: 'interaction-only',
        callback: (token) => {
          setTurnstileToken(token);
          setSecurityReady(true);
        },
        'error-callback': () => {
          setTurnstileToken('');
          setSecurityReady(false);
          setError('The security check could not load. Please try again.');
        },
        'expired-callback': () => setTurnstileToken(''),
      });
    };

    if (window.turnstile) {
      renderWidget();
    } else {
      let script = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null;
      if (!script) {
        script = document.createElement('script');
        script.id = TURNSTILE_SCRIPT_ID;
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
      script.addEventListener('load', renderWidget);
      return () => {
        cancelled = true;
        script?.removeEventListener('load', renderWidget);
        removeWidget();
      };
    }

    return () => {
      cancelled = true;
      removeWidget();
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    setState('idle');
    setError('');
    setTurnstileToken('');
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setState('submitting');
    setError('');

    const form = new FormData(event.currentTarget);
    const payload = {
      id: requestIdRef.current,
      fullName: form.get('fullName'),
      role: form.get('role'),
      companyName: form.get('companyName'),
      email: form.get('email'),
      companySize: form.get('companySize'),
      monthlyUsage: form.get('monthlyUsage'),
      useCase: form.get('useCase'),
      turnstileToken,
    };

    try {
      const response = await fetch('/api/platform/v1/scale-inquiries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json() as { accepted?: boolean; error?: { message?: string } };
      if (!response.ok || !result.accepted) {
        throw new Error(result.error?.message ?? 'Your inquiry could not be sent. Please try again.');
      }
      setState('success');
    } catch (cause) {
      setState('error');
      setError(cause instanceof Error ? cause.message : 'Your inquiry could not be sent. Please try again.');
      if (widgetIdRef.current) window.turnstile?.reset(widgetIdRef.current);
      setTurnstileToken('');
    }
  };

  const turnstileRequired = Boolean(TURNSTILE_SITE_KEY);
  const canSubmit = securityReady && (!turnstileRequired || Boolean(turnstileToken));

  return (
    <>
      <button className='craft-pricing-cta' type='button' onClick={() => setOpen(true)}>
        Discuss Scale
        <ArrowRight size={13} weight='bold' aria-hidden='true' />
      </button>

      <dialog
        ref={dialogRef}
        className='craft-inquiry-dialog'
        aria-labelledby='craft-inquiry-title'
        onClose={close}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          close();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <div className='craft-inquiry-panel'>
          <button className='craft-inquiry-close' type='button' onClick={close} aria-label='Close inquiry form' autoFocus>
            <X size={17} aria-hidden='true' />
          </button>

          {state === 'success' ? (
            <div className='craft-inquiry-success' role='status'>
              <CheckCircle size={28} weight='fill' aria-hidden='true' />
              <h2 id='craft-inquiry-title'>Your inquiry is with us.</h2>
              <p>We will review your requirements and reply to your work email.</p>
              <button type='button' onClick={close}>Done</button>
            </div>
          ) : (
            <form onSubmit={submit}>
              <header className='craft-inquiry-head'>
                <h2 id='craft-inquiry-title'>Tell us what you need at scale.</h2>
                <p>Share a few details so we can respond with useful limits, pricing, and onboarding options.</p>
              </header>

              <div className='craft-inquiry-grid'>
                <label>
                  <span>Full name</span>
                  <input name='fullName' autoComplete='name' minLength={2} maxLength={100} required />
                </label>
                <label>
                  <span>Role</span>
                  <input name='role' autoComplete='organization-title' minLength={2} maxLength={100} required />
                </label>
                <label>
                  <span>Company</span>
                  <input name='companyName' autoComplete='organization' minLength={2} maxLength={120} required />
                </label>
                <label>
                  <span>Work email</span>
                  <input name='email' type='email' autoComplete='email' maxLength={254} required />
                </label>
                <label>
                  <span>Company size</span>
                  <select name='companySize' defaultValue='' required>
                    <option value='' disabled>Select a range</option>
                    <option value='1'>Just me</option>
                    <option value='2-10'>2-10 people</option>
                    <option value='11-50'>11-50 people</option>
                    <option value='51-200'>51-200 people</option>
                    <option value='201-1000'>201-1,000 people</option>
                    <option value='1000+'>More than 1,000</option>
                  </select>
                </label>
                <label>
                  <span>Expected monthly credits</span>
                  <select name='monthlyUsage' defaultValue='' required>
                    <option value='' disabled>Select a range</option>
                    <option value='under-10000'>Under 10,000</option>
                    <option value='10000-50000'>10,000-50,000</option>
                    <option value='50000-250000'>50,000-250,000</option>
                    <option value='250000-1000000'>250,000-1,000,000</option>
                    <option value='over-1000000'>More than 1,000,000</option>
                  </select>
                </label>
              </div>

              <label className='craft-inquiry-use-case'>
                <span>What are you building?</span>
                <textarea
                  name='useCase'
                  minLength={20}
                  maxLength={1200}
                  rows={4}
                  placeholder='Tell us how video data fits into your product or workflow.'
                  required
                />
              </label>

              {TURNSTILE_SITE_KEY ? <div className='craft-inquiry-turnstile' ref={widgetContainerRef} /> : null}
              {!securityReady ? (
                <p className='craft-inquiry-error' role='alert'>The security check is unavailable. Please refresh and try again.</p>
              ) : null}
              {state === 'error' && error ? <p className='craft-inquiry-error' role='alert'>{error}</p> : null}

              <footer className='craft-inquiry-footer'>
                <p>By submitting, you agree that we may contact you about this inquiry. See our <a href='/privacy'>privacy policy</a>.</p>
                <button type='submit' disabled={state === 'submitting' || !canSubmit}>
                  {state === 'submitting' ? 'Sending...' : 'Send inquiry'}
                  {state !== 'submitting' ? <ArrowRight size={13} weight='bold' aria-hidden='true' /> : null}
                </button>
              </footer>
            </form>
          )}
        </div>
      </dialog>
    </>
  );

  function removeWidget() {
    if (!widgetIdRef.current) return;
    window.turnstile?.remove(widgetIdRef.current);
    widgetIdRef.current = null;
  }
}
