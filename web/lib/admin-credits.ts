import { platformRequest } from './platform-request.ts';

export type CreditUser = { id: string; name: string; email: string; creditBalance: number };
export type CreditGrant = { id: string; userId: string; credits: number; reason: string; adminUserId: string; createdAt: number };
export type CreditAccount = { user: CreditUser; grants: CreditGrant[] };
export type CreditGrantInput = { userId: string; requestId: string; credits: number; reason: string };
export type CreditGrantResult = { user: CreditUser; grant: CreditGrant; replayed: boolean };

export function lookupCreditAccount(user: string, signal?: AbortSignal) {
  return platformRequest<CreditAccount>(`/v1/admin/credits?${new URLSearchParams({ user })}`, { cache: 'no-store', signal });
}
export function grantCredits(input: CreditGrantInput) {
  return platformRequest<CreditGrantResult>('/v1/admin/credits/grants', { method: 'POST', cache: 'no-store', body: JSON.stringify(input) });
}
