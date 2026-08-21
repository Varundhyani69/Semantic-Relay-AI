const { semanticRelay } = require('../src/index');
const normalizer = require('../src/normalizer');
const scorer = require('../src/scorer');
const supersetBuilder = require('../src/superset-builder');
const partitioner = require('../src/partitioner');

describe('semanticRelay core modules', () => {
  it('supports direct and named CommonJS imports', () => {
    const directImport = require('../src/index');

    expect(typeof directImport).toBe('function');
    expect(directImport.semanticRelay).toBe(semanticRelay);
  });

  it('normalizer extracts cleanly', () => {
    const req = {
      path: '/products',
      query: { page: '2', limit: '30', sort: 'desc' },
      headers: {
        'x-relay-group': 'grid-1',
        'x-relay-expected-size': '4'
      }
    };
    const intent = normalizer(req);
    expect(intent.resource).toBe('/products');
    expect(intent.page).toBe(2);
    expect(intent.limit).toBe(30);
    expect(intent.filters).toEqual({ sort: 'desc' });
    expect(intent.groupKey).toBe('grid-1');
    expect(intent.expectedGroupSize).toBe(4);
    expect(intent.intentId).toBeDefined();
  });

  it('normalizer falls back for invalid pagination', () => {
    const intent = normalizer({
      path: '/products',
      query: { page: '-2', limit: '0', type: 'book' }
    });

    expect(intent.page).toBe(1);
    expect(intent.limit).toBe(20);
    expect(intent.filters).toEqual({ type: 'book' });
  });

  it('scorer logic', () => {
    const intentA = { resource: '/products', page: 1, filters: { cat: 'shoes' } };
    const intentB = { resource: '/products', page: 2, filters: { cat: 'shoes' } };
    const intentC = { resource: '/users', page: 1, filters: { cat: 'shoes' } };
    
    expect(scorer(intentA, intentA)).toBe(1.0);
    expect(scorer(intentA, intentB)).toBe(0.9);
    expect(scorer(intentA, intentC)).toBe(0);
  });

  it('uses relay group hints for scoring', () => {
    const intentA = { resource: '/products', page: 1, filters: { cat: 'shoes' }, groupKey: 'grid-1' };
    const intentB = { resource: '/products', page: 16, filters: { cat: 'shoes' }, groupKey: 'grid-1' };
    const intentC = { resource: '/products', page: 2, filters: { cat: 'shoes' }, groupKey: 'grid-2' };

    expect(scorer(intentA, intentB)).toBe(0.95);
    expect(scorer(intentA, intentC)).toBe(0);
  });

  it('builds and partitions absolute ranges when limits differ', () => {
    const group = [
      { intent: { intentId: 'a', page: 2, limit: 2, filters: { cat: 'shoes' } } },
      { intent: { intentId: 'b', page: 1, limit: 5, filters: { cat: 'shoes' } } }
    ];

    const superset = supersetBuilder(group);
    expect(superset).toMatchObject({
      filter: { cat: 'shoes' },
      skip: 0,
      limit: 5,
      pages: [1, 2]
    });

    const partitions = partitioner([1, 2, 3, 4, 5], group, superset);
    expect(partitions.get('a')).toEqual([3, 4]);
    expect(partitions.get('b')).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('semanticRelay middleware', () => {
  jest.useFakeTimers();

  it('batches requests correctly', async () => {
    const mw = semanticRelay({
      windowMs: 20,
      threshold: 0.8,
      include: ['/products']
    });

    const createReqRes = (page) => {
      const intentId = 'id-' + page;
      const req = {
        method: 'GET',
        path: '/products',
        query: { page: String(page), limit: '2' },
      };
      let jsonResolve;
      const jsonPromise = new Promise(r => jsonResolve = r);
      const res = {
        json: jest.fn((data) => {
             jsonResolve(data);
        }),
        send: jest.fn((data) => jsonResolve(data))
      };
      const next = jest.fn();
      return { req, res, next, jsonPromise, intentId };
    };

    const ctx1 = createReqRes(1);
    const ctx2 = createReqRes(2);

    mw(ctx1.req, ctx1.res, ctx1.next);
    mw(ctx2.req, ctx2.res, ctx2.next);

    jest.advanceTimersByTime(25);

    await Promise.resolve(); // trigger microtasks
    await Promise.resolve();
    
    expect(ctx1.next).toHaveBeenCalled();
    expect(ctx2.next).not.toHaveBeenCalled();

    // the intercepting function overrides leader res
    ctx1.res.json([
      { id: 1 }, { id: 2 },
      { id: 3 }, { id: 4 }
    ]);

    await ctx1.jsonPromise;
    await ctx2.jsonPromise;
    
    expect(ctx1.res.json).toHaveBeenCalledWith([{ id: 1 }, { id: 2 }]);
    expect(ctx2.res.json).toHaveBeenCalledWith([{ id: 3 }, { id: 4 }]);
    
    const metrics = mw.getMetrics();
    expect(metrics.totalWindowsOpened).toBe(1);
    expect(metrics.queriesSaved).toBe(1);
  });

  it('intercepts send with a JSON array payload', async () => {
    const mw = semanticRelay({
      windowMs: 20,
      threshold: 0.8,
      include: ['/products']
    });

    const createReqRes = (page) => {
      const req = {
        method: 'GET',
        path: '/products',
        query: { page: String(page), limit: '2' },
      };
      let jsonResolve;
      const jsonPromise = new Promise(r => jsonResolve = r);
      const res = {
        json: jest.fn((data) => jsonResolve(data)),
        send: jest.fn((data) => jsonResolve(data))
      };
      const next = jest.fn();
      return { req, res, next, jsonPromise };
    };

    const ctx1 = createReqRes(1);
    const ctx2 = createReqRes(2);

    mw(ctx1.req, ctx1.res, ctx1.next);
    mw(ctx2.req, ctx2.res, ctx2.next);

    jest.advanceTimersByTime(25);
    await Promise.resolve();
    await Promise.resolve();

    ctx1.res.send(JSON.stringify([
      { id: 1 }, { id: 2 },
      { id: 3 }, { id: 4 }
    ]));

    await ctx1.jsonPromise;
    await ctx2.jsonPromise;

    expect(ctx1.res.json).toHaveBeenCalledWith([{ id: 1 }, { id: 2 }]);
    expect(ctx2.res.json).toHaveBeenCalledWith([{ id: 3 }, { id: 4 }]);
  });

  it('flushes early when the hinted group reaches its expected size', async () => {
    const mw = semanticRelay({
      windowMs: 50,
      threshold: 0.8,
      include: ['/products']
    });

    const createReqRes = (page) => {
      const req = {
        method: 'GET',
        path: '/products',
        query: { page: String(page), limit: '2' },
        headers: {
          'x-relay-group': 'grid-1',
          'x-relay-expected-size': '2'
        }
      };
      let jsonResolve;
      const jsonPromise = new Promise(r => jsonResolve = r);
      const res = {
        json: jest.fn((data) => jsonResolve(data)),
        send: jest.fn((data) => jsonResolve(data))
      };
      const next = jest.fn();
      return { req, res, next, jsonPromise };
    };

    const ctx1 = createReqRes(1);
    const ctx2 = createReqRes(2);

    mw(ctx1.req, ctx1.res, ctx1.next);
    mw(ctx2.req, ctx2.res, ctx2.next);

    jest.advanceTimersByTime(55);
    await Promise.resolve();
    await Promise.resolve();

    expect(ctx1.next).toHaveBeenCalledTimes(1);
    expect(ctx2.next).not.toHaveBeenCalled();

    ctx1.res.json([
      { id: 1 }, { id: 2 },
      { id: 3 }, { id: 4 }
    ]);

    await ctx1.jsonPromise;
    await ctx2.jsonPromise;

    expect(ctx1.res.json).toHaveBeenCalledWith([{ id: 1 }, { id: 2 }]);
    expect(ctx2.res.json).toHaveBeenCalledWith([{ id: 3 }, { id: 4 }]);
  });

  it('uses a registered route fetcher directly for grouped GET requests', async () => {
    const fetch = jest.fn(async (query) => {
      expect(query).toMatchObject({
        skip: 0,
        limit: 4,
        pages: [1, 2]
      });

      return [
        { id: 1 }, { id: 2 },
        { id: 3 }, { id: 4 }
      ];
    });

    const mw = semanticRelay({
      windowMs: 50,
      threshold: 0.8,
      include: ['/products'],
      routes: {
        '/products': { fetch }
      }
    });

    const createReqRes = (page) => {
      const req = {
        method: 'GET',
        path: '/products',
        query: { page: String(page), limit: '2' },
        headers: {
          'x-relay-group': 'grid-1',
          'x-relay-expected-size': '2'
        }
      };
      let jsonResolve;
      const jsonPromise = new Promise(r => jsonResolve = r);
      const res = {
        json: jest.fn((data) => jsonResolve(data)),
        send: jest.fn((data) => jsonResolve(data))
      };
      const next = jest.fn();
      return { req, res, next, jsonPromise };
    };

    const ctx1 = createReqRes(1);
    const ctx2 = createReqRes(2);

    mw(ctx1.req, ctx1.res, ctx1.next);
    mw(ctx2.req, ctx2.res, ctx2.next);

    await ctx1.jsonPromise;
    await ctx2.jsonPromise;

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ctx1.next).not.toHaveBeenCalled();
    expect(ctx2.next).not.toHaveBeenCalled();
    expect(ctx1.res.json).toHaveBeenCalledWith([{ id: 1 }, { id: 2 }]);
    expect(ctx2.res.json).toHaveBeenCalledWith([{ id: 3 }, { id: 4 }]);
  });

  it('falls back instead of building an oversized superset', async () => {
    const fetch = jest.fn();
    const mw = semanticRelay({
      windowMs: 50,
      threshold: 0.8,
      include: ['/products'],
      maxSupersetLimit: 10,
      maxPageGap: 2,
      routes: {
        '/products': { fetch }
      }
    });

    const createReqRes = (page) => {
      const req = {
        method: 'GET',
        path: '/products',
        query: { page: String(page), limit: '2' },
        headers: {
          'x-relay-group': 'wide-grid',
          'x-relay-expected-size': '2'
        }
      };
      const res = {
        json: jest.fn(),
        send: jest.fn()
      };
      const next = jest.fn();
      return { req, res, next };
    };

    const ctx1 = createReqRes(1);
    const ctx2 = createReqRes(100);

    mw(ctx1.req, ctx1.res, ctx1.next);
    mw(ctx2.req, ctx2.res, ctx2.next);

    jest.advanceTimersByTime(55);
    await Promise.resolve();
    await Promise.resolve();

    expect(fetch).not.toHaveBeenCalled();
    expect(ctx1.next).toHaveBeenCalledTimes(1);
    expect(ctx2.next).toHaveBeenCalledTimes(1);
    expect(ctx1.req.semanticRelay.fallbackReason).toBe('solo');
    expect(ctx2.req.semanticRelay.fallbackReason).toBe('solo');
  });

  it('caches repeated direct grouped fetches briefly', async () => {
    const fetch = jest.fn(async () => [
      { id: 1 }, { id: 2 },
      { id: 3 }, { id: 4 }
    ]);

    const mw = semanticRelay({
      windowMs: 50,
      threshold: 0.8,
      include: ['/products'],
      cacheTtlMs: 1000,
      routes: {
        '/products': { fetch }
      }
    });

    const createReqRes = (page, groupKey) => {
      const req = {
        method: 'GET',
        path: '/products',
        query: { page: String(page), limit: '2' },
        headers: {
          'x-relay-group': groupKey,
          'x-relay-expected-size': '2'
        }
      };
      let jsonResolve;
      const jsonPromise = new Promise(r => jsonResolve = r);
      const res = {
        json: jest.fn((data) => jsonResolve(data)),
        send: jest.fn((data) => jsonResolve(data))
      };
      const next = jest.fn();
      return { req, res, next, jsonPromise };
    };

    for (const groupKey of ['grid-1', 'grid-2']) {
      const ctx1 = createReqRes(1, groupKey);
      const ctx2 = createReqRes(2, groupKey);
      mw(ctx1.req, ctx1.res, ctx1.next);
      mw(ctx2.req, ctx2.res, ctx2.next);
      await ctx1.jsonPromise;
      await ctx2.jsonPromise;
    }

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mw.getMetrics().cacheHits).toBe(1);
  });

  it('falls followers back when the leader sends an error response', async () => {
    const mw = semanticRelay({
      windowMs: 20,
      threshold: 0.8,
      include: ['/products']
    });

    const createReqRes = (page, statusCode = 200) => {
      const req = {
        method: 'GET',
        path: '/products',
        query: { page: String(page), limit: '2' },
      };
      let jsonResolve;
      const jsonPromise = new Promise(r => jsonResolve = r);
      const res = {
        statusCode,
        json: jest.fn((data) => jsonResolve(data)),
        send: jest.fn((data) => jsonResolve(data))
      };
      const next = jest.fn();
      return { req, res, next, jsonPromise };
    };

    const ctx1 = createReqRes(1, 500);
    const ctx2 = createReqRes(2);

    mw(ctx1.req, ctx1.res, ctx1.next);
    mw(ctx2.req, ctx2.res, ctx2.next);

    jest.advanceTimersByTime(25);
    await Promise.resolve();
    await Promise.resolve();

    ctx1.res.json({ error: 'database failed' });

    await ctx1.jsonPromise;
    await Promise.resolve();

    expect(ctx1.res.json).toHaveBeenCalledWith({ error: 'database failed' });
    expect(ctx2.next).toHaveBeenCalledTimes(1);
    expect(ctx2.req.semanticRelay.fallbackReason).toBe('leader-error-response');
  });

  it('falls followers back when the leader never sends a response', async () => {
    const mw = semanticRelay({
      windowMs: 20,
      threshold: 0.8,
      include: ['/products'],
      responseTimeoutMs: 50
    });

    const createReqRes = (page) => {
      const req = {
        method: 'GET',
        path: '/products',
        query: { page: String(page), limit: '2' },
      };
      const res = {
        statusCode: 200,
        json: jest.fn(),
        send: jest.fn()
      };
      const next = jest.fn();
      return { req, res, next };
    };

    const ctx1 = createReqRes(1);
    const ctx2 = createReqRes(2);

    mw(ctx1.req, ctx1.res, ctx1.next);
    mw(ctx2.req, ctx2.res, ctx2.next);

    jest.advanceTimersByTime(25);
    await Promise.resolve();
    await Promise.resolve();

    expect(ctx1.next).toHaveBeenCalledTimes(1);
    expect(ctx2.next).not.toHaveBeenCalled();

    jest.advanceTimersByTime(50);
    await Promise.resolve();

    expect(ctx2.next).toHaveBeenCalledTimes(1);
    expect(ctx2.req.semanticRelay.fallbackReason).toBe('leader-timeout');
  });

  it('handles explicit semantic batch requests with one superset fetch', async () => {
    const fetch = jest.fn(async (query) => {
      expect(query).toMatchObject({
        filter: { category: 'books' },
        skip: 0,
        limit: 4,
        pages: [1, 2]
      });

      return [
        { id: 1 }, { id: 2 },
        { id: 3 }, { id: 4 }
      ];
    });

    const mw = semanticRelay({
      threshold: 0.8,
      routes: {
        '/products': { fetch }
      }
    });

    const req = {
      body: {
        requests: [
          { id: 'a', path: '/products', query: { page: '1', limit: '2', category: 'books' } },
          { id: 'b', path: '/products', query: { page: '2', limit: '2', category: 'books' } }
        ]
      }
    };
    let payload;
    const res = {
      statusCode: 200,
      status: jest.fn(function(code) {
        this.statusCode = code;
        return this;
      }),
      json: jest.fn((data) => {
        payload = data;
      })
    };
    const next = jest.fn();

    await mw.batchHandler(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(payload.responses).toEqual([
      { id: 'a', status: 200, body: [{ id: 1 }, { id: 2 }] },
      { id: 'b', status: 200, body: [{ id: 3 }, { id: 4 }] }
    ]);
    expect(payload.metrics).toEqual({ requests: 2, groups: 1, dbCalls: 1 });

    const metrics = mw.getMetrics();
    expect(metrics.explicitBatchCalls).toBe(1);
    expect(metrics.explicitBatchRequests).toBe(2);
    expect(metrics.explicitBatchGroups).toBe(1);
    expect(metrics.explicitBatchDbCalls).toBe(1);
  });
});
