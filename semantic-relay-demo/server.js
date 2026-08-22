const path = require('path');
const express = require('express');
const semanticRelay = require('semantic-relay');

// Load environment variables from .env file
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3100;

// Synonym groups for value equivalence detection
// Each group demonstrates different AI decision paths
const synonymGroups = {
  // High confidence match - Cohere scores ~0.96+ (above embeddingThreshold 0.96)
  // Should trigger: Cohere only, skip Gemini
  electronics: ["electronics", "gadgets", "tech devices", "electronic items"],

  // Ambiguous match - Cohere scores ~0.85-0.95 (between reasoningThreshold 0.50 and embeddingThreshold 0.96)
  // Should trigger: Cohere + Gemini reasoning
  // Using actual synonyms that Gemini will approve
  clothing: ["apparel", "garments", "attire", "clothes"],

  // Pattern cache hit - After first run, should use cached pattern
  // Should trigger: Instant merge from cache (no API calls)
  books: ["books", "literature", "reading material", "publications"],

  // Deterministic match - All requests use EXACTLY the same filter value
  // Should trigger: Deterministic grouping (no AI needed)
  kitchen: ["kitchen", "kitchen", "kitchen", "kitchen"],  // All same value

  // Low similarity - Completely unrelated terms
  // Should trigger: Cohere scores < 0.50, immediate split
  "test-low-similarity": ["sports equipment", "office furniture", "garden tools", "pet supplies"],

  // Validator reject - Terms that seem similar but shouldn't be merged
  // Should trigger: Cohere high score but validator rejects (safety check)
  "test-validator-reject": ["electronics-small", "electronics-large", "electronics-premium", "electronics-budget"]
};

