import type { CapabilityRouteDecision, EvidencePacket } from '../../contracts';
import type { SessionBrief } from '../../runtime/session-evidence';
import { SAVED_EVIDENCE_ARTIFACT } from '../../runtime/saved-evidence-contract';
import { z } from 'zod';

export const savedAnswerFormatSchema = z.object({
  name: z.string().min(1).max(120).nullable().describe('Latest explicit name of the note, card or plan, copied exactly from USER messages. Resolve renames chronologically. Null if none.'),
  numberedPoints: z.number().int().min(1).max(20).nullable().describe('Latest explicitly requested number of answer points, including preferences carried forward from earlier USER messages. Null if unspecified.'),
  onlyNumberedPoints: z.boolean().describe('True if the user prohibits an introduction or closing section and requests only numbered points.'),
  fencedCode: z.boolean().describe('True if a current or still-active earlier USER instruction requires a fenced code block. False otherwise.'),
});

export const savedVerificationHandoffSchema = z.object({
  userRequirements: z.array(z.string().min(1).max(500)).min(1).max(12)
    .describe('Resolved current task and active preferences from USER messages, including the latest plan name, format, requested items and prohibitions. Not source facts or a draft answer.'),
  answerFormat: savedAnswerFormatSchema,
});

export const savedCodeBlocksSchema = z.array(z.object({
  blockIndex: z.number().int().min(0).max(19).describe('Zero-based index of the answer point that contains this code example.'),
  language: z.string().max(30).regex(/^[a-zA-Z0-9_+-]*$/).describe('Code language, or empty string when unspecified.'),
  code: z.string().min(1).max(16_000).regex(/\S/).describe('Exact requested code without Markdown fence delimiters. Copy visible source code faithfully.'),
})).min(1).max(8).describe('Requested code examples. The application renders the fences inside their answer points. Do not repeat this code in block text.');

