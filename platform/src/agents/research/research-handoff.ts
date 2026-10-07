import { z } from 'zod';
import type { CapabilityRouteDecision, EvidencePacket } from '../contracts';
import type { SessionAccess } from '../runtime/session-evidence';
import type { DeliverEvidence } from '../runtime/prior-evidence';
import type { TraceToolCall } from '../runtime/tool-call-trace';
import { hasContentEvidence } from './evidence-fallback';

const savedReadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('asset'), version: z.string().regex(/^[a-f0-9]{64}$/),
    offset: z.number().int().min(0), query: z.string().min(1).max(200).nullable() }),
  z.object({ kind: z.literal('history'), offset: z.number().int().min(0), role: z.enum(['user', 'assistant', 'all']) }),
]);
export const researchHandoffSchema = z.object({
  requirements: z.array(z.object({ question: z.string().min(1).max(400),
    evidenceIds: z.array(z.string().min(1).max(300)).max(20) })).min(1).max(20),
  gaps: z.array(z.object({ question: z.string().min(1).max(400), read: savedReadSchema.nullable() })).max(8),
});
export type ResearchHandoff = z.infer<typeof researchHandoffSchema>;
type SavedRead = z.infer<typeof savedReadSchema>;
interface Gap {
  question: string;
  reason: string;
  read: SavedRead | null;
  status: 'unresolved' | 'evidence_loaded' | 'partial' | 'unavailable' | 'read_limit';
}
export interface ResearchPreparation {
  requirements: ResearchHandoff['requirements'];
  gaps: Gap[];
  history: unknown[];
  incomplete: boolean;
  readCount: number;
}

export const RESEARCH_HANDOFF_GUIDANCE = 'When research is done, call finalize_answer with a handoff report, not answer blocks. List each part of the user request and the supporting excerpt evidenceIds. List unanswered questions as gaps. A gap may request one exact saved asset version/page/query or history page, only if that read could answer it. Use read:null when evidence is unavailable. Do not invent references, claim semantic completeness from video counts, or request broad discovery. The finalizer will use the supplied analyses directly and read only identified gaps. Resolve research and image-analysis needs here before handing off.';

/** Application checks are evidence/coverage checks, not a semantic completeness judge.
 * Bounded reads never retrieve new provider data or trigger another analysis model. */
