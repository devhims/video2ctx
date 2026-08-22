export const SITE_NAME = 'video2ctx';
export const SITE_URL = 'https://www.video2ctx.dev';
/* Renders as <meta name="description">, og:description, twitter:description and
 * the JSON-LD WebSite block. It is the search snippet and the link-preview body,
 * not a tagline: the title already carries the positioning, so this should add
 * rather than restate. Under ~158 characters, past which Google truncates.
 *
 * Two framings this has already been through and should not go back to. It once
 * opened "Paste a YouTube URL", which reads as a single integration when
 * provider routes are namespaced and a second source slots in beside YouTube.
 * It then led with transcript, channel, comments and playlist, which sells the
 * primitives as the product rather than the layer built on them.
 *
 * The surfaces named here are the ones that ship: skills, the @video2ctx/cli,
 * and the hosted API. Do not call `all-things-youtube` an SDK — it is a
 * server-side TypeScript client for YouTube data with no hosted service in the
 * path, so listing it beside "hosted API" implies a client for that API. */
export const SITE_DESCRIPTION =
  'Search, extract, and monitor video context with agent skills, a CLI, and a hosted API.';
export const HOME_TITLE = 'video2ctx | video context for AI agents';
