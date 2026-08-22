const path = require('path');
const express = require('express');
const semanticRelay = require('semantic-relay');

// Load environment variables from .env file
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3100;

const products = Array.from({ length: 720 }, (_, index) => {
  const id = index + 1;
  const categories = ['hardware', 'apparel', 'books', 'kitchen'];
  return {
    id,
    name: `Product ${String(id).padStart(3, '0')}`,
    category: categories[index % categories.length],
    price: 20 + ((index * 7) % 180),
    rating: Number((3.4 + ((index % 16) / 10)).toFixed(1))
  };
});

const productIndex = products.reduce((index, product) => {
  if (!index.has(product.category)) index.set(product.category, []);
  index.get(product.category).push(product);
  return index;
}, new Map());

function selectProducts(filter) {
  if (filter && (filter.category || filter.type || filter.genre || filter.productType)) {
    // Handle semantic variations of category filter
    const categoryValue = filter.category || filter.type || filter.genre || filter.productType;
    return productIndex.get(categoryValue) || [];
  }

  return products;
}

function createConstrainedStore(label) {
  const maxConcurrent = 2;
  const queue = [];
  let active = 0;
  let calls = 0;
  let maxQueueDepth = 0;

  function runNext() {
    if (active >= maxConcurrent || queue.length === 0) return;

    const job = queue.shift();
    active++;
    calls++;

    const delayMs = 180 + Math.ceil(job.limit * 0.2);
    setTimeout(() => {
      const filtered = selectProducts(job.filter);

      active--;
      job.resolve({
        label,
        calls,
        items: filtered.slice(job.skip, job.skip + job.limit)
      });
      runNext();
    }, delayMs);
  }

  return {
    query(filter, skip, limit) {
      return new Promise((resolve) => {
        queue.push({ filter, skip, limit, resolve });
        maxQueueDepth = Math.max(maxQueueDepth, queue.length);
        runNext();
      });
    },
    reset() {
      calls = 0;
      maxQueueDepth = 0;
    },
    stats() {
      return {
        label,
        calls,
        active,
        queued: queue.length,
        maxQueueDepth,
        maxConcurrent
      };
    }
  };
}

const rawStore = createConstrainedStore('raw');
const batchStore = createConstrainedStore('batch');
const relayStore = createConstrainedStore('relay');
const semanticBatchStore = createConstrainedStore('semantic-batch');
const relayWindowMs = parsePositiveInt(process.env.RELAY_WINDOW_MS, 12);
const relayThreshold = Number.parseFloat(process.env.RELAY_THRESHOLD || '0.8');
const relayDemoStats = {
  aggregateGroups: 0,
  aggregatedRequests: 0,
  fallbackRequests: 0
};

const relayMiddleware = semanticRelay({
  windowMs: relayWindowMs,
  threshold: Number.isFinite(relayThreshold) ? relayThreshold : 0.8,
  earlyFlushMinSize: 8,
  maxGroupSize: 24,
  maxSupersetLimit: 600,
  maxPageGap: 24,
  maxPendingPerKey: 128,
  cacheTtlMs: 150,
  maxCacheEntries: 64,
  include: ['/api/relay/products'],
  // AI Configuration
  aiMode: process.env.AI_MODE || 'adaptive',
  aiOptions: {
    cohereApiKey: process.env.COHERE_API_KEY,
    geminiApiKey: process.env.GEMINI_API_KEY,
    embeddingThreshold: parseFloat(process.env.EMBEDDING_THRESHOLD) || 0.85,
    reasoningThreshold: parseFloat(process.env.REASONING_THRESHOLD) || 0.6,
    minConfidence: parseFloat(process.env.MIN_CONFIDENCE) || 0.7,
    maxPatternCacheSize: 500
  },
  routes: {
    '/api/relay/products': {
      fetch: async ({ filter, skip, limit }) => {
        const result = await relayStore.query(filter || {}, skip, limit);
        return result.items;
      }
    },
    '/products': {
      fetch: async ({ filter, skip, limit }) => {
        const result = await semanticBatchStore.query(filter || {}, skip, limit);
        return result.items;
      }
    }
  },
  onAggregate(group) {
    relayDemoStats.aggregateGroups++;
    relayDemoStats.aggregatedRequests += group.length;
  },
  onFallback() {
    relayDemoStats.fallbackRequests++;
  }
});

