'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useDashboardSession } from '../DashboardSessionProvider';
import { agentSessionListSchema, fetchAgentData, type AgentSessionList, type AgentAdmission } from '../../../lib/agent-sessions';

function createSessionCache() {
  const lists = new Map<string, { page: AgentSessionList; savedAt: number }>();
  const requests = new Map<string, Promise<AgentSessionList>>();
  const focus = new Map<string, string>();
  let generation = 0;
  const saveList = (query: string, page: AgentSessionList) => {
    lists.delete(query);
    lists.set(query, { page, savedAt: Date.now() });
    if (lists.size > 10) lists.delete(lists.keys().next().value!);
  };
  return {
    readList: (query: string) => lists.get(query)?.page,
    saveList,
    loadList(query: string, refresh = false): Promise<AgentSessionList> {
      const cached = lists.get(query);
      if (!refresh && cached && Date.now() - cached.savedAt < 30_000) return Promise.resolve(cached.page);
      const pending = requests.get(query);
      if (pending) return pending;
      const startedAtGeneration = generation;
      const request = fetchAgentData(`/sessions?${new URLSearchParams({ q: query, limit: '20' })}`, agentSessionListSchema, AbortSignal.timeout(15_000))
        .then(page => { if (generation === startedAtGeneration) saveList(query, page); return page; })
        .finally(() => { requests.delete(query); });
      requests.set(query, request);
      return request;
    },
    recordAdmission(receipt: AgentAdmission, message: string) {
      generation++;
      focus.set(receipt.sessionId, receipt.diagnostics.userMessageId);
      // Keep the default list useful immediately; other searches are refreshed on return.
      const previous = lists.get('')?.page;
      lists.clear();
      if (!previous) return;
      const existing = previous.sessions.find(row => row.sessionId === receipt.sessionId);
      const now = Date.now();
      const row = { sessionId: receipt.sessionId, title: existing?.title || message.slice(0, 160), latestMessagePreview: message,
        lastRunId: receipt.runId, runCount: (existing?.runCount ?? 0) + 1, createdAt: existing?.createdAt ?? now, updatedAt: now };
      saveList('', { ...previous, sessions: [row, ...previous.sessions.filter(item => item.sessionId !== row.sessionId)] });
      // Refresh the server-generated title next time while still showing the cached rows.
      lists.get('')!.savedAt = 0;
    },
    pendingFocus: (sessionId: string) => focus.get(sessionId),
    clearFocus: (sessionId: string) => { focus.delete(sessionId); },
  };
}

const SessionCache = createContext<ReturnType<typeof createSessionCache> | null>(null);

export function AgentSessionCacheProvider({ children }: { children: ReactNode }) {
  const { user, agentAccess } = useDashboardSession();
  // Memory only, discarded when the account/access changes or this workspace closes.
  const key = `${user?.id ?? 'signed-out'}:${agentAccess}`;
  const cache = useMemo(createSessionCache, [key]);
  return <SessionCache.Provider key={key} value={cache}>{children}</SessionCache.Provider>;
}

export function useAgentSessionCache() {
  const cache = useContext(SessionCache);
  if (!cache) throw new Error('Agent session cache is unavailable');
  return cache;
}
