'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { platformRequest as api } from '../../../lib/platform-request';
import { useDashboardDraft, useStreamedAccountResource, useProjectDetail, useDashboardCache } from '../DashboardDataProvider';
import type { ResourceResult } from '../../../lib/dashboard-cache';
import type { Project } from '../research-types';
import { ProjectsView } from './ProjectsView';
import { NewProjectDialog } from '../NewProjectDialog';
import { projectItemPath } from '../dashboard-routes';
export function ProjectsClient({ promise }: { promise: Promise<ResourceResult<Project[]>> }) {
  const router = useRouter(),
    params = useSearchParams();
  const resource = useStreamedAccountResource('projects', [], promise);
  const [selected, setSelected] = useDashboardDraft<Project | null>('selected-project', null);
  const cache = useDashboardCache();
  const detail = useProjectDetail(selected?.id ?? null);
  const [createError, setCreateError] = useState(''), [create, setCreate] = useState(false);
  const open = useCallback((project: Project) => { setSelected(project); }, [setSelected]);
  useEffect(() => {
    const id = params.get('project'),
      newProject = params.get('newProject');
    if (id) void open({ id, name: '' });
    if (newProject) { setCreateError(''); setCreate(true); }
    if (id || newProject) router.replace('/dashboard/projects', { scroll: false });
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
          selectedProject={selected ? { ...selected, ...detail.data, name: detail.data?.name || resource.data.find(project => project.id === selected.id)?.name || selected.name || 'Project', items: detail.data?.items ?? [] } : null}
          loading={Boolean(selected && !detail.data && !detail.error)}
          error={detail.error}
          onRetry={() => void detail.refresh()}
          onPrefetch={project => void cache.projectDetails.load(project.id)}
          onCreate={() => { setCreateError(''); setCreate(true); }}
          onOpen={(p) => void open(p)}
          onBack={() => {
            setSelected(null);
          }}
          onFindSources={() => selected && router.push(`/dashboard/sources?project=${encodeURIComponent(selected.id)}`)}
          onOpenItem={(item) => selected && router.push(projectItemPath(selected.id, item))}
        />
      )}
      {create && <NewProjectDialog onClose={() => { setCreate(false); setCreateError(''); }} onCreate={add} error={createError} />}
    </>
  );
}
