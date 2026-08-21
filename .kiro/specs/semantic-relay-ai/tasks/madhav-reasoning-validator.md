# Madhav — Implementation Brief
## Branch: feat/madhav-reasoning
## Files to create: src/ai/reasoning-model.js, src/ai/validator.js
## Files to create (tests): test/reasoning-model.test.js, test/validator.test.js
## Files to NOT touch: everything else — especially src/normalizer.js, src/scorer.js, src/index.js

---

## Project Context

You are working on `semantic-relay`, an Express middleware npm package that groups
similar paginated GET requests and executes a single superset DB query.

You are adding two critical pieces of an AI upgrade:

1. **ReasoningModel** — calls Google Gemini 1.5 Flash when the embedding model (Cohere)
   is not confident enough. Gemini looks at two API requests and decides if they are
   semantically equivalent (e.g. `?category=laptops` and `?type=laptop`).

2. **Validator** — a purely deterministic safety gate. It receives the AI's proposed
   merge plan and checks it for safety. The AI has NO execution authority.
   This function is the final authority. If it rejects, the merge does not happen.

The full flow once all teammates are done:
  Request pair → pattern cache → Cohere embedding (Vipul) →
  if ambiguous → Gemini reasoning (your code) → validator (your code) →
  orchestrate all (Varun) → wire into middleware (Varun)

Your job: implement reasoning-model.js and validator.js with full tests.
These are standalone modules with no dependency on any other new file.

---

## Key data types used across the project

```js
// Intent (existing — produced by src/normalizer.js, do not modify)
{
  intentId: string,       // uuid
  resource: string,       // e.g. '/products'
  page: number,
  limit: number,
  filters: Record<string, unknown>,  // e.g. { category: 'laptops', maxPrice: '50000' }
  groupKey: string | null,
  expectedGroupSize: number
}

// GeminiResponse — what your reasoning model parses from Gemini
{
  equivalent: boolean,
  canonicalFilter: Record<string, unknown> | null,
  confidence: number,       // 0.0–1.0
  reason: string
}

// ValidationResult — what your validator returns
{
  safe: boolean,
  reason: string   // one of the reason codes listed below
}
```

---

## File 1: src/ai/reasoning-model.js

### Purpose
Call Gemini 1.5 Flash to analyze two semantically ambiguous API request intents.
Return a structured plan: are they equivalent? What is the canonical filter?
Handle all errors gracefully — never throw to the caller.

### Full implementation

```js
'use strict';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';
const DEFAULT_TIMEOUT_MS = 5000;

class ReasoningModel {
  constructor(options = {}) {
    this.apiKey = options.apiKey || '';
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  /**
   * Analyze two intents and determine if they are semantically equivalent.
   * Only called when Cohere similarity score is in the ambiguous range (0.6–0.84).
   *
   * @param {object} intentA
   * @param {object} intentB
   * @param {number} cohereScore - the Cohere similarity score that triggered this call
   * @returns {{
   *   equivalent: boolean,
   *   canonicalFilter: object|null,
   *   confidence: number,
   *   reason: string,
   *   latencyMs: number,
   *   tokenCount: number
   * }}
   * Never throws. Returns safe fallback on any error.
   */
  async analyze(intentA, intentB, cohereScore) {
    const start = Date.now();
    try {
      if (!this.apiKey) {
        throw new Error('GEMINI_API_KEY not set');
      }
      const prompt = this._buildPrompt(intentA, intentB, cohereScore);
      const rawText = await this._callGemini(prompt);
      const parsed = this._parseResponse(rawText);
      return {
        ...parsed,
        latencyMs: Date.now() - start,
        tokenCount: this._estimateTokens(prompt + rawText)
      };
    } catch (err) {
      const reason = err.name === 'AbortError' || err.message === 'timeout'
        ? 'timeout'
        : err.message.includes('parse') ? 'parse-error' : 'api-error';
      return {
        equivalent: false,
        canonicalFilter: null,
        confidence: 0,
        reason,
        latencyMs: Date.now() - start,
        tokenCount: 0
      };
    }
  }

  /**
   * Build the prompt sent to Gemini.
   * Instructs the model to return ONLY valid JSON.
   */
  _buildPrompt(intentA, intentB, cohereScore) {
    return `You are an API semantics analyzer. Determine if these two API requests are semantically equivalent.

