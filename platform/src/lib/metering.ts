import type { Context } from 'hono';
import type { App } from '../types';
import { ApiError } from './http';
import { creditBalance, releaseCredits, reserveCredits, settleCredits } from './entitlements';
import { requirePrincipal } from '../middlewares/authentication';

export const CREDIT_COSTS = {
  free: 0,
  privateSearch: 3,
  deterministicTrends: 15,
  aiTrends: 25,
  answer: 10,
  comparison: 20,
  trendPlan: 26,
  report: 32,
} as const;

export const CREDIT_RESERVES = {
  trends: 25,
  answer: 12,
  comparison: 24,
  trendPlan: 32,
  report: 40,
} as const;

export const DATA_OPERATION_PRICING = {
  search: { cached: 1, fresh: 2 },
  browse: { cached: 1, fresh: 1 },
  video: { cached: 1, fresh: 1 },
  tracks: { cached: 1, fresh: 1 },
  transcript: { cached: 1, fresh: 1 },
  comments: { cached: 1, fresh: 2 },
  endscreen: { cached: 1, fresh: 1 },
  channel: { cached: 1, fresh: 1 },
  channelVideos: { cached: 1, fresh: 1 },
  channelPlaylists: { cached: 1, fresh: 1 },
  playlist: { cached: 1, fresh: 1 },
} as const;

export type DataOperation = keyof typeof DATA_OPERATION_PRICING;
export type MeteredCacheStatus = 'hit' | 'miss' | 'coalesced' | 'stale';

export function dataOperationCost(operation: DataOperation, cacheStatus: MeteredCacheStatus): number {
  const price = DATA_OPERATION_PRICING[operation];
  return cacheStatus === 'miss' ? price.fresh : price.cached;
}

export function dataOperationReserve(operation: DataOperation): number {
  const price = DATA_OPERATION_PRICING[operation];
  return Math.max(price.cached, price.fresh);
}

export interface CreditWork<T> {
  value: T;
  actualCredits: number;
  cacheStatus?: MeteredCacheStatus;
}

export interface MeteringOptions {
  operation: string;
  reservedCredits: number;
  providerCostMicros?: number;
  metadata?: Record<string, unknown>;
}

export async function meterOperation<T>(
  c: Context<App>,
  options: MeteringOptions,
  work: () => Promise<CreditWork<T>>,
): Promise<T> {
  const principal = requirePrincipal(c);
  const operationId = crypto.randomUUID();
  const commonMetadata = {
    operation: options.operation,
    requestId: c.get('requestId'),
    authMethod: principal.method,
    apiKeyId: principal.apiKeyId,
    ...options.metadata,
  };

  if (options.reservedCredits > 0) {
    try {
      await reserveCredits(c.env, principal.user.id, operationId, options.reservedCredits, commonMetadata);
    } catch (error) {
      if (error instanceof ApiError && error.status === 402) {
        c.header('X-Credits-Charged', '0');
        c.header('X-Credits-Remaining', String(await creditBalance(c.env, principal.user.id)));
      }
      throw error;
    }
  }

  let result: CreditWork<T>;
  try {
    result = await work();
  } catch (error) {
    if (options.reservedCredits > 0) {
      await releaseCredits(c.env, principal.user.id, operationId, options.reservedCredits, {
        ...commonMetadata,
        outcome: 'failed',
      });
    }
    throw error;
  }

  if (!Number.isInteger(result.actualCredits) || result.actualCredits < 0 || result.actualCredits > options.reservedCredits) {
    if (options.reservedCredits > 0) {
      await releaseCredits(c.env, principal.user.id, operationId, options.reservedCredits, {
        ...commonMetadata,
        outcome: 'invalid-metering-result',
      });
    }
    throw new ApiError(500, 'METERING_CONFIGURATION_ERROR', 'This operation could not be metered.');
  }

  if (options.reservedCredits > 0) {
    await settleCredits(
      c.env,
      principal.user.id,
      operationId,
      options.reservedCredits,
      result.actualCredits,
      options.providerCostMicros ?? 0,
      { ...commonMetadata, cacheStatus: result.cacheStatus },
    );
  }

  const remaining = await creditBalance(c.env, principal.user.id);
  c.header('X-Credits-Charged', String(result.actualCredits));
  c.header('X-Credits-Remaining', String(remaining));
  return result.value;
}
