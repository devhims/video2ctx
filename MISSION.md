# Mission: Understand the backend request architecture

## Why
Build enough architectural confidence to safely debug and extend the platform backend without getting lost between Cloudflare handlers, Hono middleware, routes, and service code.

## Success looks like
- Trace an HTTP request from Cloudflare to its final route and response
- Explain the difference between the Worker, the Hono app, middleware, and route handlers
- Know where a new public, data, or session-only endpoint belongs

## Constraints
- Use this repository's real code rather than generic framework examples
- Prefer simple language and flow diagrams

## Out of scope
- Rewriting the backend framework
- Deferred general agent endpoints and workflow design