Request A: GET ${intentA.resource} with filters ${JSON.stringify(intentA.filters || {})}
Request B: GET ${intentB.resource} with filters ${JSON.stringify(intentB.filters || {})}
Cohere embedding similarity score: ${cohereScore.toFixed(3)}

Respond with ONLY valid JSON, no markdown, no explanation outside the JSON:
{
  "equivalent": true or false,
  "canonicalFilter": { merged filter object if equivalent, null if not equivalent },
  "confidence": number between 0.0 and 1.0,
  "reason": "one sentence explaining your decision"
}

Rules you must follow:
- Set equivalent=true only if both requests would return the exact same underlying dataset
- canonicalFilter must only contain keys that already exist in Request A or Request B filters
- Do not invent new filter keys
- If filters differ in value (not just key name), set equivalent=false
- If you are unsure, set equivalent=false with a lower confidence`;
  }

  /**
   * Parse Gemini's response text into a structured object.
   * Handles JSON wrapped in markdown code blocks.
   * @throws {Error} if JSON cannot be parsed or required fields are missing
   */
  _parseResponse(text) {
    if (!text || typeof text !== 'string') {
      throw new Error('parse-error: empty response');
    }

    // Strip markdown code blocks if present
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      throw new Error('parse-error: invalid JSON from Gemini');
    }

    // Validate required fields
    if (typeof parsed.equivalent !== 'boolean') {
      throw new Error('parse-error: missing equivalent field');
    }
    if (typeof parsed.confidence !== 'number') {
      throw new Error('parse-error: missing confidence field');
    }
    if (typeof parsed.reason !== 'string') {
      throw new Error('parse-error: missing reason field');
    }
    // canonicalFilter can be null when equivalent=false
    if (parsed.equivalent && !parsed.canonicalFilter) {
      throw new Error('parse-error: equivalent=true but no canonicalFilter');
    }

    return {
      equivalent: parsed.equivalent,
      canonicalFilter: parsed.canonicalFilter || null,
      confidence: Math.min(1, Math.max(0, parsed.confidence)),
      reason: parsed.reason
    };
  }

  /**
   * Call the Gemini 1.5 Flash API.
   * @param {string} prompt
   * @returns {string} the model's text response
   * @throws on network error, non-200 response, or timeout
   */
  async _callGemini(prompt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = `${GEMINI_URL}?key=${this.apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt }]
          }],
          generationConfig: {
            temperature: 0.1,      // low temperature for deterministic structured output
            maxOutputTokens: 512
          }
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Gemini API ${response.status}: ${body.slice(0, 200)}`);
      }

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!text) {
        throw new Error('Gemini response missing text content');
      }

      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Rough token count estimate (4 chars ≈ 1 token).
   * Used for cost tracking only — not for billing.
   */
  _estimateTokens(text) {
    return Math.ceil((text || '').length / 4);
  }
}

module.exports = ReasoningModel;
```

---

## File 2: src/ai/validator.js

### Purpose
The final safety gate. Receives the AI's proposed merge plan and checks it
deterministically. Returns { safe: true } only if ALL checks pass.

This is the most safety-critical file in the project.
It must NEVER call any external API or model.
It must NEVER throw — always return a result object.

### Full implementation

