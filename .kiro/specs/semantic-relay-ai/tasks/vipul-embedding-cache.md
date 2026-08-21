# Vipul — Implementation Brief
## Branch: feat/vipul-embedding
## Files to create: src/ai/pattern-cache.js, src/ai/embedding-model.js
## Files to create (tests): test/pattern-cache.test.js, test/embedding-model.test.js
## Files to NOT touch: everything else — especially src/normalizer.js, src/scorer.js, src/index.js

---

## Project Context

You are working on `semantic-relay`, an Express middleware npm package. The package
currently groups similar paginated GET requests within a time window and executes a
single superset DB query instead of N separate queries.

You are adding the first layer of an AI upgrade: an embedding model (Cohere) that
computes semantic similarity between two API request filters, and a pattern cache that
stores known-safe equivalences so future requests skip the API call entirely.

The full flow once all teammates are done:
  Request pair arrives → check pattern cache → if miss, call Cohere (your code) →
  if ambiguous, call Gemini (Madhav's code) → validate (Madhav's code) →
  orchestrate all of the above (Varun's code) → wire into middleware (Varun's code)

Your job: implement pattern-cache.js and embedding-model.js with full tests.
These are standalone modules. They have no dependency on any other new file.

---

## File 1: src/ai/pattern-cache.js

### Purpose
Store validated-safe filter equivalence pairs so the system learns over time.
A cache hit means zero API calls for a previously seen request pair.

### Full implementation

```js
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_CACHE_FILE = path.join(__dirname, '..', '..', 'pattern-cache.json');
const DEFAULT_MAX_SIZE = 500;

class PatternCache {
  constructor(options = {}) {
    this.maxSize = options.maxSize || DEFAULT_MAX_SIZE;
    this.cacheFile = options.cacheFile || DEFAULT_CACHE_FILE;
    // Map: hash → { canonicalFilter, approvedAt, hitCount }
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;

    this._load();

    // Persist on shutdown
    process.on('exit', () => this._save());
    process.on('SIGINT', () => {
      this._save();
      process.exit(0);
    });
  }

  /**
   * Look up a known equivalence for two filter objects.
   * Order-independent: get(A, B) === get(B, A)
   * @returns {object|null} canonicalFilter or null if not cached
   */
  get(filterA, filterB) {
    const key = this._hash(filterA, filterB);
    const entry = this.cache.get(key);
    if (entry) {
      entry.hitCount++;
      this.hits++;
      return entry.canonicalFilter;
    }
    this.misses++;
    return null;
  }

  /**
   * Store a validated-safe equivalence.
   * Evicts oldest entry (by approvedAt) when at capacity.
   */
  set(filterA, filterB, canonicalFilter) {
    const key = this._hash(filterA, filterB);

    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      // Evict oldest
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.cache.entries()) {
        if (v.approvedAt < oldestTime) {
          oldestTime = v.approvedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      canonicalFilter,
      approvedAt: Date.now(),
      hitCount: 0
    });
  }

  getStats() {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size
    };
  }

  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Stable, order-independent hash of two filter objects.
   * hash(A, B) === hash(B, A)
   */
  _hash(filterA, filterB) {
    const strA = _stableStringify(filterA);
    const strB = _stableStringify(filterB);
    // Sort the two strings so order doesn't matter
    const combined = [strA, strB].sort().join('::');
    return crypto.createHash('sha256').update(combined).digest('hex');
  }

  _load() {
    try {
      if (!fs.existsSync(this.cacheFile)) return;
      const raw = fs.readFileSync(this.cacheFile, 'utf8');
      const entries = JSON.parse(raw);
      if (!Array.isArray(entries)) return;
      for (const [key, value] of entries) {
        this.cache.set(key, value);
      }
    } catch (err) {
      // Corrupt or missing file — start empty
      console.warn('[semantic-relay] pattern cache load failed, starting empty:', err.message);
    }
  }

  _save() {
    try {
      const entries = Array.from(this.cache.entries());
      fs.writeFileSync(this.cacheFile, JSON.stringify(entries), 'utf8');
    } catch (err) {
      // Non-fatal — just means patterns aren't persisted this session
    }
  }
}

function _stableStringify(obj) {
  if (obj === null || obj === undefined) return '';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(_stableStringify).join(',')}]`;
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${_stableStringify(obj[k])}`).join(',')}}`;
}

