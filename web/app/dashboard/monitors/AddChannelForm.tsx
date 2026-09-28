'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { platformRequest, isAbortError } from '../../../lib/platform-request';
import { findMonitorChannels, type MonitorChannel } from '../../../lib/monitor-channels';
import type { Monitor } from '../research-types';
import { MONITOR_INTERVAL_OPTIONS } from './MonitorsView';
import pageStyles from '../DashboardPages.module.css';
import styles from './AddChannelForm.module.css';

export function AddChannelForm({ monitors, monitorsReady = true, onAdd, onCancel }: {
  monitors: Monitor[]; monitorsReady?: boolean; onAdd: (channel: MonitorChannel, interval: number) => Promise<void>; onCancel: () => void;
}) {
  const [input, setInput] = useState('');
  const [channels, setChannels] = useState<MonitorChannel[]>([]);
  const [selected, setSelected] = useState<MonitorChannel | null>(null);
  const [interval, setInterval] = useState(1440);
  const [searched, setSearched] = useState(false), [searching, setSearching] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const savingRef = useRef(false);
  useEffect(() => () => controller.current?.abort(), []);
  const alreadyMonitored = (id: string) => monitors.some(monitor => monitor.provider === 'youtube' && monitor.kind === 'channel' && monitor.target === id);
  const search = async (event: FormEvent) => {
    event.preventDefault();
    if (!input.trim() || savingRef.current) return;
    controller.current?.abort();
    const next = new AbortController(); controller.current = next;
    setSearching(true); setError(''); setSelected(null); setChannels([]); setSearched(false);
    try {
      const found = await findMonitorChannels(input, platformRequest, next.signal);
      if (next.signal.aborted) return;
      setChannels(found); setSearched(true);
      if (found.length === 1) setSelected(found[0]);
    } catch (cause) { if (!isAbortError(cause) && !next.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not find channels.'); }
    finally { if (!next.signal.aborted) setSearching(false); }
  };
  const add = async () => {
    if (!monitorsReady || !selected || alreadyMonitored(selected.id) || savingRef.current) return;
    savingRef.current = true; setSaving(true); setError('');
    try { await onAdd(selected, interval); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add channel.'); }
    finally { savingRef.current = false; setSaving(false); }
  };
  return <section className={styles.panel} aria-label='Add channel'>
    <form className={styles.lookup} onSubmit={event => void search(event)}>
      <label htmlFor='monitor-channel-input'>Channel name, handle, or URL</label>
      <div className={styles.searchRow}>
        <input id='monitor-channel-input' autoFocus maxLength={500} placeholder='e.g. @veritasium or a YouTube channel URL' value={input} disabled={saving} onChange={event => {
          controller.current?.abort(); setSearching(false); setInput(event.target.value); setSelected(null); setChannels([]); setSearched(false); setError('');
        }} />
        <button className={pageStyles.primaryAction} disabled={!input.trim() || searching || saving}>{searching ? 'Finding…' : 'Find channel'}</button>
      </div>
    </form>
    {error && <div className='alert error' role='alert'>{error}</div>}
    {searching && <p role='status'>Finding YouTube channels…</p>}
    {searched && !channels.length && <p role='status'>No channels found. Try a channel URL or @handle.</p>}
    {channels.length > 0 && <fieldset className={styles.results} disabled={saving}><legend>Select a channel</legend>{channels.map(channel => <label key={channel.id} className={styles.channel}>
      <input type='radio' name='monitor-channel' value={channel.id} checked={selected?.id === channel.id} onChange={() => setSelected(channel)} />
      <span><strong>{channel.name}</strong><small>{channel.handle || channel.id}{alreadyMonitored(channel.id) ? ' · Already monitored' : ''}</small></span>
    </label>)}</fieldset>}
    {selected && <div className={pageStyles.monitorSchedule}><label><span>Check every</span><select aria-label='Check channel every' value={interval} disabled={saving} onChange={event => setInterval(Number(event.target.value))}>
      {MONITOR_INTERVAL_OPTIONS.map(option => <option key={option.minutes} value={option.minutes}>{option.label}</option>)}
    </select></label></div>}
    <div className={styles.actions}>
      <button type='button' className={pageStyles.primaryAction} disabled={!monitorsReady || !selected || alreadyMonitored(selected.id) || saving} onClick={() => void add()}>{saving ? 'Adding…' : 'Add channel'}</button>
      <button type='button' className={pageStyles.textAction} disabled={saving} onClick={onCancel}>Cancel</button>
    </div>
  </section>;
}
