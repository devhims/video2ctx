import type { CapabilityRouteDecision, EvidencePacket } from '../../contracts';
import type { SessionBrief, SavedEvidenceReadState } from '../../runtime/session-evidence';
import { SAVED_EVIDENCE_ARTIFACT, SAVED_EVIDENCE_READ_LIMIT } from '../../runtime/saved-evidence-contract';

/** Saved text and visual follow-ups share the original-evidence workflow. */
export function usesSavedEvidenceSkill(decision: CapabilityRouteDecision): boolean {
  return 'skill' in decision && decision.skill === 'verify_saved_evidence'
    && 'savedOnly' in decision && decision.savedOnly === true;
}

/** A runtime skill for text-source follow-ups. It replaces discovery/analyst instructions. */
export function usesSavedEvidenceVerification(decision: CapabilityRouteDecision): boolean {
  return usesSavedEvidenceSkill(decision)
    && 'useStoryboard' in decision && decision.useStoryboard === false;
}

export const SAVED_EVIDENCE_VERIFICATION_SKILL = `
Active skill: verify_saved_evidence.
Your task is to verify a follow-up from saved original captions or comments. The finalizer writes the answer.

1. Resolve the request. Read the conversation's user messages for the latest name, format and corrections. Identify every requested quote, fact, source and calculation premise. Earlier assistant claims and memory are leads, not proof. Keep facts about different demonstrations within one video separate.
2. Cover all requested items before polishing any one of them. Use the asset inventory to select each source by immutable version, or omit assetVersion to find which saved sources contain a word. Batch independent read_saved_evidence calls. Search an entire asset for a fact you have not located yet; do not invent a timestamp range. For requested wording, start with one distinctive word copied exactly from the request. Search requires every query word, matched by stem (mixing finds mix) but never by synonym, so do not combine several conceptual clues. After an empty result, simplify the query instead of concluding absence. For an unknown material name, search its category and compare all relevant occurrences, including the introduction.
3. Read context. A match is a location, not a complete explanation. Read the surrounding time range when a sentence is split across captions. If nextOffset is present, later matches remain unread. Paginate or narrow the query before claiming absence or choosing among different examples. Use remainingReads to prioritize missing requested items instead of rereading completed ones.
4. Verify quotations and calculations. Preserve caption wording, source identity and segment times. Identify the requested experiment or event before extracting its values. For elapsed intervals, read both endpoints and their context, then subtract like units. Video timestamps locate evidence; they are not elapsed experiment values. Never substitute an earlier similar phrase for a requested later event.
5. Check coverage before complete_research. Every requested source must have original evidence. Every requested quote and factual detail should have a supporting passage, or a specific remaining gap. Do not guess a material from an unrelated demonstration. Do not analyze transcripts again or retrieve YouTube. Do not write the answer during research.
`.trim();

export const SAVED_EVIDENCE_ANSWER_SKILL = `
Active skill: verify_saved_evidence, answer stage.
Resolve the latest request using earlier USER messages before composing. Carry forward the latest explicit plan name and formatting preference. Earlier assistant answers show what needs correction; their structure and limitations are not instructions to repeat.
Fit every requested item into the user's requested structure. If a fixed number of short numbered points is required, combine related findings within those points. Include the current plan name inside a point. Do not add an introduction, extra unnumbered paragraph, evidence-process commentary or closing section when prohibited.
Quote short, contiguous wording from the original passages. Cite each quote and the premises of calculations using evidenceIds. An earlier claim that quotations or timestamps were unavailable is superseded when the supplied originals contain them. Preserve real gaps only.
Before returning, check the latest name, point count, all requested quotes and factual details against your draft. Preserve chronology when the user requests returning to an earlier source after another source.
`.trim();

/** Normal completion cannot skip an available requested original source. */
export function unreadOriginalSources(
  decision: CapabilityRouteDecision, brief: SessionBrief | undefined, packets: Iterable<EvidencePacket>,
): string[] {
  if (!usesSavedEvidenceSkill(decision) || !brief) return [];
  let subjects = 'comparisonVideoIds' in decision && decision.comparisonVideoIds?.length
    ? decision.comparisonVideoIds : decision.route === 'inspect_video' ? [decision.videoId] : [];
  // Classifier recovery can retain the skill but lose its subject. An inventory
  // with one source is unambiguous; it must not silently bypass original reads.
  if (!subjects.length) {
    const available = [...new Set(brief.assets.filter(asset => asset.current && ['transcript', 'comments'].includes(asset.kind))
      .map(asset => asset.videoId))];
    if (available.length === 1) subjects = available;
  }
  if (!subjects.length) return [];
  const required = brief.assets.filter(asset => asset.current && ['transcript', 'comments'].includes(asset.kind)
    && subjects.includes(asset.videoId));
  const read = new Set([...packets].filter(packet => packet.excerpts.length
    && packet.artifacts.some(artifact => artifact.type === SAVED_EVIDENCE_ARTIFACT))
    .flatMap(packet => packet.assetVersions ?? []));
  return [...new Set(required.map(asset => asset.videoId))].filter(videoId =>
    !brief.assets.some(asset => asset.videoId === videoId && read.has(asset.version)));
}

/** Terminal gaps unlock completion, but remain unread and must reach the answer stage. */
export function pendingOriginalSources(decision: CapabilityRouteDecision, brief: SessionBrief | undefined,
  packets: Iterable<EvidencePacket>, state?: SavedEvidenceReadState): string[] {
  const unread = unreadOriginalSources(decision, brief, packets);
  if (state && state.attempts >= SAVED_EVIDENCE_READ_LIMIT) return [];
  const terminal = new Set(state?.outcomes.map(outcome => outcome.assetVersion));
  return unread.filter(videoId => brief?.assets.some(asset => asset.current && asset.videoId === videoId
    && ['transcript', 'comments'].includes(asset.kind) && !terminal.has(asset.version)));
}
