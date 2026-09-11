export function SessionLoading() {
  return <div className='agent-session-loading' role='status' aria-label='Loading session'>
    <span className='sr-only'>Loading session</span>
    <div aria-hidden='true' className='agent-loading-title' />
    <div aria-hidden='true' className='agent-loading-user'><span /><span /></div>
    <div aria-hidden='true' className='agent-loading-answer'><span /><span /><span /></div>
  </div>;
}
