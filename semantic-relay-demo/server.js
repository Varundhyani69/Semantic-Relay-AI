const path = require('path');
const express = require('express');
const semanticRelay = require('semantic-relay');

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
  if (filter && filter.category) {
    return productIndex.get(filter.category) || [];
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
  const category = typeof req.query.category === 'string' ? req.query.category : '';
  return {
    filter: category ? { category } : {},
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
  res.json({
    raw: rawStore.stats(),
    batch: batchStore.stats(),
    relay: relayStore.stats(),
    semanticBatch: semanticBatchStore.stats(),
    relayDemo: Object.assign({}, relayDemoStats),
    semanticRelay: relayMiddleware.getMetrics()
  });
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
    const pages = Array.from({ length: count }, (_, index) => index + 1);

    rawStore.reset();
    batchStore.reset();
    relayStore.reset();
    semanticBatchStore.reset();
    relayDemoStats.aggregateGroups = 0;
    relayDemoStats.aggregatedRequests = 0;
    relayDemoStats.fallbackRequests = 0;

    const raw = await runHttpScenario('/api/raw/products', pages, limit, category);
    const rawMetrics = rawStore.stats();

    const batch = await runHttpBatchScenario(pages, limit, category);
    const batchMetrics = batchStore.stats();

    const semanticBatch = await runHttpSemanticBatchScenario(pages, limit, category);
    const semanticBatchMetrics = semanticBatchStore.stats();

    const semanticRelayBefore = relayMiddleware.getMetrics();
    const relayGroup = `products-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const relay = await runHttpScenario('/api/relay/products', pages, limit, category, {
      headers: {
        'x-relay-group': relayGroup,
        'x-relay-expected-size': String(pages.length)
      }
    });
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
      pages,
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
  console.log(`semantic-relay demo running at http://localhost:${port}`);
});
