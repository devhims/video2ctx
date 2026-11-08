/** Publishing details for one short, written by the agent into <project>/publish.json. */
export interface PublishShort {
  id: string;
  title: string;
  /** May use {episode} (full episode link) and {moment} (episode link at this short's first cut). */
  description: string;
  hashtags?: string[];
  tags?: string[];
  /** Second of the short to use as the cover frame. */
  coverSec?: number;
  /** Video to link from the Short; defaults to the episode. */
  relatedVideo?: string;
  pinnedComment?: string;
  /** ISO 8601 time with offset, e.g. 2026-11-10T18:00:00+05:30. */
  publishAt?: string;
}

export interface PublishPlan {
  episodeUrl?: string;
  shorts: PublishShort[];
}

export interface KitIssue {
  short?: string;
  level: 'error' | 'warning';
  message: string;
}

/** Limits from YouTube's Data API reference and Help Center. */
export const LIMITS = {
  titleChars: 100,
  descriptionBytes: 5_000,
  tagsChars: 500,
  hashtagsIgnoredAbove: 60,
  hashtagsShownAboveTitle: 3,
  shortMaxSec: 180,
} as const;

const ANGLE = /[<>]/;
const HASHTAG = /^#[\p{L}\p{N}_]+$/u;

/** YouTube counts commas between tags, and quotes around tags that contain spaces. */
export function tagsLength(tags: string[]): number {
  return tags.reduce((total, tag) => total + tag.length + (/\s/.test(tag) ? 2 : 0), 0) + Math.max(0, tags.length - 1);
}

export function momentUrl(videoId: string, startMs: number): string {
  return `https://youtu.be/${videoId}?t=${Math.floor(startMs / 1_000)}`;
}

/** Fill {episode} and {moment}, then append hashtags on their own line. */
export function composeDescription(short: PublishShort, episodeUrl: string, moment: string): string {
  const body = short.description.replaceAll('{episode}', episodeUrl).replaceAll('{moment}', moment).trim();
  const hashtags = (short.hashtags ?? []).filter((tag) => !body.includes(tag));
  return hashtags.length ? `${body}\n\n${hashtags.join(' ')}` : body;
}

export function parsePublishPlan(value: unknown): PublishPlan {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as PublishPlan).shorts)) {
    throw new Error('publish.json needs a shorts array.');
  }
  const plan = value as PublishPlan;
  plan.shorts.forEach((short, index) => {
    if (typeof short?.id !== 'string' || typeof short.title !== 'string' || typeof short.description !== 'string') {
      throw new Error(`publish.json shorts[${index}] needs id, title, and description strings.`);
    }
  });
  return plan;
}

export interface ShortFacts {
  durationSec?: number;
  width?: number;
  height?: number;
}

/** Check one short's copy and file against YouTube's limits. */
export function checkShort(short: PublishShort, description: string, videoId: string, facts: ShortFacts): KitIssue[] {
  const issues: KitIssue[] = [];
  const add = (level: KitIssue['level'], message: string) => issues.push({ short: short.id, level, message });
  const title = short.title.trim();
  if (!title) add('error', 'Title is empty.');
  if ([...title].length > LIMITS.titleChars) add('error', `Title has ${[...title].length} characters; YouTube allows ${LIMITS.titleChars}.`);
  if (ANGLE.test(title)) add('error', 'Title contains < or >, which YouTube rejects.');
  const bytes = Buffer.byteLength(description, 'utf8');
  if (bytes > LIMITS.descriptionBytes) add('error', `Description is ${bytes} bytes; YouTube allows ${LIMITS.descriptionBytes}.`);
  if (ANGLE.test(description)) add('error', 'Description contains < or >, which YouTube rejects.');
  if (!description.includes(videoId)) add('warning', 'Description does not link the full episode; use {episode} or {moment}.');
  const hashtags = short.hashtags ?? [];
  const bad = hashtags.filter((tag) => !HASHTAG.test(tag));
  if (bad.length) add('error', `Hashtags must be # plus letters, digits, or _ with no spaces: ${bad.join(', ')}.`);
  const allHashtags = (`${title} ${description}`.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
  if (allHashtags > LIMITS.hashtagsIgnoredAbove) add('error', `${allHashtags} hashtags: above ${LIMITS.hashtagsIgnoredAbove}, YouTube ignores every one.`);
  else if (allHashtags > 5) add('warning', `${allHashtags} hashtags; YouTube shows at most ${LIMITS.hashtagsShownAboveTitle} above the title, so 3 to 5 is plenty.`);
  const tags = short.tags ?? [];
  if (tags.some((tag) => ANGLE.test(tag))) add('error', 'A tag contains < or >.');
  if (tagsLength(tags) > LIMITS.tagsChars) add('error', `Tags total ${tagsLength(tags)} characters; YouTube allows ${LIMITS.tagsChars}.`);
  if (short.publishAt !== undefined && (!/[zZ]|[+-]\d{2}:\d{2}$/.test(short.publishAt) || Number.isNaN(Date.parse(short.publishAt)))) {
    add('error', 'publishAt must be an ISO 8601 time with a time zone, e.g. 2026-11-10T18:00:00+05:30.');
  }
  if (facts.durationSec !== undefined && facts.durationSec > LIMITS.shortMaxSec) {
    add('error', `Video runs ${facts.durationSec.toFixed(1)}s; Shorts allow up to ${LIMITS.shortMaxSec}s.`);
  }
  if (facts.width !== undefined && facts.height !== undefined && facts.width > facts.height) {
    add('error', `Video is ${facts.width}x${facts.height}; Shorts must be vertical or square.`);
  }
  if (!short.pinnedComment) add('warning', 'No pinned comment; one that points to the full episode is a cheap extra path to it.');
  return issues;
}

/** A copy-paste sheet for YouTube Studio. */
export function publishSheet(short: PublishShort, description: string, related: string, cover: string, video: string): string {
  return [
    `# ${short.id}: ${short.title}`,
    '',
    `Video: ${video}`,
    `Cover frame: ${cover}`,
    short.publishAt ? `Schedule: ${short.publishAt}` : 'Schedule: not set',
    '',
    '## Title',
    '',
    short.title,
    '',
    '## Description',
    '',
    description,
    '',
    '## Tags',
    '',
    (short.tags ?? []).join(', ') || '(none)',
    '',
    '## Related video',
    '',
    related,
    '',
    '## Pinned comment',
    '',
    short.pinnedComment ?? '(none)',
    '',
  ].join('\n');
}