export function renderSavedCodeBlocks(blocks: Array<{ text: string }>, codeBlocks: z.infer<typeof savedCodeBlocksSchema>): void {
  for (const code of codeBlocks) {
    const target = blocks[code.blockIndex];
    if (!target) throw new z.ZodError([{ code: 'custom', path: ['codeBlocks'], message: 'Every code block must refer to an existing zero-based answer block index.' }]);
    const fence = '`'.repeat(Math.max(3, ...[...code.code.matchAll(/`+/g)].map(match => match[0].length + 1)));
    const rendered = `${fence}${code.language}\n${code.code}\n${fence}`;
    if (!target.text.includes(rendered)) target.text += `\n\n${rendered}`;
  }
}

/** Saved visual follow-ups need the same preference handoff without disabling visual tools. */
export function needsSavedVerificationHandoff(decision: CapabilityRouteDecision): boolean {
  return 'skill' in decision && decision.skill === 'verify_saved_evidence'
    && 'savedOnly' in decision && decision.savedOnly === true;
}

/** A runtime skill for text-source follow-ups. It replaces discovery/analyst instructions. */
export function usesSavedEvidenceVerification(decision: CapabilityRouteDecision): boolean {
  return needsSavedVerificationHandoff(decision)
    && 'useStoryboard' in decision && decision.useStoryboard === false;
}

export const SAVED_VERIFICATION_HANDOFF_GUIDANCE = 'Before other tools, call set_verification_requirements once. Resolve active requirements from USER messages in chronological order, including renames and preferences that the latest request carries forward. Record answerFormat as structured constraints: the latest name, numbered point count, whether only those points are allowed, and whether code must be fenced. Do not infer preferences from prior assistant formatting or source content. Recording requirements does not finish research; next read the missing saved evidence.';

export const SAVED_EVIDENCE_VERIFICATION_SKILL = `
Active skill: verify_saved_evidence.
Your task is to verify a follow-up from saved original captions or comments. The finalizer writes the answer.

1. Resolve the request. Read the conversation's user messages for the latest name, format and corrections. Identify every requested quote, fact, source and calculation premise. Call set_verification_requirements before reading originals to record these requirements for the finalizer, including explicit names and formatting. This task record survives a research timeout. Earlier assistant claims and memory are leads, not proof. Keep facts about different demonstrations within one video separate.
2. Cover all requested items before polishing any one of them. Use the asset inventory to select each source by immutable version. Batch independent read_saved_evidence calls. Search an entire asset for a fact you have not located yet; do not invent a timestamp range. For requested wording, start with one distinctive word copied exactly from the request. Search matches every query word literally, with no stemming or synonyms, so do not combine several conceptual clues. After an empty result, simplify the query instead of concluding absence. For an unknown material name, search its category and compare all relevant occurrences, including the introduction.
3. Read context. A match is a location, not a complete explanation. Read the surrounding time range when a sentence is split across captions. If nextOffset is present, later matches remain unread. Paginate or narrow the query before claiming absence or choosing among different examples. Use remainingReads to prioritize missing requested items instead of rereading completed ones.
4. Verify quotations and calculations. Preserve caption wording, source identity and segment times. Identify the requested experiment or event before extracting its values. For elapsed intervals, read both endpoints and their context, then subtract like units. Video timestamps locate evidence; they are not elapsed experiment values. Never substitute an earlier similar phrase for a requested later event.
5. Check coverage before complete_research. Every requested source must have original evidence. Every requested quote and factual detail should have a supporting passage, or a specific remaining gap. Requirements are recorded once; proceed to source reads after recording them. Do not guess a material from an unrelated demonstration. Do not analyze transcripts again or retrieve YouTube. Do not write the answer during research.
`.trim();

export const SAVED_EVIDENCE_ANSWER_SKILL = `
Active skill: verify_saved_evidence, answer stage.
Resolve the latest request using earlier USER messages before composing. The verificationHandoff lists the resolved userRequirements; check these against the user messages and satisfy each in the answer. Carry forward the latest explicit plan name and formatting preference. Earlier assistant answers show what needs correction; their structure and limitations are not instructions to repeat.
Fit every requested item into the user's requested structure. If a fixed number of short numbered points is required, combine related findings within those points. Include the current plan name inside a point. Do not add an introduction, extra unnumbered paragraph, evidence-process commentary or closing section when prohibited.
Quote short, contiguous wording from the original passages. Cite each quote and the premises of calculations using evidenceIds. An earlier claim that quotations or timestamps were unavailable is superseded when the supplied originals contain them. Preserve real gaps only.
Before returning, check the latest name, point count, all requested quotes and factual details against your draft. Preserve chronology when the user requests returning to an earlier source after another source.
`.trim();

/** Move an existing number outside heading/emphasis markup so Markdown renders a list.
 * Never invent a number, remove an unnumbered introduction, or change source text/code. */
export function normalizeSavedPoint(text: string, format: z.infer<typeof savedAnswerFormatSchema> | undefined): string {
  if (!format?.onlyNumberedPoints || format.numberedPoints === null) return text;
  return text.trimStart()
    .replace(/^(?:#{1,6}[ \t]+)?(\*\*|__)(\d+)[.)]\1[ \t]+/, '$2. ')
    .replace(/^(?:#{1,6}[ \t]+)?(\*\*|__)(\d+)[.)][ \t]+/, '$2. $1')
    .replace(/^#{1,6}[ \t]+(\d+)[.)][ \t]+/, '$1. ')
    .replace(/^(\d+)\)[ \t]+/, '$1. ');
}

/** A fixed-size block array is the list structure; the application owns its markers. */
export function renderSavedPointNumbers(blocks: Array<{ text: string }>, format: z.infer<typeof savedAnswerFormatSchema> | undefined): void {
  if (!format?.onlyNumberedPoints || format.numberedPoints !== blocks.length) return;
  for (const [index, block] of blocks.entries()) {
    const content = normalizeSavedPoint(block.text, format).replace(/^\d+[.)][ \t]+/, '');
    block.text = `${index + 1}. ${content}`;
  }
}

/** Validate presentation before persistence; source and citation validation stay separate. */
export function validateSavedAnswerFormat(
  blocks: Array<{ text: string }>, format: z.infer<typeof savedAnswerFormatSchema> | undefined,
): void {
  if (!format) return;
  const issues: z.core.$ZodIssue[] = [];
  const fail = (message: string) => issues.push({ code: 'custom', path: ['blocks'], message });
  let hasCode = false;
  const prose = blocks.map(block => {
    let fence: { marker: string; size: number; content: string[] } | undefined;
    const lines: string[] = [];
    for (const line of block.text.split('\n')) {
      const boundary = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (boundary && boundary[1]![0] === fence.marker && boundary[1]!.length >= fence.size && !boundary[2]!.trim()) {
          hasCode ||= fence.content.join('\n').trim().length > 0;
          fence = undefined;
        } else fence.content.push(line);
      } else if (boundary) fence = { marker: boundary[1]![0]!, size: boundary[1]!.length, content: [] };
      else lines.push(line);
    }
    if (fence) fail('Close every code fence within its answer block.');
    return lines.join('\n');
  });
  if (format.name && !prose.join('\n').includes(format.name)) fail(`Include the current name ${JSON.stringify(format.name)} in the answer prose, inside a numbered point when only points are requested.`);
  if (format.numberedPoints !== null) {
    const numbers = [...prose.join('\n').matchAll(/^\s{0,3}(\d+)[.)]\s/gm)].map(match => Number(match[1]));
    if (numbers.length !== format.numberedPoints || numbers.some((number, index) => number !== index + 1)) {
      fail(`Use exactly ${format.numberedPoints} numbered points, sequentially numbered from 1.`);
    }
    if (format.onlyNumberedPoints && (blocks.length !== format.numberedPoints
      || prose.some((text, index) => !new RegExp(`^${index + 1}[.)]\\s`).test(text.trimStart())))) {
      fail(`Return exactly ${format.numberedPoints} blocks, one complete numbered point per block. No heading, introduction, separate continuation block or closing section.`);
    }
  }
  if (format.fencedCode && !hasCode) fail('Preserve the requested code in a nonempty fenced code block inside its numbered point.');
  if (issues.length) throw new z.ZodError(issues);
}

/** Normal completion cannot skip an available requested original source. */
export function unreadOriginalSources(
  decision: CapabilityRouteDecision, brief: SessionBrief | undefined, packets: Iterable<EvidencePacket>,
): string[] {
  if (!needsSavedVerificationHandoff(decision) || !brief) return [];
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
