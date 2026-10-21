'use client';

import { useState } from 'react';
import { useDialogFocus } from './use-dialog-focus';

export function NewProjectDialog({ onClose, onCreate, error }: {
  onClose: () => void;
  onCreate: (name: string) => Promise<boolean>;
  error: string;
}) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const close = () => { if (!creating) onClose(); };
  const dialogRef = useDialogFocus<HTMLFormElement>(close);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    const succeeded = await onCreate(trimmed);
    if (!succeeded) setCreating(false);
  };

  return <div className='dialog-backdrop' onMouseDown={close}>
    <form
      ref={dialogRef}
      className='dialog new-project-dialog'
      role='dialog'
      aria-modal='true'
      aria-labelledby='new-project-title'
      aria-busy={creating}
      onMouseDown={event => event.stopPropagation()}
      onSubmit={event => { event.preventDefault(); void create(); }}
    >
      <button type='button' className='dialog-close' aria-label='Close new-project dialog' disabled={creating} onClick={close}>×</button>
      <h2 id='new-project-title'>New project</h2>
      <p className='new-project-description'>Keep related sources in one place.</p>
      <label className='field-label' htmlFor='project-name'>Name</label>
      <input id='project-name' autoFocus maxLength={120} value={name} disabled={creating} onChange={event => setName(event.target.value)} placeholder='e.g. AI video research' />
      {error && <p className='new-project-error' role='alert'>{error}</p>}
      <button className='button primary' disabled={!name.trim() || creating}>
        {creating && <span className='status-spinner' aria-hidden='true' />}
        {creating ? 'Creating…' : 'Create'}
      </button>
    </form>
  </div>;
}
