'use client';
import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAccountResource } from './DashboardDataProvider';
import { DashboardSidebar, type DashboardSidebarSection } from './DashboardSidebar';
import { useDashboardSession } from './DashboardSessionProvider';
import { DashboardHeader } from './DashboardHeader';
import { dashboardPath, projectItemPath } from './dashboard-routes';
import { PlatformStatus } from './PlatformStatus';
import { WorkspaceNotifications } from './WorkspaceNotifications';
import pageStyles from './DashboardPages.module.css';
export function WorkspaceShell({
  section,
  title,
  children,
}: {
  section: DashboardSidebarSection;
  title: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const { user, demoEnabled, signOut } = useDashboardSession();
  const { data: projects } = useAccountResource('projects', []);
  const { data: usage } = useAccountResource('usage', null);
  const [mobileNotificationsTarget, setMobileNotificationsTarget] = useState<HTMLDivElement | null>(null);
  return (
    <main className='workspace-shell'>
      <DashboardSidebar
        activeSection={section}
        projects={projects}
        onNavigate={(s) => router.push(dashboardPath(s))}
        onNewProject={() => router.push('/dashboard/projects?newProject=1')}
        onOpenProject={(p) => router.push(`/dashboard/projects?project=${encodeURIComponent(p.id)}`)}
        onOpenProjectItem={(project, item) => router.push(projectItemPath(project.id, item))}
        onSignIn={() => router.push('/login')}
        accountName={user?.name ?? user?.email ?? (demoEnabled ? 'Local demo' : undefined)}
        credits={usage?.creditBalance}
        onSignOut={() => void signOut()}
        mobileActions={section !== 'developer' ? <div ref={setMobileNotificationsTarget} /> : undefined}
      />
      <div className={`workspace-main ${pageStyles.pages}`}>
        <DashboardHeader title={title}>
          {section !== 'developer' && <PlatformStatus path={`/dashboard/${section === 'discover' ? 'sources' : section}`} />}
          {section !== 'developer' && <WorkspaceNotifications mobileContainer={mobileNotificationsTarget} />}
        </DashboardHeader>
        {children}
      </div>
    </main>
  );
}
