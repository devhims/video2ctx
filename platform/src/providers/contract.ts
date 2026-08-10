export const PROVIDER_IDS = ['youtube'] as const;

export type ProviderId = typeof PROVIDER_IDS[number];

export const PROVIDER_CAPABILITIES = [
  'search',
  'browse',
  'trends',
  'video',
  'tracks',
  'transcript',
  'comments',
  'endscreen',
  'channel',
  'playlist',
] as const;

export type ProviderCapability = typeof PROVIDER_CAPABILITIES[number];

export interface ProviderDescriptor {
  id: ProviderId;
  name: string;
  capabilities: readonly ProviderCapability[];
}