// ─── AI Decision Log ──────────────────────────────────────────────────────────
const aiDecisionLog = [];
const AI_DECISION_LOG_MAX = 50;

/**
 * Record one AI planner decision into the circular buffer.
 * Called by the planner callback once Varun wires it up.
 * Safe to call with any object shape — it just stores what it gets.
 */
function recordAiDecision(decision) {
  console.log('🔵 [AI DECISION RECORDED]', {
    resourceA: decision.resourceA,
    resourceB: decision.resourceB,
    filtersA: decision.filtersA,
    filtersB: decision.filtersB,
    cohereScore: decision.cohereScore,
    geminiUsed: decision.geminiUsed,
    validatorApproved: decision.validatorApproved,
    mergeExecuted: decision.mergeExecuted
  });

  aiDecisionLog.unshift({
    timestamp: Date.now(),
    resourceA: decision.resourceA || '',
    resourceB: decision.resourceB || '',
    filtersA: decision.filtersA || {},
    filtersB: decision.filtersB || {},
    cohereScore: typeof decision.cohereScore === 'number' ? decision.cohereScore : null,
    geminiUsed: decision.geminiUsed === true,
    geminiConfidence: typeof decision.geminiConfidence === 'number' ? decision.geminiConfidence : null,
    validatorApproved: decision.validatorApproved === true,
    mergeExecuted: decision.mergeExecuted === true,
    latencyMs: typeof decision.latencyMs === 'number' ? decision.latencyMs : 0
  });
  if (aiDecisionLog.length > AI_DECISION_LOG_MAX) {
    aiDecisionLog.pop();
  }
}

// Expose recordAiDecision so Varun can wire it from the planner callback
// Usage: relayMiddleware.onAiDecision = recordAiDecision;
console.log('🟡 [WIRING AI DECISION CALLBACK]');
relayMiddleware.onAiDecision = recordAiDecision;

// Wire the planner's onDecision callback to our recordAiDecision function
const plannerInstance = relayMiddleware.getPlanner && relayMiddleware.getPlanner();
console.log('🟡 [PLANNER INSTANCE]', plannerInstance ? 'Found' : 'Not found');
if (plannerInstance) {
  plannerInstance.onDecision = relayMiddleware.onAiDecision;
  console.log('✅ [PLANNER WIRED] onDecision callback attached');
} else {
  console.log('⚠️ [PLANNER NOT FOUND] AI decisions will not be recorded');
}
// ─────────────────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(relayMiddleware);

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readStandardQuery(req) {
  const page = parsePositiveInt(req.query.page, 1);
  const limit = parsePositiveInt(req.query.limit, 12);

  // Handle semantic variations of category filter
  const category = typeof req.query.category === 'string' ? req.query.category : '';
  const type = typeof req.query.type === 'string' ? req.query.type : '';
  const genre = typeof req.query.genre === 'string' ? req.query.genre : '';
  const productType = typeof req.query.productType === 'string' ? req.query.productType : '';

  const filter = {};
  if (category) filter.category = category;
  else if (type) filter.type = type;
  else if (genre) filter.genre = genre;
  else if (productType) filter.productType = productType;

  return {
    filter,
    skip: (page - 1) * limit,
    limit
  };
}

app.get('/api/raw/products', async (req, res, next) => {
  try {
    const query = readStandardQuery(req);
    const startedAt = Date.now();
    const result = await rawStore.query(query.filter, query.skip, query.limit);

    res.json(result.items);
  } catch (error) {
    next(error);
  }
});

