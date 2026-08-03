import {
  BROWSE_CATEGORIES,
  BROWSE_LANGUAGES,
  BROWSE_REGIONS,
} from './lib/browse-contract';

type Schema = Record<string, unknown>;

const schemaRef = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const responseRef = (name: string) => ({ $ref: `#/components/responses/${name}` });
const jsonResponse = (description: string, schema: Schema) => ({
  description,
  content: { 'application/json': { schema } },
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
const standardErrors = {
  '401': responseRef('Unauthorized'),
  '422': responseRef('ValidationError'),
  '500': responseRef('ServerError'),
};
const idParameter = pathParameter('id', 'Resource identifier.');

const sourceMetadata: Schema = {
  type: 'object',
  required: ['source', 'fetchedAt', 'partial', 'warnings'],
  properties: {
    source: { type: 'string', enum: ['innertube', 'youtube-data-api', 'cache', 'derived'] },
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
  required: ['type', 'id', 'title', 'thumbnails', 'url'],
  properties: {
    type: { const: 'playlist' },
    id: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    channel: { type: 'object', additionalProperties: true },
    thumbnails: { type: 'array', items: schemaRef('Thumbnail') },
    videoCount: { type: 'integer', minimum: 0 },
    videoCountText: { type: 'string' },
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
  required: ['query', 'generatedAt', 'sampleSize', 'methodologyVersion', 'methodology', 'sample', 'confidence', 'summary', 'videos', 'hashtags', 'titlePatterns', 'durationMix', 'plan', 'warnings'],
  properties: {
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
    title: 'all-things-youtube API',
    version: '1.0.0',
    license: { name: 'Proprietary' },
    description: [
      'Interactive contract for the all-things-youtube platform Worker.',
      'Public discovery routes can be called directly. Private routes accept a Better Auth session cookie.',
      'When running locally with ENVIRONMENT other than production, set X-Demo-User to any stable value to create and use an isolated demo account.',
    ].join('\n\n'),
  },
  security: [],
  servers: [{ url: '/', description: 'Current platform host' }],
  tags: [
    { name: 'System', description: 'Service status and machine-readable documentation.' },
    { name: 'Authentication', description: 'Better Auth entry points used by the web application.' },
    { name: 'UI Helpers', description: 'Internal routing helpers used by the first-party web interface.' },
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
    '/v1/resolve': {
      post: {
        tags: ['UI Helpers'],
        operationId: 'resolveInput',
        summary: 'Route universal UI input',
        description: 'Internal first-party UI helper that classifies text, an ID, or a YouTube URL before navigation. It is not a primary public consumer API. In production, this route also requires a valid Cloudflare Turnstile response header.',
        'x-internal': true,
        security: [{}, { turnstile: [] }],
        requestBody: jsonBody(schemaRef('ResolveRequest')),
        responses: {
          '200': jsonResponse('The classified input.', schemaRef('ResolveResponse')),
          '403': responseRef('Forbidden'),
          '422': responseRef('ValidationError'),
          '429': responseRef('RateLimited'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/search': {
      get: {
        tags: ['Discovery'],
        operationId: 'search',
        summary: 'Search YouTube, private evidence, or ask a cited question',
        description: '`mode=youtube` is public. `inside` and `ask` require authentication. The authentication controls can be set before changing modes.',
        parameters: [
          queryParameter('q', 'Search query or question.', { type: 'string', maxLength: 500, example: 'AI agents' }, true),
          queryParameter('mode', 'Search mode.', { type: 'string', enum: ['youtube', 'inside', 'ask'], default: 'youtube' }),
          queryParameter('projectId', 'Restrict private retrieval to a project.', { type: 'string' }),
          queryParameter('type', 'YouTube entity type.', { type: 'string', enum: ['all', 'video', 'channel', 'playlist'], default: 'all' }),
          queryParameter('channel', 'Restrict YouTube search to a channel.', { type: 'string' }),
          queryParameter('language', 'Preferred language code.', { type: 'string', example: 'en' }),
          queryParameter('duration', 'Video duration bucket.', { type: 'string', enum: ['short', 'medium', 'long'] }),
          queryParameter('sort', 'Result ordering.', { type: 'string', enum: ['relevance', 'date', 'views', 'rating'] }),
          queryParameter('captions', 'Only include captioned videos.', { type: 'boolean' }),
          queryParameter('live', 'Live broadcast state.', { type: 'string', enum: ['live', 'upcoming', 'completed'] }),
          queryParameter('continuation', 'Opaque token returned by a previous YouTube search page.', { type: 'string' }),
        ],
        responses: {
          '200': jsonResponse('Search results or a cited answer, depending on mode.', {
            oneOf: [schemaRef('SearchResponse'), schemaRef('PrivateSearchResponse'), schemaRef('CitedAnswer')],
          }),
          '401': responseRef('Unauthorized'),
          '422': responseRef('ValidationError'),
          '429': responseRef('RateLimited'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/browse': {
      get: {
        tags: ['Discovery'],
        operationId: 'browseYouTube',
        summary: 'Browse a public YouTube discovery feed',
        description: 'Returns queryless discovery results from a supported public YouTube destination. A category is required because YouTube no longer exposes an anonymous general Trending feed.',
        parameters: [
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
          '200': jsonResponse('Browse results.', schemaRef('BrowseResponse')),
          '422': responseRef('ValidationError'),
          '429': responseRef('RateLimited'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/trends': {
      get: {
        tags: ['Discovery'],
        operationId: 'researchTrends',
        summary: 'Calculate public trend signals for a topic',
        description: 'Builds a diversified topic sample, persists public metric snapshots, calculates observed acceleration when history exists, and optionally adds GLM-generated evidence-grounded themes and content gaps.',
        parameters: [
          queryParameter('q', 'Topic to research.', { type: 'string', maxLength: 200, example: 'AI agents' }, true),
          queryParameter('limit', 'Number of diversified videos to enrich; clamped to 8–30.', { type: 'integer', minimum: 8, maximum: 30, default: 20 }),
          queryParameter('insights', 'AI insight mode. Use deterministic to skip GLM analysis.', { type: 'string', enum: ['ai', 'deterministic'], default: 'ai' }),
        ],
        responses: {
          '200': jsonResponse('Topic trend report.', schemaRef('TrendReport')),
          '422': responseRef('ValidationError'),
          '429': responseRef('RateLimited'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/trends/plan': {
      post: {
        tags: ['Discovery'],
        operationId: 'generateTrendPlan',
        summary: 'Generate an AI video plan from trend signals',
        description: 'Uses Kimi K2.6 for strategic synthesis and automatically falls back to GPT-OSS 120B when Kimi is unavailable. The response identifies the model that produced it.',
        security: privateSecurity,
        requestBody: jsonBody({
          type: 'object',
          required: ['report'],
          properties: { report: schemaRef('TrendReport') },
        }),
        responses: {
          '200': jsonResponse('Evidence-grounded video plan.', schemaRef('AiTrendPlan')),
          ...standardErrors,
          '503': responseRef('ServiceUnavailable'),
        },
      },
    },
    '/v1/videos/{id}': {
      get: {
        tags: ['Videos'],
        operationId: 'getVideo',
        summary: 'Inspect a video',
        parameters: [pathParameter('id', 'YouTube video ID.', 'dQw4w9WgXcQ')],
        responses: {
          '200': jsonResponse('Normalized video metadata.', schemaRef('Video')),
          '404': responseRef('NotFound'),
          '422': responseRef('ValidationError'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/videos/{id}/captions': {
      get: {
        tags: ['Videos'],
        operationId: 'getVideoCaptions',
        summary: 'List caption tracks',
        parameters: [pathParameter('id', 'YouTube video ID.', 'dQw4w9WgXcQ')],
        responses: {
          '200': jsonResponse('Caption track information.', schemaRef('CaptionTrackList')),
          '404': responseRef('NotFound'),
          '422': responseRef('ValidationError'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/videos/{id}/transcript': {
      get: {
        tags: ['Videos'],
        operationId: 'getVideoTranscript',
        summary: 'Get a timed transcript',
        parameters: [
          pathParameter('id', 'YouTube video ID.', 'dQw4w9WgXcQ'),
          queryParameter('language', 'Requested language code.', { type: 'string', default: 'en' }),
        ],
        responses: {
          '200': jsonResponse('Normalized timed transcript.', schemaRef('Transcript')),
          '404': responseRef('NotFound'),
          '422': responseRef('ValidationError'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/videos/{id}/comments': {
      get: {
        tags: ['Videos'],
        operationId: 'getVideoComments',
        summary: 'Get video comments',
        parameters: [
          pathParameter('id', 'YouTube video ID.', 'dQw4w9WgXcQ'),
          queryParameter('continuation', 'Opaque pagination token.', { type: 'string' }),
          queryParameter('all', 'Fetch all available pages rather than one page.', { type: 'boolean', default: false }),
        ],
        responses: {
          '200': jsonResponse('A comment page or collection.', schemaRef('CommentResponse')),
          '404': responseRef('NotFound'),
          '422': responseRef('ValidationError'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/videos/{id}/storyboards': {
      get: {
        tags: ['Videos'],
        operationId: 'getVideoStoryboards',
        summary: 'Get storyboard metadata',
        parameters: [pathParameter('id', 'YouTube video ID.', 'dQw4w9WgXcQ')],
        responses: {
          '200': jsonResponse('Video storyboard levels.', { type: 'array', items: schemaRef('Storyboard') }),
          '422': responseRef('ValidationError'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/videos/{id}/endscreen': {
      get: {
        tags: ['Videos'],
        operationId: 'getVideoEndscreen',
        summary: 'Get endscreen elements',
        parameters: [pathParameter('id', 'YouTube video ID.', 'dQw4w9WgXcQ')],
        responses: {
          '200': jsonResponse('Video endscreen elements.', { type: 'array', items: schemaRef('EndscreenElement') }),
          '422': responseRef('ValidationError'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/channels/{id}': {
      get: {
        tags: ['Channels'],
        operationId: 'getChannel',
        summary: 'Inspect a channel',
        parameters: [pathParameter('id', 'YouTube channel ID or handle.', '@YouTube')],
        responses: {
          '200': jsonResponse('Normalized channel and catalog.', schemaRef('Channel')),
          '404': responseRef('NotFound'),
          '422': responseRef('ValidationError'),
          '500': responseRef('ServerError'),
        },
      },
    },
    '/v1/playlists/{id}': {
      get: {
        tags: ['Playlists'],
        operationId: 'getPlaylist',
        summary: 'Inspect a playlist',
        parameters: [pathParameter('id', 'YouTube playlist ID.', 'PL123')],
        responses: {
          '200': jsonResponse('Normalized playlist and videos.', schemaRef('Playlist')),
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
        security: privateSecurity,
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
        security: privateSecurity,
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
        security: privateSecurity,
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
        security: privateSecurity,
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
        security: privateSecurity,
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
        security: privateSecurity,
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
        security: privateSecurity,
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
        security: privateSecurity,
        requestBody: jsonBody(schemaRef('AnswerRequest')),
        responses: {
          '200': jsonResponse('Evidence-grounded answer.', schemaRef('CitedAnswer')),
          ...standardErrors,
          '503': responseRef('ServiceUnavailable'),
        },
      },
    },
    '/v1/comparisons': {
      post: {
        tags: ['Research'],
        operationId: 'createComparison',
        summary: 'Compare private research sources',
        security: privateSecurity,
        requestBody: jsonBody(schemaRef('ComparisonRequest')),
        responses: {
          '200': jsonResponse('Evidence-grounded comparison.', schemaRef('CitedAnswer')),
          ...standardErrors,
          '503': responseRef('ServiceUnavailable'),
        },
      },
    },
    '/v1/reports': {
      post: {
        tags: ['Research'],
        operationId: 'createReport',
        summary: 'Generate an evidence-first report',
        security: privateSecurity,
        requestBody: jsonBody(schemaRef('ReportRequest')),
        responses: {
          '200': jsonResponse('Evidence-grounded report.', schemaRef('CitedAnswer')),
          ...standardErrors,
          '503': responseRef('ServiceUnavailable'),
        },
      },
    },
    '/v1/projects/{id}/exports': {
      post: {
        tags: ['Exports'],
        operationId: 'createProjectExport',
        summary: 'Create a project export',
        security: privateSecurity,
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
        security: privateSecurity,
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
        security: privateSecurity,
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
        security: privateSecurity,
        requestBody: jsonBody(schemaRef('CreateMonitorRequest')),
        responses: {
          '201': jsonResponse('Monitor created.', schemaRef('IdResponse')),
          ...standardErrors,
        },
      },
    },
    '/v1/monitors/{id}': {
      delete: {
        tags: ['Monitoring'],
        operationId: 'deleteMonitor',
        summary: 'Delete a monitor',
        security: privateSecurity,
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
        security: privateSecurity,
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
        security: privateSecurity,
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
      put: {
        tags: ['Monitoring'],
        operationId: 'updateNotificationPreferences',
        summary: 'Update notification preferences',
        security: privateSecurity,
        requestBody: jsonBody(schemaRef('NotificationPreferencesRequest')),
        responses: {
          '200': jsonResponse('Updated preferences.', schemaRef('NotificationPreferences')),
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
          '200': { description: 'Email digests disabled.', content: { 'text/plain': { schema: { type: 'string' } } } },
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
          '200': { description: 'Email digests disabled.', content: { 'text/plain': { schema: { type: 'string' } } } },
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
        security: privateSecurity,
        responses: {
          '200': jsonResponse('Current entitlements and credits.', schemaRef('Usage')),
          '401': responseRef('Unauthorized'),
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
      demoUser: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Demo-User',
        description: 'Local development only. Any stable value selects an isolated demo account. Ignored in production.',
      },
      turnstile: {
        type: 'apiKey',
        in: 'header',
        name: 'cf-turnstile-response',
        description: 'Cloudflare Turnstile token required by /v1/resolve in production.',
      },
      stripeSignature: {
        type: 'apiKey',
        in: 'header',
        name: 'stripe-signature',
        description: 'Stripe-generated signature over the exact raw request body.',
      },
    },
    responses: {
      BadRequest: jsonResponse('The request is malformed.', schemaRef('Error')),
      Unauthorized: jsonResponse('Authentication is required.', schemaRef('Error')),
      Forbidden: jsonResponse('The caller is not allowed to perform this operation.', schemaRef('Error')),
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
          service: { const: 'all-things-youtube-platform' },
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
      ResolveRequest: {
        type: 'object',
        required: ['input'],
        properties: { input: { type: 'string', maxLength: 500, example: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } },
      },
      ResolveResponse: {
        oneOf: [
          { type: 'object', required: ['kind', 'id'], properties: { kind: { const: 'video' }, id: { type: 'string' } } },
          { type: 'object', required: ['kind', 'id'], properties: { kind: { const: 'channel' }, id: { type: 'string' } } },
          { type: 'object', required: ['kind', 'id'], properties: { kind: { const: 'playlist' }, id: { type: 'string' } } },
          { type: 'object', required: ['kind', 'query'], properties: { kind: { const: 'search' }, query: { type: 'string' } } },
        ],
      },
      SourceMetadata: sourceMetadata,
      Thumbnail: thumbnail,
      ChannelSummary: channelSummary,
      VideoSummary: videoSummary,
      PlaylistSummary: playlistSummary,
      SearchResult: { oneOf: [schemaRef('VideoSummary'), schemaRef('ChannelSummary'), schemaRef('PlaylistSummary')] },
      SearchResponse: {
        type: 'object',
        required: ['query', 'results', 'videos', 'channels', 'playlists', 'meta'],
        properties: {
          query: { type: 'string' },
          results: { type: 'array', items: schemaRef('SearchResult') },
          videos: { type: 'array', items: schemaRef('VideoSummary') },
          channels: { type: 'array', items: schemaRef('ChannelSummary') },
          playlists: { type: 'array', items: schemaRef('PlaylistSummary') },
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
      CaptionTrackList: {
        type: 'object',
        required: ['tracks', 'translationLanguages', 'meta'],
        properties: {
          tracks: { type: 'array', items: schemaRef('CaptionTrack') },
          translationLanguages: { type: 'array', items: { type: 'object', required: ['languageCode', 'name'], properties: { languageCode: { type: 'string' }, name: { type: 'string' } } } },
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
          segments: { type: 'array', items: schemaRef('TranscriptSegment') },
          granularity: { type: 'string', enum: ['segment', 'word'] }, text: { type: 'string' }, meta: schemaRef('SourceMetadata'),
        },
      },
      Video: {
        allOf: [schemaRef('VideoSummary'), {
          type: 'object',
          required: ['keywords', 'availability', 'captionTracks', 'translationLanguages', 'media', 'storyboards', 'endscreen', 'meta'],
          properties: {
            keywords: { type: 'array', items: { type: 'string' } },
            availability: { type: 'object', additionalProperties: true },
            captionTracks: { type: 'array', items: schemaRef('CaptionTrack') },
            translationLanguages: { type: 'array', items: { type: 'object', additionalProperties: true } },
            media: { type: 'object', additionalProperties: true },
            storyboards: { type: 'array', items: schemaRef('Storyboard') },
            endscreen: { type: 'array', items: schemaRef('EndscreenElement') },
            meta: schemaRef('SourceMetadata'),
          },
        }],
      },
      Storyboard: {
        type: 'object',
        required: ['levels'],
        properties: {
          recommendedLevel: { type: 'integer', minimum: 0 },
          levels: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
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
      CommentResponse: {
        type: 'object',
        required: ['videoId', 'comments', 'meta'],
        properties: {
          videoId: { type: 'string' }, comments: { type: 'array', items: { type: 'object', additionalProperties: true } },
          continuation: { type: 'string' }, estimatedTotal: { type: 'integer' }, complete: { type: 'boolean' },
          pagesFetched: { type: 'integer' }, topLevelCount: { type: 'integer' }, replyCount: { type: 'integer' },
          remainingContinuations: { type: 'integer' }, meta: schemaRef('SourceMetadata'),
        },
      },
      Channel: {
        allOf: [schemaRef('ChannelSummary'), {
          type: 'object', required: ['videos', 'playlists', 'meta'], properties: {
            videos: { type: 'array', items: schemaRef('VideoSummary') }, playlists: { type: 'array', items: schemaRef('PlaylistSummary') },
            continuation: { type: 'string' }, estimatedTotal: { type: 'integer' }, meta: schemaRef('SourceMetadata'),
          },
        }],
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
        required: ['model', 'generatedAt', 'angle', 'audience', 'hook', 'recommendedDurationSeconds', 'outline', 'titleIdeas', 'hashtags', 'differentiation', 'evidence', 'caveats', 'operationId'],
        properties: {
          model: { type: 'string', enum: ['@cf/moonshotai/kimi-k2.6', '@cf/openai/gpt-oss-120b'] }, generatedAt: { type: 'string', format: 'date-time' }, angle: { type: 'string' },
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
        type: 'object', required: ['entityType', 'entityId'], properties: {
          entityType: { type: 'string', maxLength: 30, example: 'video' }, entityId: { type: 'string' }, title: { type: 'string', maxLength: 300 },
          startMs: { type: 'integer', minimum: 0 }, endMs: { type: 'integer', minimum: 0 }, note: { type: 'string', maxLength: 5000 },
          tags: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 50 } }, content: { type: 'string', maxLength: 100000 },
        },
      },
      IdResponse: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      CreateImportRequest: {
        type: 'object', required: ['kind', 'entityId'], properties: {
          kind: { type: 'string', enum: ['video', 'channel', 'playlist', 'comments', 'deep-comments'] },
          entityId: { type: 'string' }, projectId: { type: 'string' }, idempotencyKey: { type: 'string', maxLength: 200 },
        },
      },
      JobAccepted: { type: 'object', required: ['id', 'status', 'progress'], properties: { id: { type: 'string' }, status: { type: 'string' }, progress: { type: 'integer', minimum: 0, maximum: 100 } } },
      Job: { allOf: [storedRecord, { properties: { id: { type: 'string' }, status: { type: 'string', enum: ['queued', 'running', 'partial', 'succeeded', 'failed', 'cancelled'] }, progress: { type: 'integer', minimum: 0, maximum: 100 } } }] },
      Evidence: {
        type: 'object', required: ['id', 'score', 'text'], properties: {
          id: { type: 'string' }, score: { type: 'number' }, text: { type: 'string' }, entityId: { type: 'string' },
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
          entityId: { type: 'string' }, scope: { type: 'string', enum: ['private', 'public'], default: 'private' },
        },
      },
      ComparisonRequest: { type: 'object', properties: { question: { type: 'string', maxLength: 2000 }, projectId: { type: 'string' } } },
      ReportRequest: { type: 'object', properties: { prompt: { type: 'string', maxLength: 2000 }, projectId: { type: 'string' } } },
      CreateExportRequest: { type: 'object', required: ['format'], properties: { format: { type: 'string', description: 'Supported export format.', example: 'markdown' } } },
      Export: storedRecord,
      Monitor: storedRecord,
      CreateMonitorRequest: {
        type: 'object', required: ['kind', 'target'], properties: {
          kind: { type: 'string', enum: ['channel', 'topic', 'search'] }, target: { type: 'string', minLength: 1, maxLength: 500 },
          cadence: { type: 'string', maxLength: 30, default: 'hourly' }, query: { type: 'object', additionalProperties: true },
        },
      },
      Notification: storedRecord,
      NotificationPreferencesRequest: { type: 'object', properties: { inApp: { type: 'boolean', default: true }, emailDigest: { type: 'string', enum: ['off', 'daily', 'weekly'], default: 'weekly' } } },
      NotificationPreferences: { type: 'object', required: ['inApp', 'emailDigest'], properties: { inApp: { type: 'boolean' }, emailDigest: { type: 'string', enum: ['off', 'daily', 'weekly'] } } },
      Usage: { type: 'object', additionalProperties: true, properties: { plan: { type: 'string', enum: ['free', 'pro'] }, creditBalance: { type: 'integer' } } },
    },
  },
} as const;
