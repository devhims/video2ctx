import { AsyncLocalStorage } from 'node:async_hooks';
import type { YouTubeAgentProvider } from '../providers/youtube/provider';
import { ConcurrencyLimiter, type AgentToolContext } from '../providers/youtube/tool-context';

/** All retrievals share four slots. A slot ends with the provider call, so neither
 * inference nor its nested metadata lookup waits on an enclosing retrieval tool. */
export function scheduleEvidenceTools(
  provider: YouTubeAgentProvider, execute: AgentToolContext['executeEvidenceTool'], signal: AbortSignal,
): Pick<AgentToolContext, 'provider' | 'executeEvidenceTool'> {
  const callerSignal = new AsyncLocalStorage<AbortSignal>();
  const retrievals = new ConcurrencyLimiter(4);
  const savedAnalyses = new ConcurrencyLimiter(4);
  const limit = <Args extends unknown[], Result>(method: (...args: Args) => Promise<Result>) =>
    (...args: Args) => {
      const current = callerSignal.getStore() ?? signal;
      return retrievals.run(() => { signal.throwIfAborted(); current.throwIfAborted(); return method.apply(provider, args); });
    };
  return {
    provider: {
      frames: provider.frames ? limit(provider.frames) : undefined,
      storyboard: provider.storyboard ? limit(provider.storyboard) : undefined,
      search: limit(provider.search), browse: limit(provider.browse), trends: limit(provider.trends),
      video: limit(provider.video), tracks: limit(provider.tracks), transcript: limit(provider.transcript),
      comments: limit(provider.comments), endscreen: limit(provider.endscreen), channel: limit(provider.channel),
      channelVideos: limit(provider.channelVideos), channelPlaylists: limit(provider.channelPlaylists), playlist: limit(provider.playlist),
    },
    executeEvidenceTool: execution => {
      const work = () => {
        signal.throwIfAborted();
        const current = execution.signal ?? signal;
        current.throwIfAborted();
        return callerSignal.run(current, () => execute({ ...execution, signal: current, execute: async () => {
          signal.throwIfAborted();
          current.throwIfAborted();
          const packet = await execution.execute();
          signal.throwIfAborted();
          current.throwIfAborted();
          return packet;
        } }));
      };
      // Combined calls acquire inference slots only when their inputs are ready,
      // through the research context's analystLimiter. Bound saved payload reads
      // separately; these tools never surround an extraction request.
      return execution.toolName.startsWith('analyze_') ? savedAnalyses.run(work) : work();
    },
  };
}
