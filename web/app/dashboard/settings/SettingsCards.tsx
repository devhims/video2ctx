'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { platformRequest as api } from '../../../lib/platform-request';
import { authClient } from '../../../lib/auth-client';
import { canDeleteAccount, confirmDashboardEmailConsent, DEFAULT_NOTIFICATION_PREFERENCES, DELETE_ACCOUNT_CONFIRMATION, emailConsentToConfirm, pathWithoutEmailConsent, type DashboardBilling, type DashboardNotificationPreferences } from '../../../lib/dashboard-data';
import type { AccountSeeds } from '../../../lib/dashboard-cache';
import { useDashboardCache, useStreamedAccountResource } from '../DashboardDataProvider';
import { BuilderConfirmation } from './BuilderConfirmation';
import { useDashboardSession } from '../DashboardSessionProvider';
import { BillingSkeleton, PreferencesSkeleton } from './SettingsSkeleton';
import { useLoadErrorToast } from '../../../lib/use-error-toast';

export function BillingCard({ promise }: { promise: NonNullable<AccountSeeds['billing']> }) {
  const { user } = useDashboardSession();
  const email = user?.email;
  const resource = useStreamedAccountResource('billing', null, promise);
  const { data: billing, ready: billingReady, error: billingError } = resource;
  const cache = useDashboardCache();
  const [confirmation, setConfirmation] = useState<DashboardBilling | null>(null);
  const [confirmationAttempt, setConfirmationAttempt] = useState(0);
  const [canRetryConfirmation, setCanRetryConfirmation] = useState(false);
  const closeConfirmation = useCallback(() => setConfirmation(null), []);
  useLoadErrorToast(billingError, 'Retry billing', () => void resource.refresh());
  const [billingAction, setBillingAction] = useState<'checkout' | 'portal'>();
  const [billingMessage, setBillingMessage] = useState('');
  const manageSubscription = billing?.plan === 'builder' || billing?.needsBillingAttention;
  const startCheckout = async () => {
    if (billingAction) return;
    setBillingAction('checkout');
    setBillingMessage('');
    try {
      const result = await authClient.checkout({ slug: 'builder' });
      if (result.error) throw new Error(result.error.message ?? 'Could not start checkout.');
    } catch (cause) {
      setBillingMessage(cause instanceof Error ? cause.message : 'Could not start checkout.');
      setBillingAction(undefined);
    }
  };

  const openBillingPortal = async () => {
    if (billingAction) return;
    setBillingAction('portal');
    setBillingMessage('');
    try {
      const result = await authClient.customer.portal();
      if (result.error) throw new Error(result.error.message ?? 'Could not open billing management.');
    } catch (cause) {
      setBillingMessage(cause instanceof Error ? cause.message : 'Could not open billing management.');
      setBillingAction(undefined);
    }
  };

  useEffect(() => {
    const checkout = new URLSearchParams(window.location.search).get('checkout');
    if (checkout === 'cancelled') {
      setBillingMessage('Checkout was cancelled. Your current plan has not changed.');
      return;
    }
    if (checkout !== 'success') return;

    const controller = new AbortController();
    let timer: number | undefined;
    let attempts = 0;
    setCanRetryConfirmation(false);
    setBillingMessage('Confirming your Builder plan and credits...');
    const reconcile = async () => {
      attempts += 1;
      let failure = '';
      try {
        const next = await api<DashboardBilling>('/v1/billing', { cache: 'no-store', signal: controller.signal });
        if (controller.signal.aborted) return;
        cache.setBilling(next);
        if (next.plan === 'builder' && next.creditsReady === true) {
          setBillingMessage('Builder is active and your credit balance is ready.');
          const url = new URL(window.location.href);
          url.searchParams.delete('checkout');
          window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
          setConfirmation(next);
          return;
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        failure = cause instanceof Error ? cause.message : 'Could not confirm billing status.';
      }
      if (attempts < 8) timer = window.setTimeout(() => void reconcile(), 1_500);
      else {
        setBillingMessage(failure || 'Your upgrade is still syncing. Try confirming again in a moment.');
        setCanRetryConfirmation(true);
      }
    };
    void reconcile();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [cache, confirmationAttempt]);

  return <article className='mb-6 grid grid-cols-[minmax(0,1fr)_minmax(15rem,22rem)] items-center gap-10 rounded-[var(--radius-dashboard-md)] border border-[var(--color-dashboard-rule)] bg-[var(--color-dashboard-surface)] p-6 max-[43.75rem]:grid-cols-1' aria-labelledby='billing-settings-heading'>
      {!billingReady && billingError ? <p className='settings-card-copy'>Billing details are unavailable.</p> : !billingReady ? <BillingSkeleton contentsOnly /> : <>

      <div>
        <span className='panel-label'>Billing</span>
        <h3 className='settings-card-title mt-2 mb-0' id='billing-settings-heading'>{billing?.plan === 'builder' ? 'Builder plan' : 'Starter plan'}</h3>
        <p className='settings-card-copy mt-2 mb-0 max-w-[65ch]'>{billing?.needsBillingAttention
          ? 'Your subscription needs payment attention. Open Manage billing to review it or update your payment details.'
          : billing?.plan === 'builder'
          ? `${formatNumber(billing.creditBalance)} credits available from a ${formatNumber(billing.includedCredits)} credit monthly allowance.`
          : 'Includes 1,000 onboarding credits. Upgrade to Builder for a 10,000 credit monthly allowance and higher workspace limits.'}</p>
        {billing?.plan === 'builder' && billing.currentPeriodEnd && <p className='settings-save-status mt-3' role='status'>{billing.cancelAtPeriodEnd
          ? `Builder remains active until ${formatBillingDate(billing.currentPeriodEnd)}.`
          : `Next renewal: ${formatBillingDate(billing.currentPeriodEnd)}.`}</p>}
        {billingMessage && <p className='settings-save-status mt-3' role='status' aria-live='polite'>{billingMessage}</p>}
        {canRetryConfirmation && <button className='button secondary mt-3' onClick={() => setConfirmationAttempt(attempt => attempt + 1)}>Retry confirmation</button>}
      </div>
      <div className='grid gap-2'>
        {!manageSubscription && <button className='button primary min-h-11' disabled={Boolean(billingAction) || !email} onClick={() => void startCheckout()}>{billingAction === 'checkout' ? 'Opening checkout...' : 'Upgrade to Builder'}</button>}
        {(manageSubscription || billing?.canManageBilling) && <button className='button secondary min-h-11' disabled={Boolean(billingAction)} onClick={() => void openBillingPortal()}>{billingAction === 'portal' ? 'Opening billing...' : manageSubscription ? 'Manage billing' : 'Billing history'}</button>}
      </div>
      </>}
      {confirmation && <BuilderConfirmation billing={confirmation} onClose={closeConfirmation} />}
    </article>;
}

export function PreferencesCard({ promise, emailConsent }: { promise: NonNullable<AccountSeeds['notificationPreferences']>; emailConsent?: string }) {
  const { user } = useDashboardSession();
  const email = user?.email;
  const resource = useStreamedAccountResource('notificationPreferences', DEFAULT_NOTIFICATION_PREFERENCES, promise);
  const { data: preferences, ready: preferencesReady, error: preferencesError, setData: onPreferencesChange } = resource;
  useLoadErrorToast(preferencesError, 'Retry notification preferences', () => void resource.refresh());
  const [preferenceSaving, setPreferenceSaving] = useState<'inApp' | 'emailAlerts'>();
  const [preferenceMessage, setPreferenceMessage] = useState('');
  const [confirmationState, setConfirmationState] = useState<'idle' | 'confirming' | 'success' | 'error'>('idle');
  const [confirmationMessage, setConfirmationMessage] = useState('');
  const attemptedEmailConsent = useRef<string | undefined>(undefined);
  const savePreference = async (key: 'inApp' | 'emailAlerts', value: boolean) => {
    const previous = preferences;
    const next = key === 'emailAlerts' && value
      ? { ...preferences, emailAlerts: false, emailAlertsPending: true }
      : { ...preferences, [key]: value, ...(key === 'emailAlerts' ? { emailAlertsPending: false } : {}) };
    onPreferencesChange(next);
    setPreferenceSaving(key);
    setPreferenceMessage('');
    try {
      const saved = await api<DashboardNotificationPreferences>('/v1/notification-preferences', {
        method: 'PUT', body: JSON.stringify({ [key]: value }),
      });
      onPreferencesChange(saved);
      setPreferenceMessage(key === 'emailAlerts' && value
        ? `Confirmation sent to ${email}. Email alerts remain off until you approve them.`
        : 'Notification preferences saved.');
    } catch (cause) {
      onPreferencesChange(previous);
      setPreferenceMessage(cause instanceof Error ? cause.message : 'Could not save notification preferences.');
    } finally {
      setPreferenceSaving(undefined);
    }
  };

  const confirmEmailDelivery = useCallback(async (confirmationToken: string) => {
    setConfirmationState('confirming');
    setConfirmationMessage('');
    try {
      const saved = await confirmDashboardEmailConsent(
        (path, options) => api<DashboardNotificationPreferences>(path, options),
        confirmationToken,
      );
      onPreferencesChange(saved);
      setConfirmationState('success');
      setConfirmationMessage(`Email alerts are now enabled for ${email}.`);
      window.history.replaceState(null, '', pathWithoutEmailConsent(window.location.pathname, window.location.search));
    } catch (cause) {
      setConfirmationState('error');
      setConfirmationMessage(cause instanceof Error ? cause.message : 'Could not confirm email alerts.');
    }
  }, [email, onPreferencesChange]);

  useEffect(() => {
    const confirmationToken = emailConsentToConfirm(
      emailConsent,
      email,
      preferencesReady,
      attemptedEmailConsent.current,
    );
    if (!confirmationToken) return;
    attemptedEmailConsent.current = confirmationToken;
    if (preferences.emailAlerts) {
      setConfirmationState('success');
      setConfirmationMessage(`Email alerts are already enabled for ${email}.`);
      window.history.replaceState(null, '', pathWithoutEmailConsent(window.location.pathname, window.location.search));
      return;
    }
    void confirmEmailDelivery(confirmationToken);
  }, [preferencesReady, confirmEmailDelivery, email, emailConsent, preferences.emailAlerts]);

  return <article className='settings-notification-card' aria-labelledby='notification-settings-heading'>
      <div className='settings-notification-intro'>
        <h3 className='settings-card-title' id='notification-settings-heading'>Notifications</h3>
        <p className='settings-card-copy'>Updates from your monitors.</p>
      </div>
      <div className='settings-toggle-list'>
        {!preferencesReady && preferencesError ? <p className='settings-card-copy'>Notification preferences are unavailable.</p> : !preferencesReady ? <PreferencesSkeleton contentsOnly /> : <>

        {confirmationState !== 'idle' && <div className='settings-email-confirmation' data-state={confirmationState} role={confirmationState === 'error' ? 'alert' : 'status'} aria-live='polite'>
          <span><strong>{confirmationState === 'confirming' ? 'Confirming email alerts…' : confirmationState === 'success' ? 'Email alerts enabled' : 'Email confirmation failed'}</strong><small>{confirmationState === 'confirming' ? <>Checking the approval for <b>{email}</b>.</> : confirmationMessage}</small></span>
        </div>}
        <label className='settings-toggle-row'>
          <span><strong>In-app alerts</strong><small>Show new monitor matches in the notification inbox.</small></span>
          <input type='checkbox' role='switch' checked={preferences.inApp} disabled={Boolean(preferenceSaving)} onChange={(event) => void savePreference('inApp', event.target.checked)} />
          <i aria-hidden='true' />
        </label>
        <label className='settings-toggle-row' data-disabled={!email}>
          <span><strong>Email alerts</strong><small>{email
            ? preferences.emailAlerts
              ? <>Confirmed for <b>{email}</b>. New monitor matches can be emailed immediately.</>
              : preferences.emailAlertsPending
                ? <>Waiting for confirmation from <b>{email}</b>. Monitor emails remain off.</>
                : <>Off by default. Enabling sends a confirmation message to <b>{email}</b>.</>
            : 'Sign in with an account to enable email delivery.'}</small></span>
          <input type='checkbox' role='switch' checked={Boolean(email && (preferences.emailAlerts || preferences.emailAlertsPending))} disabled={!email || Boolean(preferenceSaving)} onChange={(event) => void savePreference('emailAlerts', event.target.checked)} />
          <i aria-hidden='true' />
        </label>
        {preferences.emailAlertsPending && email && <button className='settings-resend-confirmation' type='button' disabled={Boolean(preferenceSaving)} onClick={() => void savePreference('emailAlerts', true)}>Resend confirmation email</button>}
        {preferenceMessage && <p className='settings-save-status' role='status'>{preferenceMessage}</p>}
        </>}
      </div>
    </article>;
}

export function AccountCards() {
  const { user } = useDashboardSession();
  const email = user?.email;
  const [confirmation, setConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const confirmed = canDeleteAccount(confirmation);
  const deleteAccount = async () => {
    if (!email || !confirmed || deleting) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await api<void>('/v1/account', { method: 'DELETE' });
      window.location.replace('/');
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : 'Could not delete your account.');
      setDeleting(false);
    }
  };

  return <>
    <article className='grid grid-cols-[minmax(0,1fr)_auto] items-center gap-10 rounded-[var(--radius-dashboard-md)] border border-[var(--color-dashboard-rule)] bg-[var(--color-dashboard-surface)] p-6 max-[43.75rem]:grid-cols-1'>
      <div><span className='panel-label'>Signed-in account</span><h3 className='settings-card-title mt-2 mb-0'>{email ?? 'Local demo account'}</h3></div>
      <Link className='button secondary no-underline max-[43.75rem]:w-full' href='/dashboard/developer'>Manage API keys</Link>
    </article>
    <article className='mt-6 grid grid-cols-[minmax(0,1fr)_minmax(17rem,24rem)] items-start gap-10 rounded-[var(--radius-dashboard-md)] border border-[color-mix(in_srgb,var(--color-dashboard-danger)_45%,var(--color-dashboard-rule))] bg-[color-mix(in_srgb,var(--color-dashboard-danger)_4%,var(--color-dashboard-surface))] p-6 max-[43.75rem]:grid-cols-1' aria-labelledby='delete-account-heading'>
      <div>
        <span className='panel-label !text-[var(--color-dashboard-danger)]'>Danger zone</span>
        <h3 className='settings-card-title mt-2 mb-0' id='delete-account-heading'>Delete account permanently</h3>
        <p className='settings-card-copy mt-2 mb-0 max-w-[65ch]'>This removes your projects, saved research, monitors, API keys, credit history, and connected accounts. This action cannot be undone.</p>
      </div>
      {email ? <div className='grid gap-2'>
        <label className='settings-confirm-label' htmlFor='delete-account-confirmation'>Type <strong>{DELETE_ACCOUNT_CONFIRMATION}</strong> to confirm</label>
        <input
          className='settings-confirm-input min-h-11 rounded-[var(--radius-dashboard-sm)] border border-[var(--color-dashboard-rule-strong)] bg-[var(--color-dashboard-surface)] px-3 text-[var(--color-dashboard-ink)]'
          id='delete-account-confirmation'
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete='off'
          spellCheck={false}
          placeholder={DELETE_ACCOUNT_CONFIRMATION}
          aria-describedby='delete-account-help'
          disabled={deleting}
        />
        <small className='text-[.7rem] text-[var(--color-dashboard-muted)]' id='delete-account-help'>The confirmation is case-sensitive.</small>
        <button className='settings-delete-button mt-2 min-h-11 cursor-pointer rounded-[var(--radius-dashboard-sm)] border border-[var(--color-dashboard-danger)] bg-[var(--color-dashboard-danger)] text-white hover:brightness-90 disabled:cursor-not-allowed disabled:opacity-45' disabled={!confirmed || deleting} onClick={() => void deleteAccount()}>
          {deleting ? 'Deleting account…' : 'Delete account permanently'}
        </button>
        {deleteError && <p className='alert error' role='alert'>{deleteError}</p>}
      </div> : <p className='settings-danger-message mt-2 mb-0 max-w-[65ch]'>Account deletion is unavailable for the local demo identity.</p>}
    </article>
  </>;
}

function formatNumber(value:unknown){const number=Number(value);return Number.isFinite(number)?Intl.NumberFormat('en',{notation:'compact'}).format(number):'—';}
function formatBillingDate(timestamp:number){return new Date(timestamp).toLocaleDateString([],{dateStyle:'medium'});}
