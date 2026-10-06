import type { loadLandingInspection } from '../../src/lib/landing-inspection';
const image = 'data:image/png;base64,aGVsbG8=';
const meta = { source: 'allthingsyoutube' as const, fetchedAt: '2020-01-01T00:00:00Z', partial: false, warnings: [] };
export function inspection(videoId = 'bAX27XRHMH8'): Awaited<ReturnType<typeof loadLandingInspection>> {
  return {
    video: {
      type: 'video', id: videoId, title: 'Sample video', channel: { id: 'channel', name: 'Channel', url: 'https://youtube.com/@channel' },
      thumbnails: [{ url: image, width: 640, height: 360 }], isLive: false,
      url: `https://www.youtube.com/watch?v=${videoId}`, keywords: [], availability: { status: 'OK', playable: true }, meta,
    },
    channel: { status: 'ready', channel: {
      type: 'channel', id: 'channel', name: 'Channel', url: 'https://youtube.com/@channel', thumbnails: [{ url: image }], meta,
      about: { description: 'Sample channel', links: [], moreInfo: { canonicalChannelUrl: 'https://youtube.com/@channel', businessEmailAvailable: false } },
    } },
    transcript: { status: 'ready', track: { id: 'en', name: 'English', languageCode: 'en', kind: 'manual', isTranslatable: true, isDefault: true },
      segmentCount: 1, segments: [{ startMs: 0, endMs: 1000, durationMs: 1000, text: 'Sample transcript' }] },
    comments: { status: 'ready', totalCount: 1, comments: [{ id: 'comment', text: 'Sample comment', author: { name: 'Viewer', thumbnails: [{ url: image }] }, isPinned: false, isHearted: false, replies: [] }] },
    partial: false,
  };
}
