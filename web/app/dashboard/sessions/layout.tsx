import './sessions.css';
import { AgentShell } from './SessionsClient';
import { AgentSessionCacheProvider } from './AgentSessionCache';

export default function AgentSessionsLayout({ children }: { children: React.ReactNode }) {
  return <AgentSessionCacheProvider><AgentShell>{children}</AgentShell></AgentSessionCacheProvider>;
}
