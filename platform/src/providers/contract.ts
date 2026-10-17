import { TRENDS_ENABLED } from '../features';

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

// Advertised to API consumers; Trends stays internal until it is enabled.
export const PUBLIC_PROVIDER_CAPABILITIES: readonly ProviderCapability[] = PROVIDER_CAPABILITIES
  .filter((capability) => TRENDS_ENABLED || capability !== 'trends');

export interface ProviderDescriptor {
  id: ProviderId;
  name: string;
  capabilities: readonly ProviderCapability[];
}
