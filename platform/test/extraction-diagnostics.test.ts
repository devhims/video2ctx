import { extractionFixture } from './fixtures/extraction-diagnostic';
import { extractionCapture, emitExtractionDiagnostic } from '../src/lib/extraction-diagnostics';



test('accepts useful fields but never keeps URLs, errors, messages, headers or prompts', () => {
  const secret = 'https://user:password@example.com/video?sig=SECRET';
  const capture = extractionCapture({ diagnostics: { version: 1, droppedEvents: 2, events: [
    { stage: 'ffmpeg_success', profile: 'ios', width: 640, height: 360, formatId: 18,
      error: { message: secret }, message: secret, url: secret, headers: { authorization: secret }, prompt: secret },
    { stage: secret }, { stage: 'player', profile: secret },
  ] } });
  expect(capture).toEqual({ capture: 'available', droppedEvents: 4,
    events: [{ stage: 'ffmpeg_success', profile: 'ios', width: 640, height: 360, formatId: 18 }] });
  expect(JSON.stringify(capture)).not.toContain('SECRET');
});

test('distinguishes old containers from invalid and excessive diagnostic envelopes', () => {
  expect(extractionCapture({ value: {} }).capture).toBe('missing');
  for (const diagnostics of [null, { version: 2 }, { version: 1, events: Array(65).fill({}), droppedEvents: 0 },
    { version: 1, events: [], droppedEvents: -1 }]) {
    expect(extractionCapture({ diagnostics })).toEqual({ capture: 'invalid', events: [], droppedEvents: 0 });
  }
});

test('a throwing sink cannot change extraction or trigger retries', () => {
  expect(() => emitExtractionDiagnostic(() => { throw new Error('private failure'); }, extractionFixture)).not.toThrow();
});
