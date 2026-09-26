const smallNumbers: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const scales: Record<string, number> = { thousand: 1_000, million: 1_000_000, billion: 1_000_000_000 };
const digits = /(?<![\p{L}\p{N}.,+-])([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?:\s*(thousand|million|billion)(?!\p{L}))?(?!\d|\.\d|,\d)/gu;
const ones = 'one|two|three|four|five|six|seven|eight|nine';
const teens = 'zero|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen';
const tens = 'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety';
const underHundred = `(?:${tens})(?:[ -](?:${ones}))?|${teens}|${ones}`;
const underThousand = new RegExp(`^(?:(?:${ones}) hundred(?: (?:and )?(?:${underHundred}))?|${underHundred})$`, 'u');
const wordToken = `${Object.keys(smallNumbers).join('|')}|hundred|thousand|million|billion|and|minus|negative`;
const words = new RegExp(`(?<![\\p{L}\\p{N}-])(?:${wordToken})(?:[ -](?:${wordToken}))*(?![\\p{L}\\p{N}-])`, 'gu');

function wordValue(phrase: string): number {
  const tokens = phrase.replaceAll('-', ' ').split(' ');
  let sign = 1;
  if (['minus', 'negative'].includes(tokens[0]!)) { tokens.shift(); sign = -1; }
  let total = 0, start = 0, previousScale = Infinity;
  const groupValue = (group: string[]) => {
    if (total && group[0] === 'and') group = group.slice(1);
    if (!underThousand.test(group.join(' '))) return NaN;
    return group.reduce((value, word) => word === 'hundred' ? value * 100 : word === 'and' ? value : value + smallNumbers[word]!, 0);
  };
  for (let index = 0; index < tokens.length; index++) {
    const scale = scales[tokens[index]!];
    if (!scale) continue;
    const value = groupValue(tokens.slice(start, index));
    if (!value || scale >= previousScale) return NaN;
    total += value * scale;
    previousScale = scale;
    start = index + 1;
  }
  const remainder = start === tokens.length ? 0 : groupValue(tokens.slice(start));
  return (total + remainder) * sign;
}

/** Recognize equivalent source notation, never calculate conversions or repair ASR decimals. */
export function sourceNumbers(text: string): number[] {
  return [
    ...[...text.matchAll(digits)].map(([, value, scale]) => Number(value!.replaceAll(',', '')) * (scales[scale!] ?? 1)),
    ...[...text.matchAll(words)].map(([phrase]) => wordValue(phrase)),
  ].filter(value => Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)));
}
