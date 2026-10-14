import app from './app';
export { UserAccountDO } from './durable-objects/user-account';

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (String(env.ENVIRONMENT) !== 'development' || String(env.POLAR_ENVIRONMENT) !== 'sandbox') {
      return new Response('This entry point only runs with local Polar sandbox settings.', { status: 503 });
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
