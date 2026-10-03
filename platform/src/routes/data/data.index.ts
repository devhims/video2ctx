import { Hono, type Context } from 'hono';
import type { ChannelPlaylistSort, ChannelVideoSort, SearchFilters } from 'all-things-youtube';
import type { App } from '../../types';
import { requireAccountPrincipal, requireDataPrincipal, requireSessionPrincipal, requireUser } from '../../middlewares/authentication';
import { ApiError, asId, body, text } from '../../lib/http';
import {
  CREDIT_COSTS,
  CREDIT_RESERVES,
  dataOperationCost,
  dataOperationReserve,
  meterOperation,
  type DataOperation,
} from '../../lib/metering';
import { routeInput, type CacheStatus } from '../../lib/youtube';
import { requireEvidence, searchPrivate } from '../../lib/search';
import { citedAnswer } from '../../lib/analysis';
import { parseTranscriptFormat, projectTranscript } from '../../lib/transcript-projection';
import { generateTrendPlan, normalizeTrendPlanSignals } from '../../lib/trend-plan';
import { creditBalance, entitlements } from '../../lib/entitlements';
import { getProvider, providerDescriptors, type ProviderAdapter } from '../../providers';

export const dataRoutes = new Hono<App>();

export const DATA_ROUTE_PATTERNS = [
  '/resolve',
  '/search',
  '/providers',
  '/browse',
  '/trends',
  '/videos/*',
  '/channels/*',
  '/playlists/*',
  '/projects/:projectId/search',
  '/projects/:projectId/answers',
  '/projects/:projectId/comparisons',
  '/projects/:projectId/reports',
  '/trends/*',
  '/usage',
] as const;

for (const path of DATA_ROUTE_PATTERNS) dataRoutes.use(path, requireDataPrincipal);

dataRoutes.post('/resolve', async (c) => {
  const input = await body<{ input?: string }>(c.req.raw);
  const resolved = routeInput(text(input.input, 500));
  return c.json(await meterOperation(c, { operation: 'resolve', reservedCredits: CREDIT_COSTS.free }, async () => ({
    value: resolved,
    actualCredits: CREDIT_COSTS.free,
  })));
});

dataRoutes.get('/projects/:projectId/search', requireAccountPrincipal, async (c) => {
  const query = text(c.req.query('q'), 500);
  if (!query) throw new ApiError(422, 'QUERY_REQUIRED', 'A search query is required.');
  const user = requireUser(c);
  const projectId = await projectFor(c);
  const payload = await meterOperation(c, { operation: 'private-search', reservedCredits: CREDIT_COSTS.privateSearch }, async () => ({
    value: { query, results: await searchPrivate(c.env, user.id, query, projectId) },
    actualCredits: CREDIT_COSTS.privateSearch,
  }));
  return c.json(payload);
});

dataRoutes.get('/providers', async (c) => c.json(await meterOperation(c, {
  operation: 'list-providers',
  reservedCredits: CREDIT_COSTS.free,
}, async () => ({
  value: { providers: providerDescriptors },
  actualCredits: CREDIT_COSTS.free,
}))));

dataRoutes.get('/search', async (c) => {
  const provider = providerFor(c);
  const query = text(c.req.query('q'), 500);
  if (!query) throw new ApiError(422, 'QUERY_REQUIRED', 'A search query is required.');
  await enforceTrafficRate(c);
  const filters: SearchFilters = {
    type: entityType(c.req.query('type')),
    channelId: text(c.req.query('channel'), 200) || undefined,
    language: text(c.req.query('language'), 32) || undefined,
    duration: duration(c.req.query('duration')),
    sort: sort(c.req.query('sort')),
    captionsOnly: c.req.query('captions') === 'true' || undefined,
    live: live(c.req.query('live')),
    continuation: text(c.req.query('continuation'), 10_000) || undefined,
  };
  const payload = await meterOperation(c, {
    operation: `${provider.descriptor.id}-search`,
    reservedCredits: dataOperationReserve('search'),
    metadata: { provider: provider.descriptor.id },
  }, async () => {
    const search = await provider.search(c.env, query, filters);
    return {
      value: {
        query: search.value.query,
        results: search.value.results,
        continuation: search.value.continuation,
        estimatedTotal: search.value.estimatedTotal,
        meta: search.value.meta,
        freshness: search.value.freshness,
      },
      actualCredits: dataOperationCost('search', search.cacheStatus),
      cacheStatus: search.cacheStatus,
    };
  });
  return c.json(payload);
});

