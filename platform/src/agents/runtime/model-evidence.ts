import { compactTranscript } from './transcript-segments';
import { storyboardManifestSchema } from '../providers/youtube/storyboard';
import { framesSchema } from '../../lib/youtube-frames-contract';
import { transcriptFactsSchema, transcriptSourceContextSchema } from './transcript-grounding';
import { z } from 'zod';
import {
  agentWarningSchema,
  evidenceExcerptSchema,
  evidenceSourceSchema,
  type EvidencePacket,
} from '../contracts';

const MODEL_EXCERPTS_PER_PACKET = 8;
const MODEL_EXCERPT_CHARACTERS = 800;
const MODEL_ANALYSIS_SUMMARY_CHARACTERS = 2_000;
const MODEL_ANALYSIS_FINDINGS = 20;
const frameCoverageSchema = z.object({
  requestedTimestampsMs: z.array(z.number().int().nonnegative()).max(6),
  frames: z.array(framesSchema.shape.frames.element.omit({ imageBase64: true })).max(6),
  failures: framesSchema.shape.failures,
});
const visualCoverageSchema = z.object({
  manifest: storyboardManifestSchema.optional(),
  selection: z.object({ mode: z.enum(['leading', 'spread', 'timestamps', 'indexes', 'metadata']),
    requestedTimestampsMs: z.array(z.number().int().nonnegative()).max(20).optional(),
    requestedSheetIndexes: z.array(z.number().int().nonnegative()).max(20).optional() }).optional(),
  sampledRanges: z.array(z.object({ startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative() })).max(20),
  totalFrames: z.number().int().positive(),
  sampledFrames: z.number().int().nonnegative(),
  intervalMs: z.number().int().positive(),
});

const transcriptAnalysisDataSchema = z.object({
  groundingVersion: z.literal(1).optional(),
  summary: z.string().trim().min(1),
  sourceContext: transcriptSourceContextSchema.optional(),
  findings: z.array(transcriptFactsSchema.extend({
    claim: z.string().trim().min(1),
    excerptIds: z.array(z.string().min(1).max(300)).max(3),
  })),
  coverage: z.object({
    completeTranscriptRead: z.boolean(),
    segmentCount: z.number().int().nonnegative(),
    startMs: z.number().int().nonnegative().nullable(),
    endMs: z.number().int().nonnegative().nullable(),
  }),
  selectedExcerptCount: z.number().int().nonnegative(),
});

export const modelEvidencePacketSchema = z.object({
  packetId: z.string().min(1).max(300),
  kind: z.string().min(1).max(100),
  assetVersions: z.array(z.string()).optional(),
  sources: z.array(evidenceSourceSchema).max(24),
  transcriptAnalysis: z.object({
    groundingVersion: z.literal(1).optional(),
    sourceContext: transcriptSourceContextSchema.optional(),
    summary: z.string().trim().min(1).max(MODEL_ANALYSIS_SUMMARY_CHARACTERS),
    findings: z.array(transcriptFactsSchema.extend({
      claim: z.string().trim().min(1),
      excerptIds: z.array(z.string().min(1).max(300)).max(3),
    })).max(MODEL_ANALYSIS_FINDINGS),
    coverage: transcriptAnalysisDataSchema.shape.coverage,
    selectedExcerptCount: z.number().int().nonnegative(),
  }).optional(),
  transcript: z.object({
    citationPrefix: z.string(),
    text: z.string(),
    timestampSeconds: z.number().optional(),
    hasSpeechAtTimestamp: z.boolean().optional(),
    timing: z.array(z.tuple([z.string(), z.number(), z.number()])).optional(),
  }).optional(),
  excerpts: z.array(evidenceExcerptSchema).max(5_000).optional(),
  visualCoverage: visualCoverageSchema.optional(),
  frameCoverage: frameCoverageSchema.optional(),
  artifacts: z.array(z.object({
    type: z.string().min(1).max(100),
    title: z.string().min(1).max(500).optional(),
  })).max(10).optional(),
  continuation: z.string().max(4_000).optional(),
  warnings: z.array(agentWarningSchema).max(50),
});

