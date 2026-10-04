import { canonicalJson } from './canonical-json';

/** Only response-envelope fields may differ from an immutable source payload. */
export function projectSessionPayload(source: unknown, value: unknown,
  envelopeFields: readonly string[] = ['meta', 'freshness', 'selection', 'failures'],
): { overrides: Record<string, unknown>; omitted: string[] } | undefined {
  if (!source || !value || typeof source !== 'object' || typeof value !== 'object'
    || Array.isArray(source) || Array.isArray(value)) return;
  const a = source as Record<string, unknown>, b = value as Record<string, unknown>;
  const overrides: Record<string, unknown> = {}, omitted: string[] = [];
  for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (canonicalJson(a[field]) === canonicalJson(b[field])) continue;
    if (!envelopeFields.includes(field)) return;
    if (b[field] === undefined) omitted.push(field);
    else overrides[field] = b[field];
  }
  // Keep source arrays and images out of Durable Object SQLite.
  if (JSON.stringify(overrides).length > 32_000) return;
  return { overrides, omitted };
}
