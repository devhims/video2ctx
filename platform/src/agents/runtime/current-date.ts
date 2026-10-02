// Run-scoped date context for model instructions. Models otherwise fall back to the
// year in their training data when a user says "today" or "this year".

export const DEFAULT_AGENT_TIME_ZONE = 'UTC';

/** True for an IANA zone the runtime recognizes, such as Asia/Kolkata. */
export function isValidTimeZone(value: string): boolean {
  if (!value || value.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimeZone(value: string | null | undefined): string {
  return value && isValidTimeZone(value) ? value : DEFAULT_AGENT_TIME_ZONE;
}

function isoDate(now: number, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * One trusted instruction line naming the run's date. Pass the run's admission time, not
 * Date.now(), so every phase and every recovery of a run agrees on what "today" means.
 * Only the date is included: it changes once a day, so it does not disturb prompt caching.
 */
export function currentDateGuidance(now: number, timeZone: string | null | undefined): string {
  const zone = normalizeTimeZone(timeZone);
  const long = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(now);
  const local = isoDate(now, zone);
  const utc = isoDate(now, 'UTC');
  const utcNote = zone === 'UTC' ? '' : local === utc ? ' The UTC date is the same.' : ` The UTC date is ${utc}.`;
  return `Current date: ${long} (${local}) in the user's time zone, ${zone}.${utcNote} `
    + 'Interpret today, yesterday, this week, this month, this year, last year and recent relative to this date. '
    + 'Your training data ends earlier; never assume the current date or year from it. YouTube publish dates are reported in UTC.';
}
