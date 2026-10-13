import { answerCitationIds, mapCitationProse } from '../src/agents/markdown-citations';

it.each([
  '`[cite:literal]`',
  '``a ` [cite:literal]``',
  '``a\n[cite:literal]``',
  '```js\n[cite:literal]\n```',
  '~~~js\n[cite:literal]\n~~~',
  '    [cite:literal]',
  '> ```js\n> [cite:literal]\n> ```',
  '- Example:\n\n  ```js\n  [cite:literal]\n  ```',
  '```js\n[cite:literal]',
])('reads only prose citations and preserves code bytes: %s', code => {
  const text = `Before [cite:source].\n\n${code}`;
  expect(answerCitationIds(text)).toEqual(['source']);
  expect(mapCitationProse(text, prose => prose.replace(/\[cite:[^\]]+\]/g, '[source deleted]')))
    .toBe(`Before [source deleted].\n\n${code}`);
});

it('does not treat an escaped backtick as an unfinished streaming code span', () => {
  const text = 'Escaped \\` then [cite:source]';
  expect(mapCitationProse(text, prose => prose.replace('[cite:source]', ''), true))
    .toBe('Escaped \\` then ');
});
