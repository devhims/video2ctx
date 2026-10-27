/** Citation markers may split an exact quotation at original caption boundaries.
 * Join only adjacent quoted fragments separated by whitespace/citations, never commentary. */
export function quotedPassages(answer: string): string[] {
  const quotes = (text: string) => [...text.matchAll(/[“"]([^”"]+)[”"]/g)].map(match => match[1]!);
  const passages = quotes(answer);
  for (const match of answer.matchAll(/[“"][^”"]+[”"](?:\s*(?:\[cite:[^\]]+\]\s*)*[“"][^”"]+[”"])+/g)) {
    passages.push(quotes(match[0]).join(' '));
  }
  return passages;
}
