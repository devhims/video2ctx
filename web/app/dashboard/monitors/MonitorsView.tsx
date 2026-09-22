'use client';
import { Icon } from '../DashboardSidebar';
import pageStyles from '../DashboardPages.module.css';
import type {Monitor} from '../research-types';
const MONITOR_INTERVAL_OPTIONS = [
  { minutes: 60, label: 'Hour' },
  { minutes: 360, label: '6 hours' },
  { minutes: 720, label: '12 hours' },
  { minutes: 1440, label: '24 hours' },
  { minutes: 4320, label: '3 days' },
  { minutes: 10080, label: 'Week' },
] as const;


export function MonitorsView({ monitors, knownChannel, savingId, onFindSource, onOpenTarget, onSchedule, onRemove }: { monitors: Monitor[]; knownChannel?: { id: string; name: string; handle?: string }; savingId?: string; onFindSource:()=>void; onOpenTarget:(target:string)=>void; onSchedule:(id:string, intervalMinutes:number)=>void; onRemove:(id:string)=>void }) {
  const activeCount = monitors.filter(monitor => monitor.enabled).length;
  return <section className='content-section standalone monitor-section'>
    <header className={pageStyles.pageHeading}><div className={pageStyles.intro}><h2>Watch for new videos</h2><p>Get updates from channels and searches you follow.</p></div><button className={pageStyles.primaryAction} onClick={onFindSource}><Icon name='plus' size={15} />Find a source</button></header>
    <div className={pageStyles.listHeading}><h3>Monitors <span>{monitors.length}</span></h3><span>{activeCount} active</span></div>
    <div className={pageStyles.recordList}>{monitors.map(monitor => {
      const details = monitorDetails(monitor, knownChannel);
      const channelWatch = monitor.kind === 'channel' || isYouTubeChannelId(monitor.target);
      return <article className={pageStyles.monitorRow} key={monitor.id}>
        <span className={pageStyles.rowIcon}><Icon name={channelWatch ? 'monitor' : 'search'} size={19} /></span>
        <div className={pageStyles.recordCopy}><div className={pageStyles.monitorTitle}><h3>{details.label}</h3><span data-active={Boolean(monitor.enabled)}>{monitor.enabled ? 'Active' : 'Paused'}</span></div><small>{[channelWatch ? 'Channel' : 'Search', details.handle].filter(Boolean).join(' · ')}</small><p>{monitorStatusText(monitor)}</p>
          <div className={pageStyles.rowActions}><button className={pageStyles.textAction} onClick={() => onOpenTarget(details.label)}>Open in Sources ↗</button>{channelWatch && <a href={`https://www.youtube.com/channel/${encodeURIComponent(monitor.target)}`} target='_blank' rel='noreferrer'>YouTube ↗</a>}</div>
        </div>
        <div className={pageStyles.monitorSchedule}><label><span>Check every</span><select aria-label={`Monitoring frequency for ${details.label}`} value={monitor.interval_minutes ?? 1440} disabled={savingId === monitor.id} onChange={event => onSchedule(monitor.id, Number(event.target.value))}>{MONITOR_INTERVAL_OPTIONS.map(option => <option key={option.minutes} value={option.minutes}>{option.label}</option>)}</select></label><button className={pageStyles.deleteMonitor} aria-label={`Delete monitor for ${details.label}`} title='Delete monitor' onClick={() => onRemove(monitor.id)}><Icon name='trash' size={16} /></button></div>
      </article>;
    })}</div>
    {!monitors.length && <div className={pageStyles.emptyState}><span className={pageStyles.rowIcon}><Icon name='monitor' size={21} /></span><div><h3>No monitors yet</h3><p>Open a video and select Monitor channel to get new upload alerts.</p></div></div>}
  </section>;
}

export function monitorIntervalLabel(intervalMinutes: number): string {
  if (intervalMinutes === 60) return 'hour';
  if (intervalMinutes < 1440) return `${intervalMinutes / 60} hours`;
  if (intervalMinutes === 1440) return '24 hours';
  if (intervalMinutes === 10080) return 'week';
  return `${intervalMinutes / 1440} days`;
}

function monitorStatusText(monitor: Monitor): string {
  const next = monitor.next_check_at ? new Date(monitor.next_check_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : undefined;
  if (!monitor.last_checked_at) return next ? `First check ${next}` : `Runs every ${monitorIntervalLabel(monitor.interval_minutes ?? 1440)}.`;
  const last = new Date(monitor.last_checked_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  return next ? `Last checked ${last} · Next ${next}` : `Last checked ${last}`;
}

function monitorDetails(monitor: Monitor, knownChannel?: { id: string; name: string; handle?: string }): { label: string; handle?: string } {
  const query = monitorQueryMetadata(monitor);
  if (query.label) return { label: query.label, handle: query.handle };
  if (knownChannel?.id === monitor.target) return { label: knownChannel.name, handle: knownChannel.handle };
  return { label: isYouTubeChannelId(monitor.target) ? 'YouTube channel' : monitor.target };
}

export function monitorQueryMetadata(monitor: Monitor): { label?: string; handle?: string } {
  let query: { label?: string; handle?: string } = {};
  try {
    const parsed = monitor.query_json ? JSON.parse(monitor.query_json) as unknown : {};
    query = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as typeof query : {};
  } catch { query = {}; }
  return query;
}

export function isYouTubeChannelId(value: string): boolean {
  return /^UC[A-Za-z0-9_-]{22}$/.test(value);
}