```js
'use strict';

/**
 * Validates an AI-proposed merge plan against the two original intents.
 *
 * This is the final authority. The AI cannot bypass this.
 * If this returns { safe: false }, the requests execute independently.
 *
 * @param {object} plan - { equivalent, canonicalFilter, confidence, reason }
 * @param {object} intentA - normalized intent (resource, filters, page, limit, ...)
 * @param {object} intentB - normalized intent
 * @param {object} options - { maxSupersetLimit?, minConfidence?, knownRoutes? }
 * @returns {{ safe: boolean, reason: string }}
 */
function validate(plan, intentA, intentB, options = {}) {
  const minConfidence = typeof options.minConfidence === 'number' ? options.minConfidence : 0.7;
  const maxSupersetLimit = typeof options.maxSupersetLimit === 'number' ? options.maxSupersetLimit : 1000;
  const knownRoutes = options.knownRoutes || {};

  try {
    // Check 1: plan must exist and have required fields
    if (!plan || typeof plan !== 'object') {
      return { safe: false, reason: 'incomplete-plan' };
    }
    if (typeof plan.equivalent !== 'boolean') {
      return { safe: false, reason: 'incomplete-plan' };
    }
    if (!plan.canonicalFilter || typeof plan.canonicalFilter !== 'object') {
      return { safe: false, reason: 'incomplete-plan' };
    }
    if (typeof plan.confidence !== 'number') {
      return { safe: false, reason: 'incomplete-plan' };
    }

    // Check 2: AI must say equivalent=true
    if (!plan.equivalent) {
      return { safe: false, reason: 'ai-says-not-equivalent' };
    }

    // Check 3: confidence must meet floor
    if (plan.confidence < minConfidence) {
      return { safe: false, reason: 'low-confidence' };
    }

    // Check 4: canonicalFilter must not introduce unknown keys
    const filtersA = intentA.filters || {};
    const filtersB = intentB.filters || {};
    const allowedKeys = new Set([
      ...Object.keys(filtersA),
      ...Object.keys(filtersB)
    ]);
    for (const key of Object.keys(plan.canonicalFilter)) {
      if (!allowedKeys.has(key)) {
        return { safe: false, reason: 'unknown-filter-keys' };
      }
    }

    // Check 5: projected superset size must not exceed limit
    const skipA = (intentA.page - 1) * intentA.limit;
    const skipB = (intentB.page - 1) * intentB.limit;
    const endA = skipA + intentA.limit;
    const endB = skipB + intentB.limit;
    const combinedLimit = Math.max(endA, endB) - Math.min(skipA, skipB);
    if (combinedLimit > maxSupersetLimit) {
      return { safe: false, reason: 'superset-too-large' };
    }

    // Check 6: if resources differ, both must map to the same registered route
    if (intentA.resource !== intentB.resource) {
      const routeKeys = Object.keys(knownRoutes);
      const routeA = routeKeys.find(r => intentA.resource.startsWith(r));
      const routeB = routeKeys.find(r => intentB.resource.startsWith(r));
      if (!routeA || !routeB || routeA !== routeB) {
        return { safe: false, reason: 'unverified-route-equivalence' };
      }
    }

    return { safe: true, reason: 'validated' };

  } catch (err) {
    // Defensive — validation must never throw
    return { safe: false, reason: 'validator-internal-error' };
  }
}

module.exports = { validate };
```

---

## File 3: test/reasoning-model.test.js

