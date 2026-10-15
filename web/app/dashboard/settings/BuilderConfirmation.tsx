'use client';

import { useEffect, useRef } from 'react';
import { CheckCircleIcon, XIcon } from '@phosphor-icons/react';
import type { DashboardBilling } from '../../../lib/dashboard-data';
import { burstConfetti, whenSettled } from '../confetti';
import styles from './BuilderConfirmation.module.css';

const number = new Intl.NumberFormat('en-US');

export function BuilderConfirmation({ billing, onClose }: { billing: DashboardBilling; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const celebrated = useRef(false);
  const continueButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    continueButton.current?.focus();
    let clearConfetti = () => {};
    const cancelSettled = whenSettled('[data-builder-confirmation]', rect => {
      if (!dialog.open || !dialog.isConnected || celebrated.current) return;
      celebrated.current = true;
      // Mount inside the native dialog so the burst shares its top layer.
      clearConfetti = burstConfetti(rect.left + rect.width / 2, rect.top + 90, dialog);
    });
    return () => {
      cancelSettled();
      clearConfetti();
      dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return <dialog ref={ref} className={styles.dialog} data-builder-confirmation
    aria-labelledby='builder-confirmation-title' aria-describedby='builder-confirmation-description'
    onClose={event => {
      // Strict Mode can queue a cleanup close event before reopening the dialog.
      if (!event.currentTarget.open) onClose();
    }} onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button');
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    }} onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.currentTarget.close();
    }}>
    <div className={styles.content}>
      <button type='button' className={styles.close} aria-label='Close Builder confirmation' onClick={() => ref.current?.close()}><XIcon size={20} aria-hidden='true' /></button>
      <CheckCircleIcon className={styles.icon} size={42} weight='fill' aria-hidden='true' />
      <h2 id='builder-confirmation-title'>Welcome to Builder!</h2>
      <p id='builder-confirmation-description'>Your upgrade is confirmed. Your plan and credits are ready to use.</p>
      <div className={styles.credits}>
        <span>Available now</span>
        <strong>{number.format(billing.creditBalance)}</strong>
        <span>credits</span>
      </div>
      <p className={styles.allowance}>Your plan includes a {number.format(billing.includedCredits)} credit monthly allowance.</p>
      <button ref={continueButton} type='button' className={`button primary ${styles.continue}`} onClick={() => ref.current?.close()}>Continue building</button>
    </div>
  </dialog>;
}