app.get('/api/relay/products', async (req, res, next) => {
  try {
    const standard = readStandardQuery(req);
    const relayQuery = req.semanticRelay && req.semanticRelay.query;
    const query = relayQuery || standard;

    const startedAt = Date.now();
    const result = await relayStore.query(query.filter || {}, query.skip, query.limit);

    res.json(result.items);
  } catch (error) {
    next(error);
  }
});

app.get('/api/batch/products', async (req, res, next) => {
  try {
    const pages = String(req.query.pages || '')
      .split(',')
      .map((page) => parsePositiveInt(page, 0))
      .filter((page) => page > 0);
    const uniquePages = Array.from(new Set(pages)).sort((a, b) => a - b);
    const limit = parsePositiveInt(req.query.limit, 12);
    const category = typeof req.query.category === 'string' ? req.query.category : '';
    const filter = category ? { category } : {};

    if (uniquePages.length === 0) {
      return res.json([]);
    }

    const byPage = await Promise.all(uniquePages.map((page) => {
      const skip = (page - 1) * limit;
      return batchStore.query(filter, skip, limit).then(result => result.items);
    }));

    res.json(byPage.flat());
  } catch (error) {
    next(error);
  }
});

app.post('/api/semantic-batch', relayMiddleware.batchHandler);

app.post('/api/reset', (req, res) => {
  rawStore.reset();
  batchStore.reset();
  relayStore.reset();
  semanticBatchStore.reset();
  relayDemoStats.aggregateGroups = 0;
  relayDemoStats.aggregatedRequests = 0;
  relayDemoStats.fallbackRequests = 0;
  res.json({ ok: true });
});

app.get('/api/metrics', (req, res) => {
  const metrics = relayMiddleware.getMetrics();
  console.log('📊 [METRICS REQUEST]', {
    aiInvocations: metrics.aiInvocations,
    embeddingInvocations: metrics.embeddingInvocations,
    reasoningInvocations: metrics.reasoningInvocations,
    validatorApprovals: metrics.validatorApprovals,
    validatorRejects: metrics.validatorRejects,
    aiDecisionLogLength: aiDecisionLog.length
  });

  res.json({
    raw: rawStore.stats(),
    batch: batchStore.stats(),
    relay: relayStore.stats(),
    semanticBatch: semanticBatchStore.stats(),
    relayDemo: Object.assign({}, relayDemoStats),
    semanticRelay: metrics
  });
});

app.get('/api/ai-decisions', (req, res) => {
  res.json({
    decisions: aiDecisionLog,
    summary: relayMiddleware.getMetrics()
  });
});

// New endpoint for decision logs
app.get('/api/decision-logs', (req, res) => {
  const logs = relayMiddleware.getDecisionLog ? relayMiddleware.getDecisionLog() : [];
  res.json({ logs });
});

function buildProductUrl(endpoint, page, limit, category) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit)
  });

  if (category) params.set('category', category);

  return `http://127.0.0.1:${port}${endpoint}?${params.toString()}`;
}

async function runHttpScenario(endpoint, pages, limit, category, fetchOptions = {}) {
  const startedAt = Date.now();
  const responses = await Promise.all(
    pages.map((page) => fetch(buildProductUrl(endpoint, page, limit, category), fetchOptions)
      .then((response) => response.json()))
  );

  return {
    elapsedMs: Date.now() - startedAt,
    items: responses.flatMap((payload) => Array.isArray(payload) ? payload : payload.data || [])
  };
}

async function runHttpBatchScenario(pages, limit, category) {
  const startedAt = Date.now();
  const params = new URLSearchParams({
    pages: pages.join(','),
    limit: String(limit)
  });

  if (category) params.set('category', category);

  const response = await fetch(`http://127.0.0.1:${port}/api/batch/products?${params.toString()}`);
  const payload = await response.json();

  return {
    elapsedMs: Date.now() - startedAt,
    items: Array.isArray(payload) ? payload : []
  };
}