```js
'use strict';

const ReasoningModel = require('../src/ai/reasoning-model');

global.fetch = jest.fn();

afterEach(() => {
  jest.resetAllMocks();
});

const intentA = { resource: '/products', filters: { category: 'laptops' }, page: 1, limit: 20 };
const intentB = { resource: '/products', filters: { type: 'laptop' }, page: 1, limit: 20 };

describe('ReasoningModel._buildPrompt', () => {
  const model = new ReasoningModel({ apiKey: 'test' });

  it('includes both resources in the prompt', () => {
    const prompt = model._buildPrompt(intentA, intentB, 0.72);
    expect(prompt).toContain('/products');
    expect(prompt).toContain('category');
    expect(prompt).toContain('type');
  });

  it('includes the cohere score', () => {
    const prompt = model._buildPrompt(intentA, intentB, 0.72);
    expect(prompt).toContain('0.720');
  });

  it('instructs model to return only JSON', () => {
    const prompt = model._buildPrompt(intentA, intentB, 0.72);
    expect(prompt).toContain('ONLY valid JSON');
  });
});

describe('ReasoningModel._parseResponse', () => {
  const model = new ReasoningModel({ apiKey: 'test' });

  it('parses valid JSON response', () => {
    const raw = JSON.stringify({
      equivalent: true,
      canonicalFilter: { category: 'laptops' },
      confidence: 0.91,
      reason: 'category=laptops is semantically equivalent to type=laptop'
    });
    const result = model._parseResponse(raw);
    expect(result.equivalent).toBe(true);
    expect(result.confidence).toBe(0.91);
    expect(result.canonicalFilter).toEqual({ category: 'laptops' });
  });

  it('parses JSON wrapped in markdown code block', () => {
    const raw = '```json\n{"equivalent":false,"canonicalFilter":null,"confidence":0.3,"reason":"different values"}\n```';
    const result = model._parseResponse(raw);
    expect(result.equivalent).toBe(false);
  });

  it('throws on malformed JSON', () => {
    expect(() => model._parseResponse('not json at all')).toThrow();
  });

  it('throws when equivalent field is missing', () => {
    const raw = JSON.stringify({ canonicalFilter: {}, confidence: 0.9, reason: 'ok' });
    expect(() => model._parseResponse(raw)).toThrow();
  });

  it('throws when equivalent=true but canonicalFilter is missing', () => {
    const raw = JSON.stringify({ equivalent: true, canonicalFilter: null, confidence: 0.9, reason: 'ok' });
    expect(() => model._parseResponse(raw)).toThrow();
  });

  it('clamps confidence to [0, 1]', () => {
    const raw = JSON.stringify({ equivalent: false, canonicalFilter: null, confidence: 1.5, reason: 'ok' });
    const result = model._parseResponse(raw);
    expect(result.confidence).toBe(1);
  });
});

describe('ReasoningModel.analyze', () => {
  it('returns api-error fallback when API key is not set', async () => {
    const model = new ReasoningModel({ apiKey: '' });
    const result = await model.analyze(intentA, intentB, 0.72);
    expect(result.equivalent).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.reason).toBe('api-error');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns timeout fallback when fetch times out', async () => {
    global.fetch.mockImplementation(() =>
      new Promise((_, reject) =>
        setTimeout(() => { const e = new Error('AbortError'); e.name = 'AbortError'; reject(e); }, 50)
      )
    );
    const model = new ReasoningModel({ apiKey: 'test', timeoutMs: 30 });
    const result = await model.analyze(intentA, intentB, 0.72);
    expect(result.equivalent).toBe(false);
    expect(result.reason).toBe('timeout');
  });

  it('returns api-error when Gemini returns non-200', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'service unavailable'
    });
    const model = new ReasoningModel({ apiKey: 'test' });
    const result = await model.analyze(intentA, intentB, 0.72);
    expect(result.equivalent).toBe(false);
    expect(result.reason).toBe('api-error');
  });

  it('returns parse-error fallback when Gemini returns malformed JSON', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'not valid json' }] } }]
      })
    });
    const model = new ReasoningModel({ apiKey: 'test' });
    const result = await model.analyze(intentA, intentB, 0.72);
    expect(result.equivalent).toBe(false);
    expect(result.reason).toBe('parse-error');
  });

  it('returns correct parsed result on successful response', async () => {
    const mockResponse = {
      equivalent: true,
      canonicalFilter: { category: 'laptops' },
      confidence: 0.91,
      reason: 'semantically equivalent'
    };
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(mockResponse) }] } }]
      })
    });
    const model = new ReasoningModel({ apiKey: 'test' });
    const result = await model.analyze(intentA, intentB, 0.72);
    expect(result.equivalent).toBe(true);
    expect(result.canonicalFilter).toEqual({ category: 'laptops' });
    expect(result.confidence).toBe(0.91);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.tokenCount).toBeGreaterThan(0);
  });

  it('never throws even with null inputs', async () => {
    const model = new ReasoningModel({ apiKey: 'test' });
    const result = await model.analyze(null, null, 0);
    expect(result.equivalent).toBe(false);
    expect(typeof result.reason).toBe('string');
  });
});
```

---

## File 4: test/validator.test.js

