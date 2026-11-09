import { describe, expect, it } from 'vitest';
import { seekMilliseconds, timestampExpressions } from '../src/agents/research/timestamp-expression';
import { frameRequestIssue, readFrameRequest } from '../src/agents/research/frame-request';

describe('frame timestamp expressions', () => {
  it('reads equivalent clocks, quantities, and seek values as one complete position', () => {
    for (const hours of [1, 2, 12]) for (const minutes of [0, 1, 30, 59]) for (const seconds of [0, 5, 59]) {
      const expected = ((hours * 60 + minutes) * 60 + seconds) * 1000;
      for (const expression of [
        `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`,
        `${hours}h${minutes}m${seconds}s`,
        `${hours} hours ${minutes} minutes and ${seconds} seconds`,
        `${hours * 60 + minutes} minutes ${seconds} seconds`,
      ]) {
        const prefix = 'Inspect at ';
        expect(timestampExpressions(prefix + expression + '.')).toEqual([
          { start: prefix.length, end: prefix.length + expression.length, milliseconds: expected, ambiguous: false },
        ]);
        if (!expression.includes(' ')) expect(seekMilliseconds(expression)).toBe(expected);
      }
    }
  });

  it.each([
    ['at 1 hour and at 30 minutes', [3600000, 1800000]],
    ['at 1 hour 30 minutes and at 1 hour 45 minutes', [5400000, 6300000]],
    ['at 30 seconds and 45 seconds', [30000, 45000]],
    ['at 1.5 hours and at 250 ms', [5400000, 250]],
  ] as const)('preserves separately specified positions in "%s"', (message, positions) => {
    expect(timestampExpressions(message).map(time => time.milliseconds)).toEqual(positions);
  });

  it('asks for clarification before granting a comma-separated quantity with two readings', () => {
    const request = readFrameRequest('Capture at 1 hour, 30 minutes.');
    for (const times of [[5400000], [1800000, 3600000]]) {
      expect(frameRequestIssue({ route: 'inspect_video', frameAccess: [{ videoId: 'abcdefghijk',
        savedTimestampsMs: [], captureTimestampsMs: times }] }, request)).toContain('unambiguous timestamp');
    }
  });

  it('keeps an unread exact-time instruction closed for both finite and delegated grants', () => {
    const request = readFrameRequest('Capture only the frame at half past the first hour.');
    const plan = { route: 'inspect_video' };
    expect(frameRequestIssue({ ...plan, frameAccess: 'agent_selected' }, request)).toContain('unambiguous timestamp');
    expect(frameRequestIssue({ ...plan, frameAccess: [{ savedTimestampsMs: [], captureTimestampsMs: [30000] }] }, request))
      .toContain('unambiguous timestamp');
  });

  it('keeps a compound source duration out of image permissions', () => {
    expect(readFrameRequest('Find a 1 hour 30 minute lecture and capture only at 1 minute 10 seconds.').positions)
      .toEqual([{ role: 'capture', time: 70000, videoIds: [] }]);
  });
});
