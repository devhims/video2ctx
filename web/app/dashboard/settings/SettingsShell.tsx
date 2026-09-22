'use client';

import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAccountResource } from '../DashboardDataProvider';
import { DashboardSidebar, type DashboardSection } from '../DashboardSidebar';
import { useDashboardSession } from '../DashboardSessionProvider';
import { DashboardHeader } from '../DashboardHeader';
import styles from '../DashboardPages.module.css';

export function SettingsShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { user, demoEnabled, signOut } = useDashboardSession();
  const { data: projects } = useAccountResource('projects', []);
  const { data: usage } = useAccountResource('usage', null);
  const navigate = (section: DashboardSection) => router.push(section === 'settings' ? '/dashboard/settings' : `/dashboard/${section === 'discover' ? 'sources' : section}`);
  return <main className='workspace-shell'>
    <DashboardSidebar activeSection='settings' projects={projects} onNavigate={navigate}
      onNewProject={() => router.push('/dashboard/projects?newProject=1')}
      onOpenProject={project => router.push(`/dashboard/projects?project=${encodeURIComponent(project.id)}`)}
      onSignIn={() => router.push('/login')} accountName={user?.name ?? user?.email ?? (demoEnabled ? 'Local demo' : undefined)}
      credits={usage?.creditBalance} onSignOut={() => void signOut()} />
    <div className={`workspace-main ${styles.pages}`}>
      <DashboardHeader title='Settings' />
      <section className='content-section standalone settings-page'>
        <header className={styles.intro}><h2>Workspace settings</h2><p>Manage your plan, notifications, and account.</p></header>
        {children}
      </section>
    </div>
  </main>;
}
