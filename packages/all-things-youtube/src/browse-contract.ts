export const BROWSE_CATEGORIES = ['music', 'news', 'sports', 'live'] as const;
export const BROWSE_REGIONS = ['US', 'IN'] as const;
export const BROWSE_LANGUAGES = ['en', 'hi'] as const;

function supportedValue(
  value: string,
  supported: readonly string[],
  label: string
): string {
  if (supported.includes(value)) return value;
  throw new RangeError(`${label} must be one of: ${supported.join(', ')}.`);
}

export function normalizeBrowseCategory(value?: string): string | undefined {
  if (!value) return undefined;
  return supportedValue(value.trim().toLowerCase(), BROWSE_CATEGORIES, 'category');
}

export function normalizeBrowseRegion(value?: string): string {
  return supportedValue((value ?? 'US').trim().toUpperCase(), BROWSE_REGIONS, 'region');
}

export function normalizeBrowseLanguage(value?: string): string {
  return supportedValue((value ?? 'en').trim().toLowerCase(), BROWSE_LANGUAGES, 'language');
}
