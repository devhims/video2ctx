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
const MODEL_ANALYSIS_FINDINGS = 5;
const MODEL_ANALYSIS_FINDING_CHARACTERS = 600;

const transcriptAnalysisDataSchema = z.object({
  summary: z.string().trim().min(1),
  findings: z.array(z.object({
    claim: z.string().trim().min(1),
    excerptIds: z.array(z.string().min(1).max(300)).max(3),
  })),
  coverage: z.object({
    completeTranscriptRead: z.literal(true),
    segmentCount: z.number().int().nonnegative(),
    startMs: z.number().int().nonnegative().nullable(),
    endMs: z.number().int().nonnegative().nullable(),
  }),
  selectedExcerptCount: z.number().int().nonnegative(),
});

export const modelEvidencePacketSchema = z.object({
  packetId: z.string().min(1).max(300),
  kind: z.string().min(1).max(100),
  sources: z.array(evidenceSourceSchema).max(24),
  transcriptAnalysis: z.object({
    summary: z.string().trim().min(1).max(MODEL_ANALYSIS_SUMMARY_CHARACTERS),
    findings: z.array(z.object({
      claim: z.string().trim().min(1).max(MODEL_ANALYSIS_FINDING_CHARACTERS),
      excerptIds: z.array(z.string().min(1).max(300)).max(3),
    })).max(MODEL_ANALYSIS_FINDINGS),
    coverage: transcriptAnalysisDataSchema.shape.coverage,
    selectedExcerptCount: z.number().int().nonnegative(),
  }).optional(),
  excerpts: z.array(evidenceExcerptSchema).max(MODEL_EXCERPTS_PER_PACKET).optional(),
  artifacts: z.array(z.object({
    type: z.string().min(1).max(100),
    title: z.string().min(1).max(500).optional(),
  })).max(10).optional(),
  continuation: z.string().max(4_000).optional(),
  warnings: z.array(agentWarningSchema).max(50),
});

export type ModelEvidencePacket = z.infer<typeof modelEvidencePacketSchema>;

/**
 * Produces the evidence representation that a model may read. The full packet
 * remains the source of truth for billing, recovery, and citation validation.
 */
export function evidencePacketForModel(packet: EvidencePacket): ModelEvidencePacket {
  const transcriptAnalysis = readTranscriptAnalysis(packet);
  if (transcriptAnalysis) {
    return modelEvidencePacketSchema.parse({
      packetId: packet.packetId,
      kind: packet.kind,
      sources: packet.sources,
      transcriptAnalysis: {
        summary: boundedText(transcriptAnalysis.summary, MODEL_ANALYSIS_SUMMARY_CHARACTERS),
        findings: transcriptAnalysis.findings.slice(0, MODEL_ANALYSIS_FINDINGS).map((finding) => ({
          claim: boundedText(finding.claim, MODEL_ANALYSIS_FINDING_CHARACTERS),
          excerptIds: finding.excerptIds,
        })),
        coverage: transcriptAnalysis.coverage,
        selectedExcerptCount: transcriptAnalysis.selectedExcerptCount,
      },
      warnings: packet.warnings,
    });
  }

  const excerpts = packet.excerpts.slice(0, MODEL_EXCERPTS_PER_PACKET).map((excerpt) => ({
    ...excerpt,
    text: boundedText(excerpt.text, MODEL_EXCERPT_CHARACTERS),
  }));
  const sourceIds = new Set(excerpts.map((excerpt) => excerpt.sourceId));
  const sources = packet.sources.filter((source) => sourceIds.has(source.id));

  return modelEvidencePacketSchema.parse({
    packetId: packet.packetId,
    kind: packet.kind,
    sources: sources.length > 0 ? sources : packet.sources.slice(0, 1),
    excerpts,
    artifacts: packet.artifacts.map((artifact) => ({
      type: artifact.type,
      title: artifact.title,
    })),
    continuation: packet.continuation,
    warnings: packet.warnings,
  });
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
          claim: boundedText(finding.claim, 300),
        })),
      },
    });
  }

  const excerpts = packet.excerpts?.slice(0, 1).map((excerpt) => ({
    ...excerpt,
    text: boundedText(excerpt.text, 200),
  }));
  const sourceId = excerpts?.[0]?.sourceId;
  return modelEvidencePacketSchema.parse({
    ...packet,
    sources: sourceId ? packet.sources.filter((source) => source.id === sourceId) : packet.sources.slice(0, 1),
    excerpts,
    artifacts: packet.artifacts?.slice(0, 1),
    continuation: undefined,
  });
}

function boundedText(value: string, maximum: number): string {
  return value.trim().slice(0, maximum);
}

function serializedLength(value: unknown): number {
  return JSON.stringify(value).length;
}

/** Short references reduce recovery output tokens; full IDs remain persisted. */
export function finalizationEvidenceForModel(packets: readonly EvidencePacket[], maxCharacters: number) {
  const fullIds = new Map<string, string>();
  const aliases = new Map<string, string>();
  const alias = (id: string) => {
    let value = aliases.get(id);
    if (!value) {
      value = `ref_${aliases.size + 1}`;
      aliases.set(id, value);
      fullIds.set(value, id);
    }
    return value;
  };
  const evidence = evidencePacketsForModel(packets, { maxCharacters }).map(packet => ({
    ...packet,
    ...(packet.transcriptAnalysis ? { transcriptAnalysis: { ...packet.transcriptAnalysis,
      findings: packet.transcriptAnalysis.findings.map(finding => ({ ...finding,
        excerptIds: finding.excerptIds.map(alias),
      })),
    } } : {}),
    ...(packet.excerpts ? { excerpts: packet.excerpts.map(excerpt => ({ ...excerpt, id: alias(excerpt.id) })) } : {}),
  }));
  return { evidence, fullIds };
}
