import { Polar } from '@polar-sh/sdk';

export function polarClient(env: Env): Polar {
  return new Polar({
    accessToken: env.POLAR_ACCESS_TOKEN,
    server: String(env.POLAR_ENVIRONMENT) === 'sandbox' ? 'sandbox' : 'production',
  });
}
