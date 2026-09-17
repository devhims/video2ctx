import type { ReactNode } from 'react';
import styles from './DashboardHeader.module.css';

export function DashboardHeader({ title, children }: { title: string; children?: ReactNode }) {
  return <header className={'topbar ' + styles.header}>
    <h1>{title}</h1>
    {children && <div className={'topbar-actions ' + styles.actions}>{children}</div>}
  </header>;
}
