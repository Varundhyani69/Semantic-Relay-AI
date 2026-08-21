export type NextFunction = (error?: unknown) => void;

export interface RelayRequest {
  method?: string;
  path?: string;
  url?: string;
  query?: Record<string, unknown>;
  semanticRelay?: SemanticRelayState;
  [key: string]: unknown;
}

export interface RelayResponse {
  statusCode?: number;
  json(data: unknown): unknown;
  send?(data: unknown): unknown;
  [key: string]: unknown;
}

export type RequestHandler = (
  req: RelayRequest,
  res: RelayResponse,
  next: NextFunction
) => unknown;

export interface SemanticRelayIntent {
  intentId: string;
  resource: string;
  page: number;
  limit: number;
  filters: Record<string, unknown>;
  groupKey?: string | null;
  expectedGroupSize?: number;
}

export interface SemanticRelayQuery {
  filter: Record<string, unknown>;
  skip: number;
  limit: number;
  pages: number[];
  baseLimit: number;
}

export interface SemanticRelayState {
  aggregated: boolean;
  groupSize: number;
  leader?: boolean;
  query: SemanticRelayQuery | null;
  error?: string;
  callbackError?: unknown;
  fallbackReason?: string;
}

export interface SemanticRelayContext {
  req: RelayRequest;
  res: RelayResponse;
  next: NextFunction;
  intent: SemanticRelayIntent;
  resolve(value: unknown[] | null): void;
  reject(error: unknown): void;
}

export interface WindowAdapter {
  add(resourceKey: string, intentCtx: SemanticRelayContext): void;
  flush(resourceKey: string): Promise<SemanticRelayContext[]> | SemanticRelayContext[];
  peek?(resourceKey: string): SemanticRelayContext[];
  clear(resourceKey: string): void;
}

export interface SemanticRelayOptions {
  windowMs?: number;
  threshold?: number;
  earlyFlushMinSize?: number;
  maxGroupSize?: number;
  maxSupersetLimit?: number;
  maxPageGap?: number;
  maxPendingPerKey?: number;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
  include?: string[];
  responseTimeoutMs?: number;
  routes?: Record<string, SemanticRelayBatchRoute>;
  onAggregate?: (group: SemanticRelayContext[]) => void;
  onFallback?: (req: RelayRequest) => void;
  window?: WindowAdapter;
}

export interface SemanticRelayBatchRequest {
  id?: string;
  path?: string;
  resource?: string;
  query?: Record<string, unknown>;
}

export interface SemanticRelayBatchContext {
  index: number;
  request: SemanticRelayBatchRequest;
  intent: SemanticRelayIntent;
}

export interface SemanticRelayBatchRoute {
  fetch(
    query: SemanticRelayQuery,
    context: {
      group: SemanticRelayBatchContext[];
      intents: SemanticRelayIntent[];
      requests: SemanticRelayBatchRequest[];
    }
  ): Promise<unknown> | unknown;
  buildSuperset?(group: SemanticRelayBatchContext[]): SemanticRelayQuery;
  extractResults?(result: unknown): unknown[];
  partition?(
    results: unknown[],
    group: SemanticRelayBatchContext[],
    superset: SemanticRelayQuery
  ): Map<string, unknown[]>;
}

export interface SemanticRelayMetrics {
  totalRequests: number;
  aggregatedRequests: number;
  soloRequests: number;
  totalWindowsOpened: number;
  queriesSaved: number;
  reductionPercent: number;
  explicitBatchCalls: number;
  explicitBatchRequests: number;
  explicitBatchGroups: number;
  explicitBatchDbCalls: number;
  directGroupedFetches: number;
  guardrailFallbacks: number;
  guardrailSplits: number;
  cacheHits: number;
  cacheMisses: number;
  cacheEntries: number;
}

export interface SemanticRelayMiddleware extends RequestHandler {
  batchHandler: RequestHandler;
  getMetrics(): SemanticRelayMetrics;
}

export class MemoryWindow implements WindowAdapter {
  constructor();
  add(resourceKey: string, intentCtx: SemanticRelayContext): void;
  flush(resourceKey: string): Promise<SemanticRelayContext[]>;
  peek(resourceKey: string): SemanticRelayContext[];
  clear(resourceKey: string): void;
}

export function semanticRelay(options?: SemanticRelayOptions): SemanticRelayMiddleware;

export default semanticRelay;