dataRoutes.get('/browse', async (c) => {
  const provider = providerFor(c);
  await enforceTrafficRate(c);
  const options = provider.normalizeBrowseOptions({
    categoryId: text(c.req.query('category'), 32) || undefined,
    region: text(c.req.query('region'), 8) || undefined,
    language: text(c.req.query('language'), 16) || undefined,
    continuation: text(c.req.query('continuation'), 4000) || undefined,
  });
  return c.json(await meterOperation(c, {
    operation: `${provider.descriptor.id}-browse`,
    reservedCredits: dataOperationReserve('browse'),
    metadata: { provider: provider.descriptor.id },
  }, async () => {
    const result = await provider.browse(c.env, options);
    return { value: result.value, actualCredits: dataOperationCost('browse', result.cacheStatus), cacheStatus: result.cacheStatus };
  }));
});

dataRoutes.get('/trends', async (c) => {
  const provider = providerFor(c);
  await enforceTrafficRate(c);
  const query = text(c.req.query('q'), 200);
  if (!query) throw new ApiError(422, 'QUERY_REQUIRED', 'A topic is required.');
  const requestedLimit = Number(c.req.query('limit') ?? 20);
  const includeAiInsights = c.req.query('insights') !== 'deterministic';
  return c.json(await meterOperation(c, {
    operation: includeAiInsights ? 'trends-with-ai' : 'trends-deterministic',
    reservedCredits: CREDIT_RESERVES.trends,
    metadata: { query, provider: provider.descriptor.id },
  }, async () => ({
    value: {
      ...await provider.trends(c.env, query, Number.isFinite(requestedLimit) ? requestedLimit : 20, includeAiInsights),
      provider: provider.descriptor.id,
    },
    actualCredits: includeAiInsights ? CREDIT_COSTS.aiTrends : CREDIT_COSTS.deterministicTrends,
  })));
});

dataRoutes.post('/trends/plan', async (c) => {
  const payload = await body<{ report?: unknown }>(c.req.raw);
  const signals = normalizeTrendPlanSignals(payload.report);
  return c.json(await meterOperation(c, {
    operation: 'trend-plan',
    reservedCredits: CREDIT_RESERVES.trendPlan,
    metadata: { topic: signals.query },
  }, async () => {
    const operationId = crypto.randomUUID();
    const plan = await generateTrendPlan(c.env, signals, operationId);
    return { value: { ...plan, operationId }, actualCredits: CREDIT_COSTS.trendPlan };
  }));
});

dataRoutes.get('/videos/:id', async (c) => {
  const provider = providerFor(c);
  const id = asId(c.req.param('id'));
  const refresh = refreshRequested(c);
  return c.json(await cachedRead(c, `${provider.descriptor.id}-video`, 'video', provider, () => provider.getVideo(c.env, id, refresh)));
});

dataRoutes.get('/videos/:id/tracks', async (c) => {
  const provider = providerFor(c);
  const id = asId(c.req.param('id'));
  return c.json(await meterOperation(c, {
    operation: `${provider.descriptor.id}-video-tracks`,
    reservedCredits: dataOperationReserve('tracks'),
    metadata: { provider: provider.descriptor.id },
  }, async () => ({
    value: await provider.getTracks(c.env, id), actualCredits: dataOperationCost('tracks', 'miss'),
  })));
});

dataRoutes.get('/videos/:id/transcript', async (c) => {
  const provider = providerFor(c);
  const id = asId(c.req.param('id'));
  const desiredLanguage = text(c.req.query('lang'), 20) || undefined;
  const format = parseTranscriptFormat(c.req.query('format'));
  const refresh = refreshRequested(c);
  const transcript = await cachedRead(c, `${provider.descriptor.id}-video-transcript`, 'transcript', provider, () =>
    provider.getTranscript(c.env, id, desiredLanguage, undefined, refresh));
  return c.json(projectTranscript(transcript, format));
});

dataRoutes.get('/videos/:id/comments', async (c) => {
  const provider = providerFor(c);
  const id = asId(c.req.param('id'));
  const all = c.req.query('all') === 'true';
  const refresh = refreshRequested(c);
  if (all) {
    return c.json(await meterOperation(c, {
      operation: `${provider.descriptor.id}-video-comments-all`,
      reservedCredits: dataOperationReserve('comments'),
      metadata: { provider: provider.descriptor.id },
    }, async () => {
      const result = await provider.getAllComments(c.env, id, refresh);
      return {
        value: result.value,
        actualCredits: dataOperationCost('comments', result.cacheStatus),
        cacheStatus: result.cacheStatus,
      };
    }));
  }
  return c.json(await cachedRead(c, `${provider.descriptor.id}-video-comments`, 'comments', provider, () =>
    provider.getComments(c.env, id, c.req.query('continuation'), refresh)));
});

