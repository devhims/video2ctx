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
const apiCli = readFileSync(
  new URL('../../.agents/skills/video2ctx-api/scripts/video2ctx.mjs', import.meta.url),
);
const monitoringCli = readFileSync(
  new URL('../../.agents/skills/video2ctx-monitoring/scripts/video2ctx.mjs', import.meta.url),
);

describe('hosted video2ctx skills', () => {
  test.each([
    ['video2ctx-api', apiSkill],
    ['video2ctx-monitoring', monitoringSkill],
  ])('%s stays on the authenticated production surface', (_name, skill) => {
    expect(skill).toContain('https://api.video2ctx.dev');
    expect(skill).toContain('scripts/video2ctx.mjs');
    expect(skill).toContain('auth login');
    expect(skill).toContain('auth status --json');
    expect(skill).toContain('video2ctx.mjs api');
    expect(skill).toContain('VIDEO2CTX_API_KEY');
    expect(skill).toContain('https://api.video2ctx.dev/openapi.json');
    expect(skill).not.toMatch(/all-things-youtube|youtubei\.googleapis\.com|www\.youtube\.com/);
    expect(skill).not.toMatch(/npm (?:install|add)|npx /);
    expect(skill).not.toMatch(/fetch\(|curl |Authorization: Bearer \$VIDEO2CTX_API_KEY/);
  });

  test('selector metadata distinguishes direct, hosted, and monitoring use', () => {
    expect(directSkill).toMatch(/^---\nname: youtube-direct\n/);
    expect(directSkill).toContain('Direct, no-account YouTube search and extraction');
    expect(directSkill).toContain('use video2ctx-api instead');

    expect(apiSkill).toContain('Managed, authenticated YouTube search and extraction');
    expect(apiSkill).toContain('Use instead of youtube-direct');

    expect(monitoringSkill).toContain('Stateful video2ctx monitoring');
    expect(monitoringSkill).toContain('Use video2ctx-api for one-time hosted reads');
  });

  test('ships the same self-contained credential transport in both hosted skills', () => {
    expect(apiCli.byteLength).toBeGreaterThan(1_000);
    expect(apiCli.equals(monitoringCli)).toBe(true);
    expect(apiCli.toString('utf8')).toContain('video2ctx auth login');
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
