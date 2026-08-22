const WindowManager = require('./window-manager');
const normalizer = require('./normalizer');
const supersetBuilder = require('./superset-builder');
const partitioner = require('./partitioner');
const scorer = require('./scorer');
const MemoryWindow = require('./adapters/memory-window');

// Optional AI layer — loads only when available
let SemanticPlanner = null;
try {
  SemanticPlanner = require('./ai/planner');
} catch (_) { /* AI layer not installed — safe mode will be used */ }

function extractResultsArray(data) {
  if (Array.isArray(data)) return data;

  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      return extractResultsArray(parsed);
    } catch (err) {
      return [];
    }
  }

  if (data && Array.isArray(data.data)) return data.data;

  return [];
}

function invokeOriginal(res, method, data) {
  if (typeof method !== 'function') return res;
  return method.call(res, data);
}

function sendJson(res, statusCode, payload) {
  if (typeof res.status === 'function') {
    return res.status(statusCode).json(payload);
  }

  res.statusCode = statusCode;
  return res.json(payload);
}

function groupBySimilarity(contexts, threshold) {
  const buckets = new Map();
  for (const ctx of contexts) {
    const intent = ctx.intent;
    const key = intent.groupKey
      ? `hint:${intent.groupKey}`
      : ['auto', intent.resource, intent.limit].join('|');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(ctx);
  }

  const groups = [];
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => a.intent.page - b.intent.page);
    let current = [];

    for (const ctx of bucket) {
      if (current.length === 0) {
        current.push(ctx);
        continue;
      }

      const matchesGroup = scorer(current[current.length - 1].intent, ctx.intent) >= threshold
        || current.some(existing => scorer(existing.intent, ctx.intent) >= threshold);

      if (matchesGroup) {
        current.push(ctx);
      } else {
        groups.push(current);
        current = [ctx];
      }
    }

    if (current.length > 0) groups.push(current);
  }

  return groups;
}

