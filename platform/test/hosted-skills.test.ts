import { readFileSync } from 'node:fs';

import { openApiDocument } from '../src/openapi';

const platformSkill = readFileSync(
  new URL('../../.agents/skills/video2ctx-platform/SKILL.md', import.meta.url),
  'utf8',
);
const hostedDataReference = readFileSync(
  new URL('../../.agents/skills/video2ctx-platform/references/hosted-data.md', import.meta.url),
  'utf8',
);
const monitoringReference = readFileSync(
  new URL('../../.agents/skills/video2ctx-platform/references/monitoring.md', import.meta.url),
  'utf8',
);
const youtubeContextSkill = readFileSync(
  new URL('../../.agents/skills/youtube-ctx/SKILL.md', import.meta.url),
  'utf8',
);
const youtubeDirectReference = readFileSync(
  new URL('../../.agents/skills/youtube-ctx/references/direct.md', import.meta.url),
  'utf8',
);
const youtubeVisualReference = readFileSync(
  new URL('../../.agents/skills/youtube-ctx/references/visual.md', import.meta.url),
  'utf8',
);
const platformSelector = readFileSync(
  new URL('../../.agents/skills/video2ctx-platform/agents/openai.yaml', import.meta.url),
  'utf8',
);
const youtubeContextSelector = readFileSync(
  new URL('../../.agents/skills/youtube-ctx/agents/openai.yaml', import.meta.url),
  'utf8',
);
describe('hosted video2ctx platform skill', () => {
  test('stays on the authenticated production surface', () => {
    const publishedContract = [platformSkill, hostedDataReference, monitoringReference].join('\n');
    expect(platformSkill).toContain('https://api.video2ctx.dev');
    expect(platformSkill).toContain('video2ctx --version');
    expect(platformSkill).toContain('npm install --global @video2ctx/cli');
    expect(platformSkill).toContain('auth login');
    expect(platformSkill).toContain('whoami --json');
    expect(platformSkill).not.toContain('auth status --json');
    expect(platformSkill).toContain('video2ctx api');
    expect(platformSkill).toContain('VIDEO2CTX_API_KEY');
    expect(platformSkill).toContain('https://api.video2ctx.dev/openapi.json');
    expect(publishedContract).not.toMatch(/all-things-youtube|youtubei\.googleapis\.com|www\.youtube\.com/);
    expect(publishedContract).not.toContain('scripts/video2ctx.mjs');
    expect(publishedContract).not.toMatch(/npx |<skill-directory>/);
    expect(publishedContract).not.toMatch(/fetch\(|curl |Authorization: Bearer \$VIDEO2CTX_API_KEY/);
  });

  test('routers distinguish local context from hosted platform branches', () => {
    expect(youtubeContextSkill).toMatch(/^---\nname: youtube-ctx\n/);
    expect(youtubeContextSkill).toContain('Personal, local-machine YouTube context for one-off, low-to-moderate usage');
    expect(youtubeContextSkill).toContain('[references/direct.md](references/direct.md)');
    expect(youtubeContextSkill).toContain('[references/visual.md](references/visual.md)');
    expect(youtubeContextSkill).toContain('continue with `video2ctx-platform` without asking the user');
    expect(youtubeDirectReference).toContain('stateless YouTube search and extraction');
    expect(youtubeVisualReference).toContain('does not require FFmpeg');
    expect(youtubeVisualReference).toContain('Verify with exact frames when needed');
    expect(youtubeContextSelector).toContain('$youtube-ctx');

    expect(platformSkill).toMatch(/^---\nname: video2ctx-platform\n/);
    expect(platformSkill).toContain('Managed, hosted YouTube context for production and cloud-backed applications');
    expect(platformSkill).toContain('[references/hosted-data.md](references/hosted-data.md)');
    expect(platformSkill).toContain('[references/monitoring.md](references/monitoring.md)');
    expect(hostedDataReference).toContain('automatic fallback after a `youtube-ctx` direct operation fails');
    expect(monitoringReference).toContain('recurring checks, monitor state, notifications, and delivery preferences');
    expect(platformSelector).toContain('$video2ctx-platform');
  });

  test('keeps installation explicit and reuses one public credential transport', () => {
    expect(platformSkill).toContain('public `@video2ctx/cli` npm package');
    expect(platformSkill).toContain('ask the user to approve its installation');
  });

  test('preserves stateful monitoring invariants behind the monitoring branch', () => {
    expect(monitoringReference).toContain('first check as a baseline');
    expect(monitoringReference).toContain('raises no alert');
    expect(monitoringReference).toContain('resolve exact account-owned IDs');
    expect(monitoringReference).toContain('only after handling the work it triggered');
    expect(monitoringReference).toContain('Use `1440` when the user gives no cadence');
  });

  test('every explicitly documented hosted route exists in OpenAPI', () => {
    const paths = openApiDocument.paths as Record<string, Record<string, unknown>>;
    const operations = [
      ['get', '/v1/providers'],
      ['get', '/v1/usage'],
      ['get', '/v1/account'],
      ['get', '/v1/providers/{provider}/search'],
      ['get', '/v1/providers/{provider}/browse'],
      ['get', '/v1/providers/{provider}/videos/{id}'],
      ['get', '/v1/providers/{provider}/videos/{id}/tracks'],
      ['get', '/v1/providers/{provider}/videos/{id}/transcript'],
      ['get', '/v1/providers/{provider}/videos/{id}/comments'],
      ['get', '/v1/providers/{provider}/videos/{id}/endscreen'],
      ['get', '/v1/providers/{provider}/channels/{id}'],
      ['get', '/v1/providers/{provider}/channels/{id}/videos'],
      ['get', '/v1/providers/{provider}/channels/{id}/playlists'],
      ['get', '/v1/providers/{provider}/playlists/{id}'],
      ['post', '/v1/monitors'],
      ['get', '/v1/monitors'],
      ['patch', '/v1/monitors/{id}'],
      ['delete', '/v1/monitors/{id}'],
      ['get', '/v1/notifications'],
      ['post', '/v1/notifications/{id}/read'],
      ['get', '/v1/notification-preferences'],
      ['put', '/v1/notification-preferences'],
    ] as const;

    for (const [method, path] of operations) {
      expect(paths[path]?.[method], `${method.toUpperCase()} ${path}`).toBeDefined();
    }
  });
});
