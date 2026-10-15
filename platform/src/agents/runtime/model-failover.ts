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
  videoId?: string;
  modelCallId?: string;
  analysisAttempt?: number;
  serviceTier?: 'priority';
  startedAt?: number;
  outcome?: 'succeeded' | 'failed' | 'canceled';
  reason?: string;
  /** Time to completion or failure. */
  elapsedMs?: number;
  /** First text, reasoning or tool-argument delta, so it covers provider queueing and prompt processing. */
  firstContentMs?: number;
  idleMs?: number;
  statusCode?: number;
  retryable?: boolean;
  providerRequestId?: string;
  usageAvailable?: boolean;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  firstContentTimeoutMs?: number;
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
  // Visual analysis and memory have an outer 20-second deadline for all attempts.
  visual_analyst: { firstContentMs: 8_000, totalMs: 8_000 },
  memory_updater: { firstContentMs: 8_000, totalMs: 8_000 },
};

/**
 * Every attempt streams. A silent provider fails at firstContentMs. After first content,
 * pauses are allowed until totalMs, clamped to the phase deadline.
 */
export function modelRoleLimits(role: string): ModelRoleLimits {
  return ROLE_LIMITS[role] ?? DEFAULT_ROLE_LIMITS;
}

/** Shared by all model roles in one run. Persist the fallback event before the next call. */
export interface ModelFailoverState {
  fallback: boolean;
  deadlineAt?: number;
  onDiagnostic?: (event: ModelAttemptDiagnostic) => void;
  beforeAttempt?: () => void;
}

export class ModelRequestExhaustedError extends Error {
  readonly code: string = 'MODEL_REQUEST_EXHAUSTED';
  constructor(readonly failures: readonly unknown[]) {
    super('Model inference is unavailable after the bounded retry. Please retry.');
  }
}

export class ModelFallbackExhaustedError extends ModelRequestExhaustedError {
  override readonly code = 'MODEL_FALLBACK_EXHAUSTED';
}

/** The SDK wraps a terminal non-retryable error if an earlier request was retried. */
export function modelRequestExhaustion(error: unknown): ModelRequestExhaustedError | undefined {
  const seen = new Set<unknown>();
  while (RetryError.isInstance(error) && !seen.has(error)) {
    seen.add(error);
    error = error.lastError;
  }
  return error instanceof ModelRequestExhaustedError ? error : undefined;
}

/** Only the owner of the displayed draft may restart a partially consumed stream. */
export class ModelStreamRestartError extends Error {
  constructor(readonly failure: unknown) { super('Restart the model request after discarding the interrupted draft.'); }
}

