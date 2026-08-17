import { readFileSync } from 'node:fs';

import { openApiDocument } from '../src/openapi';

const apiSkill = readFileSync(
  new URL('../../.agents/skills/video2ctx-api/SKILL.md', import.meta.url),
  'utf8',
);
const directSkill = readFileSync(
  new URL('../../.agents/skills/youtube-direct/SKILL.md', import.meta.url),
  'utf8',
);
const monitoringSkill = readFileSync(
  new URL('../../.agents/skills/video2ctx-monitoring/SKILL.md', import.meta.url),
  'utf8',
);
describe('hosted video2ctx skills', () => {
  test.each([
    ['video2ctx-api', apiSkill],
    ['video2ctx-monitoring', monitoringSkill],
  ])('%s stays on the authenticated production surface', (_name, skill) => {
    expect(skill).toContain('https://api.video2ctx.dev');
    expect(skill).toContain('video2ctx --version');
    expect(skill).toContain('npm install --global @video2ctx/cli');
    expect(skill).toContain('auth login');
    expect(skill).toContain('auth status --json');
    expect(skill).toContain('video2ctx api');
    expect(skill).toContain('VIDEO2CTX_API_KEY');
    expect(skill).toContain('https://api.video2ctx.dev/openapi.json');
    expect(skill).not.toMatch(/all-things-youtube|youtubei\.googleapis\.com|www\.youtube\.com/);
    expect(skill).not.toContain('scripts/video2ctx.mjs');
    expect(skill).not.toMatch(/npx |<skill-directory>/);
    expect(skill).not.toMatch(/fetch\(|curl |Authorization: Bearer \$VIDEO2CTX_API_KEY/);
  });

  test('selector metadata distinguishes direct, hosted, and monitoring use', () => {
    expect(directSkill).toMatch(/^---\nname: youtube-direct\n/);
    expect(directSkill).toContain('Direct, no-account YouTube search and extraction');
    expect(directSkill).toContain('use video2ctx-api instead');

    expect(apiSkill).toContain('Managed, authenticated YouTube search and extraction');
    expect(apiSkill).toContain('Use instead of youtube-direct');

    expect(monitoringSkill).toContain('Stateful video2ctx monitoring');
    expect(monitoringSkill).toContain('use video2ctx-api for one-time hosted reads');
  });

  test('keeps installation explicit and reuses one public credential transport', () => {
    expect(apiSkill).toContain('public `@video2ctx/cli` npm package');
    expect(monitoringSkill).toContain('public `@video2ctx/cli` npm package');
    expect(apiSkill).toContain('ask the user to approve its installation');
    expect(monitoringSkill).toContain('ask the user to approve its installation');
  });

  test('every explicitly documented hosted route exists in OpenAPI', () => {
    const paths = openApiDocument.paths as Record<string, Record<string, unknown>>;
    const operations = [
      ['get', '/v1/providers'],
      ['get', '/v1/usage'],
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
