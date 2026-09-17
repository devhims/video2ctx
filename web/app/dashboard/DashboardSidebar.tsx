'use client';

import Link from 'next/link';
import { useDashboardSession } from './DashboardSessionProvider';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SidebarSimpleIcon, KeyIcon, BookOpenIcon, CoinsIcon, SignOutIcon, CaretDownIcon, ListIcon, XIcon } from '@phosphor-icons/react';
import styles from './DashboardSidebar.module.css';

export type DashboardSection = 'trends' | 'discover' | 'projects' | 'monitors' | 'settings';
export type DashboardSidebarSection = DashboardSection | 'developer' | 'sessions';
export type SidebarProject = { id: string; name: string };

type IconName = 'trend' | 'search' | 'folder' | 'monitor' | 'user' | 'spark' | 'plus' | 'settings' | 'trash' | 'bell';

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
    trash: <><path d='M4.5 7h15' /><path d='M9 3.5h6l1 3.5H8zM7 7l.7 13h8.6L17 7M10 10.5v6M14 10.5v6' /></>,
    bell: <><path d='M6.5 9.5a5.5 5.5 0 0 1 11 0c0 6 2.5 6 2.5 7.5H4c0-1.5 2.5-1.5 2.5-7.5Z' /><path d='M9.5 20h5' /></>,
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

const COLLAPSED_KEY = 'video2ctx.sidebar.collapsed';