class ModelAttemptTimeout extends Error {
  constructor(readonly reason: 'first_content_timeout' | 'attempt_timeout' | 'phase_budget') {
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
  if (!hasModelTimeouts(model)) return false;
  requestObservers.set(model as object, observer);
  return true;
}
const activePrimaryAttempts = new WeakMap<ModelFailoverState, Set<AbortController>>();
export function hasModelTimeouts(model: unknown): boolean {
  return typeof model === 'object' && model !== null && managedModels.has(model);
}

export function setModelDeadline(model: unknown, deadlineAt: number): void {
  if (typeof model === 'object' && model !== null) {
    const state = managedModels.get(model);
    if (state) state.deadlineAt = deadlineAt;
  }
}

/** Recheck the run's cost budget before every physical provider request. */
export function setModelAttemptGuard(model: unknown, guard: () => void): void {
  if (hasModelTimeouts(model)) managedModels.get(model as object)!.beforeAttempt = guard;
}

interface ModelRequestState { timeoutRetries: number; failures: unknown[] }
// The draft owner keeps one retry allowance across stream restarts, then releases it.
const streamRequests = new Map<string, ModelRequestState>();

/** At most one model switch and one timeout retry, independent of schema repair. */
export async function withModelStreamFallback<T>(work: (callId: string) => Promise<T>): Promise<T> {
  const callId = crypto.randomUUID();
  streamRequests.set(callId, { timeoutRetries: 0, failures: [] });
  try {
    for (let request = 0; request < 3; request += 1) {
      try { return await work(callId); }
      catch (error) {
        if (!(error instanceof ModelStreamRestartError)) throw error;
        if (request === 2) throw new ModelRequestExhaustedError(streamRequests.get(callId)!.failures);
      }
    }
    throw new Error('Model request retry exhausted.');
  } finally { streamRequests.delete(callId); }
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

/** Assemble a generate result from a provider stream, tracking first content and usage. */
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

interface ModelExecutionOptions {
  primary: LanguageModelV4;
  fallback?: LanguageModelV4;
  state: ModelFailoverState;
  role: string;
  runId?: string;
  serviceTier?: 'priority';
}

/** Every selected model uses the same role limits, even without a backup. */
export function withModelTimeouts(options: Omit<ModelExecutionOptions, 'primary' | 'fallback'> & {
  model: LanguageModelV4;
}): LanguageModelV4 {
  const { model, ...execution } = options;
  return withModelExecution({ ...execution, primary: model });
}

export function withModelFailover(options: Omit<ModelExecutionOptions, 'fallback'> & {
  fallback: LanguageModelV4;
}): LanguageModelV4 {
  return withModelExecution({ ...options, serviceTier: 'priority' });
}

function withModelExecution(options: ModelExecutionOptions): LanguageModelV4 {
  const { primary, fallback, state, role } = options;
  const limits = modelRoleLimits(role);
  const fallbackReserveMs = 10_000;
  const emit = (event: ModelAttemptDiagnostic) => {
    console.log(JSON.stringify({ ...event, event: 'agent_model_failover', phase: event.event, runId: options.runId }));
    state.onDiagnostic?.(event);
  };
  const attempt = (model: LanguageModelV4, params: LanguageModelV4CallOptions, callId: string, attemptId = crypto.randomUUID(),
    onStart?: (requestId: string) => void) => {
    params.abortSignal?.throwIfAborted();
    if (state.deadlineAt !== undefined && Date.now() >= state.deadlineAt) throw new ModelAttemptTimeout('phase_budget');
    state.beforeAttempt?.();
    onStart?.(attemptId);
    const controller = new AbortController();
    if (fallback && model === primary) {
      let active = activePrimaryAttempts.get(state);
      if (!active) activePrimaryAttempts.set(state, active = new Set());
      active.add(controller);
    }
    const signal = params.abortSignal ? AbortSignal.any([params.abortSignal, controller.signal]) : controller.signal;
    const startedAt = Date.now();
    const fields = { callId, attemptId, modelId: model.modelId, role, serviceTier: options.serviceTier,
      videoId: params.providerOptions?.agentDiagnostics?.videoId as string | undefined,
      modelCallId: params.providerOptions?.agentDiagnostics?.modelCallId as string | undefined,
      analysisAttempt: params.providerOptions?.agentDiagnostics?.analysisAttempt as number | undefined };
    let firstContentAt: number | undefined;
    let lastContentAt: number | undefined;
    let usage: LanguageModelV4Usage | undefined;
    let providerRequestId: string | undefined;
    let ended = false;
    const fail = (reason: ConstructorParameters<typeof ModelAttemptTimeout>[0]) => controller.abort(new ModelAttemptTimeout(reason));
    const remainingMs = Math.max(1, (state.deadlineAt ?? Infinity) - Date.now());
    const budgetMs = fallback && model === primary ? Math.max(1, remainingMs - fallbackReserveMs) : remainingMs;
    const attemptLimitMs = Math.min(limits.totalMs, budgetMs);
    // A provider that stays silent until the overall limit is still a first-content failure.
    const total = setTimeout(() => fail(budgetMs < limits.totalMs ? 'phase_budget'
      : firstContentAt === undefined ? 'first_content_timeout' : 'attempt_timeout'), attemptLimitMs);
    const firstContentLimitMs = Math.min(limits.firstContentMs, attemptLimitMs);
    const firstContent = setTimeout(() => fail('first_content_timeout'), firstContentLimitMs);
    // Record the limits this attempt actually ran under, after the phase budget.
    const timeouts = { firstContentTimeoutMs: firstContentLimitMs, totalTimeoutMs: attemptLimitMs };
    emit({ event: 'attempt_started', ...fields, startedAt, ...timeouts });
    const finish = (error?: unknown) => {
      if (ended) return;
      ended = true;
      activePrimaryAttempts.get(state)?.delete(controller);
      clearTimeout(total); clearTimeout(firstContent);
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
        statusCode: details.statusCode, retryable: details.retryable, providerRequestId: providerRequestId ?? details.providerRequestId });
    };
    const nextModel = (error: unknown, request: ModelRequestState): LanguageModelV4 => {
      finish(error);
      request.failures.push(error);
      params.abortSignal?.throwIfAborted();
      if (!eligible(error)) throw error;
      const timeAvailable = state.deadlineAt === undefined || Date.now() < state.deadlineAt;
      if (fallback && model === primary && timeAvailable) {
        if (!state.fallback) {
          state.fallback = true;
          emit({ event: 'fallback', ...fields, reason: error instanceof ModelAttemptTimeout ? error.reason : 'provider_error' });
          // Wake concurrent transcript/image calls immediately, without waiting for their own timers.
          for (const pending of activePrimaryAttempts.get(state) ?? []) pending.abort(new RunModelFallback());
        }
        return fallback;
      }
      if (error instanceof ModelAttemptTimeout && error.reason !== 'phase_budget'
        && request.timeoutRetries < 1 && timeAvailable) {
        request.timeoutRetries += 1;
        return model;
      }
      // Exhaustion is terminal to SDK retries and finalizer timeout repair alike.
      if (fallback) throw new ModelFallbackExhaustedError(request.failures);
      if (request.timeoutRetries > 0 || (error instanceof ModelAttemptTimeout && error.reason !== 'phase_budget'))
        throw new ModelRequestExhaustedError(request.failures);
      throw error;
    };
    const progress = (part: LanguageModelV4StreamPart) => {
      if (part.type === 'response-metadata' && part.id && /^[\w-]{1,128}$/.test(part.id)) providerRequestId = part.id;
      if (part.type === 'finish') usage = part.usage;
      if (!((part.type === 'text-delta' || part.type === 'reasoning-delta' || part.type === 'tool-input-delta') && part.delta.length)
        && part.type !== 'tool-call' && part.type !== 'file') return;
      firstContentAt ??= Date.now(); lastContentAt = Date.now();
      clearTimeout(firstContent);
    };
    return { signal, finish, nextModel, progress,
      cancel: () => { activePrimaryAttempts.get(state)?.delete(controller);
        controller.abort(new Error('Model attempt finished.')); clearTimeout(total); clearTimeout(firstContent); } };
  };
  const model: LanguageModelV4 = {
    specificationVersion: 'v4', provider: primary.provider,
    get modelId() { return fallback && state.fallback ? fallback.modelId : primary.modelId; },
    supportedUrls: primary.supportedUrls,
    async doGenerate(params) {
      const callId = crypto.randomUUID();
      const request: ModelRequestState = { timeoutRetries: 0, failures: [] };
      const observer = requestObservers.get(model);
      let candidate = fallback && state.fallback ? fallback : primary;
      while (true) {
        params.abortSignal?.throwIfAborted();
        const requestId = crypto.randomUUID();
        const current = attempt(candidate, params, callId, requestId, observer?.onStart);
        try {
          // Streaming lets a silent provider fail at its first-content limit, while a
          // call that keeps producing content is not cut off at that limit.
          const result = await collectStream(candidate, { ...params, abortSignal: current.signal }, current);
          observer?.onUsage({ requestId, modelId: result.response?.modelId ?? candidate.modelId, usage: result.usage });
          current.finish();
          return result;
        } catch (error) {
          candidate = current.nextModel(error, request);
        } finally { current.cancel(); }
      }
    },
    async doStream(params) {
      const suppliedId = params.providerOptions?.agentDiagnostics?.failoverCallId;
      const callId = typeof suppliedId === 'string' && /^[\w-]{1,128}$/.test(suppliedId) ? suppliedId : crypto.randomUUID();
      // Stream errors, including failures before headers, share the draft-owner retry path.
      const candidate = fallback && state.fallback ? fallback : primary;
      const request = streamRequests.get(callId) ?? { timeoutRetries: 0, failures: [] };
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
            try { current.nextModel(error, request); controller.error(new ModelStreamRestartError(error)); }
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