function readBatchBody(req) {
  if (req.body) return Promise.resolve(req.body);

  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function stableStringify(obj) {
  if (obj === null || obj === undefined) return '';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function cacheKeyFor(resource, superset) {
  return [
    resource,
    superset.skip,
    superset.limit,
    stableStringify(superset.filter)
  ].join('|');
}

function fallbackGroup(group, reason) {
  for (const ctx of group) {
    ctx.req.semanticRelay = Object.assign({}, ctx.req.semanticRelay, {
      aggregated: false,
      fallbackReason: reason
    });
    ctx.resolve(null);
    ctx.next();
  }
}

function splitByGuardrails(group, options) {
  const {
    maxGroupSize,
    maxSupersetLimit,
    maxPageGap
  } = options;
  const sorted = group.slice().sort((a, b) => {
    const leftSkip = (a.intent.page - 1) * a.intent.limit;
    const rightSkip = (b.intent.page - 1) * b.intent.limit;
    return leftSkip - rightSkip;
  });
  const result = [];
  let current = [];

  function canAdd(ctx) {
    const candidate = current.concat(ctx);
    if (maxGroupSize > 0 && candidate.length > maxGroupSize) return false;

    const pages = candidate.map(item => item.intent.page);
    if (maxPageGap !== Infinity && Math.max(...pages) - Math.min(...pages) > maxPageGap) return false;

    const superset = supersetBuilder(candidate);
    if (maxSupersetLimit > 0 && superset.limit > maxSupersetLimit) return false;

    return true;
  }

  for (const ctx of sorted) {
    if (current.length === 0 || canAdd(ctx)) {
      current.push(ctx);
      continue;
    }

    result.push(current);
    current = [ctx];
  }

  if (current.length > 0) result.push(current);
  return result;
}

function semanticRelay(options = {}) {
  const {
    windowMs = 20,
    threshold = 0.8,
    earlyFlushMinSize = 0,
    maxGroupSize = 32,
    maxSupersetLimit = 1000,
    maxPageGap = 32,
    maxPendingPerKey = 1000,
    cacheTtlMs = 0,
    maxCacheEntries = 128,
    include = [],
    responseTimeoutMs = 30000,
    routes = {},
    onAggregate = () => { },
    onFallback = () => { },
    window: windowAdapter = new MemoryWindow(),
    aiMode = 'adaptive',
    aiOptions = {}
  } = options;

  let totalRequests = 0;
  let aggregatedRequests = 0;
  let soloRequests = 0;
  let totalWindowsOpened = 0;
  let explicitBatchCalls = 0;
  let explicitBatchRequests = 0;
  let explicitBatchGroups = 0;
  let explicitBatchDbCalls = 0;
  let directGroupedFetches = 0;
  let guardrailFallbacks = 0;
  let guardrailSplits = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  const responseCache = new Map();

  // Decision log for debugging and visualization
  const decisionLog = [];
  const MAX_DECISION_LOG = 100;

  function logDecision(entry) {
    decisionLog.unshift({
      timestamp: Date.now(),
      ...entry
    });
    if (decisionLog.length > MAX_DECISION_LOG) {
      decisionLog.pop();
    }
  }

  const wm = new WindowManager({
    windowMs,
    threshold,
    earlyFlushMinSize,
    maxPendingPerKey,
    maxPageGap,
    window: windowAdapter
  });

  // Instantiate AI planner if available and not in safe mode
  let planner = null;
  if (SemanticPlanner && aiMode !== 'safe') {
    try {
      planner = new SemanticPlanner({
        cohereApiKey: aiOptions.cohereApiKey || process.env.COHERE_API_KEY,
        geminiApiKey: aiOptions.geminiApiKey || process.env.GEMINI_API_KEY,
        embeddingThreshold: aiOptions.embeddingThreshold || 0.85,
        reasoningThreshold: aiOptions.reasoningThreshold || 0.6,
        maxPatternCacheSize: aiOptions.maxPatternCacheSize || 500,
        minConfidence: aiOptions.minConfidence || 0.7,
        maxSupersetLimit,
        aiMode,
        knownRoutes: routes
      });
    } catch (err) {
      // planner stays null — middleware continues in deterministic mode
    }
  }

  const routeEntries = Object.keys(routes)
    .sort((a, b) => b.length - a.length)
    .map(route => [route, routes[route]]);

  const findRoute = (resource) => {
    const exact = routes[resource];
    if (exact) return exact;

    const entry = routeEntries.find(([route]) => resource.startsWith(route));
    return entry && entry[1];
  };

  function getCached(resource, superset) {
    if (cacheTtlMs <= 0) return null;
    const key = cacheKeyFor(resource, superset);
    const entry = responseCache.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      responseCache.delete(key);
      cacheMisses++;
      return null;
    }
    cacheHits++;
    return entry.resultsArray;
  }

  function setCached(resource, superset, resultsArray) {
    if (cacheTtlMs <= 0) return;
    const key = cacheKeyFor(resource, superset);
    responseCache.set(key, {
      expiresAt: Date.now() + cacheTtlMs,
      resultsArray
    });

    while (responseCache.size > maxCacheEntries) {
      const oldestKey = responseCache.keys().next().value;
      responseCache.delete(oldestKey);
    }
  }

  function handleSolo(ctx, reason) {
    soloRequests++;
    logDecision({
      type: 'solo',
      reason,
      resource: ctx.intent?.resource,
      filters: ctx.intent?.filters,
      page: ctx.intent?.page,
      limit: ctx.intent?.limit
    });
    ctx.req.semanticRelay = {
      aggregated: false,
      groupSize: 1,
      query: null,
      fallbackReason: reason
    };
    try {
      onFallback(ctx.req);
    } catch (err) {
      ctx.req.semanticRelay.callbackError = err;
    }
    ctx.resolve(null);
    ctx.next();
  }

  async function handleAggregatedGroup(groupContexts) {
    console.log('[DEBUG] handleAggregatedGroup called with', groupContexts.length, 'requests');
    if (groupContexts.length === 1) {
      handleSolo(groupContexts[0], 'solo');
      return;
    }

    // AI-assisted merge for groups with ambiguous semantic similarity
    // For groups of any size, evaluate pairwise comparisons to find semantic equivalences
    // Ambiguous = score is close to threshold but above it (barely passing)
    // AND filters are different (semantic ambiguity, not just page difference)
    const AI_AMBIGUITY_RANGE = 0.15;  // Score within 0.15 above threshold is ambiguous
    if (planner && groupContexts.length >= 2) {
      // For groups larger than 2, check if there are any ambiguous pairs
      // that would benefit from AI evaluation
      let hasAmbiguousPairs = false;
      let canonicalFilterResolved = null;

      // Collect unique filter structures in the group
      const uniqueFilters = new Map();
      for (const ctx of groupContexts) {
        const filterStr = stableStringify(ctx.intent.filters);
        if (!uniqueFilters.has(filterStr)) {
          uniqueFilters.set(filterStr, ctx.intent.filters);
        }
      }

      // If all filters are identical, no AI needed (deterministic handles it)
      if (uniqueFilters.size === 1) {
        console.log('[DEBUG] AI Check: All filters identical, skipping AI (deterministic)');
      } else {
        // Check first distinct pair for ambiguity (representative sample)
        const filterArray = Array.from(uniqueFilters.values());
        const intentA = { ...groupContexts[0].intent, filters: filterArray[0] };
        const intentB = { ...groupContexts[0].intent, filters: filterArray[1] };
        const scoreAB = scorer(intentA, intentB);
        const filtersDiffer = true; // Already confirmed by uniqueFilters.size > 1
        const isAmbiguous = filtersDiffer && scoreAB >= threshold && scoreAB < (threshold + AI_AMBIGUITY_RANGE);

        console.log('[DEBUG] AI Check:', {
          groupSize: groupContexts.length,
          uniqueFilters: uniqueFilters.size,
          scoreAB,
          threshold,
          ambiguityRange: `${threshold} - ${threshold + AI_AMBIGUITY_RANGE}`,
          filtersDiffer,
          willTriggerAI: isAmbiguous,
          sampleFiltersA: filterArray[0],
          sampleFiltersB: filterArray[1]
        });

        logDecision({
          type: 'deterministic-check',
          groupSize: groupContexts.length,
          uniqueFilters: uniqueFilters.size,
          score: scoreAB,
          threshold,
          resource: groupContexts[0].intent?.resource,
          willTriggerAI: isAmbiguous
        });

        if (isAmbiguous) {
          console.log(`[DEBUG] TRIGGERING AI for group of ${groupContexts.length} with ${uniqueFilters.size} filter variants...`);
          hasAmbiguousPairs = true;

          logDecision({
            type: 'ai-trigger',
            resource: groupContexts[0].intent?.resource,
            groupSize: groupContexts.length,
            uniqueFilters: uniqueFilters.size,
            deterministicScore: scoreAB
          });

          try {
            // Evaluate representative pair from the group
            const planResult = await planner.evaluate(intentA, intentB);
            console.log('[DEBUG] AI Result:', planResult);

            logDecision({
              type: 'ai-result',
              decision: planResult.decision,
              confidence: planResult.confidence,
              source: planResult.source,
              canonicalFilter: planResult.canonicalFilter,
              latencyMs: planResult.latencyMs
            });

            if (planResult.decision === 'merge' && planResult.canonicalFilter) {
              // Apply canonical filter to ALL requests in the group
              canonicalFilterResolved = planResult.canonicalFilter;
              for (const ctx of groupContexts) {
                ctx.intent.filters = canonicalFilterResolved;
              }
              console.log(`[DEBUG] Applied canonical filter to all ${groupContexts.length} requests`);
            } else if (planResult.decision === 'split') {
              logDecision({
                type: 'ai-split',
                resource: groupContexts[0].intent?.resource,
                groupSize: groupContexts.length
              });
              for (const ctx of groupContexts) handleSolo(ctx, 'ai-split');
              return;
            }
            // decision === 'fallback' → fall through to existing deterministic path
          } catch (err) {
            console.log('[DEBUG] AI Error:', err.message);
            logDecision({
              type: 'ai-error',
              error: err.message
            });
            /* planner error → continue deterministic */
          }
        } else if (scoreAB >= threshold) {
          logDecision({
            type: 'deterministic-handled',
            outcome: 'above-threshold',
            score: scoreAB,
            threshold,
            resource: groupContexts[0].intent?.resource,
            groupSize: groupContexts.length
          });
        }
      }
    }

    const guardedGroups = splitByGuardrails(groupContexts, {
      maxGroupSize,
      maxSupersetLimit,
      maxPageGap
    });

    if (guardedGroups.length > 1) {
      guardrailSplits += guardedGroups.length - 1;
      for (const group of guardedGroups) {
        if (group.length === 1) {
          guardrailFallbacks++;
          handleSolo(group[0], 'guardrail-split');
        } else {
          handleAggregatedGroup(group);
        }
      }
      return;
    }

    aggregatedRequests += groupContexts.length;

    try {
      const superset = supersetBuilder(groupContexts);
      const leader = groupContexts[0];

      for (const ctx of groupContexts) {
        ctx.req.semanticRelay = {
          aggregated: true,
          groupSize: groupContexts.length,
          leader: ctx === leader,
          query: ctx === leader ? superset : null
        };
      }

      try {
        onAggregate(groupContexts);
      } catch (err) {
        leader.req.semanticRelay.callbackError = err;
      }

      const directRoute = findRoute(leader.intent.resource);
      if (directRoute && typeof directRoute.fetch === 'function') {
        directGroupedFetches++;
        Promise.resolve()
          .then(async () => {
            let resultsArray = getCached(leader.intent.resource, superset);
            if (!resultsArray) {
              const fetched = await directRoute.fetch(superset, {
                group: groupContexts,
                intents: groupContexts.map(ctx => ctx.intent),
                requests: groupContexts.map(ctx => ctx.req)
              });
              resultsArray = typeof directRoute.extractResults === 'function'
                ? directRoute.extractResults(fetched)
                : extractResultsArray(fetched);
              setCached(leader.intent.resource, superset, resultsArray);
            }
            const partitioned = typeof directRoute.partition === 'function'
              ? directRoute.partition(resultsArray, groupContexts, superset)
              : partitioner(resultsArray, groupContexts, superset);

            for (const ctx of groupContexts) {
              ctx.resolve(partitioned.get(ctx.intent.intentId) || []);
            }
          })
          .catch((err) => {
            for (const ctx of groupContexts) {
              ctx.reject(err);
            }
          });
        return;
      }

      const originalJson = leader.res.json;
      const originalSend = leader.res.send;
      let intercepted = false;
      let responseTimer = null;

      const restore = () => {
        leader.res.json = originalJson;
        if (typeof originalSend === 'function') {
          leader.res.send = originalSend;
        }
      };

      const fallbackFollowers = (reason) => {
        for (const ctx of groupContexts) {
          ctx.req.semanticRelay = Object.assign({}, ctx.req.semanticRelay, {
            aggregated: false,
            fallbackReason: reason
          });
          ctx.resolve(null);
          if (ctx !== leader) {
            ctx.next();
          }
        }
      };

      const intercept = function (data, methodName) {
        if (intercepted) return leader.res;
        intercepted = true;
        if (responseTimer) clearTimeout(responseTimer);

        restore();

        if (leader.res.statusCode >= 400) {
          fallbackFollowers('leader-error-response');
          return invokeOriginal(
            leader.res,
            methodName === 'send' ? originalSend : originalJson,
            data
          );
        }

        try {
          const resultsArray = extractResultsArray(data);
          const partitioned = partitioner(resultsArray, groupContexts, superset);

          for (const ctx of groupContexts) {
            const slice = partitioned.get(ctx.intent.intentId);
            ctx.resolve(slice);
          }
        } catch (err) {
          for (const ctx of groupContexts) {
            ctx.reject(err);
          }
        }

        return leader.res;
      };

      leader.res.json = intercept;
      if (typeof originalSend === 'function') {
        leader.res.send = function (data) {
          return intercept(data, 'send');
        };
      }

      if (responseTimeoutMs > 0) {
        responseTimer = setTimeout(() => {
          if (intercepted) return;
          intercepted = true;
          restore();
          fallbackFollowers('leader-timeout');
        }, responseTimeoutMs);
      }

      leader.next();
    } catch (err) {
      for (const ctx of groupContexts) {
        ctx.resolve(null);
        ctx.req.semanticRelay = {
          aggregated: false,
          groupSize: groupContexts.length,
          error: err.message
        };
        ctx.next();
      }
    }
  }

  wm.onFlush((groupContexts) => {
    totalWindowsOpened++;
    handleAggregatedGroup(groupContexts);
  });

  const middleware = async (req, res, next) => {
    try {
      if (req.method !== 'GET') {
        return next();
      }

      const requestPath = req.path || req.url || '';
      const isIncluded = include.length === 0 || include.some(route => requestPath.startsWith(route));
      if (!isIncluded) {
        return next();
      }

      totalRequests++;

      const intent = normalizer(req);

      // Debug: Log request arrival timing
      console.log(`[TIMING] Request ${totalRequests} arrived at ${Date.now()} - resource: ${intent.resource}, filters:`, intent.filters);

      let resolveDeferred, rejectDeferred;
      const deferred = new Promise((resolve, reject) => {
        resolveDeferred = resolve;
        rejectDeferred = reject;
      });

      const reqCtx = {
        req,
        res,
        next,
        intent,
        resolve: resolveDeferred,
        reject: rejectDeferred
      };

      wm.add(reqCtx);

      const resolvedData = await deferred;

      if (resolvedData !== null) {
        res.json(resolvedData);
      }

    } catch (err) {
      return next(err);
    }
  };

  middleware.batchHandler = async (req, res, next) => {
    try {
      explicitBatchCalls++;
      const body = await readBatchBody(req);
      const requests = Array.isArray(body) ? body : body.requests;

      if (!Array.isArray(requests)) {
        return sendJson(res, 400, {
          error: 'semantic-relay batch body must be an array or { requests: [] }'
        });
      }

      explicitBatchRequests += requests.length;

      const responses = new Array(requests.length);
      const contexts = [];

      requests.forEach((request, index) => {
        const path = request && (request.path || request.resource);
        const query = request && request.query ? request.query : {};

        if (!path) {
          responses[index] = {
            id: request && request.id,
            status: 400,
            body: { error: 'Batch request requires path or resource' }
          };
          return;
        }

        const fakeReq = {
          method: 'GET',
          path,
          query
        };

        contexts.push({
          index,
          request,
          intent: normalizer(fakeReq)
        });
      });

      const groups = groupBySimilarity(contexts, threshold)
        .flatMap(group => splitByGuardrails(group, {
          maxGroupSize,
          maxSupersetLimit,
          maxPageGap
        }));
      explicitBatchGroups += groups.length;

      for (const group of groups) {
        const route = findRoute(group[0].intent.resource);

        if (!route || typeof route.fetch !== 'function') {
          for (const ctx of group) {
            responses[ctx.index] = {
              id: ctx.request && ctx.request.id,
              status: 404,
              body: { error: `No semantic-relay batch route registered for ${ctx.intent.resource}` }
            };
          }
          continue;
        }

        try {
          const superset = typeof route.buildSuperset === 'function'
            ? route.buildSuperset(group)
            : supersetBuilder(group);
          let resultsArray = getCached(group[0].intent.resource, superset);
          if (!resultsArray) {
            const fetched = await route.fetch(superset, {
              group,
              intents: group.map(ctx => ctx.intent),
              requests: group.map(ctx => ctx.request)
            });
            explicitBatchDbCalls++;

            resultsArray = typeof route.extractResults === 'function'
              ? route.extractResults(fetched)
              : extractResultsArray(fetched);
            setCached(group[0].intent.resource, superset, resultsArray);
          }
          const partitioned = typeof route.partition === 'function'
            ? route.partition(resultsArray, group, superset)
            : partitioner(resultsArray, group, superset);

          for (const ctx of group) {
            responses[ctx.index] = {
              id: ctx.request && ctx.request.id,
              status: 200,
              body: partitioned.get(ctx.intent.intentId) || []
            };
          }
        } catch (err) {
          for (const ctx of group) {
            responses[ctx.index] = {
              id: ctx.request && ctx.request.id,
              status: 500,
              body: { error: err.message }
            };
          }
        }
      }

      return sendJson(res, 200, {
        responses,
        metrics: {
          requests: requests.length,
          groups: groups.length,
          dbCalls: groups.filter(group => {
            const route = findRoute(group[0].intent.resource);
            return route && typeof route.fetch === 'function';
          }).length
        }
      });
    } catch (err) {
      return next(err);
    }
  };

  middleware.getMetrics = () => {
    const queriesSaved = totalRequests - totalWindowsOpened;
    return {
      totalRequests,
      aggregatedRequests,
      soloRequests,
      totalWindowsOpened,
      queriesSaved,
      reductionPercent: totalRequests === 0 ? 0 : (queriesSaved / totalRequests) * 100,
      explicitBatchCalls,
      explicitBatchRequests,
      explicitBatchGroups,
      explicitBatchDbCalls,
      directGroupedFetches,
      guardrailFallbacks,
      guardrailSplits,
      cacheHits,
      cacheMisses,
      cacheEntries: responseCache.size,
      // AI layer fields — zeroed when planner is not active
      ...(planner ? planner.getStats() : {
        aiInvocations: 0,
        embeddingInvocations: 0,
        reasoningInvocations: 0,
        validatorApprovals: 0,
        validatorRejects: 0,
        patternCacheHits: 0,
        patternCacheMisses: 0,
        avgEmbeddingMs: 0,
        avgReasoningMs: 0,
        aiStatus: SemanticPlanner ? 'disabled' : 'not-installed',
        estimatedCostUsd: 0
      })
    };
  };

  // Expose planner so demo server can wire the onDecision callback
  middleware.getPlanner = () => planner;

  // Expose decision log for debugging UI
  middleware.getDecisionLog = () => decisionLog;

  // Expose AI mode control methods
  middleware.setAiMode = (newMode) => {
    if (planner && typeof planner.setAiMode === 'function') {
      planner.setAiMode(newMode);
    }
  };

  middleware.getAiMode = () => {
    if (planner && typeof planner.getAiMode === 'function') {
      return planner.getAiMode();
    }
    return aiMode;
  };

  // Expose pattern cache clearing
  middleware.clearPatternCache = () => {
    if (planner && typeof planner.clearPatternCache === 'function') {
      planner.clearPatternCache();
    }
  };

  return middleware;
}

module.exports = semanticRelay;
module.exports.semanticRelay = semanticRelay;
module.exports.MemoryWindow = MemoryWindow;