module.exports = PatternCache;
```

---

## File 2: src/ai/embedding-model.js

### Purpose
Convert two API request intents into text, send both to Cohere's embedding API,
compute cosine similarity, return a score 0.0–1.0.

If Cohere is unavailable for any reason, return score: -1 — never throw.

### Full implementation

```js
'use strict';

const COHERE_EMBED_URL = 'https://api.cohere.ai/v1/embed';
const DEFAULT_TIMEOUT_MS = 2000;

class EmbeddingModel {
  constructor(options = {}) {
    this.apiKey = options.apiKey || '';
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.model = 'embed-english-v3.0';
  }

  /**
   * Compute semantic similarity between two intents.
   * @param {object} intentA - { resource, filters, page, limit, ... }
   * @param {object} intentB - { resource, filters, page, limit, ... }
   * @returns {{ score: number, latencyMs: number, error?: string }}
   *   score is 0.0–1.0, or -1 if unavailable
   */
  async similarity(intentA, intentB) {
    const start = Date.now();
    try {
      const textA = this._intentToText(intentA);
      const textB = this._intentToText(intentB);
      const vectors = await this._callCohere([textA, textB]);
      const score = this._cosineSimilarity(vectors[0], vectors[1]);
      return { score, latencyMs: Date.now() - start };
    } catch (err) {
      return { score: -1, latencyMs: Date.now() - start, error: err.message };
    }
  }

  /**
   * Convert an intent into a text string for embedding.
   * Keys are sorted alphabetically for stable output.
   * Example: "resource: /products | brand: apple | category: laptops"
   */
  _intentToText(intent) {
    const filters = intent.filters || {};
    const sortedKeys = Object.keys(filters).sort();
    const filterParts = sortedKeys.map(k => `${k}: ${filters[k]}`);
    const parts = [`resource: ${intent.resource}`, ...filterParts];
    return parts.join(' | ');
  }

