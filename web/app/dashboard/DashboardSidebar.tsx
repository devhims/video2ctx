'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

export type DashboardSection = 'trends' | 'discover' | 'projects' | 'monitors' | 'settings';
export type DashboardSidebarSection = DashboardSection | 'developer';
export type SidebarProject = { id: string; name: string };

type IconName = 'trend' | 'search' | 'folder' | 'monitor' | 'user' | 'spark' | 'plus' | 'settings';

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    trend: <><path d='M4 17 9 12l3 3 8-9' /><path d='M15 6h5v5' /></>,
    search: <><circle cx='10.5' cy='10.5' r='5.75' /><path d='m15 15 4.5 4.5' /></>,
    folder: <><path d='M3.5 6.5h6l2 2h9v10.5h-17z' /><path d='M3.5 9h17' /></>,
    monitor: <><circle cx='12' cy='12' r='2.5' /><circle cx='12' cy='12' r='6.5' /><path d='M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2' /></>,
    user: <><circle cx='12' cy='8' r='3.25' /><path d='M5.5 20c.6-4 2.8-6 6.5-6s5.9 2 6.5 6' /></>,
    spark: <path d='M12 3.5c.6 4.7 2.8 6.9 7.5 7.5-4.7.6-6.9 2.8-7.5 7.5-.6-4.7-2.8-6.9-7.5-7.5 4.7-.6 6.9-2.8 7.5-7.5Z' />,
    plus: <path d='M12 5v14M5 12h14' />,
    settings: <><circle cx='12' cy='12' r='3' /><path d='M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 9 19.36a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.64 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63 1.7 1.7 0 0 0 10 3.08V3h4v.08A1.7 1.7 0 0 0 15 4.64a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9 1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z' /></>,
  };

  return <svg className='ui-icon' width={size} height={size} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.75' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'>{paths[name]}</svg>;
}

type DashboardSidebarProps<Project extends SidebarProject> = {
  activeSection: DashboardSidebarSection;
  projects: Project[];
  onNavigate: (section: DashboardSection) => void;
  onNewProject: () => void;
  onOpenProject: (project: Project) => void;
  onSignIn: () => void;
  accountName?: string;
  credits?: number;
  onSignOut: () => void;
};

export function DashboardSidebar<Project extends SidebarProject>({ activeSection, projects, onNavigate, onNewProject, onOpenProject, onSignIn, accountName, credits, onSignOut }: DashboardSidebarProps<Project>) {
  const navButton = (section: DashboardSection, label: string, icon: IconName, suffix?: ReactNode) => (
    <button aria-current={activeSection === section ? 'page' : undefined} className={activeSection === section ? 'active' : ''} onClick={() => onNavigate(section)}>
      <span aria-hidden='true'><Icon name={icon} /></span>{label}{suffix}
    </button>
  );

  return <aside className='sidebar'>
    <Link className='brand workspace-brand' aria-label='video2ctx home' href='/'><img src='/brand/video2ctx-mark-red.svg' alt='' width='36' height='36' /></Link>
    <nav aria-label='Dashboard navigation'>
      {navButton('trends', 'Trend Lab', 'trend')}
      {navButton('discover', 'Sources', 'search')}
      {navButton('projects', 'Projects', 'folder', <em>{projects.length}</em>)}
      {navButton('monitors', 'Monitors', 'monitor')}
      <Link aria-current={activeSection === 'developer' ? 'page' : undefined} className={activeSection === 'developer' ? 'active' : ''} href='/dashboard/developer'><span aria-hidden='true'>⌘</span>API keys</Link>
      {navButton('settings', 'Settings', 'settings')}
    </nav>
    <div className='sidebar-rule' />
    <div className='sidebar-label'><span>RECENT PROJECTS</span><button aria-label='Create a new project' onClick={onNewProject}>＋</button></div>
    <div className='project-links'>{projects.slice(0, 5).map((project, index) => <button key={project.id} onClick={() => onOpenProject(project)}><span aria-hidden='true' className={`project-color c${index % 4}`} />{project.name}</button>)}{!projects.length && <p>Save a source to start.</p>}</div>
    <div className='account-card'>{accountName ? <><strong>{accountName}</strong><p>{credits === undefined ? 'Loading credit balance…' : `${credits} credits remaining`}</p><button onClick={onSignOut}><Icon name='user' size={15} />Sign out</button></> : <><strong>Keep your research private</strong><p>Sign in to sync projects and monitors across devices.</p><button onClick={onSignIn}><Icon name='user' size={15} />Sign in</button></>}</div>
  </aside>;
}
