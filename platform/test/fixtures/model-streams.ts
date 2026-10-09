import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult, LanguageModelV4StreamPart } from '@ai-sdk/provider';

/** Replays a generate result as a provider stream. Failover-wrapped models stream every generate call. */
export function streamOf(result: LanguageModelV4GenerateResult): { stream: ReadableStream<LanguageModelV4StreamPart> } {
  const parts: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: result.warnings }];
  if (result.response) {
    const { id, modelId, timestamp } = result.response;
    parts.push({ type: 'response-metadata', id, modelId, timestamp });
  }
  result.content.forEach((item, index) => {
    const id = `${item.type}-${index}`;
    if (item.type === 'text') parts.push({ type: 'text-start', id }, { type: 'text-delta', id, delta: item.text }, { type: 'text-end', id });
    else if (item.type === 'reasoning') parts.push({ type: 'reasoning-start', id }, { type: 'reasoning-delta', id, delta: item.text },
      { type: 'reasoning-end', id });
    else parts.push(item);
  });
  parts.push({ type: 'finish', finishReason: result.finishReason, usage: result.usage });
  return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }) };
}

/** A doStream that runs a generate implementation first, so a throw or a pending promise fails before any content. */
export const streamed = (generate: (options: LanguageModelV4CallOptions) => PromiseLike<LanguageModelV4GenerateResult>) =>
  async (options: LanguageModelV4CallOptions) => streamOf(await generate(options));

interface ChatCompletion {
  id: string; created: number; model: string;
  choices: Array<{ index: number; finish_reason: string; message: { tool_calls?: Array<Record<string, unknown>> } & Record<string, unknown> }>;
  usage: Record<string, number>;
}

/** Answers an OpenAI-compatible request with a chat completion, as server-sent events when the request streams. */
export function chatCompletion(request: { stream?: boolean }, completion: ChatCompletion) {
  if (!request.stream) return Response.json(completion);
  const { id, created, model } = completion;
  const chunks: unknown[] = completion.choices.flatMap(({ index, finish_reason, message: { tool_calls, ...delta } }) => [
    { id, created, model, choices: [{ index, delta: { ...delta,
      ...(tool_calls ? { tool_calls: tool_calls.map((call, position) => ({ index: position, ...call })) } : {}) } }] },
    { id, created, model, choices: [{ index, delta: {}, finish_reason }] },
  ]);
  chunks.push({ id, created, model, choices: [], usage: completion.usage });
  const body = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/** A streamed chat completion with text content. */
export function sseResponse(model: string, content: string, usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }) {
  return chatCompletion({ stream: true }, { id: 'backup', created: 1, model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage });
}