```js
'use strict';

const { validate } = require('../src/ai/validator');

const intentA = { resource: '/products', filters: { category: 'laptops' }, page: 1, limit: 20 };
const intentB = { resource: '/products', filters: { type: 'laptop' }, page: 1, limit: 20 };

const validPlan = {
  equivalent: true,
  canonicalFilter: { category: 'laptops' },
  confidence: 0.91,
  reason: 'semantically equivalent'
};

describe('validate — incomplete plan checks', () => {
  it('rejects null plan', () => {
    const result = validate(null, intentA, intentB);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('incomplete-plan');
  });

  it('rejects plan missing equivalent field', () => {
    const result = validate({ canonicalFilter: {}, confidence: 0.9, reason: 'ok' }, intentA, intentB);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('incomplete-plan');
  });

  it('rejects plan missing canonicalFilter', () => {
    const result = validate({ equivalent: true, confidence: 0.9, reason: 'ok' }, intentA, intentB);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('incomplete-plan');
  });

  it('rejects plan missing confidence', () => {
    const result = validate({ equivalent: true, canonicalFilter: {}, reason: 'ok' }, intentA, intentB);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('incomplete-plan');
  });
});

describe('validate — equivalence check', () => {
  it('rejects when AI says not equivalent', () => {
    const plan = { ...validPlan, equivalent: false, canonicalFilter: null };
    const result = validate(plan, intentA, intentB);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('ai-says-not-equivalent');
  });
});

describe('validate — confidence check', () => {
  it('rejects when confidence is below default floor (0.7)', () => {
    const plan = { ...validPlan, confidence: 0.55 };
    const result = validate(plan, intentA, intentB);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('low-confidence');
  });

  it('rejects when confidence is below custom floor', () => {
    const plan = { ...validPlan, confidence: 0.8 };
    const result = validate(plan, intentA, intentB, { minConfidence: 0.85 });
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('low-confidence');
  });

  it('accepts when confidence exactly meets floor', () => {
    const plan = { ...validPlan, confidence: 0.7 };
    const result = validate(plan, intentA, intentB);
    expect(result.safe).toBe(true);
  });
});

describe('validate — unknown filter key check', () => {
  it('rejects canonicalFilter with key not in either intent', () => {
    const plan = { ...validPlan, canonicalFilter: { __inject: 'malicious' } };
    const result = validate(plan, intentA, intentB);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('unknown-filter-keys');
  });

  it('accepts canonicalFilter with keys from intentA', () => {
    const plan = { ...validPlan, canonicalFilter: { category: 'laptops' } };
    const result = validate(plan, intentA, intentB);
    expect(result.safe).toBe(true);
  });

  it('accepts canonicalFilter with keys from intentB', () => {
    const plan = { ...validPlan, canonicalFilter: { type: 'laptop' } };
    const result = validate(plan, intentA, intentB);
    expect(result.safe).toBe(true);
  });
});

describe('validate — superset size check', () => {
  it('rejects when combined pages exceed maxSupersetLimit', () => {
    const bigIntentA = { resource: '/products', filters: {}, page: 1, limit: 600 };
    const bigIntentB = { resource: '/products', filters: {}, page: 2, limit: 600 };
    const plan = { ...validPlan, canonicalFilter: {} };
    const result = validate(plan, bigIntentA, bigIntentB, { maxSupersetLimit: 1000 });
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('superset-too-large');
  });

  it('accepts when combined pages are within limit', () => {
    const plan = { ...validPlan, canonicalFilter: { category: 'laptops' } };
    const result = validate(plan, intentA, intentB, { maxSupersetLimit: 1000 });
    expect(result.safe).toBe(true);
  });
});

describe('validate — cross-resource route check', () => {
  it('rejects when resources differ and no route mapping', () => {
    const crossA = { ...intentA, resource: '/api/v1/products' };
    const crossB = { ...intentB, resource: '/api/v2/products' };
    const result = validate(validPlan, crossA, crossB, { knownRoutes: {} });
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('unverified-route-equivalence');
  });

  it('accepts when resources differ but both match same registered route prefix', () => {
    const crossA = { ...intentA, resource: '/api/products/list' };
    const crossB = { ...intentB, resource: '/api/products/search' };
    const plan = { ...validPlan, canonicalFilter: { category: 'laptops' } };
    const result = validate(plan, crossA, crossB, {
      knownRoutes: { '/api/products': { fetch: () => {} } }
    });
    expect(result.safe).toBe(true);
  });
});

describe('validate — full valid plan', () => {
  it('returns safe:true for a clean valid plan', () => {
    const result = validate(validPlan, intentA, intentB);
    expect(result.safe).toBe(true);
    expect(result.reason).toBe('validated');
  });
});

describe('validate — defensive edge cases', () => {
  it('never throws for undefined inputs', () => {
    expect(() => validate(undefined, undefined, undefined)).not.toThrow();
  });

  it('never throws for empty objects', () => {
    expect(() => validate({}, {}, {})).not.toThrow();
  });
});
```

