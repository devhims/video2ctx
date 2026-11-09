// An expression occupies one span in the request. Its component numbers are never separate grants.
export interface TimestampExpression {
  start: number;
  end: number;
  milliseconds: number;
  ambiguous: boolean;
}

const unitScale = new Map<string, number>();
for (const [scale, names] of [
  [3600000, ['hours', 'hour', 'hrs', 'hr', 'h']],
  [60000, ['minutes', 'minute', 'mins', 'min', 'm']],
  [1000, ['seconds', 'second', 'secs', 'sec', 's']],
  [1, ['milliseconds', 'millisecond', 'ms']],
] as const) {
  for (const name of names) unitScale.set(name, scale);
}
const component = String.raw`(\d+(?:\.\d+)?)\s*-?\s*(${[...unitScale.keys()].join('|')})(?![a-z])`;
const clock = String.raw`(?:\d+:)?\d{1,2}:\d{2}s?\b`;

export function timestampExpressions(input: string): TimestampExpression[] {
  const start = new RegExp(String.raw`(?<!\d:)\b(?:${clock}|${component})`, 'gi');
  const continuation = new RegExp(String.raw`(\s*(?:,\s*)?(?:and\s+)?)(?:${component})`, 'iy');
  const result: TimestampExpression[] = [];
  for (let first = start.exec(input); first; first = start.exec(input)) {
    let milliseconds: number;
    let ambiguous = false;
    if (!first[1]) {
      const fields = first[0].replace(/s$/i, '').split(':').map(Number);
      milliseconds = fields.reduce((seconds, field) => seconds * 60 + field, 0) * 1000;
    } else {
      let scale = unitScale.get(first[2]!.toLowerCase())!;
      milliseconds = Number(first[1]) * scale;
      for (;;) {
        continuation.lastIndex = start.lastIndex;
        const next = continuation.exec(input);
        if (!next) break;
        const nextScale = unitScale.get(next[3]!.toLowerCase())!;
        // "30 seconds and 45 seconds" lists two positions. Descending units form one
        // position. A comma between descending units could also introduce a list.
        if (nextScale >= scale && /,|and/i.test(next[1]!)) break;
        ambiguous ||= nextScale >= scale || next[1]!.includes(',');
        milliseconds += Number(next[2]) * nextScale;
        scale = nextScale;
        start.lastIndex = continuation.lastIndex;
      }
    }
    milliseconds = Math.round(milliseconds);
    result.push({ start: first.index, end: start.lastIndex, milliseconds,
      ambiguous: ambiguous || !Number.isSafeInteger(milliseconds) });
  }
  return result;
}

/** URL seek values also allow bare seconds. The entire parameter must be a single timestamp. */
export function seekMilliseconds(value: string): number | undefined {
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const time = Math.round(Number(value) * 1000);
    return Number.isSafeInteger(time) ? time : undefined;
  }
  // A seek parameter uses compact h/m/s or a clock. Prose-only forms have no URL meaning.
  if (!/^(?:(?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?|(?:\d+:)?\d{1,2}:\d{2})$/i.test(value)) return;
  const [time] = timestampExpressions(value);
  if (time?.start === 0 && time.end === value.length && !time.ambiguous) return time.milliseconds;
}
