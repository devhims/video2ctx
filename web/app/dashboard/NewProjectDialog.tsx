'use client';
import { useRef, useEffect, useState } from 'react';
export function NewProjectDialog({ onClose,onCreate }: { onClose:()=>void;onCreate:(name:string)=>void }) { const dialogRef=useDialogFocus<HTMLFormElement>(onClose);const [name,setName]=useState('');return <div className='dialog-backdrop' onMouseDown={onClose}><form ref={dialogRef} className='dialog' role='dialog' aria-modal='true' aria-labelledby='new-project-title' onMouseDown={(event)=>event.stopPropagation()} onSubmit={(event)=>{event.preventDefault();if(name.trim())onCreate(name.trim());}}><button type='button' className='dialog-close' aria-label='Close new-project dialog' onClick={onClose}>×</button><p className='panel-label'>New project</p><h2 id='new-project-title'>Name this line of inquiry</h2><label className='field-label' htmlFor='project-name'>Project name</label><input id='project-name' autoFocus value={name} onChange={(event)=>setName(event.target.value)} placeholder='e.g. AI video research'/><button className='button primary' disabled={!name.trim()}>Create project</button></form></div>; }

function useDialogFocus<T extends HTMLElement>(onClose: () => void) {
  const dialogRef = useRef<T>(null);
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    window.requestAnimationFrame(() => {
      const preferred = dialog?.querySelector<HTMLElement>('input[autofocus], input, button:not(.dialog-close)');
      preferred?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')).filter((element) => !element.hidden);
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); previouslyFocused?.focus(); };
  }, [onClose]);
  return dialogRef;
}
