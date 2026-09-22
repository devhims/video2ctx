export function DashboardSkeleton({ label, lines = 3, variant = 'inline' }: { label: string; lines?: number; variant?: 'inline' | 'panel' }) {
  return <div className={`source-skeleton source-skeleton-${variant}`} role='status' aria-label={label}>
    <span className='sr-only'>{label}</span>
    <div className='source-skeleton-lines' aria-hidden='true'>{Array.from({ length: lines }).map((_, index) => <i key={index} />)}</div>
  </div>;
}