async function runHttpSemanticBatchScenario(pages, limit, category) {
  const startedAt = Date.now();
  const requests = pages.map((page) => {
    const query = {
      page: String(page),
      limit: String(limit)
    };

    if (category) query.category = category;

    return {
      id: `p${page}`,
      path: '/products',
      query
    };
  });

  const response = await fetch(`http://127.0.0.1:${port}/api/semantic-batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requests })
  });
  const payload = await response.json();

  return {
    elapsedMs: Date.now() - startedAt,
    items: (payload.responses || []).flatMap(item => item.status === 200 && Array.isArray(item.body) ? item.body : []),
    batchMetrics: payload.metrics || { requests: 0, groups: 0, dbCalls: 0 }
  };
}

async function runMiddlewareOnlyRelayScenario(pages, limit, category) {
  const relayGroup = `direct-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const startedAt = Date.now();
  const responses = await Promise.all(pages.map((page) => {
    return new Promise((resolve, reject) => {
      const headers = {
        'x-relay-group': relayGroup,
        'x-relay-expected-size': String(pages.length)
      };
      const req = {
        method: 'GET',
        path: '/api/relay/products',
        query: {
          page: String(page),
          limit: String(limit)
        },
        headers,
        get(name) {
          return headers[String(name).toLowerCase()];
        }
      };

      if (category) req.query.category = category;

      const res = {
        statusCode: 200,
        json: resolve,
        send: resolve
      };
      const next = async (error) => {
        if (error) return reject(error);
        try {
          const query = readStandardQuery(req);
          const result = await relayStore.query(query.filter, query.skip, query.limit);
          resolve(result.items);
        } catch (err) {
          reject(err);
        }
      };

      Promise.resolve(relayMiddleware(req, res, next)).catch(reject);
    });
  }));

  return {
    elapsedMs: Date.now() - startedAt,
    items: responses.flatMap((payload) => Array.isArray(payload) ? payload : [])
  };
}

function sameIds(left, right) {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item && right[index] && item.id === right[index].id);
}

