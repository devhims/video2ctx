# youtube-skills

Private source, tests, and bundling for the repository's self-contained YouTube agent skills.

This package is not published. It consumes `all-things-youtube` through that package's public interface and owns agent-specific orchestration, workspace handling, media resolution, range proxying, and FFmpeg extraction. The distributable skill instructions and generated executables remain under `.agents/skills/`.

Install the public library first because this package uses it as a local dependency:

```bash
npm ci --prefix packages/all-things-youtube
npm --prefix packages/all-things-youtube run build
npm ci --prefix packages/youtube-skills
```

From the repository root:

```bash
npm run test:skills
npm run skill:bundle
npm run skill:check
```

`skill:bundle` regenerates:

- `.agents/skills/youtube-direct/scripts/youtube.mjs`
- `.agents/skills/youtube-watch/scripts/watch.mjs`

Commit generated executable changes together with their source changes. CI verifies that both bundles are current and executable.
