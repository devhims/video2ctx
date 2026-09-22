import pageStyles from './DashboardPages.module.css';
export function AccountSectionSkeleton({ section, detail = false }: { section: 'projects' | 'monitors'; detail?: boolean }) {
  const projects = section === 'projects';
  return <section className='content-section standalone' role='status' aria-label={`Loading ${detail ? 'project' : section}`} aria-busy='true'>
    <span className='sr-only'>Loading {detail ? 'project' : section}</span>
    <div aria-hidden='true'>
      {detail && <span className='back'><i className='ui-bar' data-width='short' /></span>}
      <header className={pageStyles.pageHeading}>
        <div className={pageStyles.intro}><h2>{detail ? <i className='ui-bar' /> : projects ? 'Your projects' : 'Watch for new videos'}</h2><p>{detail ? <i className='ui-bar' /> : projects ? 'Keep related sources and saved moments together.' : 'Get updates from channels and searches you follow.'}</p></div>
        <span className='skeleton-control' />
      </header>
      <div className={pageStyles.listHeading}><h3>{detail ? 'Saved sources' : projects ? 'Projects' : 'Monitors'}</h3></div>
      <div className={pageStyles.recordList}>{Array.from({ length: 3 }, (_, index) => <div key={index} className={`${projects ? pageStyles.projectRow : pageStyles.monitorRow} ${pageStyles.skeletonRow}`}>
        <span className={pageStyles.rowIcon} />
        <div className={pageStyles.recordCopy}><strong><i className='ui-bar' data-width='medium' /></strong><small><i className='ui-bar' data-width='long' /></small>{!projects && <><p><i className='ui-bar' data-width='medium' /></p><div className={pageStyles.rowActions}><i className='ui-bar skeleton-action' /></div></>}</div>
        {projects ? <span className={pageStyles.recordMeta}>{!detail && <i className='ui-bar skeleton-action' />}<i className='ui-bar skeleton-chevron' /></span> : <div className={pageStyles.monitorSchedule}><label><span>Check every</span><span className='skeleton-control' /></label><span className='skeleton-control skeleton-square' /></div>}
      </div>)}</div>
    </div>
  </section>;
}