dataRoutes.get('/videos/:id/endscreen', async (c) => {
  const provider = providerFor(c);
  const id = asId(c.req.param('id'));
  return c.json(await meterOperation(c, {
    operation: `${provider.descriptor.id}-video-endscreen`,
    reservedCredits: dataOperationReserve('endscreen'),
    metadata: { provider: provider.descriptor.id },
  }, async () => ({
    value: { provider: provider.descriptor.id, elements: await provider.getEndscreen(c.env, id) },
    actualCredits: dataOperationCost('endscreen', 'miss'),
  })));
});

dataRoutes.get('/channels/:id', async (c) => {
  const provider = providerFor(c);
  const id = asId(c.req.param('id'));
  return c.json(await cachedRead(c, `${provider.descriptor.id}-channel`, 'channel', provider, () => provider.getChannel(c.env, id)));
});

dataRoutes.get('/channels/:id/videos', async (c) => {
  const provider = providerFor(c);
  const id = asId(c.req.param('id'));
  const catalogSort = channelVideoSort(c.req.query('sort'));
  return c.json(await cachedRead(c, `${provider.descriptor.id}-channel-videos`, 'channelVideos', provider, () =>
    provider.getChannelVideos(c.env, id, c.req.query('continuation'), catalogSort)));
});

dataRoutes.get('/channels/:id/playlists', async (c) => {
  const provider = providerFor(c);
  const id = asId(c.req.param('id'));
  const catalogSort = channelPlaylistSort(c.req.query('sort'));
  return c.json(await cachedRead(c, `${provider.descriptor.id}-channel-playlists`, 'channelPlaylists', provider, () =>
    provider.getChannelPlaylists(c.env, id, c.req.query('continuation'), catalogSort)));
});

dataRoutes.get('/playlists/:id', async (c) => {
  const provider = providerFor(c);
  const id = asId(c.req.param('id'));
  return c.json(await cachedRead(c, `${provider.descriptor.id}-playlist`, 'playlist', provider, () => provider.getPlaylist(c.env, id)));
});

dataRoutes.post('/projects/:projectId/answers', requireSessionPrincipal, async (c) => {
  const input = await projectResearchInput(c, 'question');
  const question = text(input.question, 2000);
  if (!question) throw new ApiError(422, 'QUESTION_REQUIRED', 'A question is required.');
  const projectId = await projectFor(c);
  return c.json(await runAnalysis(c, question, async () =>
    requireEvidence(await searchPrivate(c.env, requireUser(c).id, question, projectId)), 'answer'));
});

dataRoutes.post('/projects/:projectId/comparisons', requireSessionPrincipal, async (c) => {
  const input = await projectResearchInput(c, 'question');
  const question = text(input.question, 2000) || 'Compare the selected sources, highlighting agreements, contradictions, and changes over time.';
  const projectId = await projectFor(c);
  return c.json(await runAnalysis(c, question, async () =>
    requireEvidence(await searchPrivate(c.env, requireUser(c).id, question, projectId)), 'comparison'));
});

dataRoutes.post('/projects/:projectId/reports', requireSessionPrincipal, async (c) => {
  const input = await projectResearchInput(c, 'prompt');
  const prompt = text(input.prompt, 2000) || 'Create an evidence-first research report with claims, supporting evidence, notable quotes, resources, action items, and content gaps.';
  const projectId = await projectFor(c);
  return c.json(await runAnalysis(c, prompt, async () =>
    requireEvidence(await searchPrivate(c.env, requireUser(c).id, prompt, projectId)), 'report'));
});

async function projectFor(c: Context<App>): Promise<string> {
  const projectId = asId(c.req.param('projectId'));
  if (c.req.query('projectId') !== undefined) {
    throw new ApiError(422, 'INVALID_INPUT', 'Use the project ID in the path, not the query.');
  }
  const project = await c.env.DB.prepare('SELECT 1 FROM projects WHERE id=? AND user_id=?')
    .bind(projectId, requireUser(c).id).first();
  if (!project) throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project not found.');
  return projectId;
}

async function projectResearchInput(c: Context<App>, field: 'question' | 'prompt'): Promise<Record<string, unknown>> {
  const input = await body<unknown>(c.req.raw);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== field)) {
    throw new ApiError(422, 'INVALID_INPUT', `Only ${field} is accepted in the body; the project is selected by the path.`);
  }
  return input as Record<string, unknown>;
}

