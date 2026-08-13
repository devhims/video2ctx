type PlatformBaseUrlOptions = {
  configuredBaseUrl?: string;
  nodeEnv?: string;
  requestHostname: string;
  demoUser?: string | null;
};

export function resolvePlatformBaseUrl({
  configuredBaseUrl,
  nodeEnv,
  requestHostname,
  demoUser,
}: PlatformBaseUrlOptions): string {
  const isLoopback = requestHostname === 'localhost' || requestHostname === '127.0.0.1';
  if (nodeEnv !== 'production' && isLoopback && demoUser) {
    return 'http://localhost:8787';
  }

  return configuredBaseUrl ??
    (nodeEnv === 'production' ? 'https://api.video2ctx.dev' : 'http://localhost:8787');
}
