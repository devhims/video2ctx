import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { failureDetails } from './diagnostics';

export interface ModelAttemptDiagnostic {
  event: 'attempt_started' | 'attempt_finished' | 'fallback';
  callId: string;
  attemptId: string;
  modelId: string;
  role: string;
  serviceTier: 'priority';
  outcome?: 'succeeded' | 'failed' | 'canceled';
  reason?: string;
  elapsedMs?: number;
  firstContentMs?: number;
  idleMs?: number;
  statusCode?: number;
  providerRequestId?: string;
  usageAvailable?: boolean;
  responseTimeoutMs?: number;
  firstContentTimeoutMs?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
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

/** Only the owner of the displayed draft may restart a partially consumed stream. */
export class ModelStreamRestartError extends Error {
  constructor(readonly failure: unknown) { super('Restart the model step with DeepSeek after discarding the interrupted draft.'); }
}

class ModelAttemptTimeout extends Error {
  constructor(readonly reason: 'response_timeout' | 'first_content_timeout' | 'stream_stall' | 'attempt_timeout') {
    super(reason);
    this.name = 'TimeoutError';
  }
}

class RunModelFallback extends Error {
  constructor() { super('Another model call switched this run to DeepSeek.'); }
}

const managedModels = new WeakMap<object, ModelFailoverState>();
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
      if (backupError instanceof ModelFallbackExhaustedError)
        throw new ModelFallbackExhaustedError([error.failure, ...backupError.failures]);
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

export function withModelFailover(options: {
  primary: LanguageModelV4;
  fallback: LanguageModelV4;
  state: ModelFailoverState;
  role: string;
  runId?: string;
}): LanguageModelV4 {
  const { primary, fallback, state, role } = options;
  // Leave most of the 20-second classification phase for its backup and validation.
  // Visual analysis and memory have an outer 20-second deadline for both attempts.
  const responseTimeoutMs = role === 'classifier' ? 5_000 : role === 'transcript_analyst' ? 15_000
    : role === 'visual_analyst' || role === 'memory_updater' ? 8_000 : 10_000;
  const firstContentTimeoutMs = 10_000;
  const idleTimeoutMs = 5_000;
  const totalTimeoutMs = 30_000;
  const fallbackReserveMs = 10_000;
  const emit = (event: ModelAttemptDiagnostic) => {
    console.log(JSON.stringify({ ...event, event: 'agent_model_failover', phase: event.event, runId: options.runId }));
    state.onDiagnostic?.(event);
  };
  const attempt = (model: LanguageModelV4, params: LanguageModelV4CallOptions, callId: string, streaming: boolean) => {
    params.abortSignal?.throwIfAborted();
    const controller = new AbortController();
    if (model === primary) {
      let active = activePrimaryAttempts.get(state);
      if (!active) activePrimaryAttempts.set(state, active = new Set());
      active.add(controller);
    }
    const signal = params.abortSignal ? AbortSignal.any([params.abortSignal, controller.signal]) : controller.signal;
    const startedAt = Date.now();
    const fields = { callId, attemptId: crypto.randomUUID(), modelId: model.modelId, role, serviceTier: 'priority' as const };
    let firstContentAt: number | undefined;
    let lastContentAt: number | undefined;
    let usageAvailable = false;
    let providerRequestId: string | undefined;
    let ended = false;
    const fail = (reason: ConstructorParameters<typeof ModelAttemptTimeout>[0]) => controller.abort(new ModelAttemptTimeout(reason));
    const remainingMs = Math.max(1, (state.deadlineAt ?? Infinity) - Date.now());
    const budgetMs = model === primary ? Math.max(1, remainingMs - fallbackReserveMs) : remainingMs;
    const attemptLimitMs = Math.min(streaming ? totalTimeoutMs : responseTimeoutMs, budgetMs);
    const total = setTimeout(() => fail(streaming ? 'attempt_timeout' : 'response_timeout'), attemptLimitMs);
    let idle = streaming ? setTimeout(() => fail('first_content_timeout'), Math.min(firstContentTimeoutMs, attemptLimitMs)) : undefined;
    emit({ event: 'attempt_started', ...fields, responseTimeoutMs: streaming ? undefined : attemptLimitMs,
      firstContentTimeoutMs: streaming ? firstContentTimeoutMs : undefined, idleTimeoutMs: streaming ? idleTimeoutMs : undefined,
      totalTimeoutMs: attemptLimitMs });
    const finish = (error?: unknown) => {
      if (ended) return;
      ended = true;
      activePrimaryAttempts.get(state)?.delete(controller);
      clearTimeout(total); clearTimeout(idle);
      const details = failureDetails(error);
      emit({ event: 'attempt_finished', ...fields,
        outcome: params.abortSignal?.aborted ? 'canceled' : error ? 'failed' : 'succeeded',
        reason: error instanceof RunModelFallback ? 'run_fallback'
          : error instanceof ModelAttemptTimeout ? error.reason : error ? 'provider_error' : undefined,
        elapsedMs: Date.now() - startedAt,
        firstContentMs: firstContentAt === undefined ? undefined : firstContentAt - startedAt,
        idleMs: lastContentAt === undefined ? Date.now() - startedAt : Date.now() - lastContentAt,
        usageAvailable, statusCode: details.statusCode, providerRequestId: providerRequestId ?? details.providerRequestId });
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
      if (part.type === 'finish') usageAvailable = true;
      if (!((part.type === 'text-delta' || part.type === 'reasoning-delta' || part.type === 'tool-input-delta') && part.delta.length)
        && part.type !== 'tool-call' && part.type !== 'file') return;
      firstContentAt ??= Date.now(); lastContentAt = Date.now();
      clearTimeout(idle);
      idle = setTimeout(() => fail('stream_stall'), idleTimeoutMs);
    };
    return { signal, finish, switchModel, progress, markUsage: () => { usageAvailable = true; },
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
      for (const candidate of state.fallback ? [fallback] : [primary, fallback]) {
        const current = attempt(candidate, params, callId, false);
        try {
          const result = await abortable(candidate.doGenerate({ ...params, abortSignal: current.signal }), current.signal);
          current.markUsage(); current.finish();
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
      const current = attempt(candidate, params, callId, true);
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