app.get('/api/benchmark', async (req, res, next) => {
  try {
    const count = Math.min(parsePositiveInt(req.query.requests, 10), 24);
    const limit = Math.min(parsePositiveInt(req.query.limit, 12), 48);
    const category = typeof req.query.category === 'string' ? req.query.category : '';

    // Enhanced: create diverse filter patterns to trigger both deterministic and AI flows
    // When category is specified, alternate filter keys to create ambiguous semantic pairs
    const pages = Array.from({ length: count }, (_, index) => {
      const page = index + 1;
      if (category) {
        // Alternate between different filter key names for the same semantic concept
        // This creates ambiguous pairs that will trigger AI evaluation
        const filterVariants = [
          { category },           // Standard key
          { type: category },     // Semantic alternative
          { genre: category },    // Another semantic alternative
          { productType: category } // Yet another alternative
        ];
        return {
          page,
          filter: filterVariants[index % filterVariants.length]
        };
      }
      return { page, filter: {} };
    });

    rawStore.reset();
    batchStore.reset();
    relayStore.reset();
    semanticBatchStore.reset();
    relayDemoStats.aggregateGroups = 0;
    relayDemoStats.aggregatedRequests = 0;
    relayDemoStats.fallbackRequests = 0;

    // Raw requests - build URLs with diverse filters
    const raw = await runHttpScenario('/api/raw/products', pages.map(p => p.page), limit, category);
    const rawMetrics = rawStore.stats();

    // Batch requests
    const batch = await runHttpBatchScenario(pages.map(p => p.page), limit, category);
    const batchMetrics = batchStore.stats();

    const semanticBatch = await runHttpSemanticBatchScenario(pages.map(p => p.page), limit, category);
    const semanticBatchMetrics = semanticBatchStore.stats();

    // Enhanced relay requests with diverse filters
    const semanticRelayBefore = relayMiddleware.getMetrics();
    const relayGroup = `products-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const relay = await runEnhancedHttpRelayScenario('/api/relay/products', pages, limit, relayGroup);
    const relayMetrics = relayStore.stats();
    const semanticRelayAfter = relayMiddleware.getMetrics();
    const semanticRelayMetrics = {
      totalRequests: semanticRelayAfter.totalRequests - semanticRelayBefore.totalRequests,
      aggregatedRequests: semanticRelayAfter.aggregatedRequests - semanticRelayBefore.aggregatedRequests,
      soloRequests: semanticRelayAfter.soloRequests - semanticRelayBefore.soloRequests,
      totalWindowsOpened: semanticRelayAfter.totalWindowsOpened - semanticRelayBefore.totalWindowsOpened,
      queriesSaved: semanticRelayAfter.queriesSaved - semanticRelayBefore.queriesSaved,
      directGroupedFetches: semanticRelayAfter.directGroupedFetches - semanticRelayBefore.directGroupedFetches,
      guardrailFallbacks: semanticRelayAfter.guardrailFallbacks - semanticRelayBefore.guardrailFallbacks,
      guardrailSplits: semanticRelayAfter.guardrailSplits - semanticRelayBefore.guardrailSplits,
      cacheHits: semanticRelayAfter.cacheHits - semanticRelayBefore.cacheHits,
      cacheMisses: semanticRelayAfter.cacheMisses - semanticRelayBefore.cacheMisses,
      cacheEntries: semanticRelayAfter.cacheEntries,
      reductionPercent: count === 0 ? 0 : ((semanticRelayAfter.queriesSaved - semanticRelayBefore.queriesSaved) / count) * 100
    };

    res.json({
      pages: pages.map(p => p.page),
      raw: Object.assign({}, raw, { calls: rawMetrics.calls }),
      batch: Object.assign({}, batch, { calls: batchMetrics.calls }),
      semanticBatch: Object.assign({}, semanticBatch, { calls: semanticBatchMetrics.calls }),
      relay: Object.assign({}, relay, { calls: relayMetrics.calls }),
      batchSavedCalls: Math.max(0, rawMetrics.calls - batchMetrics.calls),
      semanticBatchSavedCalls: Math.max(0, rawMetrics.calls - semanticBatchMetrics.calls),
      relaySavedCalls: Math.max(0, rawMetrics.calls - relayMetrics.calls),
      batchFasterByMs: Math.max(0, raw.elapsedMs - batch.elapsedMs),
      semanticBatchFasterByMs: Math.max(0, raw.elapsedMs - semanticBatch.elapsedMs),
      relayFasterByMs: Math.max(0, raw.elapsedMs - relay.elapsedMs),
      sameBatchItems: sameIds(raw.items, batch.items),
      sameSemanticBatchItems: sameIds(raw.items, semanticBatch.items),
      sameRelayItems: sameIds(raw.items, relay.items),
      metrics: {
        raw: rawMetrics,
        batch: batchMetrics,
        semanticBatch: semanticBatchMetrics,
        semanticBatchHandler: semanticBatch.batchMetrics,
        relay: relayMetrics,
        relayDemo: Object.assign({}, relayDemoStats),
        semanticRelay: semanticRelayMetrics
      }
    });
  } catch (error) {
    next(error);
  }
});

// New helper function for enhanced relay scenario with diverse filters
async function runEnhancedHttpRelayScenario(endpoint, pages, limit, relayGroup) {
  const startedAt = Date.now();

  // Stagger requests with small delays to ensure they arrive within the window
  // but not all at once (which would cause sequential processing anyway)
  const responses = [];
  for (let i = 0; i < pages.length; i++) {
    const { page, filter } = pages[i];
    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit)
    });

    // Add filter parameters
    Object.keys(filter).forEach(key => {
      params.set(key, filter[key]);
    });

    // Start request immediately but don't await yet
    const requestPromise = fetch(`http://127.0.0.1:${port}${endpoint}?${params.toString()}`, {
      headers: {
        'x-relay-group': relayGroup,
        'x-relay-expected-size': String(pages.length)
      }
    }).then((response) => response.json());

    responses.push(requestPromise);

    // Add 5ms stagger delay between requests to ensure they arrive within window
    // but give the middleware time to process them
    if (i < pages.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  // Wait for all responses
  const results = await Promise.all(responses);

  return {
    elapsedMs: Date.now() - startedAt,
    items: results.flatMap((payload) => Array.isArray(payload) ? payload : payload.data || [])
  };
}

app.get('/api/benchmark/middleware-only', async (req, res, next) => {
  try {
    const count = Math.min(parsePositiveInt(req.query.requests, 10), 24);
    const limit = Math.min(parsePositiveInt(req.query.limit, 12), 48);
    const category = typeof req.query.category === 'string' ? req.query.category : '';
    const pages = Array.from({ length: count }, (_, index) => index + 1);

    relayStore.reset();
    const before = relayMiddleware.getMetrics();
    const relay = await runMiddlewareOnlyRelayScenario(pages, limit, category);
    const after = relayMiddleware.getMetrics();

    res.json({
      relay: Object.assign({}, relay, { calls: relayStore.stats().calls }),
      metrics: {
        totalRequests: after.totalRequests - before.totalRequests,
        aggregatedRequests: after.aggregatedRequests - before.aggregatedRequests,
        totalWindowsOpened: after.totalWindowsOpened - before.totalWindowsOpened,
        directGroupedFetches: after.directGroupedFetches - before.directGroupedFetches,
        guardrailFallbacks: after.guardrailFallbacks - before.guardrailFallbacks,
        guardrailSplits: after.guardrailSplits - before.guardrailSplits,
        cacheHits: after.cacheHits - before.cacheHits,
        cacheMisses: after.cacheMisses - before.cacheMisses
      }
    });
  } catch (error) {
    next(error);
  }
});

app.listen(port, () => {
  console.log(`\n🚀 semantic-relay demo running at http://localhost:${port}`);
  console.log('📋 AI Configuration:');
  console.log('   - Mode:', process.env.AI_MODE || 'adaptive');
  console.log('   - Cohere API Key:', process.env.COHERE_API_KEY ? '✅ Set' : '❌ Missing');
  console.log('   - Gemini API Key:', process.env.GEMINI_API_KEY ? '✅ Set' : '❌ Missing');
  console.log('   - Embedding Threshold:', parseFloat(process.env.EMBEDDING_THRESHOLD) || 0.85);
  console.log('   - Reasoning Threshold:', parseFloat(process.env.REASONING_THRESHOLD) || 0.6);
  console.log('   - Relay Threshold:', relayThreshold);
  console.log('   - Relay Window:', relayWindowMs + 'ms');
  console.log('\n⏳ Waiting for requests...\n');
});

// Test endpoint specifically designed to trigger AI evaluation
app.get('/api/test-ai', async (req, res) => {
  try {
    // Reset stores
    relayStore.reset();

    // Create a pair of requests with same page but different filter keys (semantic equivalence)
    const relayGroup = `ai-test-${Date.now()}`;
    const page = 1;
    const limit = 12;
    const category = 'hardware';

    // Request 1: category=hardware
    const req1Promise = fetch(`http://127.0.0.1:${port}/api/relay/products?page=${page}&limit=${limit}&category=${category}`, {
      headers: {
        'x-relay-group': relayGroup,
        'x-relay-expected-size': '2'
      }
    }).then(r => r.json());

    // Small delay to ensure they're in the same window but consecutive
    await new Promise(resolve => setTimeout(resolve, 3));

    // Request 2: type=hardware (semantically equivalent but different key)
    const req2Promise = fetch(`http://127.0.0.1:${port}/api/relay/products?page=${page}&limit=${limit}&type=${category}`, {
      headers: {
        'x-relay-group': relayGroup,
        'x-relay-expected-size': '2'
      }
    }).then(r => r.json());

    const [result1, result2] = await Promise.all([req1Promise, req2Promise]);

    // Get metrics after the requests
    const metrics = relayMiddleware.getMetrics();
    const decisions = relayMiddleware.getDecisionLog();

    res.json({
      success: true,
      result1Length: result1.length,
      result2Length: result2.length,
      metrics,
      recentDecisions: decisions.slice(0, 10)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
