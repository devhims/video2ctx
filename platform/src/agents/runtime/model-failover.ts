import type {
  LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4GenerateResult, LanguageModelV4Reasoning,
  LanguageModelV4ResponseMetadata, LanguageModelV4StreamPart, LanguageModelV4Text, LanguageModelV4Usage, SharedV4Warning,
} from '@ai-sdk/provider';
import { RetryError } from 'ai';
import { failureDetails } from './diagnostics';

export interface ModelAttemptDiagnostic {
  event: 'attempt_started' | 'attempt_finished' | 'fallback';
  callId: string;
  attemptId: string;
  modelId: string;
  role: string;
  serviceTier: 'priority';
  startedAt?: number;
  outcome?: 'succeeded' | 'failed' | 'canceled';
  reason?: string;
  /** Time to completion or failure. */
  elapsedMs?: number;
  /** First text, reasoning or tool-argument delta, so it covers provider queueing and prompt processing. */
  firstContentMs?: number;
  idleMs?: number;
  statusCode?: number;
  providerRequestId?: string;
  usageAvailable?: boolean;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  firstContentTimeoutMs?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
}

export interface ModelRoleLimits { firstContentMs: number; totalMs: number }
const DEFAULT_ROLE_LIMITS: ModelRoleLimits = { firstContentMs: 10_000, totalMs: 30_000 };
// Roles with fixed phase budgets keep one whole-response limit. Fireworks often takes 2 to 3
// seconds to first content even for short prompts (measured October 9, 2026), so an earlier
// first-content cut would only move healthy calls, and the rest of their run, to the backup.
const ROLE_LIMITS: Record<string, ModelRoleLimits> = {
  // Leave most of the 20-second classification phase for its backup and validation.
  classifier: { firstContentMs: 5_000, totalMs: 5_000 },
  // Visual analysis and memory have an outer 20-second deadline for both attempts.
  visual_analyst: { firstContentMs: 8_000, totalMs: 8_000 },
  memory_updater: { firstContentMs: 8_000, totalMs: 8_000 },
};

/**
 * Every attempt streams. A silent provider fails at firstContentMs, while a call that keeps
 * producing content may continue to totalMs, clamped to the phase deadline.
 */
export function modelRoleLimits(role: string): ModelRoleLimits {
  return ROLE_LIMITS[role] ?? DEFAULT_ROLE_LIMITS;
}

/** Shared by all model roles in one run. Persist the fallback event before the next call. */
export interface ModelFailoverState {
  fallback: boolean;
  deadlineAt?: number;
  onDiagnostic?: (event: ModelAttemptDiagnostic) => void;
}

export class ModelFallbackExhaustedError extends Error {
  readonly code = 'MODEL_FALLBACK_EXHAUSTED';
  constructor(readonly failures: readonly unknown[]) {
    super('Model inference is unavailable after trying the configured fallback. Please retry.');
  }
}

/** The SDK wraps a terminal non-retryable error if an earlier request was retried. */
export function modelFallbackExhaustion(error: unknown): ModelFallbackExhaustedError | undefined {
  const seen = new Set<unknown>();
  while (RetryError.isInstance(error) && !seen.has(error)) {
    seen.add(error);
    error = error.lastError;
  }
  return error instanceof ModelFallbackExhaustedError ? error : undefined;
}

/** Only the owner of the displayed draft may restart a partially consumed stream. */
export class ModelStreamRestartError extends Error {
  constructor(readonly failure: unknown) { super('Restart the model step with DeepSeek after discarding the interrupted draft.'); }
}

class ModelAttemptTimeout extends Error {
  constructor(readonly reason: 'first_content_timeout' | 'stream_stall' | 'attempt_timeout' | 'phase_budget') {
    super(reason);
    this.name = 'TimeoutError';
  }
}

class RunModelFallback extends Error {
  constructor() { super('Another model call switched this run to DeepSeek.'); }
}

const managedModels = new WeakMap<object, ModelFailoverState>();
interface ModelRequestObserver {
  onStart: (requestId: string) => void;
  onUsage: (observation: { requestId: string; modelId: string; usage: LanguageModelV4Usage }) => void;
}
const requestObservers = new WeakMap<object, ModelRequestObserver>();

