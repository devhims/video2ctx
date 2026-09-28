import type { ProjectDetail } from '../app/dashboard/research-types.ts';

type Snapshot = { data?: ProjectDetail; loading: boolean; error: string; updatedAt: number };
const EMPTY: Snapshot = { loading: false, error: '', updatedAt: 0 };
const FRESH_MS = 60_000;

// Owned by the account-keyed dashboard provider, never shared across users.
export function createProjectDetailCache(request: (path: string) => Promise<unknown>) {
  const entries = new Map<string, Snapshot>();
  const pending = new Map<string, Promise<void>>();
  const versions = new Map<string, number>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(listener => listener());
  const read = (id: string | null): Snapshot => id ? entries.get(id) ?? EMPTY : EMPTY;
  function load(id: string, force = false): Promise<void> {
    if (!force && pending.has(id)) return pending.get(id)!;
    const previous = read(id);
    if (!force && previous.updatedAt && Date.now() - previous.updatedAt < FRESH_MS) return Promise.resolve();
    const version = (versions.get(id) ?? 0) + 1;
    versions.set(id, version);
    entries.set(id, { ...previous, loading: true, error: '' });
    const task = Promise.resolve().then(async () => {
      try {
        const data = await request(`/v1/projects/${encodeURIComponent(id)}`) as ProjectDetail;
        if (versions.get(id) === version) entries.set(id, { data, loading: false, error: '', updatedAt: Date.now() });
      } catch (cause) {
        const status = (cause as { status?: number } | null)?.status;
        if (versions.get(id) === version) entries.set(id, {
          ...([401, 403, 404].includes(status ?? 0) ? EMPTY : previous), loading: false,
          error: cause instanceof Error ? cause.message : 'Could not load saved sources.',
        });
      } finally {
        if (versions.get(id) === version) pending.delete(id);
        emit();
      }
    });
    pending.set(id, task);
    emit();
    return task;
  }
  return {
    read, load,
    // A completed mutation supersedes any read that started before it.
    invalidate(id: string) { return entries.has(id) ? load(id, true) : Promise.resolve(); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