dataRoutes.get('/usage', async (c) => {
  const user = requireUser(c);
  return c.json(await meterOperation(c, { operation: 'usage', reservedCredits: CREDIT_COSTS.free }, async () => ({
    value: { ...await entitlements(c.env, user.id), creditBalance: await creditBalance(c.env, user.id) },
    actualCredits: CREDIT_COSTS.free,
  })));
});

async function cachedRead<T>(
  c: Context<App>,
  operation: string,
  dataOperation: DataOperation,
  provider: ProviderAdapter,
  load: () => Promise<{ value: T; cacheStatus: CacheStatus }>,
): Promise<T> {
  return meterOperation(c, {
    operation,
    reservedCredits: dataOperationReserve(dataOperation),
    metadata: { provider: provider.descriptor.id },
  }, async () => {
    const result = await load();
    return {
      value: result.value,
      actualCredits: dataOperationCost(dataOperation, result.cacheStatus),
      cacheStatus: result.cacheStatus,
    };
  });
}

function providerFor(c: Context<App>): ProviderAdapter {
  const values = c.req.queries('provider');
  if (!values?.length || !values[0]?.trim()) {
    throw new ApiError(422, 'PROVIDER_REQUIRED', 'The provider query parameter is required.');
  }
  if (values.length !== 1) throw new ApiError(422, 'INVALID_INPUT', 'Specify exactly one provider.');
  return getProvider(values[0]);
}

async function runAnalysis(
  c: Context<App>,
  question: string,
  loadEvidence: () => Promise<Parameters<typeof citedAnswer>[2]>,
  mode: 'answer' | 'comparison' | 'report',
) {
  const reservedCredits = mode === 'report' ? CREDIT_RESERVES.report
    : mode === 'comparison' ? CREDIT_RESERVES.comparison : CREDIT_RESERVES.answer;
  const actualCredits = mode === 'report' ? CREDIT_COSTS.report
    : mode === 'comparison' ? CREDIT_COSTS.comparison : CREDIT_COSTS.answer;
  return meterOperation(c, { operation: mode, reservedCredits }, async () => {
    const evidence = await loadEvidence();
    const operationId = crypto.randomUUID();
    const result = await citedAnswer(c.env, question, evidence, operationId, mode);
    return { value: { ...result, operationId }, actualCredits };
  });
}

async function enforceTrafficRate(c: Context<App>): Promise<void> {
  const principal = requireUser(c);
  const apiKeyId = c.get('principal')?.apiKeyId;
  const key = apiKeyId ? `api-key:${apiKeyId}` : `user:${principal.id}`;
  const result = await c.env.PUBLIC_RATE_LIMITER.limit({ key });
  if (!result.success) throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.');
}

function entityType(value?: string): SearchFilters['type'] {
  return ['video', 'channel', 'playlist'].includes(value ?? '') ? value as SearchFilters['type'] : 'all';
}

function duration(value?: string): SearchFilters['duration'] {
  return ['short', 'medium', 'long'].includes(value ?? '') ? value as SearchFilters['duration'] : undefined;
}

function sort(value?: string): SearchFilters['sort'] {
  return ['relevance', 'date', 'views', 'rating'].includes(value ?? '') ? value as SearchFilters['sort'] : undefined;
}

function channelVideoSort(value?: string): ChannelVideoSort {
  if (!value) return 'latest';
  if (['latest', 'popular', 'oldest'].includes(value)) return value as ChannelVideoSort;
  throw new ApiError(422, 'INVALID_CHANNEL_VIDEO_SORT', 'Use latest, popular, or oldest.');
}

function channelPlaylistSort(value?: string): ChannelPlaylistSort {
  if (!value) return 'newest';
  if (['newest', 'last-video-added'].includes(value)) return value as ChannelPlaylistSort;
  throw new ApiError(422, 'INVALID_CHANNEL_PLAYLIST_SORT', 'Use newest or last-video-added.');
}

function live(value?: string): SearchFilters['live'] {
  return ['live', 'upcoming', 'completed'].includes(value ?? '') ? value as SearchFilters['live'] : undefined;
}

function refreshRequested(c: Context<App>): boolean {
  const value = c.req.query('refresh');
  if (value !== undefined && value !== 'true' && value !== 'false')
    throw new ApiError(422, 'INVALID_INPUT', 'refresh must be true or false.');
  return value === 'true';
}