export function DashboardSidebar<Project extends SidebarProject>({ activeSection, projects, onNavigate, onNewProject, onOpenProject, onSignIn, accountName, credits, onSignOut }: DashboardSidebarProps<Project>) {
  const { agentAccess } = useDashboardSession();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    try { setCollapsed(localStorage.getItem(COLLAPSED_KEY) === 'true'); } catch { /* Storage may be disabled. */ }
    const desktop = window.matchMedia('(min-width: 701px)');
    const closeOnDesktop = () => { if (desktop.matches) dialog.current?.close(); };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSED_KEY, String(next)); } catch { /* Keep the toggle usable without storage. */ }
  };
  const run = (action: () => void) => { dialog.current?.close(); action(); };
  const navButton = (section: DashboardSection, label: string, icon: IconName, suffix?: ReactNode) => (
    <button type='button' aria-label={label} title={collapsed ? label : undefined} data-tooltip={label} aria-current={activeSection === section ? 'page' : undefined} className={styles.item} onClick={() => run(() => onNavigate(section))}>
      <span className={styles.iconTile}><Icon name={icon} /></span><span className={styles.label}>{label}</span>{suffix}
    </button>
  );
  const brand = <><img src='/brand/logo-120.png' alt='' width='28' height='28' /><span className={styles.wordmark}>video2<span>ctx</span></span></>;
  const content = (mobile = false) => <>
    <div className={styles.header}>
      {(mobile || !collapsed) && <Link className={styles.brand} aria-label='video2ctx home' href='/'>{brand}</Link>}
      <button type='button' className={!mobile && collapsed ? styles.expand : styles.toggle} aria-label={mobile ? 'Close navigation' : collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={mobile ? true : !collapsed} data-tooltip={!mobile && collapsed ? 'Expand sidebar' : undefined} onClick={mobile ? () => dialog.current?.close() : toggleCollapsed}>
        {!mobile && collapsed && <img src='/brand/logo-120.png' alt='' width='28' height='28' />}
        {mobile ? <XIcon size={18} aria-hidden='true' /> : <SidebarSimpleIcon size={18} aria-hidden='true' />}
      </button>
    </div>
    <div className={styles.scrollArea}>
      <nav aria-label='Dashboard navigation' className={styles.navigation}>
        <div className={styles.group}>
          {navButton('trends', 'Trend Lab', 'trend')}
          {navButton('discover', 'Sources', 'search')}
          {agentAccess && <Link aria-label='Agent' title={collapsed ? 'Agent' : undefined} data-tooltip='Agent' aria-current={activeSection === 'sessions' ? 'page' : undefined} className={styles.item} href='/dashboard/sessions' onClick={() => dialog.current?.close()}><span className={styles.iconTile}><Icon name='spark' /></span><span className={styles.label}>Agent</span></Link>}
        </div>
        <div className={styles.group}>
          <p className={styles.groupLabel}>Workspace</p>
          {navButton('projects', 'Projects', 'folder', <span className={styles.count}>{projects.length}</span>)}
          {navButton('monitors', 'Monitors', 'monitor')}
        </div>
        <div className={styles.group}>
          <p className={styles.groupLabel}>Manage</p>
          <Link aria-label='API keys' title={collapsed ? 'API keys' : undefined} data-tooltip='API keys' aria-current={activeSection === 'developer' ? 'page' : undefined} className={styles.item} href='/dashboard/developer' onClick={() => dialog.current?.close()}><span className={styles.iconTile}><KeyIcon size={18} aria-hidden='true' /></span><span className={styles.label}>API keys</span></Link>
          {navButton('settings', 'Settings', 'settings')}
        </div>
      </nav>
      <section className={styles.projects} aria-label='Recent projects'>
        <div className={styles.projectHeading}><span>Recent projects</span><button type='button' aria-label='Create a new project' onClick={() => run(onNewProject)}><Icon name='plus' size={15} /></button></div>
        {projects.slice(0, 5).map(project => <button type='button' className={styles.project} key={project.id} title={project.name} onClick={() => run(() => onOpenProject(project))}><span className={styles.projectDot} /><span>{project.name}</span></button>)}
        {!projects.length && <p>Save a source to start a project.</p>}
      </section>
      <button type='button' className={styles.item + ' ' + styles.quickCreate} aria-label='Create a new project' title='New project' data-tooltip='New project' onClick={() => run(onNewProject)}><span className={styles.iconTile}><Icon name='plus' /></span></button>
    </div>
    <div className={styles.footer}>
      <a className={styles.item} href='https://docs.video2ctx.dev/' target='_blank' rel='noreferrer' aria-label='Documentation (opens in a new tab)' data-tooltip='Documentation'><span className={styles.footerIcon}><BookOpenIcon size={18} aria-hidden='true' /></span><span className={styles.label}>Documentation</span></a>
      {accountName ? <>
        <button type='button' className={styles.item + ' ' + styles.balance} aria-label={credits === undefined ? 'Credit balance loading' : credits.toLocaleString() + ' credits remaining'} data-tooltip={credits === undefined ? 'Credit balance loading' : credits.toLocaleString() + ' credits'} onClick={() => run(() => onNavigate('settings'))}>
          <span className={styles.footerIcon}><CoinsIcon size={18} aria-hidden='true' /></span><span className={styles.label}>Credits</span><span className={styles.creditAmount}>{credits === undefined ? '…' : credits.toLocaleString()}</span>
        </button>
        <details className={styles.account} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }} onKeyDown={event => { if (event.key === 'Escape' && event.currentTarget.open) { event.stopPropagation(); event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
          <summary className={styles.item} aria-label={'Account: ' + accountName} data-tooltip={accountName}><span className={styles.avatar}>{accountName.trim().slice(0, 2).toUpperCase()}</span><span className={styles.label}>{accountName}</span><CaretDownIcon className={styles.accountCaret} size={14} aria-hidden='true' /></summary>
          <div className={styles.accountMenu}><strong>{accountName}</strong><button type='button' aria-label='Account settings' className={styles.item} onClick={() => run(() => onNavigate('settings'))}><Icon name='settings' size={16} />Account settings</button><button type='button' aria-label='Sign out' className={styles.item} onClick={() => run(onSignOut)}><SignOutIcon size={16} aria-hidden='true' />Sign out</button></div>
        </details>
      </> : <button type='button' className={styles.item} aria-label='Sign in' data-tooltip='Sign in' onClick={() => run(onSignIn)}><span className={styles.avatar}><Icon name='user' size={16} /></span><span className={styles.label}>Sign in</span></button>}
    </div>
  </>;

  return <>
    <aside className={styles.sidebar} data-dashboard-sidebar data-collapsed={collapsed} aria-label='Workspace sidebar'>{content()}</aside>
    <div className={styles.mobileBar}><button type='button' aria-label='Open navigation' aria-haspopup='dialog' aria-expanded={mobileOpen} onClick={() => { dialog.current?.showModal(); setMobileOpen(true); }}><ListIcon size={22} aria-hidden='true' /></button><Link className={styles.brand} href='/' aria-label='video2ctx home'>{brand}</Link></div>
    <dialog ref={dialog} className={styles.drawer} aria-label='Dashboard navigation' onClose={() => setMobileOpen(false)} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}><div className={styles.drawerContent}>{content(true)}</div></dialog>
  </>;
}
