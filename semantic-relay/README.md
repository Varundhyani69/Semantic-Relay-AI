# semantic-relay

[![CI](https://github.com/Varundhyani69/Semantic-Relay/actions/workflows/nodejs.yml/badge.svg)](https://github.com/Varundhyani69/Semantic-Relay/actions/workflows/nodejs.yml)

An Express middleware that batches similar incoming GET requests within a short time window, groups them by semantic similarity, and executes a single "superset" DB query. It partitions the result back to each original caller individually, drastically reducing redundant database calls in monolithic Express/MongoDB apps.

Where it differs from every other batching layer: it groups requests whose filter **values** mean the same thing. Four users searching `electronics`, `gadgets`, `tech devices` and `electronic items` become one database call, with no synonym list written by hand.

## Hackathon submission

| Deliverable | File |
|---|---|
| Architecture diagram | [ARCHITECTURE-DIAGRAM.md](./ARCHITECTURE-DIAGRAM.md) |
| Failure log | [FAILURE-LOG.md](./FAILURE-LOG.md) |
| Prior art (3 closest products) | [PRIOR-ART.md](./PRIOR-ART.md) |
| 2-minute pitch | [PITCH-SCRIPT.md](./PITCH-SCRIPT.md) |
| Live demo | `cd ../semantic-relay-demo && node server.js` → http://localhost:3100 |
| Evaluation harness | `npm run eval` (20 cases, exits 1 below 80% accuracy) |

**Track:** Developer Tooling

### Declared constraints (two required, four met)

1. **Two models, not one.** Cohere `embed-english-v3.0` scores similarity; only the ambiguous band (0.50–0.974) escalates to Gemini `gemini-3.6-flash` for a reasoned verdict. Neither model can produce a merge alone — Cohere never decides in the ambiguous band, and Gemini is never consulted outside it.
2. **Degrade gracefully.** Cohere unreachable → deterministic scoring, `aiStatus: 'degraded'`. Gemini failing → the failure is reported as `geminiFailed` with its error class, explicitly *not* as a "not equivalent" verdict. Demonstrable live by setting an invalid key.

Also satisfied: **handle being wrong** (a validator with hard veto power over both models, plus `validatorRejects` metric), and **cost ceiling** (below).

### Cost ceiling

**$0.14/day at 10,000 requests/day.** Derivation: ~10K Cohere embed calls × $0.0001 = $1.00/day worst case, but the pattern cache collapses repeat filter pairs to zero API calls, and measured cache hit rates put real embed volume near 1.4K/day → ~$0.14. Gemini fires only in the ambiguous band (~5% of groups) at ~500 tokens × $0.075/1M ≈ $0.002/day. The 2023 equivalent was roughly $45/day at 3–5s latency, which is why this could not have shipped then.

## Measured against prior art

16 concurrent requests across 4 synonym values, identical input and identical 500ms window for every approach:

| Approach | DB calls | Latency |
|---|---|---|
| Naive | 16 | 1627ms |
| DataLoader (key batching) | 4 | 1012ms |
| nginx (URL coalescing) | 16 | 1589ms |
| Elasticsearch (synonym dictionary) | 1 | 795ms |
| **semantic-relay-ai** | **1** | 2997ms |

Read honestly: batching alone gets 16 → 4, and Elasticsearch reaches 1 *and beats us on latency* when its hand-maintained dictionary happens to cover your terms. Our claim is narrower and load-bearing — swap to a synonym group absent from that dictionary and Elasticsearch degrades to 4 calls while we stay at 1. Full numbers and caveats in [PRIOR-ART.md](./PRIOR-ART.md).

Reproduce: `GET /api/benchmark-all?requests=16&category=electronics` then `&category=clothing`.

## Features
- **Zero Production Dependencies** (only uses `uuid`)
- Dual-model semantic planner with pattern cache and validator veto
- Swappable storage adapter for window management
- Groups similar overlapping pagination queries
- Built-in metrics tracking, including per-model invocation counts and cost

## Installation

```bash
npm install semantic-relay
```

## Basic Usage

1. **Mount the middleware in your Express app:**

```javascript
const express = require('express');
const { semanticRelay } = require('semantic-relay');
const app = express();

app.use(semanticRelay({
  windowMs: 20, // Collect requests for 20ms
  threshold: 0.8, // Similarity score threshold for grouping
  include: ['/products', '/users'], // Optional route prefixes to watch (all GETs if omitted)
  responseTimeoutMs: 30000, // Fallback followers if the leader never sends JSON
  onAggregate: (group) => console.log(`Aggregated ${group.length} requests`),
  onFallback: (req) => console.log(`Group size 1, fallback to normal execution`)
}));
```

You can also import the middleware directly:

```javascript
const semanticRelay = require('semantic-relay');
```

2. **Adapt your Route Handler (Mongoose Example):**

Since `semantic-relay` executes your route handler ONCE for a group of requests, your route handler needs to use the grouped `superset` query provided by `req.semanticRelay` if it exists.

```javascript
app.get('/products', async (req, res) => {
  // Check if semantic-relay has batched requests
  const aggregation = req.semanticRelay;
  
  // Use the superset query if it exists; otherwise use the original from req.query
  const filter = aggregation?.query?.filter || req.query.filter || {};
  
  // Example for pagination
  const baseSkip = (parseInt(req.query.page) - 1) * parseInt(req.query.limit || 20);
  const skip = aggregation?.query?.skip ?? baseSkip;
  const limit = aggregation?.query?.limit ?? parseInt(req.query.limit || 20);

  // Execute the database call ONCE
  const products = await Product.find(filter)
    .skip(skip)
    .limit(limit)
    .exec();

  // semantic-relay intercepts this call, partitions the results,
  // and intelligently slices the array down to each original caller
  res.json(products);
});
```

## Integration Notes

- Mount `semanticRelay` before the GET routes you want to batch.
- Use it only for idempotent list endpoints that return arrays or `{ data: [...] }`.
- Include all data-shaping inputs in query params, especially filters, sort order, page, and limit.
- Do not use it for streaming, file downloads, HTML pages, or routes where each request can see different data unless that user/security scope is represented in the query filters.
- If the leader request returns an error status (`4xx` or `5xx`), follower requests fall back to normal route execution.

## Metrics
You can fetch performance metrics to see how many DB calls you successfully omitted:

```javascript
const { semanticRelay } = require('semantic-relay');
const relayMiddleware = semanticRelay({ ... });

app.use(relayMiddleware);

app.get('/metrics', (req, res) => {
  res.json(relayMiddleware.getMetrics());
});
```

## Explicit Semantic Batch API

For clients that can use a batch endpoint, register route fetchers and mount `batchHandler`. This mode does not wait for `windowMs`; it receives the full request set up front, builds semantic superset queries, fetches once per group, and partitions responses.

```javascript
const relay = semanticRelay({
  routes: {
    '/products': {
      fetch: async ({ filter, skip, limit }) => {
        return Product.find(filter).skip(skip).limit(limit).exec();
      }
    }
  }
});

app.use(relay);
app.post('/batch', express.json(), relay.batchHandler);
```

Request:

```json
{
  "requests": [
    { "id": "p1", "path": "/products", "query": { "page": "1", "limit": "20", "category": "books" } },
    { "id": "p2", "path": "/products", "query": { "page": "2", "limit": "20", "category": "books" } }
  ]
}
```

Response:

```json
{
  "responses": [
    { "id": "p1", "status": 200, "body": [] },
    { "id": "p2", "status": 200, "body": [] }
  ],
  "metrics": { "requests": 2, "groups": 1, "dbCalls": 1 }
}
```

## Options Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `windowMs` | `number` | `20` | How long to hold incoming requests before flushing the window |
| `threshold` | `number` | `0.8` | Grouping strictness (1.0 = exact params) |
| `include` | `string[]` | `[]` | Intercepts all GET requests by default. When set, only matching path prefixes are watched (e.g., `['/api']`) |
| `responseTimeoutMs` | `number` | `30000` | Maximum time followers wait for the leader response before falling back to normal route execution |
| `routes` | `object` | `{}` | Route fetchers used by `batchHandler` for explicit semantic batch requests |
| `onAggregate` | `function` | `() => {}` | Callback invoked when a group of similarity requests fires |
| `onFallback` | `function` | `() => {}` | Callback invoked when a standalone request fires |
| `window` | `WindowAdapter`| `new MemoryWindow()` | Injectable cache driver for microservice setups |

## Response Contract

For grouped requests, the route should call `res.json(array)`, `res.json({ data: array })`, or `res.send()` with a JSON-serialized array/object in that shape. The middleware partitions the returned array and sends each original request its own slice.
