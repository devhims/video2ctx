import {
  BROWSE_CATEGORIES,
  BROWSE_LANGUAGES,
  BROWSE_REGIONS,
} from './lib/browse-contract';
import { PROVIDER_CAPABILITIES, PROVIDER_IDS } from './providers/contract';

type Schema = Record<string, unknown>;

const schemaRef = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const responseRef = (name: string) => ({ $ref: `#/components/responses/${name}` });
const jsonResponse = (description: string, schema: Schema) => ({
  description,
  content: { 'application/json': { schema } },
});
const meteredJsonResponse = (description: string, schema: Schema) => ({
  ...jsonResponse(description, schema),
  headers: {
    'X-Credits-Charged': { $ref: '#/components/headers/CreditsCharged' },
    'X-Credits-Remaining': { $ref: '#/components/headers/CreditsRemaining' },
  },
});
const jsonBody = (schema: Schema, description?: string) => ({
  required: true,
  ...(description ? { description } : {}),
  content: { 'application/json': { schema } },
});
const pathParameter = (name: string, description: string, example?: string) => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: { type: 'string', minLength: 1, ...(example ? { example } : {}) },
});
const queryParameter = (name: string, description: string, schema: Schema, required = false) => ({
  name,
  in: 'query',
  required,
  description,
  schema,
});

const privateSecurity = [{ sessionCookie: [] }, { demoUser: [] }];
const personalAccessSecurity = [
  { sessionCookie: [] },
  { bearerApiKey: [] },
  { apiKey: [] },
  { demoUser: [] },
];
const dataSecurity = personalAccessSecurity;
const accountSecurity = personalAccessSecurity;
const standardErrors = {
  '401': responseRef('Unauthorized'),
  '403': responseRef('Forbidden'),
  '422': responseRef('ValidationError'),
  '500': responseRef('ServerError'),
  '503': responseRef('ServiceUnavailable'),
};
const dataErrors = {
  ...standardErrors,
  '402': responseRef('InsufficientCredits'),
  '429': responseRef('RateLimited'),
};
const idParameter = pathParameter('id', 'Resource identifier.');
const providerParameter = {
  name: 'provider',
  in: 'path',
  required: true,
  description: 'External video provider.',
  schema: { type: 'string', enum: PROVIDER_IDS, example: 'youtube' },
};

