'use client';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { platformRequest as api } from '../../../lib/platform-request';
import { useStreamedAccountResource, useProjectDetail, useDashboardCache } from '../DashboardDataProvider';
import type { ResourceResult } from '../../../lib/dashboard-cache';
import type { Project } from '../research-types';
import { ProjectsView } from './ProjectsView';
import { NewProjectDialog } from '../NewProjectDialog';
import { projectItemPath } from '../dashboard-routes';
export function ProjectsClient({ promise }: { promise: Promise<ResourceResult<Project[]>> }) {
  const router = useRouter(),
    params = useSearchParams();
  const resource = useStreamedAccountResource('projects', [], promise);
  const selectedId = params.get('project');
  const selected = selectedId ? resource.data.find(project => project.id === selectedId) ?? { id: selectedId, name: 'Project' } : null;
  const cache = useDashboardCache();
  const detail = useProjectDetail(selected?.id ?? null);
  const [createError, setCreateError] = useState(''), [create, setCreate] = useState(false);
  // Keep selection in the URL; generic Projects navigation always shows the list.
  // Native history updates integrate with Next without waiting for another server render.
  const open = (project: Project) => window.history.pushState(null, '', `/dashboard/projects?project=${encodeURIComponent(project.id)}`);
  useEffect(() => {
    if (!params.get('newProject')) return;
    setCreateError(''); setCreate(true);
    const next = new URLSearchParams(params);
    next.delete('newProject');
    window.history.replaceState(null, '', `/dashboard/projects${next.size ? `?${next}` : ''}`);
  }, [params]);
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
          onBack={() => window.history.pushState(null, '', '/dashboard/projects')}
          onFindSources={() => selected && router.push(`/dashboard/sources?project=${encodeURIComponent(selected.id)}`)}
          onOpenItem={(item) => selected && router.push(projectItemPath(selected.id, item))}
        />
      )}
      {create && <NewProjectDialog onClose={() => { setCreate(false); setCreateError(''); }} onCreate={add} error={createError} />}
    </>
  );
}
