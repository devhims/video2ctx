# Backend Architecture Resources

## Knowledge

- [Hono App documentation](https://hono.dev/docs/api/hono)
  Official explanation of the Hono application object, routing methods, and `app.fetch`. Use when distinguishing the Hono app from the Cloudflare Worker.
- [Hono on Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)
  Official pattern for combining `app.fetch` with scheduled or other Worker handlers. Use when reading `platform/src/index.ts`.
- [Cloudflare Worker handlers](https://developers.cloudflare.com/workers/runtime-apis/handlers/)
  Official list of `fetch`, `scheduled`, and `queue` entry points. Use when reasoning about non-HTTP events.
- [`platform/src/index.ts`](platform/src/index.ts)
  Primary source for the assembled Hono app and Worker export.
- [`platform/src/middlewares/authentication.ts`](platform/src/middlewares/authentication.ts)
  Primary source for principal establishment and authorization guards.
- [`platform/src/lib/metering.ts`](platform/src/lib/metering.ts)
  Primary source for the credit lifecycle around data operations.

## Wisdom (Communities)

- [Hono Discord](https://hono.dev/discord)
  Framework community for checking unusual routing and middleware behavior after consulting the official documentation.
- [Cloudflare Developers Discord](https://discord.cloudflare.com/)
  Practitioner community for Worker runtime, D1, queue, and scheduled-handler questions.
