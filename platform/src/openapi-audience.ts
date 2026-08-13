export const OPENAPI_AUDIENCES = ['consumer', 'first-party', 'callback', 'operator'] as const;

export type OpenApiAudience = typeof OPENAPI_AUDIENCES[number];

/**
 * Documentation audience for every operation published by openapi.ts.
 *
 * Consumer operations are rendered by Mintlify's interactive OpenAPI viewer.
 * Every other operation is rendered in a non-interactive internal inventory.
 * Keep this map exhaustive: generation and tests reject missing or stale IDs.
 */
export const OPENAPI_OPERATION_AUDIENCE: Readonly<Record<string, OpenApiAudience>> = {
  getServiceInfo: 'consumer',
  getHealth: 'consumer',
  getOpenApiDocument: 'consumer',
  getApiReference: 'consumer',
  inspectLandingYouTubeVideo: 'first-party',
  submitScaleInquiry: 'first-party',
  signInWithMagicLink: 'first-party',
  signInWithSocialProvider: 'first-party',
  createApiKey: 'first-party',
  listApiKeys: 'first-party',
  deleteApiKey: 'first-party',
  resolveInput: 'first-party',
  searchPrivateEvidence: 'consumer',
  listProviders: 'consumer',
  searchProvider: 'consumer',
  browseProvider: 'consumer',
  researchTrends: 'consumer',
  generateTrendPlan: 'consumer',
  getVideo: 'consumer',
  getVideoTracks: 'consumer',
  getVideoTranscript: 'consumer',
  getVideoComments: 'consumer',
  getVideoEndscreen: 'consumer',
  getChannel: 'consumer',
  getChannelVideos: 'consumer',
  getChannelPlaylists: 'consumer',
  getPlaylist: 'consumer',
  listProjects: 'consumer',
  createProject: 'consumer',
  getProject: 'consumer',
  deleteProject: 'consumer',
  addProjectItem: 'consumer',
  createImport: 'consumer',
  getJob: 'consumer',
  createAnswer: 'consumer',
  createComparison: 'consumer',
  createReport: 'consumer',
  createProjectExport: 'consumer',
  downloadExport: 'consumer',
  listMonitors: 'consumer',
  createMonitor: 'consumer',
  updateMonitor: 'consumer',
  deleteMonitor: 'consumer',
  listNotifications: 'consumer',
  markNotificationRead: 'consumer',
  getNotificationPreferences: 'consumer',
  updateNotificationPreferences: 'consumer',
  confirmNotificationEmail: 'first-party',
  unsubscribeEmail: 'callback',
  unsubscribeEmailPost: 'callback',
  createYouTubeConnectUrl: 'first-party',
  completeYouTubeOAuth: 'callback',
  disconnectYouTube: 'first-party',
  createBillingCheckout: 'first-party',
  handleStripeWebhook: 'callback',
  getUsage: 'consumer',
  listAdminJobs: 'operator',
  deleteAccount: 'first-party',
};

/**
 * Operation-specific cautions for every route excluded from the public playground.
 * Tests keep this inventory aligned with the non-consumer audience map.
 */
export const OPENAPI_INTERNAL_SAFETY: Readonly<Record<string, string>> = {
  inspectLandingYouTubeVideo: 'Public, rate-limited demo route; do not use it as a credentialed bulk-data API.',
  submitScaleInquiry: 'Public lead form; validate Turnstile and rate limits, and never let the caller choose the notification recipient.',
  signInWithMagicLink: 'Sends account email; rate-limit callers and never disclose whether an address is registered.',
  signInWithSocialProvider: 'Starts an interactive browser sign-in; do not call it with API-key credentials.',
  createApiKey: 'Creates a secret credential; expose the returned key once and keep it out of logs and client storage.',
  listApiKeys: 'Returns credential metadata; restrict it to the current signed-in account.',
  deleteApiKey: 'Immediately revokes the selected credential; require an explicit user action.',
  resolveInput: 'First-party input router; its dispatch behavior is not a stable public API contract.',
  confirmNotificationEmail: 'Enables email delivery only for the signed-in account after validating the confirmation token.',
  createYouTubeConnectUrl: 'Returns a state-bound OAuth URL; start it only from a user-initiated connection flow.',
  disconnectYouTube: 'Mutates the account connection state; require an explicit user action.',
  createBillingCheckout: 'Starts an external checkout session; the user must review and complete payment with Stripe.',
  deleteAccount: 'Destructive account operation; require deliberate confirmation and never automate it for a user.',
  handleStripeWebhook: 'Accept only Stripe-signed requests and preserve idempotent event handling.',
  unsubscribeEmail: 'A signed link changes email preferences; do not expose or reuse its token.',
  unsubscribeEmailPost: 'Changes email preferences; validate the signed request and avoid logging its token.',
  completeYouTubeOAuth: 'OAuth callback; validate state and consume authorization codes only once.',
  listAdminJobs: 'May expose cross-account operational metadata; restrict it to authorized operators.',
};
