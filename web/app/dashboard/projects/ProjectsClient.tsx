'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { platformRequest as api, isAbortError } from '../../../lib/platform-request';
import { useDashboardDraft, useStreamedAccountResource } from '../DashboardDataProvider';
import type { ResourceResult } from '../../../lib/dashboard-cache';
import type { Project, ProjectDetail } from '../research-types';
import { ProjectsView } from './ProjectsView';
import { NewProjectDialog } from '../NewProjectDialog';
import { projectItemPath } from '../dashboard-routes';
export function ProjectsClient({ promise }: { promise: Promise<ResourceResult<Project[]>> }) {
  const router = useRouter(),
    params = useSearchParams();
  const resource = useStreamedAccountResource('projects', [], promise);
  const [selected, setSelected] = useDashboardDraft<ProjectDetail | null>('selected-project', null);
  const resumeProject = useRef(selected?.id ?? null);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [createError, setCreateError] = useState(''),
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
    const requestedId = params.get('project'),
      newProject = params.get('newProject');
    const id = requestedId ?? resumeProject.current;
    resumeProject.current = null;
    if (id) void open({ id, name: '' });
    if (newProject) { setCreateError(''); setCreate(true); }
    if (requestedId || newProject) router.replace('/dashboard/projects', { scroll: false });
  }, [params, open, router]);
  const add = async (name: string): Promise<boolean> => {
    setCreateError('');
    try {
      const project = await api<Project>('/v1/projects', { method: 'POST', body: JSON.stringify({ name }) });
      resource.setData(current => [project, ...current]);
      setCreate(false);
      return true;
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : 'Could not create project.');
      return false;
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
          onCreate={() => { setCreateError(''); setCreate(true); }}
          onOpen={(p) => void open(p)}
          onBack={() => {
            setSelected(null);
            setError('');
          }}
          onFindSources={() => selected && router.push(`/dashboard/sources?project=${encodeURIComponent(selected.id)}`)}
          onOpenItem={(item) => selected && router.push(projectItemPath(selected.id, item))}
        />
      )}
      {create && <NewProjectDialog onClose={() => { setCreate(false); setCreateError(''); }} onCreate={add} error={createError} />}
    </>
  );
}
