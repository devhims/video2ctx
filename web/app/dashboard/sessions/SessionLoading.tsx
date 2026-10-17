// Mirrors the thread layout (navigation, heading, assets, a message and an answer) so content
// replaces it in place. Its own class names keep placeholders out of message selectors.
export function SessionLoading({ navigation = true }: { navigation?: boolean }) {
  return <div className='agent-session-loading' role='status' aria-label='Loading session'>
    <span className='sr-only'>Loading session</span>
    <div aria-hidden='true'>
      {navigation && <div className='agent-loading-nav'><i /><i /></div>}
      <div className='agent-loading-heading'><i /><i /></div>
      <div className='agent-loading-assets' />
      <div className='agent-loading-messages'>
        <div className='agent-loading-message agent-loading-user'><b /><div><i className='agent-loading-meta' /><div className='agent-loading-bubble'><i /></div></div></div>
        <div className='agent-loading-message'><b /><div><i className='agent-loading-meta' /><i /><i /><i /></div></div>
      </div>
    </div>
  </div>;
}

// Mirrors the Agent home: welcome heading, composer, search, and recent session rows.
export function SessionsHomeLoading() {
  return <div className='agent-session-loading' role='status' aria-label='Loading sessions'>
    <span className='sr-only'>Loading sessions</span>
    <div aria-hidden='true'>
      <div className='agent-loading-welcome'><i /></div>
      <div className='agent-loading-composer'><i /><b /></div>
      <div className='agent-loading-history'>
        <div className='agent-loading-search'><i /></div>
        <div className='agent-loading-list-heading'><i /></div>
        {[0, 1, 2].map(row => <div key={row} className='agent-loading-row'><b /><div><i /><i /></div><div><i /><i /></div></div>)}
      </div>
    </div>
  </div>;
}
