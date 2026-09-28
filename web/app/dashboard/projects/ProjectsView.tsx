'use client';
import { Icon } from '../DashboardSidebar';
import pageStyles from '../DashboardPages.module.css';
import type {Project,ProjectDetail,ProjectItem} from '../research-types';
export function ProjectsView({ projects, selectedProject, loading, error, onCreate, onOpen, onBack, onFindSources, onOpenItem, onRetry, onPrefetch }: { projects: Project[]; selectedProject: ProjectDetail | null; loading: boolean; error: string; onRetry:()=>void; onPrefetch:(project:Project)=>void; onCreate:()=>void; onOpen:(project:Project)=>void; onBack:()=>void; onFindSources:()=>void; onOpenItem:(item:ProjectItem)=>void }) {
  if (selectedProject) return <section className='content-section standalone project-detail'>
    <button className='back' onClick={onBack}>← All projects</button>
    <header className={pageStyles.pageHeading}><div className={pageStyles.intro}><h2>{selectedProject.name}</h2>{selectedProject.description && <p>{selectedProject.description}</p>}</div><button className={pageStyles.primaryAction} onClick={onFindSources}><Icon name='plus' size={15} />Add sources</button></header>
    <div className={pageStyles.listHeading}><h3>Saved sources {!loading && <span>{selectedProject.items.length}</span>}</h3></div>
    {error && <div className='alert error' role='alert'>{error} <button onClick={onRetry}>Retry loading sources</button></div>}
    {loading && <div role='status' aria-label='Loading saved sources' aria-busy='true' className={pageStyles.recordList}>{[0, 1, 2].map(index => <div key={index} className={`${pageStyles.projectRow} ${pageStyles.skeletonRow}`} aria-hidden='true'><span className={pageStyles.rowIcon} /><span className={pageStyles.recordCopy}><strong><i className='ui-bar' data-width='medium' /></strong><small><i className='ui-bar' data-width='long' /></small></span></div>)}</div>}
    <div className={pageStyles.recordList}>{selectedProject.items.map(item => <button className={pageStyles.projectRow} key={item.id} onClick={() => onOpenItem(item)}>
      <span className={pageStyles.rowIcon}><Icon name='search' size={19} /></span><span className={pageStyles.recordCopy}><strong>{item.title || item.entity_id}</strong><small>{item.note || (item.start_ms != null ? `Saved moment at ${formatTime(item.start_ms)}` : item.entity_type)}</small></span><span className={pageStyles.rowArrow} aria-hidden='true'>↗</span>
    </button>)}</div>
    {!loading && !error && !selectedProject.items.length && <div className={pageStyles.emptyState}><span className={pageStyles.rowIcon}><Icon name='folder' size={21} /></span><div><h3>No sources yet</h3><p>Add searches, videos, channels, or playlists to this project.</p></div></div>}
  </section>;
  return <section className='content-section standalone'>
    <header className={pageStyles.pageHeading}><div className={pageStyles.intro}><h2>Your projects</h2><p>Keep related sources and saved moments together.</p></div><button className={pageStyles.primaryAction} onClick={onCreate}><Icon name='plus' size={15} />New project</button></header>
    {error && <div className='alert error' role='alert'>{error}</div>}
    <div className={pageStyles.listHeading}><h3>Projects <span>{projects.length}</span></h3></div>
    <div className={pageStyles.recordList}>{projects.map(project => <button className={pageStyles.projectRow} key={project.id} onMouseEnter={() => onPrefetch(project)} onFocus={() => onPrefetch(project)} onClick={() => onOpen(project)}>
      <span className={pageStyles.rowIcon}><Icon name='folder' size={19} /></span><span className={pageStyles.recordCopy}><strong>{project.name}</strong>{project.description && <small>{project.description}</small>}</span><span className={pageStyles.recordMeta}>{project.item_count ?? 0} sources <span aria-hidden='true'>↗</span></span>
    </button>)}</div>
    {!projects.length && <div className={pageStyles.emptyState}><span className={pageStyles.rowIcon}><Icon name='folder' size={21} /></span><div><h3>No projects yet</h3><p>Create your first project to start collecting sources.</p></div></div>}
  </section>;
}

function formatTime(ms:number){const total=Math.floor(ms/1000);return `${Math.floor(total/60)}:${String(total%60).padStart(2,'0')}`;}
