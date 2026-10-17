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