/** Observe generate requests. An attempt canceled before its finish event reports no usage. */
export function observeModelRequests(model: unknown, observer: ModelRequestObserver): boolean {
  if (!hasModelFailover(model)) return false;
  requestObservers.set(model as object, observer);
  return true;
}
const activePrimaryAttempts = new WeakMap<ModelFailoverState, Set<AbortController>>();
export function hasModelFailover(model: unknown): boolean {
  return typeof model === 'object' && model !== null && managedModels.has(model);
}

export function setModelFailoverDeadline(model: unknown, deadlineAt: number): void {
  if (typeof model === 'object' && model !== null) {
    const state = managedModels.get(model);
    if (state) state.deadlineAt = deadlineAt;
  }
}

/** A stream retry is independent of schema repair, and can happen at most once. */
export async function withModelStreamFallback<T>(work: (callId: string) => Promise<T>): Promise<T> {
  const callId = crypto.randomUUID();
  try { return await work(callId); }
  catch (error) {
    if (!(error instanceof ModelStreamRestartError)) throw error;
    try { return await work(callId); }
    catch (backupError) {
      const exhausted = modelFallbackExhaustion(backupError);
      if (exhausted) throw new ModelFallbackExhaustedError([error.failure, ...exhausted.failures]);
      throw backupError;
    }
  }
}

function eligible(error: unknown): boolean {
  const status = (error as { statusCode?: number } | undefined)?.statusCode;
  // Invalid inputs and shared authentication problems cannot be repaired by changing models.
  return status === undefined || status === 408 || status === 429 || status >= 500;
}