export type ModelEvidencePacket = z.infer<typeof modelEvidencePacketSchema>;

/** Keep large reference catalogs out of provider schemas while checking every returned ID. */
export function modelCitationReference(ids: readonly string[]) {
  const allowed = new Set(ids);
  return ids.length > 100
    ? z.string().regex(/^[A-Za-z0-9:_-]+$/).max(300).refine(id => allowed.has(id), 'Unknown evidence reference.')
    : ids.length ? z.enum([...ids]) : z.string();
}

/**
 * Produces the evidence representation that a model may read. The full packet
 * remains the source of truth for billing, recovery, and citation validation.
 */
export function evidencePacketForModel(packet: EvidencePacket): ModelEvidencePacket {
  // Single-video inspection is read directly by the main model, including on recovery/finalization.
  if (packet.kind === 'youtube_transcript' && !packet.artifacts.some(artifact => artifact.type === 'youtube_transcript_analysis')) {
    const context = packet.artifacts.find(artifact => artifact.type === 'youtube_transcript_context');
    const hidden = packet.artifacts.some(artifact => artifact.data.requiresAnalysis);
    const captions = packet.excerpts.filter(excerpt => excerpt.startMs !== undefined && excerpt.endMs !== undefined);
    const compact = compactTranscript(captions);
    return modelEvidencePacketSchema.parse({
      packetId: packet.packetId, kind: packet.kind, sources: packet.sources, assetVersions: packet.assetVersions,
      continuation: packet.continuation,
      excerpts: packet.excerpts.filter(excerpt => excerpt.startMs === undefined || excerpt.endMs === undefined),
      transcript: hidden ? undefined : { ...compact, ...(context ? { timestampSeconds: context.data.timestampSeconds, hasSpeechAtTimestamp: context.data.hasSpeechAtTimestamp,
        timing: captions.map(excerpt => [excerpt.id.slice(compact.citationPrefix.length), excerpt.startMs, excerpt.endMs]) } : {}) },
      artifacts: packet.artifacts.map(({ type, title }) => ({ type, title })), warnings: packet.warnings,
    });
  }
  const transcriptAnalysis = readTranscriptAnalysis(packet);
  if (transcriptAnalysis) {
    return modelEvidencePacketSchema.parse({
      packetId: packet.packetId,
      kind: packet.kind,
      sources: packet.sources,
      assetVersions: packet.assetVersions,
      transcriptAnalysis: {
        groundingVersion: transcriptAnalysis.groundingVersion,
        sourceContext: transcriptAnalysis.sourceContext,
        summary: boundedText(transcriptAnalysis.summary, MODEL_ANALYSIS_SUMMARY_CHARACTERS),
        findings: transcriptAnalysis.findings.slice(0, MODEL_ANALYSIS_FINDINGS).map((finding) => ({
          ...finding,
          claim: finding.claim,
          excerptIds: finding.excerptIds,
        })),
        coverage: transcriptAnalysis.coverage,
        selectedExcerptCount: transcriptAnalysis.selectedExcerptCount,
      },
      warnings: packet.warnings,
    });
  }

  // One visual finding can have three frame citations. Keep each distinct
  // finding before adding duplicate observations at other timestamps.
  const ordered = (packet.kind === 'youtube_storyboard' || packet.kind === 'youtube_frames') ? distinctVisualFindingsFirst(packet.excerpts) : packet.excerpts;
  const coverage = packet.kind === 'youtube_storyboard'
    ? visualCoverageSchema.safeParse(packet.artifacts.find(artifact => ['youtube_storyboard_analysis','youtube_storyboard_retrieval'].includes(artifact.type))?.data)
    : undefined;
  const frameCoverage = packet.kind === 'youtube_frames'
    ? frameCoverageSchema.safeParse(packet.artifacts.find(artifact => ['youtube_frame_analysis','youtube_frame_retrieval'].includes(artifact.type))?.data)
    : undefined;
  const excerpts = ordered.slice(0, MODEL_EXCERPTS_PER_PACKET).map((excerpt) => ({
    ...excerpt,
    text: boundedText(excerpt.text, MODEL_EXCERPT_CHARACTERS),
  }));
  const sourceIds = new Set(excerpts.map((excerpt) => excerpt.sourceId));
  const sources = packet.sources.filter((source) => sourceIds.has(source.id));

  return modelEvidencePacketSchema.parse({
    packetId: packet.packetId,
    assetVersions: packet.assetVersions,
    kind: packet.kind,
    sources: sources.length > 0 ? sources : packet.sources.slice(0, 1),
    excerpts,
    visualCoverage: coverage?.success ? coverage.data : undefined,
    frameCoverage: frameCoverage?.success ? frameCoverage.data : undefined,
    artifacts: packet.artifacts.map((artifact) => ({
      type: artifact.type,
      title: artifact.title,
    })),
    continuation: packet.continuation,
    warnings: packet.warnings,
  });
}

