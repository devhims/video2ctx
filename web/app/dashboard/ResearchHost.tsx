'use client';

import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { Suspense, useState } from 'react';
import { WorkspaceShell } from './WorkspaceShell';

const Sources = dynamic(() => import('./SourcesClient'), { loading: () => <ResearchSkeleton /> });
const Trends = dynamic(() => import('./TrendLabClient'), { loading: () => <ResearchSkeleton /> });

export function ResearchSkeleton() {
  return (
    <section className='content-section standalone' role='status' aria-label='Loading research tools' aria-busy='true'>
      <div aria-hidden='true'>
        <h2>
          <i className='ui-bar' data-width='medium' />
        </h2>
        <p>
          <i className='ui-bar' data-width='long' />
        </p>
        <div className='skeleton-control' />
      </div>
    </section>
  );
}

// Retain only research panels that the user has visited. Keeping their controllers
// mounted lets paid, user-started requests finish while another route is visible.
// The account-keyed layout clears them on sign-out/account changes.
export function ResearchHost() {
  const path = usePathname();
  const source = path === '/dashboard/sources',
    trend = path === '/dashboard/trends';
  const [visited, setVisited] = useState({ source, trend });
  if ((source && !visited.source) || (trend && !visited.trend)) {
    setVisited({ source: visited.source || source, trend: visited.trend || trend });
  }
  return (
    <>
      {(visited.source || source) && (
        <div hidden={!source} data-research-panel='sources'>
          <WorkspaceShell section='discover' title='Sources'>
            <Suspense fallback={<ResearchSkeleton />}>
              <Sources active={source} />
            </Suspense>
          </WorkspaceShell>
        </div>
      )}
      {(visited.trend || trend) && (
        <div hidden={!trend} data-research-panel='trends'>
          <WorkspaceShell section='trends' title='Trend Lab'>
            <Suspense fallback={<ResearchSkeleton />}>
              <Trends />
            </Suspense>
          </WorkspaceShell>
        </div>
      )}
    </>
  );
}
