"use client";

import { useCallback, useEffect, useRef } from 'react';
import { toast, type ExternalToast } from 'sonner';

export function useErrorToast() {
  const current = useRef<string | number | undefined>(undefined);
  const clear = useCallback(() => {
    if (current.current !== undefined) toast.dismiss(current.current);
    current.current = undefined;
  }, []);
  const show = useCallback((message: string, options?: ExternalToast) => {
    clear();
    // A fresh ID prevents a queued dismissal from hiding a quick retry's error.
    current.current = toast.error(message, options);
  }, [clear]);
  useEffect(() => clear, [clear]);
  return { show, clear };
}

/**
 * Shows a background load failure as a persistent toast with a retry action.
 * Errors from the user's own action stay inline, next to what they did.
 */
export function useLoadErrorToast(error: string | null | undefined, retryLabel: string, retry: () => void) {
  const { show, clear } = useErrorToast();
  const retryRef = useRef(retry);
  useEffect(() => { retryRef.current = retry; });
  useEffect(() => {
    if (error) show(error, { duration: Infinity, action: { label: retryLabel, onClick: () => retryRef.current() } });
    else clear();
  }, [error, retryLabel, show, clear]);
}
