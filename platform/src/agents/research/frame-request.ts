import type { RouteFrameAccess } from '../contracts';
import { clockTime } from '../runtime/clock-time';
import { extractYouTubeVideoIds, linkedSeek, urlCandidates } from './youtube-references';
import type { SessionBrief } from '../runtime/session-evidence';

const UNIT_MS: ReadonlyArray<[RegExp, number]> = [[/^(?:ms|milliseconds?)$/i, 1], [/^(?:s|secs?|seconds?)$/i, 1_000],
  [/^(?:m|mins?|minutes?)$/i, 60_000], [/^(?:h|hrs?|hours?)$/i, 3_600_000]];
const unitMs = (unit: string) => UNIT_MS.find(([pattern]) => pattern.test(unit))?.[1] ?? 0;
const CLOCK_TIME = /\b(?:(\d+):)?(\d{1,2}):(\d{2})(?:s)?\b/gi;
const TIME_QUANTITY = /(?<!\d:)\b(\d+(?:\.\d+)?)\s*-?\s*(milliseconds?|ms|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])(?:\s*(?:and\s*)?(\d+(?:\.\d+)?)\s*(seconds?|secs?|s)\b)?/gi;

// A comparison such as "within" or "at most" can limit either video length or capture position.
// Exclude a time when the surrounding words describe duration ("videos under 5 minutes", "5 minutes long").
const COMPARISON = /\b(?:under|over|within|up to|at (?:least|most)|(?:no )?(?:longer|shorter|less|more) than)\s*$/i;
const DURATION_SUBJECT = /\b(?:duration|length|runtime)(?:\s+(?:of|is|must be|should be))?\s*$/i;
const SOURCE_SELECTION = /\b(?:find|search|recommend|list|videos?|clips?|tutorials?|lectures?|recordings?|episodes?)\b/i;
const FRAME_ACTION = /\b(?:frames?|stills?|timestamps?|capture|capturing|inspect|sample|extract)\b/i;
const VIDEO_LENGTH_SUFFIX = /^\s*-?\s*(?:long|in (?:length|duration)|videos?|clips?|lectures?|tutorials?|recordings?|episodes?|of (?:content|footage|material)|ads?|intros?|segments?|versions?|cuts?|shorts?|views?)\b/i;
const START_WINDOW = /\b(?:within(?: the first)?|up to|no later than|in the first|during the first)\s*$/i;
const START_ANCHOR = /^\s+(?:of|from)\s+(?:the\s+)?(?:(?:video|clip)(?:'s|’s)\s+)?(?:start|beginning)\b/i;
const RELATIVE_ANCHOR = /^\s+(?:of|from|after|before)\b/i;

function isVideoLength(before: string, after: string): boolean {
  if (VIDEO_LENGTH_SUFFIX.test(after)) return true;
  // An article plus a time quantity modifying a noun describes its length ("a 2-hour documentary").
  if (/\b(?:a|an)\s*$/i.test(before) && !FRAME_ACTION.test(before.split(CLAUSE).at(-1) ?? '')
    && /^\s+(?!(?:mark|position|frame|image|picture|still|timestamp|screenshot)\b)[a-z]/i.test(after)) return true;
  const comparison = COMPARISON.exec(before);
  if (!comparison) return false;
  const subject = before.slice(0, comparison.index);
  if (DURATION_SUBJECT.test(subject)) return true;
  if (!START_WINDOW.test(before) && /\b(?:video|clip|tutorial|lecture|recording|episode)s?\s*$/i.test(subject)) return true;
  const clause = subject.split(/[.!?;,\n]|\b(?:and|but|then)\b/i).at(-1) ?? '';
  return SOURCE_SELECTION.test(clause) && !FRAME_ACTION.test(clause);
}

// A list continues the preceding operation ("capture 0:30, 0:45 and 1:00").
// A new clause can change it ("reuse 0:30, then capture 1:00").
const CLAUSE = /[:;.!?]\s+|\n|(?:,\s*|\b(?:then|and|but)\s+)(?!https?:\/\/|at\b)(?=[a-z])|\b(?:with|versus|vs\.?)\s+(?=(?:(?:a|an|the)\s+)?(?:new|fresh|saved|previous|prior)\b)/i;
function positionRole(clause: string, after: string) {
  if (/\b(?:no|not|never|without|don['’]t|except|instead of|rather than|exclude|ignore|skip)\b/i.test(clause)) return 'excluded';
  if (/\bstoryboards?\b/i.test(clause) || /^\s+storyboard sheet\b/i.test(after)) return 'sheet';
  if (/\b(?:re-?capture|capture|refresh|(?:new|fresh) (?:image|still|frame))\b/i.test(clause)
    || (/\b(?:new|fresh)\s*$/i.test(clause) && /^\s+(?:image|still|frame)\b/i.test(after))) return 'capture';
  if (/\b(?:transcript|caption|comment)s?\b/i.test(clause)) return;
  if (/\b(?:reuse|re-?inspect|saved)\b/i.test(clause) || /^\s+saved (?:frame|image)\b/i.test(after)) return 'saved';
}

// The classifier resolves the subject. The user's named positions bound what the classifier may grant.
export function readFrameRequest(message: string) {
  const positions: { time: number; role: ReturnType<typeof positionRole>; videoIds: string[] }[] = [];
  let captureEndMs: number | undefined;
  const urls = [...message.matchAll(urlCandidates)];
  function addProseTime(match: RegExpExecArray, time: number) {
    if (urls.some(url => match.index >= url.index && match.index < url.index + url[0].length)) return;
    const before = message.slice(0, match.index);
    const after = message.slice(match.index + match[0].length);
    const fromStart = START_ANCHOR.test(after);
    if (!fromStart && isVideoLength(before, after)) return;
    // A window end limits new captures. It does not request inspection of a saved frame at the endpoint.
    if (START_WINDOW.test(before) && (fromStart || !RELATIVE_ANCHOR.test(after) || /\bthe first\s*$/i.test(before))) {
      captureEndMs = Math.min(captureEndMs ?? time, time);
    } else {
      const prefix = before.split(CLAUSE).at(-1) ?? '';
      const suffix = after.split(CLAUSE, 1)[0] ?? '';
      const role = positionRole(prefix, suffix);
      if (/\b(?:previous|prior|earlier|last) (?:answer|response|turn|message)\b/i.test(prefix)
        && (!role || /\b(?:described|mentioned|cited|showed|reported)\b/i.test(prefix))) return;
      const clause = prefix + match[0] + suffix;
      const subjects = extractYouTubeVideoIds(clause);
      // Multiple timed operands have separate subjects. One time followed by two links applies to both.
      const operand = /\s+(?:and|with|versus|vs\.?|to)\s+|,\s*/i;
      const separate = subjects.length > 1 && clause.split(operand).filter(part =>
        [...part.matchAll(CLOCK_TIME), ...part.matchAll(TIME_QUANTITY)].length).length > 1;
      const localSubjects = separate ? extractYouTubeVideoIds((prefix.split(operand).at(-1) ?? '') + match[0] + suffix.split(operand)[0]) : subjects;
      positions.push({ time, role, videoIds: localSubjects.length ? localSubjects : subjects });
    }
  }
  for (const match of message.matchAll(CLOCK_TIME)) {
    const [, hours, minutes, seconds] = match;
    addProseTime(match, ((Number(hours ?? 0) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1_000);
  }
  for (const match of message.matchAll(TIME_QUANTITY)) {
    const [, amount, unit, extra] = match;
    addProseTime(match, Math.round(Number(amount) * unitMs(unit!) + Number(extra ?? 0) * 1_000));
  }
  for (const match of message.matchAll(/\b(?:opening|first) (?:exact )?(?:frame|still|image)\b/gi)) addProseTime(match, 0);
  // An unspecified interval has no safe numeric end. Ask for it before retrieving images.
  const vagueWindow = /\b(?:first|last|opening|final) (?:[a-z]+(?:[- ](?:of|[a-z]+))?) (?:seconds?|minutes?|frames?)\b|\b(?:last|closing|final) (?:frame|still)\b/i.test(message);
  // An explicit position or window in the request takes precedence over the link's seek time.
  if (!positions.length && captureEndMs === undefined) {
    for (const url of urls) {
      const seek = linkedSeek(url[0]);
      if (!seek) continue;
      const prefix = message.slice(0, url.index).split(CLAUSE).at(-1) ?? '';
      const suffix = message.slice(url.index + url[0].length).split(CLAUSE, 1)[0] ?? '';
      positions.push({ ...seek, role: positionRole(prefix, suffix) });
    }
  }
  const noRecapture = /\b(?:without|never|do not|don['’]t)\s+re-?captur(?:e|ing)\b/i.test(message);
  const noCapture = /\b(?:never|do not|don['’]t)\s+capture\s+(?:any\s+)?(?:new |exact )?(?:frames?|images?|stills?)\b/i.test(message);
  const sheetTimes = positions.every(position => position.role === 'sheet') && captureEndMs === undefined
    ? [...new Set(positions.map(position => position.time))] : [];
  const refreshSheets = message.split(CLAUSE).some(clause =>
    /\b(?:refresh|reload|re-?fetch|fresh)\s+(?:(?:only|just|the|these|both|saved|video)\s+)*storyboards?\b|\bstoryboard(?:-only)?\s+refresh\b/i.test(clause)
    && !/\b(?:not|never|without|don['’]t)\s+(?:refresh|reload|re-?fetch)\b/i.test(clause));
  const requestsSaved = positions.some(pos => pos.role === 'saved') || /\b(?:reuse|re-?inspect|inspect|analy[sz]e)\s+(?:the |my |our |that )?saved (?:video |exact )?(?:frames?|images?|stills?)\b/i.test(message);
  return { positions, requestsSaved, refreshSheets, sheetTimes, captureEndMs, noRecapture, noCapture, vagueWindow };
}

export type FrameRequest = ReturnType<typeof readFrameRequest>;
interface FramePlan {
  route: string;
  videoId?: string;
  comparisonVideoIds?: string[];
  frameAccess?: RouteFrameAccess;
  savedOnly?: boolean;
  timestampedFrameQuestion?: string;
  refreshFramesOnly?: boolean;
  visualEvidence?: string;
  setAsideFrames?: { videoId: string; timestampMs: number }[];
}

/** Bind each sheet position to the named subjects before the model can call the provider. */
export function requestedSheets(plan: FramePlan, request: FrameRequest) {
  if (!request.sheetTimes.length || request.sheetTimes.length > 24) return;
  const subjects = plan.route === 'inspect_video' && plan.videoId ? [plan.videoId] : plan.comparisonVideoIds ?? [];
  if (!subjects.length || request.positions.some(pos => pos.videoIds.some(id => !subjects.includes(id)))) return;
  return subjects.flatMap(videoId => {
    const times = request.positions.filter(pos => !pos.videoIds.length || pos.videoIds.includes(videoId)).map(pos => pos.time);
    return times.length ? [{ videoId, timestampsMs: [...new Set(times)] }] : [];
  });
}

/** Bound the classifier's grant to operations named in the request, including on resume. */
export function frameRequestIssue(plan: FramePlan, request: FrameRequest, assets: SessionBrief['assets'] = [], resumed = false): string | undefined {
  const access = plan.frameAccess;
  const { positions, captureEndMs, noRecapture, noCapture } = request;
  const limited = positions.length > 0 || captureEndMs !== undefined || noRecapture || noCapture;
  const sameSubject = (ids: string[], videoId?: string) => !ids.length || (videoId !== undefined && ids.includes(videoId));
  const targetedSheets = requestedSheets(plan, request);
  if (request.vagueWindow && access && !(Array.isArray(access) && access.every(entry => !entry.captureTimestampsMs.length)))
    return 'Ask for the exact capture interval before retrieving images.';
  if (plan.visualEvidence === 'required' && !plan.savedOnly && (!access || (Array.isArray(access)
    && !access.some(entry => entry.savedTimestampsMs.length || entry.captureTimestampsMs.length))))
    return 'Required visual evidence needs capture permission or a saved inspection in frameAccess. Select permitted new images or specify the saved inspection.';
  if (access && typeof access === 'object' && !Array.isArray(access)) {
    // A previously persisted targeted sheet cannot widen during recovery.
    const actual = 'storyboardSelections' in access ? access.storyboardSelections
      : plan.route === 'inspect_video' ? [{ videoId: plan.videoId, timestampsMs: access.storyboardTimestampsMs }] : [];
    if (!targetedSheets || actual.length !== targetedSheets.length || targetedSheets.some(expected => {
      const times = actual.find(item => item.videoId === expected.videoId)?.timestampsMs;
      return !times || times.length !== expected.timestampsMs.length || expected.timestampsMs.some(time => !times.includes(time));
    })) return 'Clarify the requested storyboard sheet positions.';
    return;
  }

  const captures = positions.filter(position => position.role === 'capture');
  const matches = (time: number, videoId?: string) => positions.filter(pos => pos.time === time && sameSubject(pos.videoIds, videoId));
  if (request.refreshSheets && !captures.length && !positions.some(pos => pos.role === 'saved') && access !== 'storyboard_only')
    return 'Refresh the requested storyboard sheets with storyboard_only access.';
  if (Array.isArray(access)) {
    for (const entry of access) {
      for (const time of entry.captureTimestampsMs) {
        const named = matches(time, entry.videoId);
        if (captureEndMs !== undefined && time > captureEndMs)
          return `Select capture positions within the requested window ending at ${captureEndMs} ms.`;
        const explicit = named.find(pos => pos.role === 'capture');
        const inRequestedRange = captureEndMs !== undefined || !positions.length || named.length > 0;
        const authorized = captures.length ? !!explicit : inRequestedRange;
        const stored = assets.some(asset => asset.kind === 'frame' && asset.videoId === entry.videoId && asset.details.timestampMs === time);
        // Two videos may share a timestamp. An explicit capture on B can coexist with a saved inspection on A.
        const savedHere = named.some(pos => pos.role === 'saved') && (!explicit || (stored && !explicit.videoIds.length));
        const forbidden = noCapture || savedHere || named.some(pos => pos.role === 'excluded' || pos.role === 'sheet');
        if (!authorized || forbidden || (noRecapture && !explicit && (stored || captureEndMs === undefined)))
          return `The user did not authorize a new exact capture at ${clockTime(time)} on this video. List only the authorized capture positions.`;
      }
    }
    for (const pos of captures) {
      if (!access.some(entry => sameSubject(pos.videoIds, entry.videoId) && entry.captureTimestampsMs.includes(pos.time)))
        return `Include the requested new capture at ${clockTime(pos.time)} on its video.`;
    }
  } else {
    if (access === 'storyboard_only' && (!plan.refreshFramesOnly || request.refreshSheets) && (targetedSheets || (!positions.length && captureEndMs === undefined && !noRecapture))) return;
    if (!plan.savedOnly && (plan.timestampedFrameQuestion || (access && limited)))
      return 'The user fixed the frame positions. List the saved inspection positions and the permitted capture positions in frameAccess, one entry per video.';
    if (plan.refreshFramesOnly && access !== 'agent_selected') return 'A frame refresh needs capture permission. List the positions in frameAccess, or set agent_selected if the user left them to you.';
  }

  // Classification can set aside named inventory from an unrelated video. That choice
  // has already been validated and is not part of the persisted execution grant.
  if (!access && !plan.refreshFramesOnly && !plan.timestampedFrameQuestion && plan.visualEvidence === 'none') return;
  if (!resumed) {
    for (const asset of assets) {
      const time = asset.details.timestampMs;
      if (asset.kind !== 'frame' || typeof time !== 'number' || !positions.some(pos => pos.time === time)) continue;
      const entry = Array.isArray(access) && access.find(entry => entry.videoId === asset.videoId);
      if (entry && (entry.savedTimestampsMs.includes(time) || entry.captureTimestampsMs.includes(time))) continue;
      if (plan.setAsideFrames?.some(frame => frame.videoId === asset.videoId && frame.timestampMs === time)) continue;
      return `The session holds a saved ${clockTime(time)} frame of ${asset.videoId}. Include its requested operation in frameAccess, or in setAsideFrames if the user excluded it or meant another video.`;
    }
  }
  for (const pos of positions.filter(pos => pos.role === 'saved')) {
    if (!Array.isArray(access) || !access.some(entry => sameSubject(pos.videoIds, entry.videoId) && entry.savedTimestampsMs.includes(pos.time)))
      return `List the requested saved ${clockTime(pos.time)} inspection even if its image is unavailable.`;
  }
}
