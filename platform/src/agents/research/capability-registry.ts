import {
  RESEARCH_TOPIC_DESCRIPTION,
  RESEARCH_TOPIC_INSTRUCTIONS,
  createResearchTopicTools,
  RESEARCH_TOPIC_TOOL_NAMES,
} from './capabilities/research-topic';
import {
  createInspectVideoTools,
  INSPECT_VIDEO_DESCRIPTION,
  INSPECT_VIDEO_INSTRUCTIONS,
  INSPECT_VIDEO_TOOL_NAMES,
} from './capabilities/inspect-video';

export const capabilityRegistry = {
  topic_research: {
    id: 'topic_research',
    description: RESEARCH_TOPIC_DESCRIPTION,
    instructions: RESEARCH_TOPIC_INSTRUCTIONS,
    toolNames: RESEARCH_TOPIC_TOOL_NAMES,
    createTools: createResearchTopicTools,
  },
  inspect_video: {
    id: 'inspect_video',
    description: INSPECT_VIDEO_DESCRIPTION,
    instructions: INSPECT_VIDEO_INSTRUCTIONS,
    toolNames: INSPECT_VIDEO_TOOL_NAMES,
    createTools: createInspectVideoTools,
  },
} as const;

export type ExecutableCapabilityId = keyof typeof capabilityRegistry;

export function describeCapabilities(capabilityIds: readonly ExecutableCapabilityId[] = ['topic_research']): string {
  return capabilityIds.map((id) => capabilityRegistry[id])
    .map((capability) => `${capability.id}: ${capability.description}`)
    .join('\n');
}