  /**
   * Cosine similarity between two float arrays.
   * Returns 0.0–1.0. Returns 0 if either vector is zero-length.
   */
  _cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0;
    // Clamp to [0, 1] — floating point can produce slightly > 1
    return Math.min(1, Math.max(0, dot / denom));
  }

  /**
   * Call Cohere /v1/embed endpoint.
   * @param {string[]} texts - array of text strings to embed
   * @returns {number[][]} - array of embedding vectors
   * @throws if request fails or times out
   */
  async _callCohere(texts) {
    if (!this.apiKey) {
      throw new Error('COHERE_API_KEY not set');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(COHERE_EMBED_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          texts,
          input_type: 'search_document',
          truncate: 'END'
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Cohere API ${response.status}: ${body.slice(0, 200)}`);
      }

      const data = await response.json();

      if (!data.embeddings || !Array.isArray(data.embeddings)) {
        throw new Error('Cohere response missing embeddings array');
      }

      return data.embeddings;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = EmbeddingModel;
```

---

## File 3: test/pattern-cache.test.js

```js
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const PatternCache = require('../src/ai/pattern-cache');

describe('PatternCache', () => {
  let tmpFile;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `pattern-cache-test-${Date.now()}.json`);
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  });

  it('returns null on empty cache', () => {
    const cache = new PatternCache({ cacheFile: tmpFile });
    expect(cache.get({ category: 'laptops' }, { type: 'laptop' })).toBeNull();
  });

  it('set then get returns canonical filter', () => {
    const cache = new PatternCache({ cacheFile: tmpFile });
    const canonical = { category: 'laptops' };
    cache.set({ category: 'laptops' }, { type: 'laptop' }, canonical);
    expect(cache.get({ category: 'laptops' }, { type: 'laptop' })).toEqual(canonical);
  });

  it('get is order-independent (A,B === B,A)', () => {
    const cache = new PatternCache({ cacheFile: tmpFile });
    const canonical = { category: 'laptops' };
    cache.set({ category: 'laptops' }, { type: 'laptop' }, canonical);
    expect(cache.get({ type: 'laptop' }, { category: 'laptops' })).toEqual(canonical);
  });

  it('evicts oldest entry when at maxSize', () => {
    const cache = new PatternCache({ cacheFile: tmpFile, maxSize: 2 });
    cache.set({ a: '1' }, { b: '1' }, { x: '1' });
    cache.set({ a: '2' }, { b: '2' }, { x: '2' });
    cache.set({ a: '3' }, { b: '3' }, { x: '3' }); // should evict first
    expect(cache.getStats().size).toBe(2);
    expect(cache.get({ a: '1' }, { b: '1' })).toBeNull(); // evicted
    expect(cache.get({ a: '3' }, { b: '3' })).toEqual({ x: '3' }); // present
  });

  it('getStats counts hits and misses', () => {
    const cache = new PatternCache({ cacheFile: tmpFile });
    cache.set({ a: '1' }, { b: '1' }, { x: '1' });
    cache.get({ a: '1' }, { b: '1' }); // hit
    cache.get({ a: '2' }, { b: '2' }); // miss
    cache.get({ a: '2' }, { b: '2' }); // miss
    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(2);
  });

  it('save and load round-trips correctly', () => {
    const cache1 = new PatternCache({ cacheFile: tmpFile });
    cache1.set({ category: 'laptops' }, { type: 'laptop' }, { category: 'laptops' });
    cache1._save();

    const cache2 = new PatternCache({ cacheFile: tmpFile });
    expect(cache2.get({ category: 'laptops' }, { type: 'laptop' })).toEqual({ category: 'laptops' });
  });

  it('starts empty if cache file is corrupt', () => {
    fs.writeFileSync(tmpFile, 'not valid json', 'utf8');
    const cache = new PatternCache({ cacheFile: tmpFile });
    expect(cache.getStats().size).toBe(0);
  });

  it('starts empty if cache file does not exist', () => {
    const cache = new PatternCache({ cacheFile: '/tmp/nonexistent-cache-xyz.json' });
    expect(cache.getStats().size).toBe(0);
  });
});
```

---

## File 4: test/embedding-model.test.js

```js
'use strict';

const EmbeddingModel = require('../src/ai/embedding-model');

// We mock fetch globally for these tests
global.fetch = jest.fn();

afterEach(() => {
  jest.resetAllMocks();
});

describe('EmbeddingModel._intentToText', () => {
  const model = new EmbeddingModel({ apiKey: 'test' });

  it('produces stable output regardless of filter key insertion order', () => {
    const intentA = { resource: '/products', filters: { category: 'laptops', maxPrice: '50000' } };
    const intentB = { resource: '/products', filters: { maxPrice: '50000', category: 'laptops' } };
    expect(model._intentToText(intentA)).toBe(model._intentToText(intentB));
  });

  it('sorts keys alphabetically', () => {
    const intent = { resource: '/products', filters: { z: '1', a: '2', m: '3' } };
    expect(model._intentToText(intent)).toBe('resource: /products | a: 2 | m: 3 | z: 1');
  });

  it('handles empty filters', () => {
    const intent = { resource: '/products', filters: {} };
    expect(model._intentToText(intent)).toBe('resource: /products');
  });
});

describe('EmbeddingModel._cosineSimilarity', () => {
  const model = new EmbeddingModel({ apiKey: 'test' });

  it('returns 1.0 for identical vectors', () => {
    expect(model._cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1.0);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    expect(model._cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
  });

  it('returns 0 for zero-length vectors', () => {
    expect(model._cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it('returns 0 for mismatched lengths', () => {
    expect(model._cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('clamps result to [0, 1]', () => {
    const score = model._cosineSimilarity([1, 1, 1], [1, 1, 1]);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe('EmbeddingModel.similarity', () => {
  it('returns score -1 when API key is not set', async () => {
    const model = new EmbeddingModel({ apiKey: '' });
    const result = await model.similarity(
      { resource: '/products', filters: { category: 'laptops' } },
      { resource: '/products', filters: { type: 'laptop' } }
    );
    expect(result.score).toBe(-1);
    expect(result.error).toBeDefined();
  });

  it('returns score -1 when Cohere returns non-200', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'rate limit exceeded'
    });
    const model = new EmbeddingModel({ apiKey: 'test-key' });
    const result = await model.similarity(
      { resource: '/products', filters: { category: 'laptops' } },
      { resource: '/products', filters: { type: 'laptop' } }
    );
    expect(result.score).toBe(-1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns score -1 on timeout', async () => {
    global.fetch.mockImplementationOnce(() =>
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('AbortError')), 100)
      )
    );
    const model = new EmbeddingModel({ apiKey: 'test-key', timeoutMs: 50 });
    const result = await model.similarity(
      { resource: '/products', filters: { category: 'laptops' } },
      { resource: '/products', filters: { type: 'laptop' } }
    );
    expect(result.score).toBe(-1);
  });

  it('returns score -1 when response has no embeddings field', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'abc' }) // missing embeddings
    });
    const model = new EmbeddingModel({ apiKey: 'test-key' });
    const result = await model.similarity(
      { resource: '/products', filters: { a: '1' } },
      { resource: '/products', filters: { b: '2' } }
    );
    expect(result.score).toBe(-1);
  });

  it('returns a score between 0 and 1 on successful response', async () => {
    const vecA = [1, 0, 0];
    const vecB = [0.9, 0.1, 0];
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [vecA, vecB] })
    });
    const model = new EmbeddingModel({ apiKey: 'test-key' });
    const result = await model.similarity(
      { resource: '/products', filters: { category: 'laptops' } },
      { resource: '/products', filters: { type: 'laptop' } }
    );
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
```

---

## How to run your tests

```bash
cd e:\Sementic-relay\semantic-relay
npx jest test/pattern-cache.test.js --no-coverage
npx jest test/embedding-model.test.js --no-coverage
```

Both test files must pass before you open your PR.
The existing `test/basic.test.js` must also still pass — run `npm test` to confirm.

---

## Interface contract for Varun (planner.js)

Varun's code will use your modules like this:

```js
const EmbeddingModel = require('./embedding-model');
const PatternCache = require('./pattern-cache');

const embedder = new EmbeddingModel({ apiKey: process.env.COHERE_API_KEY });
const cache = new PatternCache({ maxSize: 500 });

// Check cache first
const cached = cache.get(intentA.filters, intentB.filters);
if (cached) { /* use cached */ }

// On cache miss
const { score, latencyMs, error } = await embedder.similarity(intentA, intentB);
// score === -1 means Cohere unavailable → degrade gracefully

// After validator approves
cache.set(intentA.filters, intentB.filters, canonicalFilter);
```

Your modules must match this interface exactly.

---

## Git workflow — exactly 3 commits

### Setup (run once)
```bash
git clone https://github.com/Varundhyani69/Semantic-Relay.git
cd Semantic-Relay/semantic-relay
git checkout -b feat/vipul-embedding
npm install
```

---

### Commit 1 — PatternCache implementation + tests

Create these two files with the full code from this brief:
- `src/ai/pattern-cache.js`
- `test/pattern-cache.test.js`

Verify before committing:
```bash
npx jest test/pattern-cache.test.js --no-coverage
# All tests must pass
npm test
# Existing 9 tests must still pass
```

Commit:
```bash
git add src/ai/pattern-cache.js test/pattern-cache.test.js
git commit -m "feat(ai): add PatternCache with JSON persistence and LRU eviction

- Stores validated-safe filter equivalence pairs keyed by SHA-256 hash
- Order-independent: get(A,B) === get(B,A)
- Evicts oldest entry when at maxSize (default 500)
- Persists to pattern-cache.json on process exit and SIGINT
- Loads from disk on startup, starts empty if file is corrupt
- Tracks hit/miss counts for metrics"
```

---

### Commit 2 — EmbeddingModel implementation + tests

Create these two files with the full code from this brief:
- `src/ai/embedding-model.js`
- `test/embedding-model.test.js`

Verify before committing:
```bash
npx jest test/embedding-model.test.js --no-coverage
# All tests must pass
npm test
# All 9 existing + new tests must pass
```

Commit:
```bash
git add src/ai/embedding-model.js test/embedding-model.test.js
git commit -m "feat(ai): add EmbeddingModel wrapping Cohere embed-english-v3.0

- Converts intent filters to stable alphabetically-sorted text
- Calls Cohere /v1/embed via raw fetch with 2s timeout
- Computes cosine similarity, returns score 0.0-1.0
- Returns score:-1 on any failure (timeout, 4xx/5xx, missing key)
- Never throws to caller — all errors produce fallback result
- Records latencyMs on every call"
```

---

### Commit 3 — Create src/ai/ directory marker and open PR

This commit confirms the module directory is clean and all tests pass together.

```bash
# Run the full test suite one final time
npm test

# If green, push and open PR
git push -u origin feat/vipul-embedding
```

Then go to https://github.com/Varundhyani69/Semantic-Relay and open a Pull Request:
- Base: `main`
- Compare: `feat/vipul-embedding`
- Title: `feat: PatternCache + EmbeddingModel (Vipul)`
- Fill in the PR template checklist

Final commit if you need to fix anything after review:
```bash
git add <fixed files>
git commit -m "fix(ai): address PR review comments"
git push
```
