import { useEffect, useRef } from 'react';

/** Focuses a dialog's first field, keeps Tab inside it, closes on Escape, and restores focus on unmount. */
export function useDialogFocus<T extends HTMLElement>(onClose: () => void) {
  const dialogRef = useRef<T>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    window.requestAnimationFrame(() => {
      const preferred = dialog?.querySelector<HTMLElement>('input[autofocus], input, button:not(.dialog-close)');
      preferred?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')).filter(element => !element.hidden);
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!focusable.includes(active as HTMLElement)) {
        // Focus sits on a non-tabbable anchor, such as a step heading, or has left the dialog.
        // Native Tab order from there can escape, so pick the neighbour ourselves.
        event.preventDefault();
        const inside = active instanceof Node && dialog.contains(active);
        const after = (element: HTMLElement) => inside && Boolean(active.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
        (event.shiftKey ? focusable.filter(element => inside && !after(element)).at(-1) ?? last : focusable.find(after) ?? first).focus();
        return;
      }
      if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); previouslyFocused?.focus(); };
  }, []);
  return dialogRef;
}
