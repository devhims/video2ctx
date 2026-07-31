export type Plan = 'free' | 'pro';

export interface AppUser {
  id: string;
  email: string;
  name: string;
}

export interface AppVariables {
  user: AppUser | null;
  requestId: string;
}

export interface ImportPayload {
  jobId: string;
  userId: string;
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
  type: 'magic-link' | 'daily-digest' | 'weekly-digest';
  idempotencyKey: string;
  userId?: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  unsubscribeUrl?: string;
}
