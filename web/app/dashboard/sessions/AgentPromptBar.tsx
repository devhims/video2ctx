'use client';

// Adapted from Beautiful UI's PromptBar, Copyright (c) 2026 Shane Levine.
// See web/licenses/beautiful-ui.txt for the MIT license.
import { useLayoutEffect, useRef, type FormEvent } from 'react';
import { ArrowUpIcon, ArrowClockwiseIcon, CircleNotchIcon, YoutubeLogoIcon } from '@phosphor-icons/react';

export function AgentPromptBar({ value, onChange, onSubmit, label, sendLabel, disabled, sending, uncertain, error }: {
  value: string; onChange: (value: string) => void; onSubmit: (event: FormEvent) => void;
  label: string; sendLabel: string; disabled: boolean; sending: boolean; uncertain: boolean; error: string;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const resize = () => {
      input.style.height = '0px';
      input.style.height = `${Math.min(Math.max(input.scrollHeight, 48), 160)}px`;
    };
    resize();
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth !== width) { width = input.clientWidth; resize(); }
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [value]);

  return <form className={`agent-composer${sending ? ' is-sending' : ''}`} onSubmit={onSubmit}>
    <div className='agent-prompt-bar'>
      <textarea ref={inputRef} rows={1} value={value} onChange={event => onChange(event.target.value)}
        aria-label={label} aria-describedby='agent-composer-help' maxLength={10_000}
        readOnly={sending || uncertain} placeholder={label === 'Follow-up message' ? 'Ask a follow-up…' : 'Ask about a video or YouTube channel…'}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            event.preventDefault();
            if (!disabled && !sending && value.trim()) event.currentTarget.form?.requestSubmit();
          }
        }} />
      <div className='agent-prompt-controls'>
        <span className='agent-prompt-context'><YoutubeLogoIcon size={16} aria-hidden='true' />YouTube</span>
        <span className='agent-prompt-shortcut' aria-hidden='true'>Shift + Enter for a new line</span>
        <button className='agent-send' type='submit' aria-label={sendLabel} title={sendLabel}
          disabled={disabled || sending || !value.trim()}>
          {sending ? <CircleNotchIcon size={19} className='agent-spin' aria-hidden='true' /> : uncertain
            ? <ArrowClockwiseIcon size={19} aria-hidden='true' /> : <ArrowUpIcon size={20} weight='bold' aria-hidden='true' />}
        </button>
      </div>
    </div>
    <p id='agent-composer-help' className='agent-composer-help'>{disabled ? 'A run is in progress. You can draft your next message.' : 'Enter to send. Each new request uses credits.'}</p>
    {error && <p className='alert error' role='alert'>{error}</p>}
  </form>;
}
