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
