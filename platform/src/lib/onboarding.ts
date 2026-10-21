import { z } from 'zod';
import { ApiError, now } from './http';

/** The dashboard's onboarding choices. Named agents use the `skills` CLI's `--agent` ids. */
export const ONBOARDING_AGENTS = ['claude-code', 'codex', 'cursor', 'opencode', 'other'] as const;
export const ONBOARDING_GOAL_MAX_LENGTH = 500;

export type OnboardingAgent = typeof ONBOARDING_AGENTS[number];

export interface OnboardingAnswers {
  agents: OnboardingAgent[];
  goal: string | null;
}

const answersSchema = z.object({
  agents: z.array(z.enum(ONBOARDING_AGENTS)).min(1).max(ONBOARDING_AGENTS.length)
    .refine(agents => new Set(agents).size === agents.length),
  goal: z.string().max(ONBOARDING_GOAL_MAX_LENGTH).nullable().optional(),
}).strict();

export function parseOnboardingAnswers(input: unknown): OnboardingAnswers {
  const parsed = answersSchema.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(422, 'INVALID_ONBOARDING_ANSWERS', `Choose at least one coding agent from ${ONBOARDING_AGENTS.join(', ')}, and keep the goal to ${ONBOARDING_GOAL_MAX_LENGTH} characters.`);
  }
  // A fixed order keeps equal answers byte-identical, so they group cleanly in queries.
  const agents = ONBOARDING_AGENTS.filter(agent => parsed.data.agents.includes(agent));
  return { agents, goal: parsed.data.goal?.trim() || null };
}

/** Saves the account's latest answers. Answering again, after going back a step, replaces them. */
export async function saveOnboardingAnswers(env: Env, userId: string, answers: OnboardingAnswers): Promise<void> {
  const timestamp = now();
  await env.DB.prepare(`INSERT INTO onboarding_answers (user_id, agents, goal, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET agents = excluded.agents, goal = excluded.goal, updated_at = excluded.updated_at`)
    .bind(userId, JSON.stringify(answers.agents), answers.goal, timestamp, timestamp)
    .run();
}
