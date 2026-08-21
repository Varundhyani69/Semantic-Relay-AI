const WindowManager = require('./window-manager');
const normalizer = require('./normalizer');
const supersetBuilder = require('./superset-builder');
const partitioner = require('./partitioner');
const scorer = require('./scorer');
const MemoryWindow = require('./adapters/memory-window');

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
      : ['auto', intent.resource, intent.limit, stableStringify(intent.filters)].join('|');
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
    window: windowAdapter = new MemoryWindow()
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

  const wm = new WindowManager({
    windowMs,
    threshold,
    earlyFlushMinSize,
    maxPendingPerKey,
    maxPageGap,
    window: windowAdapter
  });

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

  function handleAggregatedGroup(groupContexts) {
    if (groupContexts.length === 1) {
      handleSolo(groupContexts[0], 'solo');
      return;
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
      cacheEntries: responseCache.size
    };
  };

  return middleware;
}

module.exports = semanticRelay;
module.exports.semanticRelay = semanticRelay;
module.exports.MemoryWindow = MemoryWindow;
