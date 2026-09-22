'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { platformRequest as api, isAbortError } from '../../../lib/platform-request';
import { useDashboardDraft, useStreamedAccountResource } from '../DashboardDataProvider';
import type { ResourceResult } from '../../../lib/dashboard-cache';
import type { Project, ProjectDetail } from '../research-types';
import { ProjectsView } from './ProjectsView';
import { NewProjectDialog } from '../NewProjectDialog';
export function ProjectsClient({ promise }: { promise: Promise<ResourceResult<Project[]>> }) {
  const router = useRouter(),
    params = useSearchParams();
  const resource = useStreamedAccountResource('projects', [], promise);
  const [selected, setSelected] = useDashboardDraft<ProjectDetail | null>('selected-project', null);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [create, setCreate] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const open = useCallback(
    async (project: Project) => {
      controller.current?.abort();
      const next = new AbortController();
      controller.current = next;
      setSelected(null);
      setLoading(true);
      setError('');
      try {
        setSelected(
          await api<ProjectDetail>(`/v1/projects/${encodeURIComponent(project.id)}`, { signal: next.signal }),
        );
      } catch (cause) {
        if (!isAbortError(cause)) setError(cause instanceof Error ? cause.message : 'Could not open this project.');
      } finally {
        if (controller.current === next) setLoading(false);
      }
    },
    [setSelected],
  );
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const id = params.get('project'),
      newProject = params.get('newProject');
    if (id) void open({ id, name: '' });
    if (newProject) setCreate(true);
    if (id || newProject) router.replace('/dashboard/projects', { scroll: false });
  }, [params, open, router]);
  const add = async (name: string) => {
    try {
      await api('/v1/projects', { method: 'POST', body: JSON.stringify({ name }) });
      await resource.refresh();
      setCreate(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create project.');
    }
  };
  return (
    <>
      {resource.error && (
        <div className='alert error' role='alert'>
          {resource.error} <button onClick={() => void resource.refresh()}>Retry projects</button>
        </div>
      )}
      {resource.ready && (
        <ProjectsView
          projects={resource.data}
          selectedProject={selected}
          loading={loading}
          error={error}
          onCreate={() => setCreate(true)}
          onOpen={(p) => void open(p)}
          onBack={() => {
            setSelected(null);
            setError('');
          }}
          onFindSources={() => router.push('/dashboard/sources')}
          onOpenItem={(item) =>
            router.push(`/dashboard/sources?type=${item.entity_type}&id=${encodeURIComponent(item.entity_id)}`)
          }
        />
      )}
      {create && (
        <>
          <NewProjectDialog onClose={() => setCreate(false)} onCreate={(name) => void add(name)} />
          {error && <p role='alert'>{error}</p>}
        </>
      )}
    </>
  );
}
