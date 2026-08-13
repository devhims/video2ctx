import type { createAuth } from './lib/auth';
import type { ProviderId } from './providers/contract';

export type Plan = 'free' | 'pro';

export interface AppUser {
  id: string;
  email: string;
  name: string;
}

export type AuthenticationMethod = 'session' | 'api-key' | 'demo';

export interface AuthPrincipal {
  user: AppUser;
  method: AuthenticationMethod;
  apiKeyId?: string;
  permissions: Record<string, string[]>;
}

export interface AppVariables {
  auth?: ReturnType<typeof createAuth>;
  principal: AuthPrincipal | null;
  user: AppUser | null;
  requestId: string;
}

export type App = { Bindings: Env; Variables: AppVariables };

export interface ImportPayload {
  jobId: string;
  userId: string;
  provider: ProviderId;
  kind: 'video' | 'channel' | 'playlist' | 'comments' | 'deep-comments';
  entityId: string;
  projectId?: string;
  idempotencyKey: string;
}

export interface MonitorPayload {
  monitorId?: string;
  userId?: string;
  scheduledAt: number;
}

export interface TaskMessage {
  type: 'index-document' | 'snapshot-statistics' | 'delete-user-search';
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface EmailMessage {
  type: 'magic-link' | 'notification-opt-in' | 'monitor-alert' | 'daily-digest' | 'weekly-digest';
  idempotencyKey: string;
  userId?: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  unsubscribeUrl?: string;
}
