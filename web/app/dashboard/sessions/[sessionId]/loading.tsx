import { SessionLoading } from '../SessionLoading';

// The thread section's padding differs from the sessions home on small screens.
export default function LoadingAgentSession() {
  return <section className='agent-sessions agent-thread'><SessionLoading /></section>;
}
