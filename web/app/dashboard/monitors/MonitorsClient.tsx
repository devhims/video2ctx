'use client';
import { useEffect, useRef, useState } from 'react';
import { useErrorToast } from '../../../lib/use-error-toast';
import { useRouter } from 'next/navigation';
import { platformRequest as api } from '../../../lib/platform-request';
import { useAccountResource } from '../DashboardDataProvider';
import type { ResourceResult } from '../../../lib/dashboard-cache';
import type { Monitor, ChannelInfo } from '../research-types';
import { AddChannelForm } from './AddChannelForm';
import type { MonitorChannel } from '../../../lib/monitor-channels';
import { MonitorsView, monitorIntervalLabel, monitorQueryMetadata, isYouTubeChannelId } from './MonitorsView';
export function MonitorsClient({ promise }: { promise: Promise<ResourceResult<Monitor[]>> }) {
  const router = useRouter();
  const resource = useAccountResource('monitors', [], undefined, promise);
  const { data: monitors, setData: setMonitors } = resource;
  const [notice, setNotice] = useState(''),
    [savingId, setSavingId] = useState<string>();
  const [formVersion, setFormVersion] = useState(0);
  const { show: showLoadError, clear: clearLoadError } = useErrorToast();
  const { show: showActionError, clear: clearActionError } = useErrorToast();
  useEffect(() => {
    if (resource.error) showLoadError(resource.error, {
      duration: Infinity,
      action: { label: 'Retry monitors', onClick: () => { void resource.refresh(); } },
    });
    else clearLoadError();
    return clearLoadError;
  }, [resource.error, resource.refresh, showLoadError, clearLoadError]);
  const attempted = useRef(new Set<string>());
  useEffect(() => {
    const legacy = monitors.filter(
      (m) => isYouTubeChannelId(m.target) && !monitorQueryMetadata(m).label && !attempted.current.has(m.id),
    );
    legacy.forEach((m) => attempted.current.add(m.id));
    let cancelled = false;
    void Promise.all(
      legacy.map(async (m) => {
        try {
          const channel = await api<ChannelInfo>(
            `/v1/providers/${m.provider}/channels/${encodeURIComponent(m.target)}`,
          );
          const query = { label: channel.name, handle: channel.handle };
          await api(`/v1/monitors/${m.id}`, { method: 'PATCH', body: JSON.stringify({ query }) });
          return { id: m.id, query_json: JSON.stringify(query) };
        } catch {
          return null;
        }
      }),
    ).then((updates) => {
      if (!cancelled && updates.some(Boolean))
        setMonitors((items) => items.map((m) => ({ ...m, ...updates.find((u) => u?.id === m.id) })));
    });
    return () => {
      cancelled = true;
    };
  }, [monitors, setMonitors]);
  const addChannel = async (channel: MonitorChannel, intervalMinutes: number) => {
    if (monitors.some(monitor => monitor.provider === 'youtube' && monitor.kind === 'channel' && monitor.target === channel.id)) {
      throw new Error('This channel is already monitored. Change its frequency in the list below.');
    }
    const query = { label: channel.name, handle: channel.handle };
    const created = await api<{ id: string; intervalMinutes: number; nextCheckAt: number }>('/v1/monitors', {
      method: 'POST', body: JSON.stringify({ provider: 'youtube', kind: 'channel', target: channel.id, intervalMinutes, query }),
    });
    setMonitors(current => [{ id: created.id, provider: 'youtube', kind: 'channel', target: channel.id,
      query_json: JSON.stringify(query), interval_minutes: created.intervalMinutes, next_check_at: created.nextCheckAt, enabled: 1 }, ...current]);
    setFormVersion(version => version + 1); clearActionError();
    setNotice(`${channel.name} will be checked every ${monitorIntervalLabel(created.intervalMinutes)}. The first check establishes the starting point for new upload alerts.`);
  };
  const remove = async (id: string) => {
    try {
      await api(`/v1/monitors/${id}`, { method: 'DELETE' });
      setMonitors((items) => items.filter((m) => m.id !== id));
      setNotice('Monitor removed');
    } catch (cause) {
      showActionError(cause instanceof Error ? cause.message : 'Could not remove monitor.');
    }
  };
  const schedule = async (id: string, intervalMinutes: number) => {
    setSavingId(id);
    clearActionError();
    try {
      const next = await api<{ intervalMinutes: number; enabled: boolean; nextCheckAt?: number }>(
        `/v1/monitors/${id}`,
        { method: 'PATCH', body: JSON.stringify({ intervalMinutes }) },
      );
      setMonitors((items) =>
        items.map((m) =>
          m.id === id
            ? {
                ...m,
                interval_minutes: next.intervalMinutes,
                enabled: next.enabled ? 1 : 0,
                next_check_at: next.nextCheckAt,
              }
            : m,
        ),
      );
      setNotice(`This monitor will check for new videos every ${monitorIntervalLabel(next.intervalMinutes)}.`);
    } catch (cause) {
      showActionError(cause instanceof Error ? cause.message : 'Could not update the monitoring schedule.');
    } finally {
      setSavingId(undefined);
    }
  };
  return (
    <>
      {notice && (
        <div role='status' className='alert success'>
          {notice}
        </div>
      )}
      <MonitorsView
        monitors={monitors}
        ready={resource.ready}
        loading={resource.loading}
        savingId={savingId}
        addChannelForm={<AddChannelForm key={formVersion} monitors={monitors} monitorsReady={resource.ready} onAdd={addChannel} onCancel={() => { setFormVersion(version => version + 1); setNotice(''); clearActionError(); }} />}
        onOpenTarget={(target) => router.push(`/dashboard/sources?q=${encodeURIComponent(target)}`)}
        onSchedule={(id, n) => void schedule(id, n)}
        onRemove={(id) => void remove(id)}
      />
    </>
  );
}
