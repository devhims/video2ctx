export function BillingSkeleton({ contentsOnly = false }: { contentsOnly?: boolean }) {
  const contents = <><div role='status' aria-label='Loading billing'><span className='panel-label'>Billing</span><h3 className='settings-card-title mt-2 mb-0'><i className='ui-bar' data-width='medium' /></h3><p className='settings-card-copy mt-2 mb-0'><i className='ui-bar' /><i className='ui-bar' data-width='long' /></p></div><span className='skeleton-control skeleton-control-wide' aria-hidden='true' /></>;
  return contentsOnly ? contents : <article className='mb-6 grid grid-cols-[minmax(0,1fr)_minmax(15rem,22rem)] items-center gap-10 rounded-[var(--radius-dashboard-md)] border border-[var(--color-dashboard-rule)] bg-[var(--color-dashboard-surface)] p-6 max-[43.75rem]:grid-cols-1' aria-labelledby='billing-settings-heading'>{contents}</article>;
}

export function PreferencesSkeleton({ contentsOnly = false }: { contentsOnly?: boolean }) {
  const contents = <div role='status' aria-label='Loading notification preferences'>{['In-app alerts', 'Email alerts'].map(label => <div className='settings-toggle-row' key={label} aria-hidden='true'><span><strong>{label}</strong><small><i className='ui-bar' /><i className='ui-bar' data-width='medium' /></small></span><span className='skeleton-toggle' /></div>)}</div>;
  return contentsOnly ? contents : <article className='settings-notification-card' aria-labelledby='notification-settings-heading'>
      <div className='settings-notification-intro'>
        <h3 className='settings-card-title' id='notification-settings-heading'>Notifications</h3>
        <p className='settings-card-copy'>Updates from your monitors.</p>
      </div>
      <div className='settings-toggle-list'>{contents}</div></article>;
}
