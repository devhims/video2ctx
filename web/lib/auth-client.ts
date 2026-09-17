import { apiKeyClient } from '@better-auth/api-key/client';
import { polarClient } from '@polar-sh/better-auth/client';
import { createAuthClient } from 'better-auth/react';
import { adminClient, deviceAuthorizationClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [adminClient(), apiKeyClient(), deviceAuthorizationClient(), polarClient()],
});
