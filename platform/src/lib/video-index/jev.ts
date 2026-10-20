export type TranscriptScope = 'one_part' | 'topic' | 'whole_video';

export const JEV_MODEL = 'jev-1.14.0';
const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_TIMEOUT_MS = 5_000;

/** The three-way choice measured at 18 of 18 whole-video decisions, with chapter titles as context. */
const SCOPE_CRITERIA = {
  one_part: 'Asks about one specific part of the video, such as a particular demo, clip, segment or announcement',
  topic_anywhere: 'Asks about a topic or detail that could be discussed anywhere, possibly in several places',
  whole_video: 'Asks for a summary, overview or list covering the whole video',
} as const;

/**
 * Optional router, used only with AGENT_TRANSCRIPT_ROUTER=jev. Returns undefined on any failure,
 * so the caller keeps the classifier's scope or the topic default.
 */
export async function routeTranscriptScopeWithJev(input: {
  apiKey: string | undefined;
  question: string;
  chapterTitles: readonly string[];
  signal?: AbortSignal;
}): Promise<{ scope: TranscriptScope; probabilities?: Record<string, number>; ms: number } | undefined> {
  if (!input.apiKey?.trim()) return undefined;
  const started = Date.now();
  try {
    const response = await fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: JEV_MODEL,
        state: { question: input.question, chapters: input.chapterTitles },
        questions: { route: { type: 'choice', instructions: 'Which kind of question is `question`, for a video with the chapters listed in `chapters`?', criteria: SCOPE_CRITERIA } },
      }),
      signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(JEV_TIMEOUT_MS)]) : AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { model?: string; answers?: { route?: { choice?: string; probabilities?: Record<string, number> } } };
    if (body.model !== JEV_MODEL) return undefined;
    const choice = body.answers?.route?.choice;
    const scope: TranscriptScope | undefined = choice === 'one_part' ? 'one_part' : choice === 'whole_video' ? 'whole_video'
      : choice === 'topic_anywhere' ? 'topic' : undefined;
    return scope ? { scope, probabilities: body.answers?.route?.probabilities, ms: Date.now() - started } : undefined;
  } catch {
    input.signal?.throwIfAborted();
    return undefined;
  }
}
