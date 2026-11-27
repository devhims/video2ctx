import { describe, expect, test } from 'vitest';

import { checkShort, composeDescription, momentUrl, parsePublishPlan, tagsLength } from './kit';

const base = { id: 'S1', title: 'AI agents are like the Minions', description: 'Full conversation: {episode}\nThis moment: {moment}', hashtags: ['#AISafety', '#Shorts'], pinnedComment: 'Full episode: link' };

describe('composeDescription', () => {
  test('fills links and appends hashtags once', () => {
    const text = composeDescription(base, 'https://youtu.be/abcdefghijk', momentUrl('abcdefghijk', 684_880));
    expect(text).toBe('Full conversation: https://youtu.be/abcdefghijk\nThis moment: https://youtu.be/abcdefghijk?t=684\n\n#AISafety #Shorts');
    expect(composeDescription({ ...base, description: 'Watch #Shorts' }, '', '')).toBe('Watch #Shorts\n\n#AISafety');
  });
});

describe('checkShort', () => {
  const description = composeDescription(base, 'https://youtu.be/abcdefghijk', 'https://youtu.be/abcdefghijk?t=1');

  test('passes good copy on a vertical short', () => {
    expect(checkShort(base, description, 'abcdefghijk', { durationSec: 40, width: 1080, height: 1920 })).toEqual([]);
  });

  test('enforces YouTube limits', () => {
    const issues = checkShort(
      { ...base, title: `${'x'.repeat(101)}<`, hashtags: ['#bad tag'], tags: ['a'.repeat(501)], publishAt: '2026-11-10T18:00:00', pinnedComment: undefined },
      `${'é'.repeat(2_600)}>`,
      'abcdefghijk',
      { durationSec: 181, width: 1920, height: 1080 },
    );
    const messages = issues.map((issue) => `${issue.level}: ${issue.message}`).join('\n');
    expect(messages).toMatch(/error: Title has 102 characters/);
    expect(messages).toMatch(/error: Title contains < or >/);
    expect(messages).toMatch(/error: Description is 5201 bytes/);
    expect(messages).toMatch(/error: Hashtags must be/);
    expect(messages).toMatch(/error: Tags total 501/);
    expect(messages).toMatch(/error: publishAt must be/);
    expect(messages).toMatch(/error: Video runs 181.0s/);
    expect(messages).toMatch(/error: Video is 1920x1080/);
    expect(messages).toMatch(/warning: Description does not link the full episode/);
    expect(messages).toMatch(/warning: No pinned comment/);
  });
});

describe('helpers', () => {
  test('counts tags the way YouTube does', () => {
    expect(tagsLength(['Foo-Baz'])).toBe(7);
    expect(tagsLength(['Foo Baz'])).toBe(9);
    expect(tagsLength(['a', 'b'])).toBe(3);
  });

  test('rejects a plan without required fields', () => {
    expect(() => parsePublishPlan({ shorts: [{ id: 'S1', title: 'x' }] })).toThrow(/needs id, title, and description/);
  });
});
