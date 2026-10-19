import { normalize } from './vectors';

export const EMBEDDING_MODEL = 'fireworks/qwen3-embedding-8b';
export const EMBEDDING_DIMENSIONS = 4_096;
const EMBEDDINGS_URL = 'https://api.fireworks.ai/inference/v1/embeddings';
const MAX_INPUTS_PER_REQUEST = 64;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

/** Query input exactly as tested; passages are embedded without a prefix. */
export function embeddingQuery(question: string): string {
  return `Instruct: Given a question about a video, retrieve relevant transcript topics that answer the question.\nQuery: ${question}`;
}

export interface EmbeddingResult {
  vectors: Float32Array[];
  tokens: number;
  ms: number;
}

export class EmbeddingError extends Error {
  override readonly name = 'EmbeddingError';
  constructor(message: string, readonly status?: number) { super(message); }
}

/**
 * Embeds inputs with Qwen3 Embedding 8B on Fireworks, at most 64 per request, requests sent
 * concurrently. Every vector is L2-normalized, so similarity is a dot product.
 */
export async function embedTexts(apiKey: string | undefined, inputs: readonly string[], signal?: AbortSignal): Promise<EmbeddingResult> {
  if (!apiKey?.trim()) throw new EmbeddingError('Fireworks secret is not configured.');
  const started = Date.now();
  const batches = Array.from({ length: Math.ceil(inputs.length / MAX_INPUTS_PER_REQUEST) },
    (_, index) => inputs.slice(index * MAX_INPUTS_PER_REQUEST, (index + 1) * MAX_INPUTS_PER_REQUEST));
  const results = await Promise.all(batches.map(batch => embedBatch(apiKey, batch, signal)));
  return {
    vectors: results.flatMap(result => result.vectors),
    tokens: results.reduce((sum, result) => sum + result.tokens, 0),
    ms: Date.now() - started,
  };
}

async function embedBatch(apiKey: string, inputs: readonly string[], signal?: AbortSignal) {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(EMBEDDINGS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: inputs }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt < MAX_ATTEMPTS) continue;
      throw new EmbeddingError(`Embedding request failed: ${error instanceof Error ? error.name : 'unknown error'}.`);
    }
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, 400 * attempt));
      continue;
    }
    if (!response.ok) throw new EmbeddingError(`Embedding request failed with status ${response.status}.`, response.status);
    const body = await response.json() as { data?: { index: number; embedding: number[] }[]; usage?: { prompt_tokens?: number; total_tokens?: number } };
    const data = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
    if (data.length !== inputs.length || data.some((item, index) => item.index !== index || !Array.isArray(item.embedding)))
      throw new EmbeddingError('Embedding response does not match its inputs.');
    const dims = data[0]?.embedding.length;
    if (data.some(item => item.embedding.length !== dims)) throw new EmbeddingError('Embedding dimensions differ within a response.');
    return {
      vectors: data.map(item => normalize(item.embedding)),
      tokens: body.usage?.total_tokens ?? body.usage?.prompt_tokens ?? 0,
    };
  }
}
