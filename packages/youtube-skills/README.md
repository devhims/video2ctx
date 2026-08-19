# youtube-skills

Private source, tests, and bundling for the repository's self-contained `youtube-ctx` agent skill.

This package is not published. It consumes `all-things-youtube` through that package's public interface and owns two internal execution branches: direct search and extraction, plus progressive visual inspection. The visual branch also owns workspace handling, media resolution, range proxying, and optional FFmpeg extraction. The distributable skill instructions and generated executables remain under `.agents/skills/youtube-ctx/`.

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

- `.agents/skills/youtube-ctx/scripts/youtube.mjs`
- `.agents/skills/youtube-ctx/scripts/watch.mjs`

Commit generated executable changes together with their source changes. CI verifies that both internal bundles are current and executable.
