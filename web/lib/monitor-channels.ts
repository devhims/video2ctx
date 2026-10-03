export type MonitorChannel = { id: string; name: string; handle?: string };
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
type Request = (path: string, options?: RequestInit) => Promise<unknown>;

export async function findMonitorChannels(input: string, request: Request, signal?: AbortSignal): Promise<MonitorChannel[]> {
  const value = input.trim();
  if (!value) return [];
  let id = value.startsWith('@') || CHANNEL_ID.test(value) ? value : undefined;
  if (/^(https?:\/\/|(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\/)/i.test(value)) {
    const url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const resolved = await request('/v1/resolve', { method: 'POST', body: JSON.stringify({ input: url }), signal }) as { kind: string; id?: string };
    if (resolved.kind !== 'channel' || !resolved.id) throw new Error('Enter a channel URL or @handle, rather than a video or playlist.');
    id = resolved.id;
  }
  if (id) {
    const channel = await request(`/v1/channels/${encodeURIComponent(id)}?provider=youtube`, { signal }) as MonitorChannel;
    if (!CHANNEL_ID.test(channel.id)) throw new Error('Could not resolve this channel. Try its YouTube channel URL.');
    return [{ id: channel.id, name: channel.name || channel.id, handle: channel.handle }];
  }
  const query = new URLSearchParams({ q: value, type: 'channel' });
  const response = await request(`/v1/search?provider=youtube&${query}`, { signal }) as {
    results: Array<{ type: string; id: string; name?: string; title?: string; handle?: string }>;
  };
  return response.results.filter(item => item.type === 'channel' && CHANNEL_ID.test(item.id))
    .filter((item, index, items) => items.findIndex(other => other.id === item.id) === index)
    .map(item => ({ id: item.id, name: item.name || item.title || item.id, handle: item.handle }));
}
