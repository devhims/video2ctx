'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { platformRequest as api } from '../../../lib/platform-request';
import { useStreamedAccountResource } from '../DashboardDataProvider';
import type { ResourceResult } from '../../../lib/dashboard-cache';
import type { Monitor, ChannelInfo } from '../research-types';
import { MonitorsView, monitorIntervalLabel, monitorQueryMetadata, isYouTubeChannelId } from './MonitorsView';
export function MonitorsClient({ promise }: { promise: Promise<ResourceResult<Monitor[]>> }) {
  const router = useRouter();
  const resource = useStreamedAccountResource('monitors', [], promise);
  const { data: monitors, setData: setMonitors } = resource;
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [savingId, setSavingId] = useState<string>();
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
  const remove = async (id: string) => {
    try {
      await api(`/v1/monitors/${id}`, { method: 'DELETE' });
      setMonitors((items) => items.filter((m) => m.id !== id));
      setNotice('Monitor removed');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove monitor.');
    }
  };
  const schedule = async (id: string, intervalMinutes: number) => {
    setSavingId(id);
    setError('');
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
      setError(cause instanceof Error ? cause.message : 'Could not update the monitoring schedule.');
    } finally {
      setSavingId(undefined);
    }
  };
  return (
    <>
      {(error || resource.error) && (
        <div role='alert' className='alert error'>
          {error || resource.error}
          {resource.error && <button onClick={() => void resource.refresh()}>Retry monitors</button>}
        </div>
      )}
      {notice && (
        <div role='status' className='alert success'>
          {notice}
        </div>
      )}
      {resource.ready && (
        <MonitorsView
          monitors={monitors}
          savingId={savingId}
          onFindSource={() => router.push('/dashboard/sources')}
          onOpenTarget={(target) => router.push(`/dashboard/sources?q=${encodeURIComponent(target)}`)}
          onSchedule={(id, n) => void schedule(id, n)}
          onRemove={(id) => void remove(id)}
        />
      )}
    </>
  );
}
