import type { AuthPrincipal } from '../types';

export const DEFAULT_API_KEY_PERMISSIONS = {
  data: ['read'],
  account: ['access'],
} as const;

export function hasApiKeyPermission(
  principal: AuthPrincipal,
  resource: keyof typeof DEFAULT_API_KEY_PERMISSIONS,
  action: string,
): boolean {
  return principal.permissions[resource]?.includes(action) === true;
}