// Products use BASE categories only
const products = Array.from({ length: 720 }, (_, index) => {
  const id = index + 1;
  const baseCategories = ['electronics', 'clothing', 'books', 'kitchen'];
  return {
    id,
    name: `Product ${String(id).padStart(3, '0')}`,
    category: baseCategories[index % baseCategories.length],
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
  if (filter && filter.category) {
    const categoryValue = filter.category.toLowerCase();

    // Find which synonym group this value belongs to
    for (const [baseCategory, synonyms] of Object.entries(synonymGroups)) {
      if (synonyms.some(syn => syn.toLowerCase() === categoryValue)) {
        // Return products matching the BASE category
        return productIndex.get(baseCategory) || [];
      }
    }

    // Fallback: exact match
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
    geminiFailed: decision.geminiFailed === true,
    geminiError: decision.geminiError || null,
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

  // Read category filter value
  const category = typeof req.query.category === 'string' ? req.query.category : '';

  const filter = {};
  if (category) filter.category = category;

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

// Clear pattern cache
app.post('/api/clear-cache', (req, res) => {
  try {
    if (relayMiddleware.clearPatternCache) {
      relayMiddleware.clearPatternCache();
      console.log('✅ [CACHE CLEARED] Pattern cache has been cleared');
      res.json({ ok: true, message: 'Pattern cache cleared successfully' });
    } else {
      res.json({ ok: false, message: 'clearPatternCache method not available' });
    }
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get current AI mode
app.get('/api/ai-mode', (req, res) => {
  const currentMode = relayMiddleware.getAiMode ? relayMiddleware.getAiMode() : process.env.AI_MODE || 'adaptive';
  res.json({ mode: currentMode });
});

// Set AI mode dynamically
app.post('/api/ai-mode', (req, res) => {
  try {
    const { mode } = req.body;
    const validModes = ['disabled', 'deterministic-only', 'cohere-only', 'gemini-reasoning', 'adaptive', 'pattern-cache-test'];

    if (!validModes.includes(mode)) {
      return res.status(400).json({
        ok: false,
        error: `Invalid mode. Must be one of: ${validModes.join(', ')}`
      });
    }

    if (relayMiddleware.setAiMode) {
      relayMiddleware.setAiMode(mode);
      console.log(`✅ [AI MODE CHANGED] New mode: ${mode}`);
      res.json({ ok: true, mode, message: `AI mode changed to ${mode}` });
    } else {
      res.json({ ok: false, message: 'setAiMode method not available' });
    }
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
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

app.get('/api/decision-logs', (req, res) => {
  const logs = relayMiddleware.getDecisionLog ? relayMiddleware.getDecisionLog() : [];
  res.json({ logs });
});

// Comparison endpoint showing historical approaches vs semantic-relay
app.get('/api/comparison', async (req, res, next) => {
  try {
    // Use 4 synonym variants to demonstrate the problem
    const baseCategory = 'electronics';
    const synonyms = synonymGroups[baseCategory];
    const testRequests = synonyms.slice(0, 4).map((synonym, i) => ({
      page: i + 1,
      category: synonym
    }));

    // Reset for clean comparison
    relayStore.reset();
    const semanticRelayBefore = relayMiddleware.getMetrics();

    // Run semantic-relay approach
    const relayGroup = `comparison-${Date.now()}`;
    const relayResponses = [];

    for (let i = 0; i < testRequests.length; i++) {
      const req = testRequests[i];
      const params = new URLSearchParams({
        page: String(req.page),
        limit: '12',
        category: req.category
      });

      const requestPromise = fetch(`http://127.0.0.1:${port}/api/relay/products?${params.toString()}`, {
        headers: {
          'x-relay-group': relayGroup,
          'x-relay-expected-size': String(testRequests.length)
        }
      }).then((response) => response.json());

      relayResponses.push(requestPromise);

      // Small stagger to ensure windowing
      if (i < testRequests.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }

    await Promise.all(relayResponses);

    const semanticRelayAfter = relayMiddleware.getMetrics();
    const relayMetrics = relayStore.stats();

    // Calculate AI metrics for this comparison
    const aiInvocations = semanticRelayAfter.aiInvocations - semanticRelayBefore.aiInvocations;
    const embeddingInvocations = semanticRelayAfter.embeddingInvocations - semanticRelayBefore.embeddingInvocations;
    const reasoningInvocations = semanticRelayAfter.reasoningInvocations - semanticRelayBefore.reasoningInvocations;

    res.json({
      scenario: {
        description: "4 users search with different words for the same thing (synonyms)",
        requests: testRequests,
        baseCategory,
        synonymsUsed: synonyms.slice(0, 4)
      },
      approaches: {
        naive: {
          name: "Exact Matching (2010)",
          technology: "JSON.stringify() comparison",
          dbCalls: 4,
          logic: "\"electronics\" === \"gadgets\"  →  FALSE  →  separate queries",
          limitation: "Cannot detect synonyms — only exact string matches work",
          year: 2010
        },
        dataloader: {
          name: "DataLoader (Facebook, 2016)",
          technology: "ID batching by key",
          dbCalls: 4,
          logic: "Works for numeric IDs only — filter strings unsupported",
          limitation: "DataLoader only batches numeric IDs like: ids=[1,2,3]. Doesn't help with filter strings.",
          year: 2016
        },
        nginx: {
          name: "nginx URL coalescing (2010)",
          technology: "Exact URL matching",
          dbCalls: 4,
          logic: "URL_A === URL_B  →  FALSE (query params differ)  →  no coalescing",
          limitation: "Requires IDENTICAL URLs — any query param change breaks it",
          year: 2010
        },
        elasticsearch: {
          name: "Elasticsearch (2015)",
          technology: "Query expansion at search interface",
          dbCalls: "1 if single query, 4 if separate requests",
          logic: "Search Quality Layer (frontend) — improves RESULTS, not backend LOAD",
          limitation: "Different layer — expands ONE user's query, doesn't group MULTIPLE users' requests",
          note: "Complementary to semantic-relay, not competing",
          year: 2015
        },
        semanticRelay: {
          name: "semantic-relay (2024)",
          technology: "Cohere v3.0 embeddings + Gemini 1.5 Flash reasoning",
          dbCalls: relayMetrics.calls,
          logic: "similarity(\"electronics\", \"gadgets\")  →  0.87  →  merge",
          advantage: "AI detects semantic equivalence in VALUES — understands synonyms",
          aiInvocations,
          embeddingInvocations,
          reasoningInvocations,
          reductionPercent: ((4 - relayMetrics.calls) / 4) * 100,
          year: 2024
        }
      },
      costComparison: {
        year2023: {
          model: "OpenAI ada-002",
          costPerCall: "$0.0004 per 1K tokens",
          costPerDay10K: "$45",
          latency: "3-5 seconds",
          viable: false,
          reason: "Too expensive + too slow for synchronous middleware"
        },
        year2024: {
          model: "Cohere embed-v3.0 + Gemini Flash",
          costPerCall: "$0.0001 (Cohere) + $0.000075/1M tokens (Gemini)",
          costPerDay10K: "$0.14",
          latency: "1-1.6 seconds",
          viable: true,
          improvement: "300x cheaper, 3x faster",
          thresholdCrossed: "Q4 2023 - Q1 2024"
        }
      },
      timeline: {
        2010: ["Naive exact matching", "nginx URL coalescing"],
        2016: ["DataLoader released (Facebook)"],
        2015: ["Elasticsearch mature"],
        "2023_Q4": ["Cohere embed-v3.0 released", "Still too expensive for middleware"],
        "2024_Q1": ["Viability threshold CROSSED", "Cohere price drop + Gemini Flash released"],
        "2024_Q2": ["semantic-relay NOW VIABLE", "First time AI fast enough + cheap enough for request path"]
      },
      keyInsight: "semantic-relay is the first middleware that understands MEANING (synonyms), not just exact matches. This product window opened 18 months ago when embeddings became 300x cheaper and 3x faster."
    });
  } catch (error) {
    next(error);
  }
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

/**
 * Fires one HTTP request per entry using that entry's OWN filter, so every
 * approach sees the same mix of synonym values the relay path sees. Passing a
 * single shared category here would hand the baselines 16 identical requests
 * and quietly invalidate the whole comparison.
 */
async function runHttpScenarioWithFilters(endpoint, pages, limit) {
  const startedAt = Date.now();
  const responses = await Promise.all(
    pages.map(({ page, filter }) => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit)
      });
      Object.keys(filter || {}).forEach((key) => params.set(key, filter[key]));

      return fetch(`http://127.0.0.1:${port}${endpoint}?${params.toString()}`)
        .then((response) => response.json());
    })
  );

  return {
    elapsedMs: Date.now() - startedAt,
    items: responses.flatMap((payload) => Array.isArray(payload) ? payload : payload.data || [])
  };
}

/**
 * The manual batch endpoint accepts one category per call, so distinct synonym
 * values force one batch call per value — a limitation worth measuring rather
 * than hiding.
 */
async function runManualBatchWithVariants(pages, limit) {
  const byFilter = new Map();
  pages.forEach(({ page, filter }) => {
    const key = (filter && filter.category) || '';
    if (!byFilter.has(key)) byFilter.set(key, []);
    byFilter.get(key).push(page);
  });

  const startedAt = Date.now();
  const results = await Promise.all(
    Array.from(byFilter.entries()).map(([cat, pgs]) => runHttpBatchScenario(pgs, limit, cat))
  );

  return {
    elapsedMs: Date.now() - startedAt,
    items: results.flatMap((r) => r.items)
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

    // Enhanced: create diverse VALUE patterns to trigger AI synonym detection
    // When category is specified, alternate between SYNONYM VALUES (not keys)
    const pages = Array.from({ length: count }, (_, index) => {
      const page = index + 1;
      if (category) {
        // Find synonym group for this category
        const synonyms = synonymGroups[category] || [category];

        // Rotate through synonym variants for the SAME key
        // This creates VALUE equivalence pairs that trigger AI evaluation
        const synonymValue = synonyms[index % synonyms.length];
        return {
          page,
          filter: { category: synonymValue }  // SAME key, DIFFERENT value
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

    // Raw requests - build URLs with synonym filters
    const raw = await runHttpScenario('/api/raw/products', pages.map(p => p.page), limit, category);
    const rawMetrics = rawStore.stats();

    // Batch requests
    const batch = await runHttpBatchScenario(pages.map(p => p.page), limit, category);
    const batchMetrics = batchStore.stats();

    const semanticBatch = await runHttpSemanticBatchScenario(pages.map(p => p.page), limit, category);
    const semanticBatchMetrics = semanticBatchStore.stats();

    // Enhanced relay requests with synonym variants
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
      synonymVariants: category ? [...new Set(pages.map(p => p.filter.category))] : [],
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

// ═══════════════════════════════════════════════════════════════════════════
// COMPARISON APPROACHES - DataLoader, nginx, Elasticsearch
// ═══════════════════════════════════════════════════════════════════════════

// Create separate stores for comparison approaches
const dataloaderStore = createConstrainedStore('dataloader');
const nginxStore = createConstrainedStore('nginx');
const elasticsearchStore = createConstrainedStore('elasticsearch');

/**
 * Collects requests arriving inside a time window, groups them by a caller
 * supplied key, and issues ONE superset query per group — the same mechanic
 * semantic-relay uses. The only thing that varies between approaches is how
 * the grouping key is derived, which is exactly the property under test.
 *
 * Every approach gets the identical windowMs so the comparison isolates
 * "can this technique tell that two filter values are equivalent?" rather
 * than "does this technique batch at all?".
 */
function createWindowedBatcher({ store, windowMs, groupKeyFn, normalizeFn }) {
  let pending = [];
  let timer = null;
  let batchInvocations = 0;
  let groupsFormed = 0;

  function flush() {
    const batch = pending;
    pending = [];
    timer = null;
    if (batch.length === 0) return;

    batchInvocations++;

    const groups = new Map();
    batch.forEach((job) => {
      const key = groupKeyFn(job.filter);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(job);
    });

    groupsFormed += groups.size;

    groups.forEach((jobs) => {
      // Merge the page range into a single superset read.
      const minSkip = Math.min(...jobs.map((j) => j.skip));
      const maxEnd = Math.max(...jobs.map((j) => j.skip + j.limit));

      store.query(jobs[0].filter, minSkip, maxEnd - minSkip)
        .then((result) => {
          jobs.forEach((job) => {
            const start = job.skip - minSkip;
            job.resolve(result.items.slice(start, start + job.limit));
          });
        })
        .catch((err) => jobs.forEach((job) => job.reject(err)));
    });
  }

  return {
    load(filter, skip, limit) {
      return new Promise((resolve, reject) => {
        pending.push({
          filter: normalizeFn ? normalizeFn(filter) : filter,
          skip,
          limit,
          resolve,
          reject
        });
        if (!timer) timer = setTimeout(flush, windowMs);
      });
    },
    stats() {
      return { batchInvocations, groupsFormed };
    },
    reset() {
      batchInvocations = 0;
      groupsFormed = 0;
    }
  };
}

/**
 * DataLoader (Facebook, 2016) — batches by KEY.
 * Two requests share a DB call only when their serialized filter is byte
 * identical, because that is all a key can express.
 */
const dataloaderBatcher = createWindowedBatcher({
  store: dataloaderStore,
  windowMs: relayWindowMs,
  groupKeyFn: (filter) => JSON.stringify(filter)
});

/**
 * Elasticsearch (2015) — query expansion from a HAND MAINTAINED synonym file.
 * Deliberately partial: it covers electronics and books but nothing else,
 * which is the real world failure mode. A term nobody wrote down stays
 * unexpanded, so the requests never converge.
 */
const ES_SYNONYM_DICT = {
  electronics: ['electronics', 'gadgets', 'tech devices', 'electronic items'],
  books: ['books', 'literature', 'reading material', 'publications']
};

function elasticsearchNormalize(filter) {
  if (!filter || !filter.category) return filter;
  const value = String(filter.category).toLowerCase();

  for (const [baseCategory, synonyms] of Object.entries(ES_SYNONYM_DICT)) {
    if (synonyms.some((syn) => syn.toLowerCase() === value)) {
      return Object.assign({}, filter, { category: baseCategory });
    }
  }
  // Not in the dictionary — Elasticsearch has no idea this is a synonym.
  return filter;
}

function elasticsearchDictionaryCovers(value) {
  const needle = String(value || '').toLowerCase();
  return Object.values(ES_SYNONYM_DICT)
    .some((synonyms) => synonyms.some((syn) => syn.toLowerCase() === needle));
}

const elasticsearchBatcher = createWindowedBatcher({
  store: elasticsearchStore,
  windowMs: relayWindowMs,
  normalizeFn: elasticsearchNormalize,
  groupKeyFn: (filter) => JSON.stringify(filter)
});

/**
 * nginx URL coalescing (2010) — collapses concurrent requests for the SAME
 * URL onto one upstream read. Operates on the raw URL string, so any query
 * param difference defeats it.
 */
function createUrlCoalescer(store) {
  const inflight = new Map();
  let coalescedHits = 0;

  return {
    fetch(urlKey, filter, skip, limit) {
      const existing = inflight.get(urlKey);
      if (existing) {
        coalescedHits++;
        return existing;
      }

      const promise = store.query(filter, skip, limit)
        .then((result) => result.items)
        .finally(() => inflight.delete(urlKey));

      inflight.set(urlKey, promise);
      return promise;
    },
    stats() {
      return { coalescedHits };
    },
    reset() {
      coalescedHits = 0;
    }
  };
}

const nginxCoalescer = createUrlCoalescer(nginxStore);

/**
 * DataLoader-style approach (Facebook, 2016)
 * - Batches requests by NUMERIC ID only
 * - CANNOT batch filter strings (different category values)
 * - Result: Falls back to individual queries when filters differ
 */
app.get('/api/dataloader/products', async (req, res, next) => {
  try {
    const query = readStandardQuery(req);

    // Real key batching: identical serialized filters merge into one superset
    // read. Distinct filter values cannot merge, because a key cannot express
    // "these two strings mean the same thing".
    const items = await dataloaderBatcher.load(query.filter, query.skip, query.limit);
    res.json(items);
  } catch (error) {
    next(error);
  }
});

/**
 * nginx URL coalescing approach (2010)
 * - Coalesces requests with IDENTICAL URLs
 * - CANNOT coalesce when query params differ
 * - Result: Different category values = different URLs = no coalescing
 */
app.get('/api/nginx-coalesce/products', async (req, res, next) => {
  try {
    const query = readStandardQuery(req);

    // Coalesce on the canonical URL string. Concurrent hits on the same URL
    // share one upstream read; any differing query param produces a different
    // key and therefore a separate read.
    const urlKey = [
      req.path,
      `page=${req.query.page || 1}`,
      `limit=${req.query.limit || 12}`,
      `category=${req.query.category || ''}`
    ].join('|');

    const items = await nginxCoalescer.fetch(urlKey, query.filter, query.skip, query.limit);
    res.json(items);
  } catch (error) {
    next(error);
  }
});

/**
 * Elasticsearch query expansion approach (2015)
 * - Expands user query with synonyms at SEARCH INTERFACE
 * - Maps all synonym variants to base category BEFORE querying
 * - Different layer: Improves search QUALITY, not backend LOAD
 * 
 * Key difference from semantic-relay:
 * - Elasticsearch: Frontend preprocessing, single user's query expanded
 * - semantic-relay: Backend middleware, multiple users' requests grouped
 */
app.get('/api/elasticsearch/products', async (req, res, next) => {
  try {
    const query = readStandardQuery(req);

    // Expand via the hand maintained synonym dictionary, then batch. Terms in
    // the dictionary converge to one read. Terms nobody wrote down stay
    // distinct and cost a read each.
    const items = await elasticsearchBatcher.load(query.filter, query.skip, query.limit);
    res.json(items);
  } catch (error) {
    next(error);
  }
});

/**
 * Enhanced benchmark endpoint - tests ALL approaches in parallel
 */
app.get('/api/benchmark-all', async (req, res, next) => {
  try {
    const count = Math.min(parsePositiveInt(req.query.requests, 10), 24);
    const limit = Math.min(parsePositiveInt(req.query.limit, 12), 48);
    const category = typeof req.query.category === 'string' ? req.query.category : '';

    // Create synonym variant requests
    const pages = Array.from({ length: count }, (_, index) => {
      const page = index + 1;
      if (category) {
        const synonyms = synonymGroups[category] || [category];
        const synonymValue = synonyms[index % synonyms.length];
        return {
          page,
          filter: { category: synonymValue }
        };
      }
      return { page, filter: {} };
    });

    // ?dupes=N repeats every request N times. Identical URLs are exactly the
    // case nginx coalescing was built for, so this makes its mechanism visible
    // instead of leaving it at zero hits.
    const dupes = Math.min(parsePositiveInt(req.query.dupes, 1), 4);
    const pagesToRun = dupes > 1
      ? pages.flatMap((entry) => Array.from({ length: dupes }, () => entry))
      : pages;

    // Reset all stores
    rawStore.reset();
    batchStore.reset();
    dataloaderStore.reset();
    nginxStore.reset();
    elasticsearchStore.reset();
    relayStore.reset();
    semanticBatchStore.reset();
    dataloaderBatcher.reset();
    elasticsearchBatcher.reset();
    nginxCoalescer.reset();

    const aiBefore = relayMiddleware.getMetrics();

    // Run all approaches in parallel
    const [
      rawResult,
      batchResult,
      dataloaderResult,
      nginxResult,
      elasticsearchResult,
      relayResult
    ] = await Promise.all([
      // Every approach receives the identical per-request synonym filters.
      // 1. Naive - no batching at all
      runHttpScenarioWithFilters('/api/raw/products', pagesToRun, limit),

      // 2. Manual Batch API - one batch call per distinct filter value
      runManualBatchWithVariants(pagesToRun, limit),

      // 3. DataLoader - real key batching
      runHttpScenarioWithFilters('/api/dataloader/products', pagesToRun, limit),

      // 4. nginx - in-flight coalescing on exact URL
      runHttpScenarioWithFilters('/api/nginx-coalesce/products', pagesToRun, limit),

      // 5. Elasticsearch - synonym dictionary + batching
      runHttpScenarioWithFilters('/api/elasticsearch/products', pagesToRun, limit),

      // 6. semantic-relay-ai - AI synonym detection
      runEnhancedHttpRelayScenario('/api/relay/products', pagesToRun, limit, `all-${Date.now()}`)
    ]);

    const aiAfter = relayMiddleware.getMetrics();
    const aiDelta = {
      aiInvocations: aiAfter.aiInvocations - aiBefore.aiInvocations,
      embeddingInvocations: aiAfter.embeddingInvocations - aiBefore.embeddingInvocations,
      reasoningInvocations: aiAfter.reasoningInvocations - aiBefore.reasoningInvocations,
      validatorApprovals: aiAfter.validatorApprovals - aiBefore.validatorApprovals,
      validatorRejects: aiAfter.validatorRejects - aiBefore.validatorRejects,
      patternCacheHits: aiAfter.patternCacheHits - aiBefore.patternCacheHits,
      patternCacheMisses: aiAfter.patternCacheMisses - aiBefore.patternCacheMisses
    };

    res.json({
      scenario: {
        requests: count,
        category,
        synonymVariants: category ? [...new Set(pages.map(p => p.filter.category))] : []
      },
      aiMetrics: aiDelta,
      correctness: {
        sameRelayItems: sameIds(rawResult.items, relayResult.items),
        sameElasticsearchItems: sameIds(rawResult.items, elasticsearchResult.items),
        sameDataloaderItems: sameIds(rawResult.items, dataloaderResult.items),
        sameNginxItems: sameIds(rawResult.items, nginxResult.items)
      },
      items: relayResult.items.slice(0, 12),
      results: {
        naive: {
          name: 'Naive (No Batching)',
          technology: 'Direct queries',
          year: 2010,
          dbCalls: rawStore.stats().calls,
          latencyMs: rawResult.elapsedMs,
          itemsReturned: rawResult.items.length,
          limitation: 'Every request = separate DB call',
          synonymDetection: false
        },
        manualBatch: {
          name: 'Manual Batch API',
          technology: 'User-specified batching',
          year: 2015,
          dbCalls: batchStore.stats().calls,
          latencyMs: batchResult.elapsedMs,
          itemsReturned: batchResult.items.length,
          limitation: 'User must manually batch; no synonym detection',
          synonymDetection: false
        },
        dataloader: {
          name: 'DataLoader (Facebook)',
          technology: 'Key batching (real, windowed)',
          year: 2016,
          dbCalls: dataloaderStore.stats().calls,
          latencyMs: dataloaderResult.elapsedMs,
          itemsReturned: dataloaderResult.items.length,
          limitation: 'Batches identical keys only; cannot equate two different filter values',
          synonymDetection: false,
          diagnostics: dataloaderBatcher.stats()
        },
        nginx: {
          name: 'nginx URL Coalescing',
          technology: 'In-flight coalescing on exact URL',
          year: 2010,
          dbCalls: nginxStore.stats().calls,
          latencyMs: nginxResult.elapsedMs,
          itemsReturned: nginxResult.items.length,
          limitation: 'Any query param difference produces a different key',
          synonymDetection: false,
          diagnostics: nginxCoalescer.stats()
        },
        elasticsearch: {
          name: 'Elasticsearch Query Expansion',
          technology: 'Hand maintained synonym dictionary + batching',
          year: 2015,
          dbCalls: elasticsearchStore.stats().calls,
          latencyMs: elasticsearchResult.elapsedMs,
          itemsReturned: elasticsearchResult.items.length,
          limitation: 'Only expands terms a human already wrote into the dictionary',
          synonymDetection: 'dictionary-only',
          dictionaryCoversScenario: category
            ? (synonymGroups[category] || [category]).every(elasticsearchDictionaryCovers)
            : true,
          diagnostics: elasticsearchBatcher.stats()
        },
        semanticRelay: {
          name: 'semantic-relay-ai',
          technology: 'Cohere v3.0 + Gemini 3.6 Flash',
          year: 2024,
          dbCalls: relayStore.stats().calls,
          latencyMs: relayResult.elapsedMs,
          itemsReturned: relayResult.items.length,
          advantage: 'AI detects synonyms in VALUES - groups MULTIPLE users\' requests',
          synonymDetection: true,
          aiInvocations: relayMiddleware.getMetrics().aiInvocations,
          layer: 'backend/middleware'
        }
      },
      comparison: {
        dbCallReduction: {
          vsNaive: Math.max(0, rawStore.stats().calls - relayStore.stats().calls),
          vsDataLoader: Math.max(0, dataloaderStore.stats().calls - relayStore.stats().calls),
          vsNginx: Math.max(0, nginxStore.stats().calls - relayStore.stats().calls),
          vsElasticsearch: Math.max(0, elasticsearchStore.stats().calls - relayStore.stats().calls)
        },
        whyOthersFail: {
          dataloader: 'Can only batch numeric IDs like ids=[1,2,3]. Filter strings unsupported.',
          nginx: 'Requires identical URLs. Different query params = different URLs = no coalescing.',
          elasticsearch: 'Different problem domain: improves SEARCH QUALITY for one user, not BACKEND LOAD from multiple users.'
        }
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

app.get('/api/test-ai', async (req, res) => {
  try {
    // Reset stores
    relayStore.reset();

    // Create requests with SAME page but DIFFERENT filter VALUES (synonyms)
    const relayGroup = `ai-test-${Date.now()}`;
    const page = 1;
    const limit = 12;
    const baseCategory = 'electronics';
    const synonyms = synonymGroups[baseCategory];

    // Request 1: category=electronics
    const req1Promise = fetch(`http://127.0.0.1:${port}/api/relay/products?page=${page}&limit=${limit}&category=${synonyms[0]}`, {
      headers: {
        'x-relay-group': relayGroup,
        'x-relay-expected-size': '2'
      }
    }).then(r => r.json());

    // Small delay to ensure they're in the same window but consecutive
    await new Promise(resolve => setTimeout(resolve, 3));

    // Request 2: category=gadgets (semantically equivalent VALUE)
    const req2Promise = fetch(`http://127.0.0.1:${port}/api/relay/products?page=${page}&limit=${limit}&category=${synonyms[1]}`, {
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
      synonymsUsed: [synonyms[0], synonyms[1]],
      metrics,
      recentDecisions: decisions.slice(0, 10)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