export async function prepareResearchHandoff(options: {
  report: ResearchHandoff;
  decision: CapabilityRouteDecision;
  evidence: EvidencePacket[];
  session?: SessionAccess;
  signal: AbortSignal;
  trace?: TraceToolCall;
  deliver?: DeliverEvidence;
  onEvidence?: (packets: EvidencePacket[]) => void;
}): Promise<ResearchPreparation> {
  const { report, evidence, session, signal } = options;
  const gaps: Gap[] = report.gaps.map(gap => ({ ...gap, reason: 'research_report', status: 'unresolved' }));
  const add = (question: string, reason: string, read: SavedRead | null = null) => {
    gaps.push({ question, reason, read, status: 'unresolved' });
  };
  const usable = evidence.filter(packet => hasContentEvidence([packet])
    && !packet.warnings.some(warning => warning.code === 'SUPERSEDED_SESSION_EVIDENCE')
    && !packet.artifacts.some(artifact => ['youtube_frame_retrieval', 'youtube_storyboard_retrieval'].includes(artifact.type)));
  const knownIds = new Set(usable.flatMap(packet => packet.excerpts
    .filter(excerpt => excerpt.text.trim() && packet.sources.some(source => source.id === excerpt.sourceId)).map(excerpt => excerpt.id)));
  for (const requirement of report.requirements) {
    if (!requirement.evidenceIds.length || requirement.evidenceIds.some(id => !knownIds.has(id)))
      add(requirement.question, 'missing_supporting_evidence');
  }
  const subjects = new Set('comparisonVideoIds' in options.decision ? options.decision.comparisonVideoIds ?? [] : []);
  if (options.decision.route === 'inspect_video') subjects.add(options.decision.videoId);
  const assets = session?.brief().assets ?? [];
  for (const videoId of subjects) {
    const packets = usable.filter(packet => packet.sources.some(source => source.videoId === videoId));
    if (packets.length) continue;
    const asset = assets.filter(asset => asset.current && asset.kind === 'transcript' && asset.videoId === videoId)
      .sort((a, b) => b.collectedAt - a.collectedAt)[0];
    add(`Content evidence for requested video ${videoId} is missing.`, 'missing_subject',
      asset ? { kind: 'asset', version: asset.version, offset: 0, query: null } : null);
  }
  for (const packet of usable) {
    if (packet.warnings.some(warning => ['TRANSCRIPT_CONTEXT_TRUNCATED', 'PARTIAL_EVIDENCE'].includes(warning.code))
      || packet.continuation
      || packet.artifacts.some(artifact => artifact.type === 'youtube_complete_transcript'
        && artifact.data.allReturnedSegmentsIncluded === false))
      add(`Evidence coverage is incomplete for packet ${packet.packetId}. Do not claim exhaustive coverage.`, 'incomplete_coverage');
  }
  if ('visualEvidence' in options.decision && options.decision.visualEvidence === 'required') {
    const visual = usable.filter(packet => packet.artifacts.some(artifact => ['youtube_frame_analysis', 'youtube_storyboard_analysis'].includes(artifact.type)));
    if (!visual.length) add('The requested visual facts lack analyzed image evidence.', 'missing_visual_analysis');
    else for (const videoId of subjects) {
      if (!visual.some(packet => packet.sources.some(source => source.videoId === videoId)))
        add(`Requested visual facts for ${videoId} lack analyzed image evidence.`, 'missing_visual_analysis');
    }
  }

  const history: unknown[] = [];
  const reads = new Map<string, Gap['status']>();
  let count = 0;
  for (const gap of gaps) {
    signal.throwIfAborted();
    const read = gap.read;
    if (!read) continue;
    const key = JSON.stringify(read);
    const previous = reads.get(key);
    if (previous) { gap.status = previous; continue; }
    if (count >= 4) { gap.status = 'read_limit'; continue; }
    // Never let a model-supplied version escape this session or silently use old data.
    if (!session || (read.kind === 'asset' && !assets.some(asset => asset.version === read.version && asset.current))) {
      gap.status = 'unavailable'; continue;
    }
    count++;
    const execute = async () => {
      signal.throwIfAborted();
      if (read.kind === 'history') {
        const page = session.readHistory?.(read.offset, read.role === 'all' ? undefined : read.role);
        signal.throwIfAborted();
        if (!page) return { status: 'unavailable' as const };
        history.push(page);
        return { status: page.nextOffset !== undefined ? 'partial' as const : 'evidence_loaded' as const, history: page };
      }
      const result = await session.readEvidence(read.version, read.offset, read.query ?? undefined);
      signal.throwIfAborted();
      const delivery = options.deliver?.(result.packets, 'read_session_evidence');
      const admitted = delivery?.admitted ?? result.packets;
      options.onEvidence?.(admitted);
      for (const packet of admitted) if (!evidence.some(existing => existing.packetId === packet.packetId)) evidence.push(packet);
      const status = !hasContentEvidence(admitted) || result.needsInspection ? 'unavailable' as const
        : result.nextOffset !== undefined || delivery?.withheld.length ? 'partial' as const : 'evidence_loaded' as const;
      return { status, packets: admitted, nextOffset: result.nextOffset };
    };
    try {
      const result = options.trace ? await options.trace({ toolCallId: `handoff-read:${crypto.randomUUID()}`,
        name: read.kind === 'asset' ? 'read_session_evidence' : 'read_session_history', operation: 'finalization_context',
        source: 'execution', input: { question: gap.question, ...read }, execute }) : await execute();
      gap.status = result.status;
    } catch {
      signal.throwIfAborted();
      gap.status = 'unavailable';
    }
    reads.set(key, gap.status);
  }
  return { requirements: report.requirements, gaps, history, readCount: count,
    incomplete: gaps.some(gap => gap.status !== 'evidence_loaded') };
}