const sourceMetadata: Schema = {
  type: 'object',
  required: ['provider', 'source', 'fetchedAt', 'partial', 'warnings'],
  properties: {
    provider: { type: 'string', enum: PROVIDER_IDS, description: 'Platform that owns the source resource.' },
    source: { type: 'string', example: 'allthingsyoutube', description: 'Extractor or upstream implementation that produced the normalized response.' },
    fetchedAt: { type: 'string', format: 'date-time' },
    partial: { type: 'boolean' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
};

const thumbnail: Schema = {
  type: 'object',
  required: ['url'],
  properties: {
    url: { type: 'string', format: 'uri' },
    width: { type: 'integer', minimum: 0 },
    height: { type: 'integer', minimum: 0 },
  },
};

const channelSummary: Schema = {
  type: 'object',
  required: ['type', 'id', 'name', 'thumbnails', 'url'],
  properties: {
    type: { const: 'channel' },
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    handle: { type: 'string' },
    subscriberCountText: { type: 'string' },
    videoCountText: { type: 'string' },
    thumbnails: { type: 'array', items: schemaRef('Thumbnail') },
    url: { type: 'string', format: 'uri' },
  },
};

const videoSummary: Schema = {
  type: 'object',
  required: ['type', 'id', 'title', 'channel', 'thumbnails', 'isLive', 'url'],
  properties: {
    type: { const: 'video' },
    id: { type: 'string', example: 'dQw4w9WgXcQ' },
    title: { type: 'string' },
    description: { type: 'string' },
    channel: {
      type: 'object',
      required: ['id', 'name', 'url'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        url: { type: 'string', format: 'uri' },
      },
    },
    thumbnails: { type: 'array', items: schemaRef('Thumbnail') },
    durationSeconds: { type: 'integer', minimum: 0 },
    durationText: { type: 'string' },
    publishedTimeText: { type: 'string' },
    viewCount: { type: 'integer', minimum: 0 },
    viewCountText: { type: 'string' },
    isLive: { type: 'boolean' },
    hasCaptions: { type: 'boolean' },
    url: { type: 'string', format: 'uri' },
  },
};

const playlistSummary: Schema = {
  type: 'object',
  required: ['type', 'id', 'title', 'thumbnails', 'isPodcast', 'url'],
  properties: {
    type: { const: 'playlist' },
    id: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    channel: { type: 'object', additionalProperties: true },
    thumbnails: { type: 'array', items: schemaRef('Thumbnail') },
    videoCount: { type: 'integer', minimum: 0 },
    videoCountText: { type: 'string' },
    updatedTimeText: { type: 'string', description: 'YouTube’s display text, such as “Updated 4 days ago”.' },
    isPodcast: { type: 'boolean' },
    playUrl: { type: 'string', format: 'uri', description: 'Starts playback from the item represented by the playlist card.' },
    url: { type: 'string', format: 'uri' },
  },
};

const trendVideo: Schema = {
  type: 'object',
  required: ['id', 'title', 'channel', 'thumbnails', 'description', 'viewCount', 'signalSource', 'confidenceScore', 'hashtags', 'keywords', 'trendScore', 'trendBand', 'url'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    channel: {
      type: 'object',
      required: ['id', 'name'],
      properties: { id: { type: 'string' }, name: { type: 'string' } },
    },
    thumbnails: { type: 'array', items: schemaRef('Thumbnail') },
    description: { type: 'string' },
    durationSeconds: { type: 'integer', minimum: 0 },
    publishedTimeText: { type: 'string' },
    publishDate: { type: 'string' },
    ageHours: { type: 'number', minimum: 0 },
    viewCount: { type: 'integer', minimum: 0 },
    viewsPerHour: { type: 'number', minimum: 0 },
    observedViewsPerHour: { type: 'number', minimum: 0 },
    previousViewsPerHour: { type: 'number', minimum: 0 },
    accelerationPercent: { type: 'number' },
    observationHours: { type: 'number', minimum: 0 },
    viewDelta: { type: 'integer', minimum: 0 },
    likeDelta: { type: 'integer', minimum: 0 },
    commentDelta: { type: 'integer', minimum: 0 },
    commentCount: { type: 'integer', minimum: 0 },
    likeCount: { type: 'integer', minimum: 0 },
    engagementRate: { type: 'number', minimum: 0 },
    channelBaselineViewsPerHour: { type: 'number', minimum: 0 },
    channelLift: { type: 'number', minimum: 0 },
    searchRank: { type: 'integer', minimum: 1 },
    signalSource: { type: 'string', enum: ['observed', 'estimated'] },
    confidenceScore: { type: 'integer', minimum: 0, maximum: 100 },
    hashtags: { type: 'array', items: { type: 'string' } },
    keywords: { type: 'array', items: { type: 'string' } },
    trendScore: { type: 'integer', minimum: 0, maximum: 100 },
    trendBand: { type: 'string', enum: ['Breakout', 'Rising', 'Steady'] },
    url: { type: 'string', format: 'uri' },
  },
};

const trendReport: Schema = {
  type: 'object',
  required: ['provider', 'query', 'generatedAt', 'sampleSize', 'methodologyVersion', 'methodology', 'sample', 'confidence', 'summary', 'videos', 'hashtags', 'titlePatterns', 'durationMix', 'plan', 'warnings'],
  properties: {
    provider: { type: 'string', enum: PROVIDER_IDS },
    query: { type: 'string' },
    generatedAt: { type: 'string', format: 'date-time' },
    sampleSize: { type: 'integer', minimum: 0 },
    methodologyVersion: { const: '2.0' },
    methodology: { type: 'string' },
    sample: {
      type: 'object',
      required: ['candidateVideos', 'enrichedVideos', 'channels', 'observedVideos'],
      properties: {
        candidateVideos: { type: 'integer', minimum: 0 }, enrichedVideos: { type: 'integer', minimum: 0 },
        channels: { type: 'integer', minimum: 0 }, observedVideos: { type: 'integer', minimum: 0 },
      },
    },
    confidence: {
      type: 'object', required: ['score', 'level', 'reasons'],
      properties: {
        score: { type: 'integer', minimum: 0, maximum: 100 },
        level: { type: 'string', enum: ['low', 'medium', 'high'] },
        reasons: { type: 'array', items: { type: 'string' } },
      },
    },
    summary: {
      type: 'object',
      required: ['totalViews', 'medianViewsPerHour', 'publishedLast7Days', 'breakoutCount', 'acceleratingCount'],
      properties: {
        totalViews: { type: 'integer', minimum: 0 },
        medianViewsPerHour: { type: 'number', minimum: 0 },
        publishedLast7Days: { type: 'integer', minimum: 0 },
        breakoutCount: { type: 'integer', minimum: 0 },
        acceleratingCount: { type: 'integer', minimum: 0 },
        medianObservedViewsPerHour: { type: 'number', minimum: 0 },
      },
    },
    videos: { type: 'array', items: schemaRef('TrendVideo') },
    hashtags: { type: 'array', items: { type: 'object', additionalProperties: true } },
    titlePatterns: { type: 'array', items: { type: 'object', additionalProperties: true } },
    durationMix: { type: 'array', items: { type: 'object', additionalProperties: true } },
    insights: {
      type: 'object',
      description: 'Optional GLM-generated analysis. Omitted when deterministic mode is requested or model inference fails.',
      additionalProperties: true,
    },
    plan: { type: 'object', additionalProperties: true },
    warnings: { type: 'array', items: { type: 'string' } },
  },
};

const storedRecord: Schema = {
  type: 'object',
  description: 'A persisted D1 record. Database timestamps are Unix milliseconds.',
  additionalProperties: true,
};

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'video2ctx API',
    version: '1.0.0',
    license: {
      name: 'Apache License 2.0',
      identifier: 'Apache-2.0',
    },
    description: [
      'Interactive contract for the video2ctx platform Worker.',
      'Provider data uses explicit paths such as /v1/providers/youtube/videos/{id}. User-owned projects, private search, and analysis remain provider-neutral.',
      'Product routes accept either a Better Auth session cookie or a personal API key sent as Authorization: Bearer aty_…. X-API-Key remains supported for compatibility.',
      'Every metered response reports the charge and remaining balance in response headers. API keys and browser sessions spend from the same user credit ledger.',
      'Provider data pricing: cached responses cost 1 credit; fresh search and comment requests cost 2 credits; every other fresh provider-data request costs 1 credit. Resolve, provider listing, and usage lookup are free. Composite analysis pricing is unchanged.',
      'API keys can access normal user-owned data, projects, imports, exports, monitors, notifications, and usage. Key management, billing, connected-account changes, account deletion, and administration require a browser session.',
      'When running locally with ENVIRONMENT other than production, set X-Demo-User to any stable value to create and use an isolated demo account.',
    ].join('\n\n'),
  },
  security: [],
  servers: [{ url: '/', description: 'Current platform host' }],
  tags: [
    { name: 'System', description: 'Service status and machine-readable documentation.' },
    { name: 'Demo', description: 'Anonymous product proof used by the public landing page.' },
    { name: 'Authentication', description: 'Better Auth entry points used by the web application.' },
    { name: 'UI Helpers', description: 'Internal routing helpers used by the first-party web interface.' },
    { name: 'Providers', description: 'Supported external video providers and their capabilities.' },
    { name: 'Discovery', description: 'Search, browse, and trend research.' },
    { name: 'Videos', description: 'Video metadata and evidence.' },
    { name: 'Channels', description: 'Channel inspection.' },
    { name: 'Playlists', description: 'Playlist inspection.' },
    { name: 'Projects', description: 'Private research projects and saved material.' },
    { name: 'Research', description: 'Imports, jobs, cited answers, comparisons, and reports.' },
    { name: 'Exports', description: 'Project export creation and download.' },
    { name: 'Monitoring', description: 'Monitors, notifications, and digest preferences.' },
    { name: 'YouTube OAuth', description: 'Connect or disconnect the user’s YouTube account.' },
    { name: 'Billing', description: 'Checkout, usage, and Stripe webhook handling.' },
    { name: 'Administration', description: 'Restricted operational APIs.' },
    { name: 'Account', description: 'Account lifecycle operations.' },
  ],
  paths: {
    '/': {
      get: {
        tags: ['System'],
        operationId: 'getServiceInfo',
        summary: 'Get platform information',
        responses: { '200': jsonResponse('Platform information.', schemaRef('ServiceInfo')) },
      },
    },
    '/health': {
      get: {
        tags: ['System'],
        operationId: 'getHealth',
        summary: 'Check platform health',
        responses: { '200': jsonResponse('The platform is healthy.', schemaRef('Health')) },
      },
    },
    '/openapi.json': {
      get: {
        tags: ['System'],
        operationId: 'getOpenApiDocument',
        summary: 'Get the OpenAPI document',
        responses: {
          '200': jsonResponse('OpenAPI 3.1 document.', { type: 'object', additionalProperties: true }),
        },
      },
    },
    '/docs': {
      get: {
        tags: ['System'],
        operationId: 'getApiReference',
        summary: 'Open the Scalar API reference',
        responses: {
          '200': {
            description: 'Interactive Scalar API reference.',
            content: { 'text/html': { schema: { type: 'string' } } },
          },
        },
      },
    },
    '/v1/demo/youtube/inspect': {
      post: {
        tags: ['Demo'],
        operationId: 'inspectLandingYouTubeVideo',
        summary: 'Inspect a YouTube video from the landing page',
        description: 'Returns a bounded preview of video metadata, timestamped transcript segments, and comments. Anonymous clients may inspect five distinct videos in a rolling 24-hour window; repeating a video does not consume another slot.',
        security: [],
        requestBody: jsonBody(schemaRef('LandingDemoInspectionRequest')),
        responses: {
          '200': jsonResponse('A landing-page video inspection.', schemaRef('LandingDemoInspectionResponse')),
          '422': responseRef('ValidationError'),
          '429': responseRef('RateLimited'),
          '503': responseRef('ServiceUnavailable'),
        },
      },
    },
    '/api/auth/sign-in/magic-link': {
      post: {
        tags: ['Authentication'],
        operationId: 'signInWithMagicLink',
        summary: 'Send a magic sign-in link',
        description: 'Better Auth creates a single-use link and queues its delivery by email.',
        requestBody: jsonBody(schemaRef('MagicLinkSignInRequest')),
        responses: {
          '200': jsonResponse('The request was accepted.', { type: 'object', additionalProperties: true }),
          '400': responseRef('BadRequest'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/api/auth/sign-in/social': {
      post: {
        tags: ['Authentication'],
        operationId: 'signInWithSocialProvider',
        summary: 'Start Google sign-in',
        description: 'Returns the Better Auth redirect URL for Google OAuth.',
        requestBody: jsonBody(schemaRef('SocialSignInRequest')),
        responses: {
          '200': jsonResponse('OAuth redirect details.', { type: 'object', additionalProperties: true }),
          '400': responseRef('BadRequest'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/api/auth/api-key/create': {
      post: {
        tags: ['Authentication'],
        operationId: 'createApiKey',
        summary: 'Create a permanent API key',
        description: 'Session-only Better Auth endpoint. The full secret is returned once and cannot be recovered later.',
        security: privateSecurity,
        requestBody: jsonBody(schemaRef('CreateApiKeyRequest')),
        responses: {
          '200': jsonResponse('API key created.', schemaRef('CreatedApiKey')),
          '401': responseRef('Unauthorized'),
          '422': responseRef('ValidationError'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/api/auth/api-key/list': {
      get: {
        tags: ['Authentication'],
        operationId: 'listApiKeys',
        summary: 'List the current user’s API keys',
        security: privateSecurity,
        responses: {
          '200': jsonResponse('API key metadata without secrets.', schemaRef('ApiKeyList')),
          '401': responseRef('Unauthorized'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/api/auth/api-key/delete': {
      post: {
        tags: ['Authentication'],
        operationId: 'deleteApiKey',
        summary: 'Revoke an API key',
        security: privateSecurity,
        requestBody: jsonBody({
          type: 'object', required: ['keyId'], properties: { keyId: { type: 'string' } },
        }),
        responses: {
          '200': jsonResponse('API key revoked.', { type: 'object', additionalProperties: true }),
          '401': responseRef('Unauthorized'),
          '404': responseRef('NotFound'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/resolve': {
      post: {
        tags: ['UI Helpers'],
        operationId: 'resolveInput',
        summary: 'Route universal UI input',
        description: 'Internal first-party UI helper that classifies text, an ID, or a YouTube URL before navigation. It is authenticated, free of charge, and not a primary public consumer API.',
        'x-internal': true,
        security: dataSecurity,
        requestBody: jsonBody(schemaRef('ResolveRequest')),
        responses: {
          '200': meteredJsonResponse('The classified input.', schemaRef('ResolveResponse')),
          '401': responseRef('Unauthorized'),
          '403': responseRef('Forbidden'),
          '422': responseRef('ValidationError'),
          '429': responseRef('RateLimited'),
          '500': responseRef('ServerError'),
          '503': responseRef('ServiceUnavailable'),
        },
      },
    },
    '/v1/search': {
      get: {
        tags: ['Discovery'],
        operationId: 'searchPrivateEvidence',
        summary: 'Search the user’s private indexed evidence',
        description: 'Searches material previously saved or imported into the current user’s private research index.',
        security: dataSecurity,
        parameters: [
          queryParameter('q', 'Evidence search query.', { type: 'string', maxLength: 500, example: 'AI agents' }, true),
          queryParameter('projectId', 'Restrict private retrieval to a project.', { type: 'string' }),
        ],
        responses: {
          '200': meteredJsonResponse('Matching private evidence.', schemaRef('PrivateSearchResponse')),
          ...dataErrors,
        },
      },
    },
    '/v1/providers': {
      get: {
        tags: ['Providers'],
        operationId: 'listProviders',
        summary: 'List supported video providers',
        description: 'Returns the provider identifiers accepted in provider-scoped paths and the capabilities currently implemented for each provider.',
        security: dataSecurity,
        responses: {
          '200': meteredJsonResponse('Supported providers.', schemaRef('ProviderList')),
          ...dataErrors,
        },
      },
    },
    '/v1/providers/{provider}/search': {
      get: {
        tags: ['Discovery'],
        operationId: 'searchProvider',
        summary: 'Search a video provider',
        description: 'Searches the selected external provider. Cache hits cost less than fresh upstream retrieval.',
        security: dataSecurity,
        parameters: [
          providerParameter,
          queryParameter('q', 'Provider search query.', { type: 'string', maxLength: 500, example: 'AI agents' }, true),
          queryParameter('type', 'Provider entity type.', { type: 'string', enum: ['all', 'video', 'channel', 'playlist'], default: 'all' }),
          queryParameter('channel', 'Restrict search to a channel.', { type: 'string' }),
          queryParameter('language', 'Preferred language code.', { type: 'string', example: 'en' }),
          queryParameter('duration', 'Video duration bucket.', { type: 'string', enum: ['short', 'medium', 'long'] }),
          queryParameter('sort', 'Result ordering.', { type: 'string', enum: ['relevance', 'date', 'views', 'rating'] }),
          queryParameter('captions', 'Only include captioned videos.', { type: 'boolean' }),
          queryParameter('live', 'Live broadcast state.', { type: 'string', enum: ['live', 'upcoming', 'completed'] }),
          queryParameter('continuation', 'Opaque token returned by a previous provider search page.', { type: 'string' }),
        ],
        responses: {
          '200': meteredJsonResponse('Provider search results.', schemaRef('SearchResponse')),
          ...dataErrors,
        },
      },
    },
    '/v1/providers/{provider}/browse': {
      get: {
        tags: ['Discovery'],
        operationId: 'browseProvider',
        summary: 'Browse a provider discovery feed',
        description: 'Returns queryless discovery results from a supported destination on the selected provider.',
        security: dataSecurity,
        parameters: [
          providerParameter,
          queryParameter('category', 'Discovery category.', {
            type: 'string',
            enum: BROWSE_CATEGORIES,
            example: 'music',
          }, true),
          queryParameter('region', 'Supported region code.', {
            type: 'string', enum: BROWSE_REGIONS, default: 'US', example: 'IN',
          }),
          queryParameter('language', 'Supported language code.', {
            type: 'string', enum: BROWSE_LANGUAGES, default: 'en', example: 'en',
          }),
          queryParameter('continuation', 'Opaque pagination token.', { type: 'string' }),
        ],
        responses: {
          '200': meteredJsonResponse('Browse results.', schemaRef('BrowseResponse')),
          ...dataErrors,
        },
      },
    },
    '/v1/providers/{provider}/trends': {
      get: {
        tags: ['Discovery'],
        operationId: 'researchTrends',
        summary: 'Calculate public trend signals for a topic',
        description: 'Builds a diversified topic sample, persists public metric snapshots, calculates observed acceleration when history exists, and optionally adds GLM-generated evidence-grounded themes and content gaps.',
        security: dataSecurity,
        parameters: [
          providerParameter,
          queryParameter('q', 'Topic to research.', { type: 'string', maxLength: 200, example: 'AI agents' }, true),
          queryParameter('limit', 'Number of diversified videos to enrich; clamped to 8–30.', { type: 'integer', minimum: 8, maximum: 30, default: 20 }),
          queryParameter('insights', 'AI insight mode. Use deterministic to skip GLM analysis.', { type: 'string', enum: ['ai', 'deterministic'], default: 'ai' }),
        ],
        responses: {
          '200': meteredJsonResponse('Topic trend report.', schemaRef('TrendReport')),
          ...dataErrors,
        },
      },
    },
    '/v1/trends/plan': {
      post: {
        tags: ['Discovery'],
        operationId: 'generateTrendPlan',
        summary: 'Generate an AI video plan from trend signals',
        description: 'Uses Kimi K2.6 for strategic synthesis and automatically falls back to GPT-OSS 120B when Kimi is unavailable. The response identifies the model that produced it.',
        security: dataSecurity,
        requestBody: jsonBody({
          type: 'object',
          required: ['report'],
          properties: { report: schemaRef('TrendReport') },
        }),
        responses: {
          '200': meteredJsonResponse('Evidence-grounded video plan.', schemaRef('AiTrendPlan')),
          ...dataErrors,
        },
      },
    },
    '/v1/providers/{provider}/videos/{id}': {
      get: {
        tags: ['Videos'],
        operationId: 'getVideo',
        summary: 'Inspect a video',
        security: dataSecurity,
        parameters: [providerParameter, pathParameter('id', 'Provider video ID.', 'dQw4w9WgXcQ')],
        responses: {
          '200': meteredJsonResponse('Normalized video metadata.', schemaRef('Video')),
          '401': responseRef('Unauthorized'),
          '402': responseRef('InsufficientCredits'),
          '404': responseRef('NotFound'),
          '422': responseRef('ValidationError'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/providers/{provider}/videos/{id}/tracks': {
      get: {
        tags: ['Videos'],
        operationId: 'getVideoTracks',
        summary: 'List transcript tracks',
        description: 'Lists the source caption tracks and auto-translation targets available to the transcript endpoint. This endpoint returns metadata, not caption text.',
        security: dataSecurity,
        parameters: [providerParameter, pathParameter('id', 'Provider video ID.', 'dQw4w9WgXcQ')],
        responses: {
          '200': meteredJsonResponse('Transcript track information.', schemaRef('CaptionTrackList')),
          '401': responseRef('Unauthorized'),
          '402': responseRef('InsufficientCredits'),
          '404': responseRef('NotFound'),
          '422': responseRef('ValidationError'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/providers/{provider}/videos/{id}/transcript': {
      get: {
        tags: ['Videos'],
        operationId: 'getVideoTranscript',
        summary: 'Get a timed transcript',
        security: dataSecurity,
        parameters: [
          providerParameter,
          pathParameter('id', 'Provider video ID.', 'dQw4w9WgXcQ'),
          queryParameter('lang', 'Desired transcript language. The backend selects the default source track and translates only when necessary.', { type: 'string', example: 'hi' }),
        ],
        responses: {
          '200': meteredJsonResponse('Normalized timed transcript.', schemaRef('Transcript')),
          '401': responseRef('Unauthorized'),
          '402': responseRef('InsufficientCredits'),
          '404': responseRef('NotFound'),
          '422': responseRef('ValidationError'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/providers/{provider}/videos/{id}/comments': {
      get: {
        tags: ['Videos'],
        operationId: 'getVideoComments',
        summary: 'Get video comments',
        security: dataSecurity,
        parameters: [
          providerParameter,
          pathParameter('id', 'Provider video ID.', 'dQw4w9WgXcQ'),
          queryParameter('continuation', 'Opaque pagination token.', { type: 'string' }),
          queryParameter('all', 'Fetch all available pages rather than one page.', { type: 'boolean', default: false }),
        ],
        responses: {
          '200': meteredJsonResponse('A comment page or collection.', schemaRef('CommentResponse')),
          '401': responseRef('Unauthorized'),
          '402': responseRef('InsufficientCredits'),
          '404': responseRef('NotFound'),
          '422': responseRef('ValidationError'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/providers/{provider}/videos/{id}/endscreen': {
      get: {
        tags: ['Videos'],
        operationId: 'getVideoEndscreen',
        summary: 'Get endscreen elements',
        security: dataSecurity,
        parameters: [providerParameter, pathParameter('id', 'Provider video ID.', 'dQw4w9WgXcQ')],
        responses: {
          '200': meteredJsonResponse('Video endscreen elements.', schemaRef('EndscreenResponse')),
          '401': responseRef('Unauthorized'),
          '402': responseRef('InsufficientCredits'),
          '422': responseRef('ValidationError'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/providers/{provider}/channels/{id}': {
      get: {
        tags: ['Channels'],
        operationId: 'getChannel',
        summary: 'Inspect a channel',
        security: dataSecurity,
        parameters: [providerParameter, pathParameter('id', 'Provider channel ID or handle.', '@YouTube')],
        responses: {
          '200': meteredJsonResponse('Normalized channel metadata.', schemaRef('Channel')),
          '401': responseRef('Unauthorized'),
          '402': responseRef('InsufficientCredits'),
          '404': responseRef('NotFound'),
          '422': responseRef('ValidationError'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/providers/{provider}/channels/{id}/videos': {
      get: {
        tags: ['Channels'],
        operationId: 'getChannelVideos',
        summary: 'List channel videos',
        security: dataSecurity,
        parameters: [
          providerParameter,
          pathParameter('id', 'Provider channel ID or handle.', '@YouTube'),
          queryParameter('sort', 'YouTube Videos-tab ordering.', { type: 'string', enum: ['latest', 'popular', 'oldest'], default: 'latest' }),
          queryParameter('continuation', 'Opaque token returned by the previous channel videos response.', { type: 'string' }),
        ],
        responses: {
          '200': meteredJsonResponse('A page of channel videos.', schemaRef('ChannelVideos')),
          '401': responseRef('Unauthorized'),
          '402': responseRef('InsufficientCredits'),
          '404': responseRef('NotFound'),
          '422': responseRef('ValidationError'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/providers/{provider}/channels/{id}/playlists': {
      get: {
        tags: ['Channels'],
        operationId: 'getChannelPlaylists',
        summary: 'List channel playlists',
        security: dataSecurity,
        parameters: [
          providerParameter,
          pathParameter('id', 'Provider channel ID or handle.', '@YouTube'),
          queryParameter('sort', 'YouTube Playlists-tab ordering.', { type: 'string', enum: ['newest', 'last-video-added'], default: 'newest' }),
          queryParameter('continuation', 'Opaque token returned by the previous channel playlists response.', { type: 'string' }),
        ],
        responses: {
          '200': meteredJsonResponse('A page of channel playlists.', schemaRef('ChannelPlaylists')),
          '401': responseRef('Unauthorized'),
          '402': responseRef('InsufficientCredits'),
          '404': responseRef('NotFound'),
          '422': responseRef('ValidationError'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/providers/{provider}/playlists/{id}': {
      get: {
        tags: ['Playlists'],
        operationId: 'getPlaylist',
        summary: 'Inspect a playlist',
        security: dataSecurity,
        parameters: [providerParameter, pathParameter('id', 'Provider playlist ID.', 'PL123')],
        responses: {
          '200': meteredJsonResponse('Normalized playlist and videos.', schemaRef('Playlist')),
          '401': responseRef('Unauthorized'),
          '402': responseRef('InsufficientCredits'),
          '404': responseRef('NotFound'),
          '422': responseRef('ValidationError'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/projects': {
      get: {
        tags: ['Projects'],
        operationId: 'listProjects',
        summary: 'List projects',
        security: accountSecurity,
        responses: {
          '200': jsonResponse('The user’s projects.', {
            type: 'object', required: ['projects'], properties: { projects: { type: 'array', items: schemaRef('Project') } },
          }),
          '401': responseRef('Unauthorized'),
          '500': responseRef('ServerError'),
        },
      },
      post: {
        tags: ['Projects'],
        operationId: 'createProject',
        summary: 'Create a project',
        security: accountSecurity,
        requestBody: jsonBody(schemaRef('CreateProjectRequest')),
        responses: {
          '201': jsonResponse('Project created.', schemaRef('ProjectCreated')),
          ...standardErrors,
        },
      },
    },
    '/v1/projects/{id}': {
      get: {
        tags: ['Projects'],
        operationId: 'getProject',
        summary: 'Get a project and its saved items',
        security: accountSecurity,
        parameters: [idParameter],
        responses: {
          '200': jsonResponse('Project details.', schemaRef('ProjectDetail')),
          '401': responseRef('Unauthorized'),
          '404': responseRef('NotFound'),
          '500': responseRef('ServerError'),
        },
      },
      delete: {
        tags: ['Projects'],
        operationId: 'deleteProject',
        summary: 'Delete a project',
        description: 'Deletes the project’s private R2 objects and AI Search items before cascading its D1 metadata.',
        security: accountSecurity,
        parameters: [idParameter],
        responses: {
          '204': { description: 'Project deleted.' },
          '401': responseRef('Unauthorized'),
          '404': responseRef('NotFound'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/projects/{id}/items': {
      post: {
        tags: ['Projects'],
        operationId: 'addProjectItem',
        summary: 'Save material to a project',
        security: accountSecurity,
        parameters: [idParameter],
        requestBody: jsonBody(schemaRef('CreateProjectItemRequest')),
        responses: {
          '201': jsonResponse('Project item created.', schemaRef('IdResponse')),
          ...standardErrors,
          '404': responseRef('NotFound'),
        },
      },
    },
    '/v1/imports': {
      post: {
        tags: ['Research'],
        operationId: 'createImport',
        summary: 'Start a durable import job',
        security: accountSecurity,
        parameters: [{
          name: 'Idempotency-Key', in: 'header', required: false,
          description: 'Optional caller-provided idempotency key.', schema: { type: 'string', maxLength: 200 },
        }],
        requestBody: jsonBody(schemaRef('CreateImportRequest')),
        responses: {
          '202': jsonResponse('Import queued or an existing idempotent job returned.', schemaRef('JobAccepted')),
          ...standardErrors,
          '404': responseRef('NotFound'),
        },
      },
    },
    '/v1/jobs/{id}': {
      get: {
        tags: ['Research'],
        operationId: 'getJob',
        summary: 'Get import job status',
        security: accountSecurity,
        parameters: [idParameter],
        responses: {
          '200': jsonResponse('Durable job status.', schemaRef('Job')),
          '401': responseRef('Unauthorized'),
          '404': responseRef('NotFound'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/answers': {
      post: {
        tags: ['Research'],
        operationId: 'createAnswer',
        summary: 'Generate a cited answer',
        security: dataSecurity,
        requestBody: jsonBody(schemaRef('AnswerRequest')),
        responses: {
          '200': meteredJsonResponse('Evidence-grounded answer.', schemaRef('CitedAnswer')),
          ...dataErrors,
        },
      },
    },
    '/v1/comparisons': {
      post: {
        tags: ['Research'],
        operationId: 'createComparison',
        summary: 'Compare private research sources',
        security: dataSecurity,
        requestBody: jsonBody(schemaRef('ComparisonRequest')),
        responses: {
          '200': meteredJsonResponse('Evidence-grounded comparison.', schemaRef('CitedAnswer')),
          ...dataErrors,
        },
      },
    },
    '/v1/reports': {
      post: {
        tags: ['Research'],
        operationId: 'createReport',
        summary: 'Generate an evidence-first report',
        security: dataSecurity,
        requestBody: jsonBody(schemaRef('ReportRequest')),
        responses: {
          '200': meteredJsonResponse('Evidence-grounded report.', schemaRef('CitedAnswer')),
          ...dataErrors,
        },
      },
    },
    '/v1/projects/{id}/exports': {
      post: {
        tags: ['Exports'],
        operationId: 'createProjectExport',
        summary: 'Create a project export',
        security: accountSecurity,
        parameters: [idParameter],
        requestBody: jsonBody(schemaRef('CreateExportRequest')),
        responses: {
          '201': jsonResponse('Export created.', schemaRef('Export')),
          ...standardErrors,
          '404': responseRef('NotFound'),
        },
      },
    },
    '/v1/exports/{id}/download': {
      get: {
        tags: ['Exports'],
        operationId: 'downloadExport',
        summary: 'Download an export',
        security: accountSecurity,
        parameters: [idParameter],
        responses: {
          '200': {
            description: 'Export file.',
            headers: { 'Content-Disposition': { schema: { type: 'string' } } },
            content: {
              'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
              'text/markdown': { schema: { type: 'string' } },
              'text/csv': { schema: { type: 'string' } },
              'application/json': { schema: {} },
            },
          },
          '401': responseRef('Unauthorized'),
          '404': responseRef('NotFound'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/monitors': {
      get: {
        tags: ['Monitoring'],
        operationId: 'listMonitors',
        summary: 'List monitors',
        security: accountSecurity,
        responses: {
          '200': jsonResponse('The user’s monitors.', {
            type: 'object', required: ['monitors'], properties: { monitors: { type: 'array', items: schemaRef('Monitor') } },
          }),
          '401': responseRef('Unauthorized'),
          '500': responseRef('ServerError'),
        },
      },
      post: {
        tags: ['Monitoring'],
        operationId: 'createMonitor',
        summary: 'Create a monitor',
        security: accountSecurity,
        requestBody: jsonBody(schemaRef('CreateMonitorRequest')),
        responses: {
          '201': jsonResponse('Monitor created.', schemaRef('IdResponse')),
          ...standardErrors,
        },
      },
    },
    '/v1/monitors/{id}': {
      patch: {
        tags: ['Monitoring'],
        operationId: 'updateMonitor',
        summary: 'Update a monitor schedule or display metadata',
        security: accountSecurity,
        parameters: [idParameter],
        requestBody: jsonBody({
          type: 'object',
          properties: {
            query: { type: 'object', additionalProperties: true },
            intervalMinutes: schemaRef('MonitorIntervalMinutes'),
            enabled: { type: 'boolean' },
          },
        }),
        responses: {
          '200': jsonResponse('Monitor updated.', schemaRef('MonitorSchedule')),
          '401': responseRef('Unauthorized'),
          '404': responseRef('NotFound'),
          '500': responseRef('ServerError'),
        },
      },
      delete: {
        tags: ['Monitoring'],
        operationId: 'deleteMonitor',
        summary: 'Delete a monitor',
        security: accountSecurity,
        parameters: [idParameter],
        responses: {
          '204': { description: 'Monitor deleted. The response is also successful when no matching monitor exists.' },
          '401': responseRef('Unauthorized'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/notifications': {
      get: {
        tags: ['Monitoring'],
        operationId: 'listNotifications',
        summary: 'List recent notifications',
        security: accountSecurity,
        responses: {
          '200': jsonResponse('Up to 100 recent notifications.', {
            type: 'object', required: ['notifications'], properties: { notifications: { type: 'array', items: schemaRef('Notification') } },
          }),
          '401': responseRef('Unauthorized'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/notifications/{id}/read': {
      post: {
        tags: ['Monitoring'],
        operationId: 'markNotificationRead',
        summary: 'Mark a notification as read',
        security: accountSecurity,
        parameters: [idParameter],
        responses: {
          '200': jsonResponse('Read state acknowledged.', {
            type: 'object', required: ['read'], properties: { read: { const: true } },
          }),
          '401': responseRef('Unauthorized'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/notification-preferences': {
      get: {
        tags: ['Monitoring'],
        operationId: 'getNotificationPreferences',
        summary: 'Get notification preferences',
        security: accountSecurity,
        responses: {
          '200': jsonResponse('Current preferences.', schemaRef('NotificationPreferences')),
          '401': responseRef('Unauthorized'),
          '500': responseRef('ServerError'),
        },
      },
      put: {
        tags: ['Monitoring'],
        operationId: 'updateNotificationPreferences',
        summary: 'Update notification preferences',
        security: accountSecurity,
        requestBody: jsonBody(schemaRef('NotificationPreferencesRequest')),
        responses: {
          '200': jsonResponse('Updated preferences.', schemaRef('NotificationPreferences')),
          ...standardErrors,
        },
      },
    },
    '/v1/notification-preferences/confirm-email': {
      post: {
        tags: ['Monitoring'],
        operationId: 'confirmNotificationEmail',
        summary: 'Confirm monitor email alerts from the signed-in dashboard',
        security: accountSecurity,
        requestBody: jsonBody({
          type: 'object', required: ['confirmation'], properties: {
            confirmation: { type: 'string', minLength: 1, maxLength: 1000 },
          },
        }),
        responses: {
          '200': jsonResponse('Email alerts confirmed.', schemaRef('NotificationPreferences')),
          ...standardErrors,
        },
      },
    },
    '/v1/email/unsubscribe': {
      get: {
        tags: ['Monitoring'],
        operationId: 'unsubscribeEmail',
        summary: 'Unsubscribe from email digests',
        parameters: [
          queryParameter('user', 'User ID from the signed unsubscribe link.', { type: 'string' }, true),
          queryParameter('token', 'Signed unsubscribe token.', { type: 'string' }, true),
        ],
        responses: {
          '200': { description: 'Email alerts disabled.', content: { 'text/plain': { schema: { type: 'string' } } } },
          '400': { description: 'Invalid unsubscribe link.', content: { 'text/plain': { schema: { type: 'string' } } } },
        },
      },
      post: {
        tags: ['Monitoring'],
        operationId: 'unsubscribeEmailPost',
        summary: 'Unsubscribe from email digests',
        description: 'POST alias of the unsubscribe link handler.',
        parameters: [
          queryParameter('user', 'User ID from the signed unsubscribe link.', { type: 'string' }, true),
          queryParameter('token', 'Signed unsubscribe token.', { type: 'string' }, true),
        ],
        responses: {
          '200': { description: 'Email alerts disabled.', content: { 'text/plain': { schema: { type: 'string' } } } },
          '400': { description: 'Invalid unsubscribe link.', content: { 'text/plain': { schema: { type: 'string' } } } },
        },
      },
    },
    '/v1/oauth/youtube/connect': {
      get: {
        tags: ['YouTube OAuth'],
        operationId: 'createYouTubeConnectUrl',
        summary: 'Create a YouTube OAuth URL',
        security: privateSecurity,
        responses: {
          '200': jsonResponse('OAuth authorization URL.', {
            type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' } },
          }),
          '401': responseRef('Unauthorized'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/oauth/youtube/callback': {
      get: {
        tags: ['YouTube OAuth'],
        operationId: 'completeYouTubeOAuth',
        summary: 'Complete YouTube OAuth',
        parameters: [
          queryParameter('code', 'Authorization code from Google.', { type: 'string' }, true),
          queryParameter('state', 'Single-use OAuth state.', { type: 'string' }, true),
        ],
        responses: {
          '302': { description: 'Redirect to the connected account screen.', headers: { Location: { schema: { type: 'string', format: 'uri' } } } },
          '422': responseRef('ValidationError'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/oauth/youtube': {
      delete: {
        tags: ['YouTube OAuth'],
        operationId: 'disconnectYouTube',
        summary: 'Disconnect the YouTube account',
        security: privateSecurity,
        responses: {
          '204': { description: 'YouTube account disconnected.' },
          '401': responseRef('Unauthorized'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/billing/checkout': {
      post: {
        tags: ['Billing'],
        operationId: 'createBillingCheckout',
        summary: 'Create a Stripe Checkout session',
        security: privateSecurity,
        responses: {
          '200': jsonResponse('Checkout URL.', {
            type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' } },
          }),
          '401': responseRef('Unauthorized'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/billing/webhook': {
      post: {
        tags: ['Billing'],
        operationId: 'handleStripeWebhook',
        summary: 'Handle a Stripe webhook',
        description: 'Intended for Stripe delivery. Scalar cannot generate a valid signature for an edited payload.',
        security: [{ stripeSignature: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
        },
        responses: {
          '200': jsonResponse('Event processed.', {
            type: 'object', required: ['received'], properties: { received: { const: true } },
          }),
          '400': responseRef('BadRequest'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/usage': {
      get: {
        tags: ['Billing'],
        operationId: 'getUsage',
        summary: 'Get plan limits and credit balance',
        security: dataSecurity,
        responses: {
          '200': meteredJsonResponse('Current entitlements and credits.', schemaRef('Usage')),
          '401': responseRef('Unauthorized'),
          '402': responseRef('InsufficientCredits'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/admin/jobs': {
      get: {
        tags: ['Administration'],
        operationId: 'listAdminJobs',
        summary: 'List recent jobs across users',
        security: privateSecurity,
        responses: {
          '200': jsonResponse('Up to 200 recent jobs.', {
            type: 'object', required: ['jobs'], properties: { jobs: { type: 'array', items: schemaRef('Job') } },
          }),
          '401': responseRef('Unauthorized'),
          '403': responseRef('Forbidden'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/account': {
      delete: {
        tags: ['Account'],
        operationId: 'deleteAccount',
        summary: 'Permanently delete the current account',
        description: 'Deletes private files and database records and queues private search-index deletion. This operation cannot be undone.',
        security: privateSecurity,
        responses: {
          '204': { description: 'Account deleted.' },
          '401': responseRef('Unauthorized'),
          '500': responseRef('ServerError'),
        },
      },
    },
  },
  components: {
    securitySchemes: {
      sessionCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: 'better-auth.session_token',
        description: 'Better Auth session cookie. A production deployment may use the secure-prefixed cookie name; same-origin browser requests send it automatically.',
      },
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'Legacy-compatible header for a permanent personal API key. Prefer Authorization: Bearer aty_….',
      },
      bearerApiKey: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'API key',
        description: 'Permanent personal API key created in the dashboard. Example: curl -H "Authorization: Bearer aty_…" https://your-host/v1/projects',
      },
      demoUser: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Demo-User',
        description: 'Local development only. Any stable value selects an isolated demo account. Rejected in production.',
      },
      stripeSignature: {
        type: 'apiKey',
        in: 'header',
        name: 'stripe-signature',
        description: 'Stripe-generated signature over the exact raw request body.',
      },
    },
    headers: {
      CreditsCharged: {
        description: 'Credits settled for this operation.',
        schema: { type: 'integer', minimum: 0 },
      },
      CreditsRemaining: {
        description: 'Current balance in the owning user account after the request is metered.',
        schema: { type: 'integer' },
      },
    },
    responses: {
      BadRequest: jsonResponse('The request is malformed.', schemaRef('Error')),
      Unauthorized: jsonResponse('Authentication is required.', schemaRef('Error')),
      Forbidden: jsonResponse('The caller is not allowed to perform this operation.', schemaRef('Error')),
      InsufficientCredits: meteredJsonResponse('The user account does not have enough credits. Error code: INSUFFICIENT_CREDITS.', schemaRef('Error')),
      NotFound: jsonResponse('The requested resource was not found.', schemaRef('Error')),
      ValidationError: jsonResponse('The request failed validation.', schemaRef('Error')),
      RateLimited: jsonResponse('The public rate limit was exceeded.', schemaRef('Error')),
      ServerError: jsonResponse('An unexpected server error occurred.', schemaRef('Error')),
      ServiceUnavailable: jsonResponse('An upstream AI or YouTube service is unavailable.', schemaRef('Error')),
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string', example: 'QUERY_REQUIRED' },
              message: { type: 'string' },
              details: {},
              requestId: { type: 'string' },
            },
          },
        },
      },
      ServiceInfo: {
        type: 'object',
        required: ['service', 'version', 'status', 'capabilities'],
        properties: {
          service: { const: 'video2ctx-platform' },
          version: { const: 'v1' },
          status: { const: 'ok' },
          capabilities: { type: 'array', items: { type: 'string' } },
        },
      },
      Health: {
        type: 'object',
        required: ['status', 'timestamp'],
        properties: { status: { const: 'ok' }, timestamp: { type: 'string', format: 'date-time' } },
      },
      MagicLinkSignInRequest: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', format: 'email', example: 'creator@example.com' },
          callbackURL: { type: 'string', default: '/' },
        },
      },
      SocialSignInRequest: {
        type: 'object',
        required: ['provider'],
        properties: { provider: { const: 'google' }, callbackURL: { type: 'string', default: '/' } },
      },
      CreateApiKeyRequest: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', minLength: 1, maxLength: 32, example: 'Production integration' } },
      },
      ApiKey: {
        type: 'object',
        required: ['id', 'configId', 'referenceId', 'enabled', 'rateLimitEnabled', 'requestCount', 'createdAt', 'updatedAt'],
        properties: {
          id: { type: 'string' },
          configId: { type: 'string', const: 'default' },
          name: { type: ['string', 'null'] },
          start: { type: ['string', 'null'], description: 'Safe starting characters used to identify the key.' },
          prefix: { type: ['string', 'null'], example: 'aty_' },
          referenceId: { type: 'string' },
          enabled: { type: 'boolean' },
          rateLimitEnabled: { type: 'boolean' },
          rateLimitTimeWindow: { type: ['integer', 'null'], example: 60000 },
          rateLimitMax: { type: ['integer', 'null'], example: 60 },
          requestCount: { type: 'integer', minimum: 0 },
          lastRequest: { type: ['string', 'null'], format: 'date-time' },
          expiresAt: { type: ['string', 'null'], description: 'Always null for permanent keys.' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
          permissions: { type: ['object', 'null'], additionalProperties: { type: 'array', items: { type: 'string' } } },
        },
      },
      CreatedApiKey: {
        allOf: [schemaRef('ApiKey'), {
          type: 'object', required: ['key'], properties: {
            key: { type: 'string', writeOnly: true, example: 'aty_…', description: 'Returned only when the key is created.' },
          },
        }],
      },
      ApiKeyList: {
        type: 'object',
        required: ['apiKeys', 'total'],
        properties: {
          apiKeys: { type: 'array', items: schemaRef('ApiKey') },
          total: { type: 'integer', minimum: 0 },
          limit: { type: ['integer', 'null'], minimum: 1 },
          offset: { type: ['integer', 'null'], minimum: 0 },
        },
      },
      ResolveRequest: {
        type: 'object',
        required: ['input'],
        properties: { input: { type: 'string', maxLength: 500, example: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } },
      },
      LandingDemoInspectionRequest: {
        type: 'object',
        required: ['url'],
        properties: {
          url: {
            type: 'string',
            format: 'uri',
            maxLength: 500,
            example: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          },
        },
      },
      LandingDemoQuota: {
        type: 'object',
        required: ['limit', 'remaining', 'resetAt', 'repeated'],
        properties: {
          limit: { type: 'integer', const: 5 },
          remaining: { type: 'integer', minimum: 0, maximum: 5 },
          resetAt: { type: 'string', format: 'date-time' },
          repeated: { type: 'boolean' },
        },
      },
      LandingDemoTranscript: {
        oneOf: [
          {
            type: 'object',
            required: ['status', 'track', 'segmentCount', 'segments'],
            properties: {
              status: { const: 'ready' },
              track: schemaRef('CaptionTrack'),
              segmentCount: { type: 'integer', minimum: 0 },
              segments: { type: 'array', maxItems: 16, items: schemaRef('TranscriptSegment') },
            },
          },
          {
            type: 'object',
            required: ['status'],
            properties: { status: { const: 'unavailable' } },
          },
        ],
      },
      LandingDemoComments: {
        oneOf: [
          {
            type: 'object',
            required: ['status', 'comments'],
            properties: {
              status: { const: 'ready' },
              totalCount: { type: 'integer', minimum: 0 },
              comments: {
                type: 'array',
                maxItems: 4,
                items: { type: 'object', additionalProperties: true },
              },
            },
          },
          {
            type: 'object',
            required: ['status'],
            properties: { status: { const: 'unavailable' } },
          },
        ],
      },
      LandingDemoInspectionResponse: {
        type: 'object',
        required: ['video', 'transcript', 'comments', 'quota', 'partial'],
        properties: {
          video: schemaRef('Video'),
          transcript: schemaRef('LandingDemoTranscript'),
          comments: schemaRef('LandingDemoComments'),
          quota: schemaRef('LandingDemoQuota'),
          partial: { type: 'boolean' },
        },
      },
      ResolveResponse: {
        oneOf: [
          { type: 'object', required: ['kind', 'provider', 'id'], properties: { kind: { const: 'video' }, provider: schemaRef('ProviderId'), id: { type: 'string' } } },
          { type: 'object', required: ['kind', 'provider', 'id'], properties: { kind: { const: 'channel' }, provider: schemaRef('ProviderId'), id: { type: 'string' } } },
          { type: 'object', required: ['kind', 'provider', 'id'], properties: { kind: { const: 'playlist' }, provider: schemaRef('ProviderId'), id: { type: 'string' } } },
          { type: 'object', required: ['kind', 'query'], properties: { kind: { const: 'search' }, query: { type: 'string' } } },
        ],
      },
      ProviderId: { type: 'string', enum: PROVIDER_IDS, example: 'youtube' },
      Provider: {
        type: 'object',
        required: ['id', 'name', 'capabilities'],
        properties: {
          id: schemaRef('ProviderId'),
          name: { type: 'string', example: 'YouTube' },
          capabilities: { type: 'array', items: { type: 'string', enum: PROVIDER_CAPABILITIES } },
        },
      },
      ProviderList: {
        type: 'object',
        required: ['providers'],
        properties: { providers: { type: 'array', items: schemaRef('Provider') } },
      },
      SourceMetadata: sourceMetadata,
      Thumbnail: thumbnail,
      ChannelSummary: channelSummary,
      VideoSummary: videoSummary,
      PlaylistSummary: playlistSummary,
      SearchResult: { oneOf: [schemaRef('VideoSummary'), schemaRef('ChannelSummary'), schemaRef('PlaylistSummary')] },
      SearchResponse: {
        type: 'object',
        required: ['query', 'results', 'meta'],
        properties: {
          query: { type: 'string' },
          results: { type: 'array', items: schemaRef('SearchResult') },
          continuation: { type: 'string' },
          estimatedTotal: { type: 'integer', minimum: 0 },
          meta: schemaRef('SourceMetadata'),
        },
      },
      BrowseResponse: {
        type: 'object',
        required: ['category', 'browseId', 'results', 'videos', 'channels', 'playlists', 'meta'],
        properties: {
          category: { type: 'string', enum: BROWSE_CATEGORIES },
          browseId: { type: 'string' },
          title: { type: 'string' },
          results: { type: 'array', items: schemaRef('SearchResult') },
          videos: { type: 'array', items: schemaRef('VideoSummary') },
          channels: { type: 'array', items: schemaRef('ChannelSummary') },
          playlists: { type: 'array', items: schemaRef('PlaylistSummary') },
          continuation: { type: 'string' },
          estimatedTotal: { type: 'integer', minimum: 0 },
          meta: schemaRef('SourceMetadata'),
        },
      },
      PrivateSearchResponse: {
        type: 'object',
        required: ['query', 'results'],
        properties: { query: { type: 'string' }, results: { type: 'array', items: schemaRef('Evidence') } },
      },
      CaptionTrack: {
        type: 'object',
        required: ['id', 'name', 'languageCode', 'kind', 'isTranslatable', 'isDefault'],
        properties: {
          id: { type: 'string' }, name: { type: 'string' }, languageCode: { type: 'string' },
          kind: { type: 'string', enum: ['manual', 'asr', 'unknown'] },
          provenance: { type: 'string', enum: ['manual', 'asr', 'unknown'] },
          isTranslatable: { type: 'boolean' }, isDefault: { type: 'boolean' },
        },
      },
      TranslationLanguage: {
        type: 'object',
        required: ['languageCode', 'name'],
        properties: {
          languageCode: { type: 'string' },
          name: { type: 'string' },
        },
      },
      CaptionTrackList: {
        type: 'object',
        required: ['tracks', 'sourceTracks', 'translationLanguages', 'autoTranslationTargets', 'meta'],
        properties: {
          tracks: { type: 'array', items: schemaRef('CaptionTrack') },
          sourceTracks: { type: 'array', items: schemaRef('CaptionTrack') },
          translationLanguages: { type: 'array', items: schemaRef('TranslationLanguage') },
          autoTranslationTargets: { type: 'array', items: schemaRef('TranslationLanguage') },
          defaultTrackId: { type: 'string' },
          meta: schemaRef('SourceMetadata'),
        },
      },
      TranscriptSegment: {
        type: 'object',
        required: ['startMs', 'durationMs', 'endMs', 'text'],
        properties: {
          startMs: { type: 'integer', minimum: 0 }, durationMs: { type: 'integer', minimum: 0 },
          endMs: { type: 'integer', minimum: 0 }, text: { type: 'string' },
          words: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      Transcript: {
        type: 'object',
        required: ['videoId', 'track', 'segments', 'text', 'meta'],
        properties: {
          videoId: { type: 'string' }, track: schemaRef('CaptionTrack'),
          translatedTo: schemaRef('TranslationLanguage'),
          segments: { type: 'array', items: schemaRef('TranscriptSegment') },
          granularity: { type: 'string', enum: ['segment', 'word'] }, text: { type: 'string' }, meta: schemaRef('SourceMetadata'),
        },
      },
      Video: {
        allOf: [schemaRef('VideoSummary'), {
          type: 'object',
          required: ['keywords', 'availability', 'meta'],
          properties: {
            keywords: { type: 'array', items: { type: 'string' } },
            availability: { type: 'object', additionalProperties: true },
            meta: schemaRef('SourceMetadata'),
          },
        }],
      },
      EndscreenElement: {
        type: 'object',
        required: ['type', 'startMs', 'endMs', 'thumbnails'],
        properties: {
          type: { type: 'string', enum: ['video', 'playlist', 'channel', 'unknown'] },
          title: { type: 'string' }, metadata: { type: 'string' }, videoId: { type: 'string' },
          playlistId: { type: 'string' }, channelId: { type: 'string' },
          startMs: { type: 'integer', minimum: 0 }, endMs: { type: 'integer', minimum: 0 },
          thumbnails: { type: 'array', items: schemaRef('Thumbnail') }, position: { type: 'object', additionalProperties: true },
        },
      },
      EndscreenResponse: {
        type: 'object',
        required: ['provider', 'elements'],
        properties: {
          provider: schemaRef('ProviderId'),
          elements: { type: 'array', items: schemaRef('EndscreenElement') },
        },
      },
      CommentResponse: {
        type: 'object',
        required: ['videoId', 'comments', 'meta'],
        properties: {
          videoId: { type: 'string' }, comments: { type: 'array', items: { type: 'object', additionalProperties: true } },
          totalCount: { type: 'integer', minimum: 0, description: 'Total comments reported by YouTube when available.' },
          continuation: { type: 'string' }, complete: { type: 'boolean' },
          pagesFetched: { type: 'integer' }, topLevelCount: { type: 'integer' }, replyCount: { type: 'integer' },
          remainingContinuations: { type: 'integer' }, meta: schemaRef('SourceMetadata'),
        },
      },
      Channel: {
        type: 'object',
        required: ['type', 'id', 'name', 'thumbnails', 'url', 'about', 'meta'],
        properties: {
          type: { const: 'channel' },
          id: { type: 'string' },
          name: { type: 'string' },
          handle: { type: 'string' },
          thumbnails: { type: 'array', items: schemaRef('Thumbnail') },
          url: { type: 'string', format: 'uri' },
          about: schemaRef('ChannelAbout'),
          meta: schemaRef('SourceMetadata'),
        },
      },
      ChannelLink: {
        type: 'object',
        required: ['title', 'displayUrl', 'url'],
        properties: {
          title: { type: 'string' },
          displayUrl: { type: 'string' },
          url: { type: 'string', format: 'uri' },
        },
      },
      ChannelMoreInfo: {
        type: 'object',
        required: ['canonicalChannelUrl', 'businessEmailAvailable'],
        properties: {
          canonicalChannelUrl: { type: 'string', format: 'uri' },
          displayCanonicalChannelUrl: { type: 'string' },
          joinedDate: { type: 'string', format: 'date' },
          joinedDateText: { type: 'string' },
          subscriberCount: { type: 'integer', minimum: 0, description: 'Normalized value of YouTube’s displayed, potentially rounded subscriber count.' },
          subscriberCountText: { type: 'string' },
          videoCount: { type: 'integer', minimum: 0 },
          videoCountText: { type: 'string' },
          viewCount: { type: 'integer', minimum: 0 },
          viewCountText: { type: 'string' },
          businessEmailAvailable: { type: 'boolean', description: 'Whether YouTube presents its protected business-email action. The email itself is not accessed.' },
        },
      },
      ChannelAbout: {
        type: 'object',
        required: ['links', 'moreInfo'],
        properties: {
          description: { type: 'string' },
          links: { type: 'array', items: schemaRef('ChannelLink') },
          moreInfo: schemaRef('ChannelMoreInfo'),
        },
      },
      ChannelVideos: {
        type: 'object',
        required: ['channelId', 'sort', 'videos', 'meta'],
        properties: {
          channelId: { type: 'string' },
          sort: { type: 'string', enum: ['latest', 'popular', 'oldest'] },
          videos: { type: 'array', items: schemaRef('VideoSummary') },
          continuation: { type: 'string' },
          meta: schemaRef('SourceMetadata'),
        },
      },
      ChannelPlaylists: {
        type: 'object',
        required: ['channelId', 'sort', 'playlists', 'meta'],
        properties: {
          channelId: { type: 'string' },
          sort: { type: 'string', enum: ['newest', 'last-video-added'] },
          playlists: { type: 'array', items: schemaRef('PlaylistSummary') },
          continuation: { type: 'string' },
          meta: schemaRef('SourceMetadata'),
        },
      },
      Playlist: {
        allOf: [schemaRef('PlaylistSummary'), {
          type: 'object', required: ['videos', 'meta'], properties: {
            videos: { type: 'array', items: schemaRef('VideoSummary') }, continuation: { type: 'string' },
            estimatedTotal: { type: 'integer' }, meta: schemaRef('SourceMetadata'),
          },
        }],
      },
      TrendVideo: trendVideo,
      TrendReport: trendReport,
      AiTrendPlan: {
        type: 'object',
        required: ['provider', 'model', 'generatedAt', 'angle', 'audience', 'hook', 'recommendedDurationSeconds', 'outline', 'titleIdeas', 'hashtags', 'differentiation', 'evidence', 'caveats', 'operationId'],
        properties: {
          provider: schemaRef('ProviderId'), model: { type: 'string', enum: ['@cf/moonshotai/kimi-k2.6', '@cf/openai/gpt-oss-120b'] }, generatedAt: { type: 'string', format: 'date-time' }, angle: { type: 'string' },
          audience: { type: 'string' }, hook: { type: 'string' }, recommendedDurationSeconds: { type: 'integer' },
          outline: { type: 'array', items: { type: 'object', required: ['section', 'goal'], properties: { section: { type: 'string' }, goal: { type: 'string' } } } },
          titleIdeas: { type: 'array', items: { type: 'string' } }, hashtags: { type: 'array', items: { type: 'string' } },
          differentiation: { type: 'array', items: { type: 'string' } },
          evidence: { type: 'array', items: { type: 'object', required: ['claim', 'videoIds'], properties: { claim: { type: 'string' }, videoIds: { type: 'array', items: { type: 'string' } } } } },
          caveats: { type: 'array', items: { type: 'string' } }, operationId: { type: 'string', format: 'uuid' },
        },
      },
      Project: { allOf: [storedRecord, { properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, item_count: { type: 'integer' } } }] },
      ProjectDetail: { allOf: [schemaRef('Project'), { type: 'object', required: ['items'], properties: { items: { type: 'array', items: schemaRef('ProjectItem') } } }] },
      ProjectItem: storedRecord,
      CreateProjectRequest: {
        type: 'object', required: ['name'], properties: {
          name: { type: 'string', minLength: 1, maxLength: 120, example: 'Research inbox' },
          description: { type: 'string', maxLength: 1000 }, tags: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 50 } },
        },
      },
      ProjectCreated: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } } },
      CreateProjectItemRequest: {
        type: 'object', required: ['provider', 'entityType', 'entityId'], properties: {
          provider: schemaRef('ProviderId'), entityType: { type: 'string', maxLength: 30, example: 'video' }, entityId: { type: 'string' }, title: { type: 'string', maxLength: 300 },
          startMs: { type: 'integer', minimum: 0 }, endMs: { type: 'integer', minimum: 0 }, note: { type: 'string', maxLength: 5000 },
          tags: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 50 } }, content: { type: 'string', maxLength: 100000 },
        },
      },
      IdResponse: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      CreateImportRequest: {
        type: 'object', required: ['provider', 'kind', 'entityId'], properties: {
          provider: schemaRef('ProviderId'),
          kind: { type: 'string', enum: ['video', 'channel', 'playlist', 'comments', 'deep-comments'] },
          entityId: { type: 'string' }, projectId: { type: 'string' }, idempotencyKey: { type: 'string', maxLength: 200 },
        },
      },
      JobAccepted: { type: 'object', required: ['id', 'status', 'progress'], properties: { id: { type: 'string' }, status: { type: 'string' }, progress: { type: 'integer', minimum: 0, maximum: 100 } } },
      Job: { allOf: [storedRecord, { properties: { id: { type: 'string' }, status: { type: 'string', enum: ['queued', 'running', 'partial', 'succeeded', 'failed', 'cancelled'] }, progress: { type: 'integer', minimum: 0, maximum: 100 } } }] },
      Evidence: {
        type: 'object', required: ['id', 'score', 'text'], properties: {
          id: { type: 'string' }, score: { type: 'number' }, text: { type: 'string' }, provider: schemaRef('ProviderId'), entityId: { type: 'string' },
          startMs: { type: 'integer', minimum: 0 }, sourceKey: { type: 'string' }, index: { type: 'integer', minimum: 1 },
        },
      },
      CitedAnswer: {
        type: 'object', required: ['answer', 'citations', 'operationId'], properties: {
          answer: { type: 'string' }, citations: { type: 'array', items: schemaRef('Evidence') }, operationId: { type: 'string', format: 'uuid' },
        },
      },
      AnswerRequest: {
        type: 'object', required: ['question'], properties: {
          question: { type: 'string', minLength: 1, maxLength: 2000 }, projectId: { type: 'string' },
          provider: schemaRef('ProviderId'), entityId: { type: 'string' }, scope: { type: 'string', enum: ['private', 'public'], default: 'private' },
        },
        dependentRequired: { entityId: ['provider'] },
      },
      ComparisonRequest: { type: 'object', properties: { question: { type: 'string', maxLength: 2000 }, projectId: { type: 'string' } } },
      ReportRequest: { type: 'object', properties: { prompt: { type: 'string', maxLength: 2000 }, projectId: { type: 'string' } } },
      CreateExportRequest: { type: 'object', required: ['format'], properties: { format: { type: 'string', description: 'Supported export format.', example: 'markdown' } } },
      Export: storedRecord,
      MonitorIntervalMinutes: {
        type: 'integer', enum: [60, 360, 720, 1440, 4320, 10080], default: 1440,
        description: 'How often the monitor runs, in minutes.',
      },
      MonitorSchedule: {
        type: 'object', required: ['intervalMinutes', 'enabled'], properties: {
          intervalMinutes: schemaRef('MonitorIntervalMinutes'), enabled: { type: 'boolean' },
          nextCheckAt: { type: ['integer', 'null'], description: 'Unix time in milliseconds for the next alarm.' },
        },
      },
      Monitor: {
        allOf: [storedRecord, {
          type: 'object', required: ['interval_minutes', 'enabled'], properties: {
            interval_minutes: schemaRef('MonitorIntervalMinutes'), enabled: { type: 'integer', enum: [0, 1] },
            next_check_at: { type: ['integer', 'null'] }, last_checked_at: { type: ['integer', 'null'] },
          },
        }],
      },
      CreateMonitorRequest: {
        type: 'object', required: ['provider', 'kind', 'target'], properties: {
          provider: schemaRef('ProviderId'), kind: { type: 'string', enum: ['channel', 'topic', 'search'] }, target: { type: 'string', minLength: 1, maxLength: 500 },
          intervalMinutes: schemaRef('MonitorIntervalMinutes'), query: { type: 'object', additionalProperties: true },
        },
      },
      Notification: storedRecord,
      NotificationPreferencesRequest: { type: 'object', properties: { inApp: { type: 'boolean', default: true }, emailAlerts: { type: 'boolean', default: false, description: 'True requests a confirmation email; delivery remains disabled until confirmed.' } } },
      NotificationPreferences: {
        type: 'object', required: ['inApp', 'emailAlerts', 'emailAlertsPending', 'emailDigest'], properties: {
          inApp: { type: 'boolean' },
          emailAlerts: { type: 'boolean', description: 'True only after the account email has confirmed delivery.' },
          emailAlertsPending: { type: 'boolean' },
          emailAlertsRequestedAt: { type: 'integer' },
          emailDigest: { type: 'string', enum: ['off', 'daily', 'weekly'] },
        },
      },
      Usage: {
        type: 'object',
        additionalProperties: true,
        properties: {
          plan: { type: 'string', enum: ['free', 'pro'] },
          includedCredits: { type: 'integer' },
          creditGrant: { type: 'string', enum: ['onboarding', 'monthly'] },
          creditBalance: { type: 'integer' },
        },
      },
    },
  },
} as const;