---

## How to run your tests

```bash
cd e:\Sementic-relay\semantic-relay
npx jest test/reasoning-model.test.js --no-coverage
npx jest test/validator.test.js --no-coverage
```

Both test files must pass before you open your PR.
The existing `test/basic.test.js` must also still pass — run `npm test` to confirm.

---

## Interface contract for Varun (planner.js)

Varun's code will use your modules like this:

```js
const ReasoningModel = require('./reasoning-model');
const { validate } = require('./validator');

const reasoner = new ReasoningModel({ apiKey: process.env.GEMINI_API_KEY });

// Called only when Cohere score is 0.6–0.84
const geminiResult = await reasoner.analyze(intentA, intentB, cohereScore);
// geminiResult: { equivalent, canonicalFilter, confidence, reason, latencyMs, tokenCount }

// Always run validator before any merge
const validationResult = validate(geminiResult, intentA, intentB, {
  maxSupersetLimit: 1000,
  minConfidence: 0.7,
  knownRoutes: routes  // the routes object from semanticRelay() options
});
// validationResult: { safe: boolean, reason: string }

if (validationResult.safe) {
  // merge — use geminiResult.canonicalFilter as the filter
} else {
  // split — execute independently
}
```

Your modules must match this interface exactly.

---

## Git workflow — exactly 3 commits

### Setup (run once)
```bash
git clone https://github.com/Varundhyani69/Semantic-Relay.git
cd Semantic-Relay/semantic-relay
git checkout -b feat/madhav-reasoning
npm install
```

---

### Commit 1 — Validator implementation + tests

The validator is purely deterministic — no API calls, no async.
Create these two files with the full code from this brief:
- `src/ai/validator.js`
- `test/validator.test.js`

Verify before committing:
```bash
npx jest test/validator.test.js --no-coverage
# All tests must pass
npm test
# Existing 9 tests must still pass
```

Commit:
```bash
git add src/ai/validator.js test/validator.test.js
git commit -m "feat(ai): add deterministic Validator — final safety gate for AI proposals

- Rejects plans with missing fields (incomplete-plan)
- Rejects plans with AI confidence below floor (low-confidence)
- Rejects canonicalFilter containing keys not in either intent (unknown-filter-keys)
- Rejects merges that would exceed maxSupersetLimit (superset-too-large)
- Rejects cross-resource merges without a verified route mapping (unverified-route-equivalence)
- Never calls any external API — purely deterministic
- Never throws — always returns { safe, reason }"
```

---

### Commit 2 — ReasoningModel implementation + tests

Create these two files with the full code from this brief:
- `src/ai/reasoning-model.js`
- `test/reasoning-model.test.js`

Verify before committing:
```bash
npx jest test/reasoning-model.test.js --no-coverage
# All tests must pass
npm test
# All existing + new tests must pass
```

Commit:
```bash
git add src/ai/reasoning-model.js test/reasoning-model.test.js
git commit -m "feat(ai): add ReasoningModel wrapping Gemini 1.5 Flash

- Called only when Cohere similarity is in ambiguous range (0.6-0.84)
- Sends structured prompt requesting JSON: { equivalent, canonicalFilter, confidence, reason }
- Parses JSON from plain text and markdown code block responses
- Returns { equivalent:false, confidence:0, reason:'api-error' } on any failure
- Returns { equivalent:false, confidence:0, reason:'timeout' } on 5s timeout
- Returns { equivalent:false, confidence:0, reason:'parse-error' } on malformed JSON
- Estimates token count for cost tracking
- Never throws to caller"
```

---

### Commit 3 — Push and open PR

```bash
# Run the full test suite one final time
npm test
# All tests must pass (existing 9 + your new tests)

# Push
git push -u origin feat/madhav-reasoning
```

Then go to https://github.com/Varundhyani69/Semantic-Relay and open a Pull Request:
- Base: `main`
- Compare: `feat/madhav-reasoning`
- Title: `feat: ReasoningModel + Validator (Madhav)`
- Fill in the PR template checklist

The most important thing to confirm in the PR description:
"Validator never calls external APIs. It is purely deterministic. All rejection reasons are documented."