function distinctVisualFindingsFirst(excerpts: EvidencePacket['excerpts']) {
  const groups = new Map<string, EvidencePacket['excerpts']>();
  for (const excerpt of excerpts) {
    const key = JSON.stringify([excerpt.sourceId, excerpt.text]);
    const group = groups.get(key) ?? [];
    group.push(excerpt);
    groups.set(key, group);
  }
  const values = [...groups.values()];
  return [...values.flatMap(group => group.slice(0, 1)), ...values.flatMap(group => group.slice(1))];
}

export function evidencePacketsForModel(
  packets: readonly EvidencePacket[],
  options: { maxCharacters: number },
): ModelEvidencePacket[] {
  const projected = packets.map(evidencePacketForModel);
  const prioritized = [
    ...projected.filter((packet) => packet.transcriptAnalysis),
    ...projected.filter((packet) => !packet.transcriptAnalysis),
  ];
  const selected: ModelEvidencePacket[] = [];

  for (const packet of prioritized) {
    if (serializedLength([...selected, packet]) <= options.maxCharacters) {
      selected.push(packet);
      continue;
    }
    if (packet.transcript?.text) {
      // Keep as much of a long transcript as fits, spread across its timeline.
      // Dropping straight to the opening sentence loses almost all comparison context.
      const lines = packet.transcript.text.split('\n');
      const candidate = (count: number): ModelEvidencePacket => ({ ...packet,
        transcript: { ...packet.transcript!, text: Array.from({length: count}, (_, index) => lines[count === 1 ? 0
          : Math.floor(index * (lines.length - 1) / (count - 1))]!).join('\n') },
        warnings: [...packet.warnings, {code:'TRANSCRIPT_CONTEXT_TRUNCATED',
          message:'Only sampled passages fit the finalization context. Additional passages remain available through saved evidence reads; do not claim exhaustive coverage.'}],
      });
      let low = 1, high = lines.length - 1;
      let fitted: ModelEvidencePacket | undefined;
      while (low <= high) {
        const count = Math.floor((low + high) / 2);
        const sample = candidate(count);
        if (serializedLength([...selected, sample]) <= options.maxCharacters) { fitted = sample; low = count + 1; }
        else high = count - 1;
      }
      if (fitted) { selected.push(fitted); continue; }
    }
    const reduced = reduceModelEvidencePacket(packet);
    if (serializedLength([...selected, reduced]) <= options.maxCharacters) selected.push(reduced);
  }

  return selected;
}

function readTranscriptAnalysis(packet: EvidencePacket) {
  if (packet.kind !== 'youtube_transcript') return undefined;
  const artifact = packet.artifacts.find(({ type }) => type === 'youtube_transcript_analysis');
  if (!artifact) return undefined;
  const parsed = transcriptAnalysisDataSchema.safeParse(artifact.data);
  return parsed.success ? parsed.data : undefined;
}

