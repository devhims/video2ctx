// Local development only. Production continues to use index.ts.
export * from './index';
export { default } from './index';
import { YouTubeProcessorContainer as ProductionProcessor } from './youtube-processor-container';

export class YouTubeProcessorContainer extends ProductionProcessor {
  constructor(ctx: ConstructorParameters<typeof ProductionProcessor>[0], env: Env) {
    super(ctx, env);
    // Wrangler reuses warm Docker containers across Worker reloads, but their
    // egress connections can reset after the runtime is replaced. Recreate the
    // stateless processor so startup establishes fresh networking. Local Worker
    // storage is untouched. A reload may interrupt an in-flight provider read.
    ctx.blockConcurrencyWhile(async () => {
      if (ctx.container?.running) await ctx.container.destroy();
    });
  }
}