/** Abort races must finish even when a provider ignores its signal. */
function abortable<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    if (signal.aborted) { Promise.resolve(work).catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Assemble a generate result from a provider stream, reporting each part to the attempt's stall timers. */
async function collectStream(model: LanguageModelV4, params: LanguageModelV4CallOptions,
  current: { signal: AbortSignal; progress: (part: LanguageModelV4StreamPart) => void }): Promise<LanguageModelV4GenerateResult> {
  const { stream, request, response: streamResponse } = await abortable(model.doStream(params), current.signal);
  const reader = stream.getReader();
  const content: LanguageModelV4Content[] = [];
  const open = new Map<string, LanguageModelV4Text | LanguageModelV4Reasoning>();
  let warnings: SharedV4Warning[] = [];
  let metadata: LanguageModelV4ResponseMetadata = {};
  const block = (type: 'text' | 'reasoning', id: string): LanguageModelV4Text | LanguageModelV4Reasoning => {
    const existing = open.get(`${type}:${id}`);
    if (existing) return existing;
    const item = { type, text: '' };
    open.set(`${type}:${id}`, item); content.push(item);
    return item;
  };
  try {
    while (true) {
      const next = await abortable(reader.read(), current.signal);
      if (next.done) throw new Error('Provider stream ended without a finish event.');
      const part = next.value;
      current.progress(part);
      switch (part.type) {
        case 'stream-start': warnings = part.warnings; break;
        case 'response-metadata': metadata = { ...metadata, ...(part.id ? { id: part.id } : {}),
          ...(part.modelId ? { modelId: part.modelId } : {}), ...(part.timestamp ? { timestamp: part.timestamp } : {}) }; break;
        case 'text-start': case 'reasoning-start': {
          const item = block(part.type === 'text-start' ? 'text' : 'reasoning', part.id);
          if (part.providerMetadata) item.providerMetadata = part.providerMetadata;
          break;
        }
        case 'text-delta': block('text', part.id).text += part.delta; break;
        case 'reasoning-delta': block('reasoning', part.id).text += part.delta; break;
        case 'text-end': case 'reasoning-end': {
          const item = open.get(`${part.type === 'text-end' ? 'text' : 'reasoning'}:${part.id}`);
          if (item && part.providerMetadata) item.providerMetadata = { ...item.providerMetadata, ...part.providerMetadata };
          break;
        }
        // Tool arguments arrive again as one complete tool-call part.
        case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end': case 'raw': break;
        case 'error': throw part.error;
        case 'finish': return {
          // Match generate results, which omit empty text and reasoning blocks.
          content: content.filter(item => !((item.type === 'text' || item.type === 'reasoning') && !item.text && !item.providerMetadata)),
          finishReason: part.finishReason, usage: part.usage,
          ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
          request, response: { ...metadata, headers: streamResponse?.headers }, warnings,
        };
        default: content.push(part);
      }
    }
  } finally { void reader.cancel().catch(() => {}); }
}

export function withModelFailover(options: {
  primary: LanguageModelV4;
  fallback: LanguageModelV4;
  state: ModelFailoverState;
  role: string;
  runId?: string;
}): LanguageModelV4 {
  const { primary, fallback, state, role } = options;
  const limits = modelRoleLimits(role);
  const idleTimeoutMs = 5_000;
  const fallbackReserveMs = 10_000;
  const emit = (event: ModelAttemptDiagnostic) => {
    console.log(JSON.stringify({ ...event, event: 'agent_model_failover', phase: event.event, runId: options.runId }));
    state.onDiagnostic?.(event);
  };
  const attempt = (model: LanguageModelV4, params: LanguageModelV4CallOptions, callId: string, attemptId = crypto.randomUUID()) => {
    params.abortSignal?.throwIfAborted();
    const controller = new AbortController();
    if (model === primary) {
      let active = activePrimaryAttempts.get(state);
      if (!active) activePrimaryAttempts.set(state, active = new Set());
      active.add(controller);
    }
    const signal = params.abortSignal ? AbortSignal.any([params.abortSignal, controller.signal]) : controller.signal;
    const startedAt = Date.now();
    const fields = { callId, attemptId, modelId: model.modelId, role, serviceTier: 'priority' as const };
    let firstContentAt: number | undefined;
    let lastContentAt: number | undefined;
    let usage: LanguageModelV4Usage | undefined;
    let providerRequestId: string | undefined;
    let ended = false;
    const fail = (reason: ConstructorParameters<typeof ModelAttemptTimeout>[0]) => controller.abort(new ModelAttemptTimeout(reason));
    const remainingMs = Math.max(1, (state.deadlineAt ?? Infinity) - Date.now());
    const budgetMs = model === primary ? Math.max(1, remainingMs - fallbackReserveMs) : remainingMs;
    const attemptLimitMs = Math.min(limits.totalMs, budgetMs);
    // A provider that stays silent until the overall limit is still a first-content failure.
    const total = setTimeout(() => fail(budgetMs < limits.totalMs ? 'phase_budget'
      : firstContentAt === undefined ? 'first_content_timeout' : 'attempt_timeout'), attemptLimitMs);
    const firstContentLimitMs = Math.min(limits.firstContentMs, attemptLimitMs);
    let idle = setTimeout(() => fail('first_content_timeout'), firstContentLimitMs);
    // Record the limits this attempt actually ran under, after the phase budget.
    const timeouts = { firstContentTimeoutMs: firstContentLimitMs, idleTimeoutMs, totalTimeoutMs: attemptLimitMs };
    emit({ event: 'attempt_started', ...fields, startedAt, ...timeouts });
    const finish = (error?: unknown) => {
      if (ended) return;
      ended = true;
      activePrimaryAttempts.get(state)?.delete(controller);
      clearTimeout(total); clearTimeout(idle);
      const details = failureDetails(error);
      emit({ event: 'attempt_finished', ...fields, startedAt, ...timeouts,
        outcome: params.abortSignal?.aborted || error instanceof RunModelFallback || (error instanceof ModelAttemptTimeout && error.reason === 'phase_budget')
          ? 'canceled' : error ? 'failed' : 'succeeded',
        reason: error instanceof RunModelFallback ? 'run_fallback'
          : error instanceof ModelAttemptTimeout ? error.reason : error ? 'provider_error' : undefined,
        elapsedMs: Date.now() - startedAt,
        firstContentMs: firstContentAt === undefined ? undefined : firstContentAt - startedAt,
        idleMs: lastContentAt === undefined ? Date.now() - startedAt : Date.now() - lastContentAt,
        usageAvailable: usage !== undefined, inputTokens: usage?.inputTokens.total, cachedInputTokens: usage?.inputTokens.cacheRead,
        outputTokens: usage?.outputTokens.total, reasoningTokens: usage?.outputTokens.reasoning,
        statusCode: details.statusCode, providerRequestId: providerRequestId ?? details.providerRequestId });
    };
    const switchModel = (error: unknown) => {
      finish(error);
      params.abortSignal?.throwIfAborted();
      if (!eligible(error)) throw error;
      if (model === fallback) throw new ModelFallbackExhaustedError([error]);
      if (!state.fallback) {
        state.fallback = true;
        emit({ event: 'fallback', ...fields, reason: error instanceof ModelAttemptTimeout ? error.reason : 'provider_error' });
        // Wake concurrent transcript/image calls immediately, without waiting for their own timers.
        for (const pending of activePrimaryAttempts.get(state) ?? []) pending.abort(new RunModelFallback());
      }
    };
    const progress = (part: LanguageModelV4StreamPart) => {
      if (part.type === 'response-metadata' && part.id && /^[\w-]{1,128}$/.test(part.id)) providerRequestId = part.id;
      if (part.type === 'finish') usage = part.usage;
      if (!((part.type === 'text-delta' || part.type === 'reasoning-delta' || part.type === 'tool-input-delta') && part.delta.length)
        && part.type !== 'tool-call' && part.type !== 'file') return;
      firstContentAt ??= Date.now(); lastContentAt = Date.now();
      clearTimeout(idle);
      idle = setTimeout(() => fail('stream_stall'), idleTimeoutMs);
    };
    return { signal, finish, switchModel, progress,
      cancel: () => { activePrimaryAttempts.get(state)?.delete(controller);
        controller.abort(new Error('Model attempt finished.')); clearTimeout(total); clearTimeout(idle); } };
  };
  const model: LanguageModelV4 = {
    specificationVersion: 'v4', provider: primary.provider,
    get modelId() { return state.fallback ? fallback.modelId : primary.modelId; },
    supportedUrls: primary.supportedUrls,
    async doGenerate(params) {
      const callId = crypto.randomUUID();
      const failures: unknown[] = [];
      const observer = requestObservers.get(model);
      for (const candidate of state.fallback ? [fallback] : [primary, fallback]) {
        params.abortSignal?.throwIfAborted();
        const requestId = crypto.randomUUID();
        observer?.onStart(requestId);
        const current = attempt(candidate, params, callId, requestId);
        try {
          // Streaming lets a silent provider fail at its first-content limit, while a
          // call that keeps producing content is not cut off at that limit.
          const result = await collectStream(candidate, { ...params, abortSignal: current.signal }, current);
          observer?.onUsage({ requestId, modelId: result.response?.modelId ?? candidate.modelId, usage: result.usage });
          current.finish();
          return result;
        } catch (error) {
          failures.push(error);
          try { current.switchModel(error); }
          catch (terminal) {
            if (terminal instanceof ModelFallbackExhaustedError) throw new ModelFallbackExhaustedError(failures);
            throw terminal;
          }
        } finally { current.cancel(); }
      }
      throw new ModelFallbackExhaustedError(failures);
    },
    async doStream(params) {
      const suppliedId = params.providerOptions?.agentDiagnostics?.failoverCallId;
      const callId = typeof suppliedId === 'string' && /^[\w-]{1,128}$/.test(suppliedId) ? suppliedId : crypto.randomUUID();
      // Stream errors, including failures before headers, share the draft-owner retry path.
      const candidate = state.fallback ? fallback : primary;
      const current = attempt(candidate, params, callId);
      let reader: ReadableStreamDefaultReader<LanguageModelV4StreamPart> | undefined;
      let canceled = false;
      const release = () => { current.cancel(); void reader?.cancel().catch(() => {}); };
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
          try {
            const result = await abortable(candidate.doStream({ ...params, abortSignal: current.signal }), current.signal);
            reader = result.stream.getReader();
            while (true) {
              const next = await abortable(reader.read(), current.signal);
              if (next.done) {
                throw new Error('Provider stream ended without a finish event.');
              }
              if (next.value.type === 'error') throw next.value.error;
              current.progress(next.value);
              controller.enqueue(next.value);
              if (next.value.type === 'finish') { current.finish(); controller.close(); break; }
            }
          } catch (error) {
            if (canceled) return;
            try { current.switchModel(error); controller.error(new ModelStreamRestartError(error)); }
            catch (terminal) { controller.error(terminal); }
          } finally { release(); }
        },
        cancel() { canceled = true; current.finish(new Error('Stream consumer canceled.')); release(); },
      });
      return { stream };
    },
  };
  managedModels.set(model, state);
  return model;
}