function reduceModelEvidencePacket(packet: ModelEvidencePacket): ModelEvidencePacket {
  if (packet.transcriptAnalysis) {
    return modelEvidencePacketSchema.parse({
      ...packet,
      transcriptAnalysis: {
        ...packet.transcriptAnalysis,
        summary: boundedText(packet.transcriptAnalysis.summary, 500),
        findings: packet.transcriptAnalysis.findings.slice(0, 2).map((finding) => ({
          ...finding,
          claim: finding.claim,
        })),
      },
    });
  }

  const completeTranscript = packet.artifacts?.some(artifact => artifact.type === 'youtube_complete_transcript');
  const excerpts = packet.excerpts?.slice(0, (packet.kind === 'youtube_storyboard' || packet.kind === 'youtube_frames') ? 5 : 1).map((excerpt) => ({
    ...excerpt,
    text: boundedText(excerpt.text, 200),
  }));
  const sourceId = excerpts?.[0]?.sourceId;
  return modelEvidencePacketSchema.parse({
    ...packet,
    sources: sourceId ? packet.sources.filter((source) => source.id === sourceId) : packet.sources.slice(0, 1),
    excerpts,
    transcript: packet.transcript ? { ...packet.transcript, text: packet.transcript.text.split('\n')[0] ?? '', timing: undefined } : undefined,
    artifacts: packet.artifacts?.slice(0, 1),
    continuation: undefined,
    warnings: completeTranscript ? [...packet.warnings, { code: 'TRANSCRIPT_CONTEXT_TRUNCATED',
      message: 'The complete retrieved transcript exceeds the finalization evidence budget. Only a partial excerpt is supplied here; do not claim exhaustive coverage.' }] : packet.warnings,
  });
}

function boundedText(value: string, maximum: number): string {
  return value.trim().slice(0, maximum);
}

function serializedLength(value: unknown): number {
  return JSON.stringify(value).length;
}

/** Short references reduce recovery output tokens; full IDs remain persisted. */
export function finalizationEvidenceForModel(
  packets: readonly EvidencePacket[], maxCharacters: number, comparisonVideoIds: readonly string[] = [],
) {
  const aliases = new Map<string, string>();
  const fullIds = new Map<string, string>();
  // For a single exact transcript, keep the displayed original segment numbers
  // stable when moving from inspection to finalization or expanding a time lookup.
  const segmentIds = packets.flatMap(packet => packet.excerpts.map(excerpt => excerpt.id))
    .filter(id => /:segment:\d+$/.test(id));
  const prefixes = new Set(segmentIds.map(id => id.replace(/\d+$/, '')));
  if (prefixes.size === 1) for (const id of segmentIds) aliases.set(id, `ref_${id.split(':').at(-1)}`);
  const used = new Set(aliases.values());
  let nextAlias = 1;
  const alias = (id: string) => {
    let value = aliases.get(id);
    if (!value) {
      while (used.has(`ref_${nextAlias}`)) nextAlias += 1;
      value = `ref_${nextAlias++}`; aliases.set(id, value); used.add(value);
    }
    return value;
  };
  // Shorten IDs before measuring the input budget, not only after truncation.
  const compact = packets.map(packet => {
    const analysis = readTranscriptAnalysis(packet);
    return { ...packet,
      excerpts: packet.excerpts.map(excerpt => ({ ...excerpt, id: alias(excerpt.id) })),
      artifacts: packet.artifacts.map(artifact => artifact.type === 'youtube_transcript_analysis' && analysis
        ? { ...artifact, data: { ...artifact.data, findings: analysis.findings.map(finding => ({
          ...finding, excerptIds: finding.excerptIds.map(alias),
        })) } } : artifact),
    };
  });
  const evidence = comparisonVideoIds.length
    ? comparisonVideoIds.flatMap(videoId => evidencePacketsForModel(
      compact.filter(packet => packet.sources.some(source => source.videoId === videoId)),
      { maxCharacters: Math.floor(maxCharacters / comparisonVideoIds.length) },
    ))
    : evidencePacketsForModel(compact, { maxCharacters });
  const included = new Set(evidence.flatMap(packet => [
    ...(packet.excerpts?.map(excerpt => excerpt.id) ?? []),
    ...(packet.transcript?.text.split('\n').filter(Boolean).map(line => packet.transcript!.citationPrefix + line.split(' ')[0]) ?? []),
    ...(packet.transcriptAnalysis?.findings.flatMap(finding => finding.excerptIds) ?? []),
  ]));
  for (const [full, short] of aliases) if (included.has(short)) fullIds.set(short, full);
  return { evidence, fullIds };
}
