# Varun — Implementation Brief
## Branch: feat/varun-core
## This is the integration owner branch — merged last after all teammates' PRs

---

## Your complete task list

1. Update `semantic-relay/package.json`
2. Implement `src/ai/planner.js`
3. Modify `src/index.js` (careful surgery — existing tests must not break)
4. Implement `test/eval.js` (20-case evaluation harness)
5. Merge all teammate PRs in order
6. Create `deploy.sh` and set up EC2 t2.micro
7. Write architecture diagram + failure log (hackathon deliverables)

---

## Merge order — do this before touching any files

```
1. git merge feat/vipul-embedding    # pattern-cache + embedding-model
2. git merge feat/madhav-reasoning   # reasoning-model + validator
3. npm test                          # must be green before continuing
4. implement planner.js and index.js changes (this file)
5. implement test/eval.js
6. npm test && npm run eval          # both must pass
7. git merge feat/anirudh-demo       # demo UI — last, needs running server
```

---

## Task 1 — Update semantic-relay/package.json

Add `optionalDependencies` and `eval` script. Do not change anything else.

```json
{
  "scripts": {
    "test": "jest",
    "eval": "node test/eval.js",
    "prepack": "npm test -- --runInBand"
  },
  "optionalDependencies": {
    "cohere-ai": "^7.10.0",
    "@google/generative-ai": "^0.15.0"
  }
}
```

Note: `cohere-ai` and `@google/generative-ai` are listed as optionalDependencies
because the package works without them (safe mode / no API keys). The embedding-model.js
and reasoning-model.js use raw `fetch` — NOT these SDK packages — so the optional deps
are for future convenience only. The existing zero-dependency story holds for production
users who don't use AI mode.

---

## Task 2 — Implement src/ai/planner.js

This file orchestrates: PatternCache → EmbeddingModel → ReasoningModel → Validator.
It is the brain of the AI layer. It must never throw to its caller.

```js
'use strict';

const EmbeddingModel = require('./embedding-model');
const ReasoningModel = require('./reasoning-model');
const PatternCache   = require('./pattern-cache');
const { validate }   = require('./validator');

class SemanticPlanner {
  /**
   * @param {object} options
   * @param {string} options.cohereApiKey
   * @param {string} options.geminiApiKey
   * @param {number} [options.embeddingThreshold=0.85] - score >= this → confident match
   * @param {number} [options.reasoningThreshold=0.6]  - score < this → definite mismatch
   * @param {number} [options.maxSupersetLimit=1000]
   * @param {number} [options.minConfidence=0.7]
   * @param {string} [options.aiMode='adaptive']
   * @param {object} [options.knownRoutes={}]
   */
  constructor(options = {}) {
    this.embeddingThreshold = options.embeddingThreshold || 0.85;
    this.reasoningThreshold = options.reasoningThreshold || 0.6;
    this.maxSupersetLimit   = options.maxSupersetLimit   || 1000;
    this.minConfidence      = options.minConfidence      || 0.7;
    this.aiMode             = options.aiMode             || 'adaptive';
    this.knownRoutes        = options.knownRoutes        || {};

    this.embedder = new EmbeddingModel({ apiKey: options.cohereApiKey });
    this.reasoner = new ReasoningModel({ apiKey: options.geminiApiKey });
    this.cache    = new PatternCache({ maxSize: options.maxPatternCacheSize || 500 });

    // Metrics counters
    this._aiInvocations         = 0;
    this._embeddingInvocations  = 0;
    this._reasoningInvocations  = 0;
    this._validatorApprovals    = 0;
    this._validatorRejects      = 0;
    this._totalEmbeddingMs      = 0;
    this._totalReasoningMs      = 0;
    this._totalCostUsd          = 0;
    this._aiStatus              = 'active';

    // Optional callback — wired by demo server to record decisions
    this.onDecision = null;
  }

  /**
   * Evaluate whether two intents should be merged.
   *
   * Decision flow:
   * 1. safe mode → fallback immediately
   * 2. pattern cache HIT → validate cached plan
   * 3. Cohere embedding →
   *    score < reasoningThreshold (0.6): split
   *    score >= embeddingThreshold (0.85): validate directly
   *    score 0.6–0.84: call Gemini
   * 4. Validator checks plan
   * 5. SAFE → store in cache, return merge
   *    UNSAFE → return split
   * 6. Any error → return fallback
   *
   * @param {object} intentA
   * @param {object} intentB
   * @returns {Promise<{
   *   decision: 'merge'|'split'|'fallback',
   *   canonicalFilter: object|null,
   *   confidence: number,
   *   source: 'cache'|'embedding'|'reasoning'|'fallback',
   *   latencyMs: number,
   *   validatorApproved: boolean,
   *   cohereScore: number|null,
   *   geminiUsed: boolean,
   *   geminiConfidence: number|null
   * }>}
   */
  async evaluate(intentA, intentB) {
    const start = Date.now();
    this._aiInvocations++;

    const decision = (d) => {
      const result = { latencyMs: Date.now() - start, ...d };
      if (typeof this.onDecision === 'function') {
        try {
          this.onDecision({
            resourceA: intentA?.resource,
            resourceB: intentB?.resource,
            filtersA: intentA?.filters,
            filtersB: intentB?.filters,
            cohereScore: result.cohereScore ?? null,
            geminiUsed: result.geminiUsed ?? false,
            geminiConfidence: result.geminiConfidence ?? null,
            validatorApproved: result.validatorApproved ?? false,
            mergeExecuted: result.decision === 'merge',
            latencyMs: result.latencyMs
          });
        } catch (_) {}
      }
      return result;
    };

    try {
      // Step 1: safe mode bypass
      if (this.aiMode === 'safe') {
        return decision({ decision: 'fallback', canonicalFilter: null, confidence: 0, source: 'fallback', validatorApproved: false, cohereScore: null, geminiUsed: false, geminiConfidence: null });
      }

      // Step 2: pattern cache check
      const cachedFilter = this.cache.get(intentA.filters, intentB.filters);
      if (cachedFilter !== null) {
        const plan = { equivalent: true, canonicalFilter: cachedFilter, confidence: 1.0, reason: 'from-cache' };
        const validation = validate(plan, intentA, intentB, { maxSupersetLimit: this.maxSupersetLimit, minConfidence: this.minConfidence, knownRoutes: this.knownRoutes });
        if (validation.safe) {
          this._validatorApprovals++;
          return decision({ decision: 'merge', canonicalFilter: cachedFilter, confidence: 1.0, source: 'cache', validatorApproved: true, cohereScore: null, geminiUsed: false, geminiConfidence: null });
        }
        // Cache entry invalidated — fall through to fresh evaluation
      }

      // Step 3: Cohere embedding
      this._embeddingInvocations++;
      const embResult = await this.embedder.similarity(intentA, intentB);
      this._totalEmbeddingMs += embResult.latencyMs;
      this._totalCostUsd += 0.0001; // Cohere per-call estimate

      if (embResult.score === -1) {
        // Cohere unavailable
        this._aiStatus = 'degraded';
        return decision({ decision: 'fallback', canonicalFilter: null, confidence: 0, source: 'fallback', validatorApproved: false, cohereScore: null, geminiUsed: false, geminiConfidence: null });
      }

      const cohereScore = embResult.score;

      // Definite mismatch
      if (cohereScore < this.reasoningThreshold) {
        return decision({ decision: 'split', canonicalFilter: null, confidence: cohereScore, source: 'embedding', validatorApproved: false, cohereScore, geminiUsed: false, geminiConfidence: null });
      }

      let plan;

      if (cohereScore >= this.embeddingThreshold) {
        // Confident match — build plan from embedding alone
        // Use first intent's filters as canonical (validator will check)
        plan = {
          equivalent: true,
          canonicalFilter: Object.assign({}, intentA.filters),
          confidence: cohereScore,
          reason: 'high-embedding-similarity'
        };
      } else {
        // Ambiguous zone (0.6–0.84) — call Gemini
        this._reasoningInvocations++;
        const gemResult = await this.reasoner.analyze(intentA, intentB, cohereScore);
        this._totalReasoningMs += gemResult.latencyMs;
        this._totalCostUsd += (gemResult.tokenCount || 500) / 1000 * 0.075 / 1000;

        if (!gemResult.equivalent) {
          return decision({ decision: 'split', canonicalFilter: null, confidence: gemResult.confidence, source: 'reasoning', validatorApproved: false, cohereScore, geminiUsed: true, geminiConfidence: gemResult.confidence });
        }

        plan = {
          equivalent: gemResult.equivalent,
          canonicalFilter: gemResult.canonicalFilter,
          confidence: gemResult.confidence,
          reason: gemResult.reason
        };

        // Step 4: validate
        const validation = validate(plan, intentA, intentB, { maxSupersetLimit: this.maxSupersetLimit, minConfidence: this.minConfidence, knownRoutes: this.knownRoutes });

        if (!validation.safe) {
          this._validatorRejects++;
          return decision({ decision: 'split', canonicalFilter: null, confidence: plan.confidence, source: 'reasoning', validatorApproved: false, cohereScore, geminiUsed: true, geminiConfidence: plan.confidence });
        }

        // Store validated pattern
        this.cache.set(intentA.filters, intentB.filters, plan.canonicalFilter);
        this._validatorApprovals++;
        return decision({ decision: 'merge', canonicalFilter: plan.canonicalFilter, confidence: plan.confidence, source: 'reasoning', validatorApproved: true, cohereScore, geminiUsed: true, geminiConfidence: plan.confidence });
      }

      // Validate embedding-confident plan
      const validation = validate(plan, intentA, intentB, { maxSupersetLimit: this.maxSupersetLimit, minConfidence: this.minConfidence, knownRoutes: this.knownRoutes });

      if (!validation.safe) {
        this._validatorRejects++;
        return decision({ decision: 'split', canonicalFilter: null, confidence: plan.confidence, source: 'embedding', validatorApproved: false, cohereScore, geminiUsed: false, geminiConfidence: null });
      }

      this.cache.set(intentA.filters, intentB.filters, plan.canonicalFilter);
      this._validatorApprovals++;
      return decision({ decision: 'merge', canonicalFilter: plan.canonicalFilter, confidence: plan.confidence, source: 'embedding', validatorApproved: true, cohereScore, geminiUsed: false, geminiConfidence: null });

    } catch (err) {
      // Unhandled — always fall back, never crash middleware
      return decision({ decision: 'fallback', canonicalFilter: null, confidence: 0, source: 'fallback', validatorApproved: false, cohereScore: null, geminiUsed: false, geminiConfidence: null });
    }
  }

  getStats() {
    const cacheStats = this.cache.getStats();
    const embCount = this._embeddingInvocations;
    const reaCount = this._reasoningInvocations;
    return {
      aiInvocations:        this._aiInvocations,
      embeddingInvocations: embCount,
      reasoningInvocations: reaCount,
      validatorApprovals:   this._validatorApprovals,
      validatorRejects:     this._validatorRejects,
      patternCacheHits:     cacheStats.hits,
      patternCacheMisses:   cacheStats.misses,
      avgEmbeddingMs:       embCount ? this._totalEmbeddingMs / embCount : 0,
      avgReasoningMs:       reaCount ? this._totalReasoningMs / reaCount : 0,
      aiStatus:             this._aiStatus,
      estimatedCostUsd:     this._totalCostUsd
    };
  }
}

module.exports = SemanticPlanner;
```

---

## Task 3 — Modify src/index.js

IMPORTANT: Run `npm test` before making any change. It must be green first.
Run `npm test` after each sub-step. If it goes red, revert that sub-step before continuing.

### Sub-step 3a — Add require at top (after existing requires)

```js
// Add after the existing require block:
let SemanticPlanner;
try {
  SemanticPlanner = require('./ai/planner');
} catch (_) {
  // optional — AI layer not installed
}
```

### Sub-step 3b — Add to options destructuring

Find the existing destructuring block inside `function semanticRelay(options = {})`.
Add these two lines at the end of the destructured list:

```js
aiMode = 'adaptive',
aiOptions = {}
```

### Sub-step 3c — Instantiate planner after WindowManager

Find the line `const wm = new WindowManager({...});`. Add after it:

```js
let planner = null;
if (SemanticPlanner && aiMode !== 'safe') {
  try {
    planner = new SemanticPlanner({
      cohereApiKey:        aiOptions.cohereApiKey || process.env.COHERE_API_KEY,
      geminiApiKey:        aiOptions.geminiApiKey || process.env.GEMINI_API_KEY,
      embeddingThreshold:  aiOptions.embeddingThreshold  || 0.85,
      reasoningThreshold:  aiOptions.reasoningThreshold  || 0.6,
      maxPatternCacheSize: aiOptions.maxPatternCacheSize  || 500,
      maxSupersetLimit,
      minConfidence:       aiOptions.minConfidence || 0.7,
      aiMode,
      knownRoutes: routes
    });
  } catch (err) {
    // planner stays null — safe fallback
  }
}
```

### Sub-step 3d — Make groupBySimilarity async and add planner hook

Find the `groupBySimilarity` function. It currently uses `scorer` to decide grouping.

Change the function signature to `async function groupBySimilarity(contexts, threshold)`.

Inside the loop where `matchesGroup` is evaluated, add the planner check:

```js
// EXISTING line (keep it):
const deterministicScore = scorer(current[current.length - 1].intent, ctx.intent);
const matchesGroup = deterministicScore >= threshold
  || current.some(existing => scorer(existing.intent, ctx.intent) >= threshold);

// NEW: AI check for ambiguous pairs only
let aiApproved = false;
if (!matchesGroup && planner && deterministicScore > 0 && deterministicScore < threshold) {
  try {
    const planResult = await planner.evaluate(
      current[current.length - 1].intent,
      ctx.intent
    );
    if (planResult.decision === 'merge' && planResult.canonicalFilter) {
      // Patch the intent filters to use canonical filter for superset building
      ctx.intent._canonicalFilter = planResult.canonicalFilter;
      aiApproved = true;
    }
  } catch (_) {
    // planner error — do not group
  }
}

if (matchesGroup || aiApproved) {
  current.push(ctx);
} else {
  groups.push(current);
  current = [ctx];
}
```

Also make the call site async:
- In `batchHandler`, `groupBySimilarity` is called synchronously. Change to `await groupBySimilarity(...)`.
- In `wm.onFlush`, the callback receives groups from `groupContexts()` in `window-manager.js`.
  The window manager calls `groupContexts` synchronously. Since we cannot change window-manager.js,
  the AI path applies only in `batchHandler` for now. The transparent middleware path will use
  a different approach: check planner inside `handleAggregatedGroup` before splitting.

  Simpler approach that avoids touching window-manager.js:
  In `handleAggregatedGroup`, BEFORE calling `splitByGuardrails`, if group has exactly 2 requests
  and their deterministic score is ambiguous, run the planner:

```js
async function handleAggregatedGroup(groupContexts) {
  // NEW: AI-assisted grouping for pairs that the deterministic scorer rated ambiguous
  if (planner && groupContexts.length === 2) {
    const scoreAB = scorer(groupContexts[0].intent, groupContexts[1].intent);
    if (scoreAB > 0 && scoreAB < threshold) {
      try {
        const planResult = await planner.evaluate(
          groupContexts[0].intent,
          groupContexts[1].intent
        );
        if (planResult.decision === 'merge' && planResult.canonicalFilter) {
          // Patch canonical filter onto both intents for supersetBuilder
          groupContexts[0].intent._canonicalFilter = planResult.canonicalFilter;
          groupContexts[1].intent._canonicalFilter = planResult.canonicalFilter;
          // Also patch filters so supersetBuilder picks up canonical
          groupContexts[0].intent.filters = planResult.canonicalFilter;
          groupContexts[1].intent.filters = planResult.canonicalFilter;
        } else if (planResult.decision === 'split') {
          // AI says split — execute each independently
          for (const ctx of groupContexts) {
            handleSolo(ctx, 'ai-split');
          }
          return;
        }
        // fallback → continue with existing behavior
      } catch (_) {}
    }
  }
  // ... rest of existing handleAggregatedGroup unchanged
```

### Sub-step 3e — Extend getMetrics()

Find the `middleware.getMetrics = () => {` block.
Add a spread of planner stats at the end of the return object:

```js
middleware.getMetrics = () => {
  const queriesSaved = totalRequests - totalWindowsOpened;
  return {
    // ... all existing fields unchanged ...
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
    // NEW: AI fields
    ...(planner ? planner.getStats() : {
      aiInvocations:        0,
      embeddingInvocations: 0,
      reasoningInvocations: 0,
      validatorApprovals:   0,
      validatorRejects:     0,
      patternCacheHits:     0,
      patternCacheMisses:   0,
      avgEmbeddingMs:       0,
      avgReasoningMs:       0,
      aiStatus:             SemanticPlanner ? 'disabled' : 'not-installed',
      estimatedCostUsd:     0
    })
  };
};
```

### Sub-step 3f — Expose planner.onDecision hook

After the planner is instantiated, expose it on the middleware so the demo server
can wire Anirudh's `recordAiDecision` callback:

```js
middleware.getPlanner = () => planner;
```

---

## Task 4 — Implement test/eval.js

This is the hackathon tiebreaker. Run with `npm run eval`.
Must output a formatted score report and exit 1 if accuracy < 80%.

```js
'use strict';

// Mock fetch before requiring any modules
global.fetch = async () => { throw new Error('fetch not mocked for this test'); };

const SemanticPlanner = require('../src/ai/planner');

// ─── Test case definitions ────────────────────────────────────────────────────

const mkIntent = (resource, filters, page = 1, limit = 20) => ({
  intentId: Math.random().toString(36).slice(2),
  resource,
  filters,
  page,
  limit,
  groupKey: null,
  expectedGroupSize: 0
});

const CASES = [
  // ── Semantic equivalence (should merge) ───────────────────────────────────
  {
    id: 'eq-001', category: 'equivalence',
    description: 'category=laptops vs type=laptop',
    intentA: mkIntent('/products', { category: 'laptops' }),
    intentB: mkIntent('/products', { type: 'laptop' }),
    mockCohereScore: 0.72,
    mockGemini: { equivalent: true, canonicalFilter: { category: 'laptops' }, confidence: 0.91, reason: 'semantically equivalent' },
    expected: 'merge'
  },
  {
    id: 'eq-002', category: 'equivalence',
    description: 'maxPrice=50000 vs price_lt=50000',
    intentA: mkIntent('/products', { maxPrice: '50000' }),
    intentB: mkIntent('/products', { price_lt: '50000' }),
    mockCohereScore: 0.68,
    mockGemini: { equivalent: true, canonicalFilter: { maxPrice: '50000' }, confidence: 0.88, reason: 'same price ceiling' },
    expected: 'merge'
  },
  {
    id: 'eq-003', category: 'equivalence',
    description: 'sort=newest vs order=desc&sortBy=date',
    intentA: mkIntent('/products', { sort: 'newest' }),
    intentB: mkIntent('/products', { order: 'desc', sortBy: 'date' }),
    mockCohereScore: 0.65,
    mockGemini: { equivalent: true, canonicalFilter: { sort: 'newest' }, confidence: 0.82, reason: 'same sort direction' },
    expected: 'merge'
  },
  {
    id: 'eq-004', category: 'equivalence',
    description: 'brand=apple vs manufacturer=apple',
    intentA: mkIntent('/products', { brand: 'apple' }),
    intentB: mkIntent('/products', { manufacturer: 'apple' }),
    mockCohereScore: 0.75,
    mockGemini: { equivalent: true, canonicalFilter: { brand: 'apple' }, confidence: 0.93, reason: 'same brand' },
    expected: 'merge'
  },
  {
    id: 'eq-005', category: 'equivalence',
    description: 'status=active vs isActive=true',
    intentA: mkIntent('/users', { status: 'active' }),
    intentB: mkIntent('/users', { isActive: 'true' }),
    mockCohereScore: 0.71,
    mockGemini: { equivalent: true, canonicalFilter: { status: 'active' }, confidence: 0.87, reason: 'same active state' },
    expected: 'merge'
  },
  {
    id: 'eq-006', category: 'equivalence',
    description: 'color=red vs colour=red (UK/US spelling)',
    intentA: mkIntent('/products', { color: 'red' }),
    intentB: mkIntent('/products', { colour: 'red' }),
    mockCohereScore: 0.88, // high confidence from embedding alone
    mockGemini: null,       // should NOT call Gemini
    expected: 'merge'
  },
  // ── Semantic non-equivalence (must NOT merge) ─────────────────────────────
  {
    id: 'neq-001', category: 'non-equivalence',
    description: 'category=laptops vs category=phones',
    intentA: mkIntent('/products', { category: 'laptops' }),
    intentB: mkIntent('/products', { category: 'phones' }),
    mockCohereScore: 0.31,  // below reasoning threshold → split without Gemini
    mockGemini: null,
    expected: 'split'
  },
  {
    id: 'neq-002', category: 'non-equivalence',
    description: 'maxPrice=50000 vs maxPrice=100000',
    intentA: mkIntent('/products', { maxPrice: '50000' }),
    intentB: mkIntent('/products', { maxPrice: '100000' }),
    mockCohereScore: 0.62,
    mockGemini: { equivalent: false, canonicalFilter: null, confidence: 0.95, reason: 'different price ceilings' },
    expected: 'split'
  },
  {
    id: 'neq-003', category: 'non-equivalence',
    description: 'userId=123 vs userId=456',
    intentA: mkIntent('/orders', { userId: '123' }),
    intentB: mkIntent('/orders', { userId: '456' }),
    mockCohereScore: 0.55,  // below reasoning threshold
    mockGemini: null,
    expected: 'split'
  },
  {
    id: 'neq-004', category: 'non-equivalence',
    description: 'status=active vs status=deleted',
    intentA: mkIntent('/users', { status: 'active' }),
    intentB: mkIntent('/users', { status: 'deleted' }),
    mockCohereScore: 0.45,
    mockGemini: null,
    expected: 'split'
  },
  {
    id: 'neq-005', category: 'non-equivalence',
    description: 'inStock=true vs inStock=false',
    intentA: mkIntent('/products', { inStock: 'true' }),
    intentB: mkIntent('/products', { inStock: 'false' }),
    mockCohereScore: 0.48,
    mockGemini: null,
    expected: 'split'
  },
  {
    id: 'neq-006', category: 'non-equivalence',
    description: '/users vs /admins — different resources',
    intentA: mkIntent('/users', { status: 'active' }),
    intentB: mkIntent('/admins', { status: 'active' }),
    mockCohereScore: 0.0, // score 0 from deterministic scorer — planner not called
    mockGemini: null,
    expected: 'split'
  },
  // ── Validator rejection (AI says merge, validator says no) ────────────────
  {
    id: 'val-001', category: 'validator-reject',
    description: 'AI injects unknown filter key',
    intentA: mkIntent('/products', { category: 'laptops' }),
    intentB: mkIntent('/products', { type: 'laptop' }),
    mockCohereScore: 0.72,
    mockGemini: { equivalent: true, canonicalFilter: { __inject: 'evil', category: 'laptops' }, confidence: 0.91, reason: 'test' },
    expected: 'split'  // validator rejects unknown key __inject
  },
  {
    id: 'val-002', category: 'validator-reject',
    description: 'AI confidence below floor',
    intentA: mkIntent('/products', { brand: 'apple' }),
    intentB: mkIntent('/products', { make: 'apple' }),
    mockCohereScore: 0.63,
    mockGemini: { equivalent: true, canonicalFilter: { brand: 'apple' }, confidence: 0.55, reason: 'possibly' },
    expected: 'split'  // confidence 0.55 < minConfidence 0.7
  },
  {
    id: 'val-003', category: 'validator-reject',
    description: 'AI proposes merge exceeding superset limit',
    intentA: mkIntent('/products', { category: 'all' }, 1, 600),
    intentB: mkIntent('/products', { type: 'all' }, 2, 600),
    mockCohereScore: 0.70,
    mockGemini: { equivalent: true, canonicalFilter: { category: 'all' }, confidence: 0.85, reason: 'equivalent' },
    expected: 'split'  // 1200 records > maxSupersetLimit 1000
  },
  // ── Fallback / degradation ────────────────────────────────────────────────
  {
    id: 'fb-001', category: 'fallback',
    description: 'Cohere API returns error (score -1)',
    intentA: mkIntent('/products', { category: 'laptops' }),
    intentB: mkIntent('/products', { type: 'laptop' }),
    mockCohereScore: -1,  // simulates Cohere unavailable
    mockGemini: null,
    expected: 'fallback'
  },
  {
    id: 'fb-002', category: 'fallback',
    description: 'Gemini returns malformed JSON (parse-error fallback)',
    intentA: mkIntent('/products', { category: 'laptops' }),
    intentB: mkIntent('/products', { type: 'laptop' }),
    mockCohereScore: 0.72,
    mockGemini: 'MALFORMED', // special signal — reasoning model returns parse-error
    expected: 'split'  // Gemini parse error → equivalent:false → split
  },
  // ── Performance / latency ─────────────────────────────────────────────────
  {
    id: 'perf-001', category: 'performance',
    description: 'Embedding call must complete under 2000ms',
    intentA: mkIntent('/products', { category: 'laptops' }),
    intentB: mkIntent('/products', { type: 'laptop' }),
    mockCohereScore: 0.91,
    mockGemini: null,
    expected: 'merge',
    maxLatencyMs: 2000
  },
  {
    id: 'perf-002', category: 'performance',
    description: 'Reasoning call must complete under 5000ms',
    intentA: mkIntent('/products', { category: 'laptops' }),
    intentB: mkIntent('/products', { type: 'laptop' }),
    mockCohereScore: 0.72,
    mockGemini: { equivalent: true, canonicalFilter: { category: 'laptops' }, confidence: 0.91, reason: 'ok' },
    expected: 'merge',
    maxLatencyMs: 5000
  },
  {
    id: 'perf-003', category: 'performance',
    description: 'Cache hit must return in under 5ms',
    intentA: mkIntent('/products', { category: 'laptops' }),
    intentB: mkIntent('/products', { category: 'laptops' }),  // same filters → cache
    mockCohereScore: 0.91,
    mockGemini: null,
    expected: 'merge',
    maxLatencyMs: 5,
    primeCache: true  // set cache entry before running
  }
];

// ─── Test runner ──────────────────────────────────────────────────────────────

async function runCase(tc) {
  // Build a planner with mocked internals
  const planner = new SemanticPlanner({
    cohereApiKey: 'test',
    geminiApiKey: 'test',
    embeddingThreshold: 0.85,
    reasoningThreshold: 0.6,
    maxSupersetLimit: 1000,
    minConfidence: 0.7,
    aiMode: 'adaptive'
  });

  // Stub embedding model
  planner.embedder.similarity = async () => ({
    score: tc.mockCohereScore,
    latencyMs: 1
  });

  // Stub reasoning model
  planner.reasoner.analyze = async () => {
    if (tc.mockGemini === 'MALFORMED') {
      return { equivalent: false, canonicalFilter: null, confidence: 0, reason: 'parse-error', latencyMs: 1, tokenCount: 100 };
    }
    if (!tc.mockGemini) {
      throw new Error('Gemini called unexpectedly for case ' + tc.id);
    }
    return { ...tc.mockGemini, latencyMs: 1, tokenCount: 100 };
  };

  // Prime cache if needed
  if (tc.primeCache) {
    planner.cache.set(tc.intentA.filters, tc.intentB.filters, tc.intentA.filters);
  }

  const start = Date.now();
  const result = await planner.evaluate(tc.intentA, tc.intentB);
  const elapsed = Date.now() - start;

  const decisionMatch = result.decision === tc.expected;
  const latencyOk = !tc.maxLatencyMs || elapsed <= tc.maxLatencyMs;
  const pass = decisionMatch && latencyOk;

  return {
    id: tc.id,
    category: tc.category,
    description: tc.description,
    pass,
    expected: tc.expected,
    actual: result.decision,
    source: result.source,
    latencyMs: elapsed,
    maxLatencyMs: tc.maxLatencyMs || null,
    reason: !decisionMatch
      ? `expected ${tc.expected}, got ${result.decision}`
      : !latencyOk
        ? `latency ${elapsed}ms exceeds ${tc.maxLatencyMs}ms`
        : null
  };
}

async function main() {
  console.log('\nsemantic-relay-ai evaluation harness');
  console.log('=====================================');
  console.log(`Running ${CASES.length} test cases...\n`);

  const results = [];
  for (const tc of CASES) {
    const r = await runCase(tc);
    results.push(r);
    const mark = r.pass ? 'PASS' : 'FAIL';
    const detail = r.pass
      ? `[${r.actual}] source:${r.source} ${r.latencyMs}ms`
      : `— ${r.reason}`;
    console.log(`${mark} ${r.id} ${r.description} ${detail}`);
  }

  // Compute metrics
  const total   = results.length;
  const passed  = results.filter(r => r.pass).length;
  const failed  = total - passed;

  const equiv   = results.filter(r => r.category === 'equivalence');
  const nonEq   = results.filter(r => r.category === 'non-equivalence');

  // False positive: equivalence case that got 'split' (missed a valid merge)
  const fp = equiv.filter(r => r.actual === 'split').length;
  // False negative: non-equivalence case that got 'merge' (unsafe merge)
  const fn = nonEq.filter(r => r.actual === 'merge').length;

  const fpRate = equiv.length ? (fp / equiv.length * 100).toFixed(1) : '0.0';
  const fnRate = nonEq.length ? (fn / nonEq.length * 100).toFixed(1) : '0.0';
  const accuracy = (passed / total * 100).toFixed(1);

  const mergedCount = results.filter(r => r.actual === 'merge').length;
  const backendReduction = ((1 - mergedCount / total) * 100).toFixed(1);

  const avgLatency = (results.reduce((s, r) => s + r.latencyMs, 0) / total).toFixed(1);

  console.log('\nResults');
  console.log('-------');
  console.log(`Total:               ${total}`);
  console.log(`Passed:              ${passed}`);
  console.log(`Failed:              ${failed}`);
  console.log(`Classification acc:  ${accuracy}%`);
  console.log(`False positive rate: ${fpRate}%  (valid merges classified as split)`);
  console.log(`False negative rate: ${fnRate}%  (unsafe merges not caught)`);
  console.log(`Backend reduction:   ${backendReduction}%`);
  console.log(`Avg latency (mock):  ${avgLatency}ms`);
  console.log(`Est. cost (mock):    $0.000`);

  if (parseFloat(accuracy) < 80) {
    console.error(`\nFAIL: classification accuracy ${accuracy}% is below 80% threshold`);
    process.exit(1);
  }

  console.log(`\nPASS: accuracy ${accuracy}% meets threshold`);
  process.exit(0);
}

main().catch(err => {
  console.error('Eval harness error:', err);
  process.exit(1);
});
```

---

## Task 5 — Deploy to EC2 t2.micro

### deploy.sh (create at repo root)

```bash
#!/bin/bash
set -e

echo "=== semantic-relay demo deployment ==="

# Node.js 20
if ! command -v node &> /dev/null; then
  curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
  sudo yum install -y nodejs
fi
echo "Node $(node --version)"

# PM2
if ! command -v pm2 &> /dev/null; then
  sudo npm install -g pm2
fi

# App
APP_DIR="/home/ec2-user/semantic-relay"
if [ -d "$APP_DIR" ]; then
  cd "$APP_DIR" && git pull
else
  git clone https://github.com/Varundhyani69/Semantic-Relay.git "$APP_DIR"
fi

# Install dependencies
cd "$APP_DIR/semantic-relay" && npm install
cd "$APP_DIR/semantic-relay-demo" && npm install

# .env (only create if missing)
ENV_FILE="$APP_DIR/semantic-relay-demo/.env"
if [ ! -f "$ENV_FILE" ]; then
  cp "$APP_DIR/semantic-relay-demo/.env.example" "$ENV_FILE"
  echo ""
  echo "IMPORTANT: Edit $ENV_FILE and add your API keys before starting."
  echo "  COHERE_API_KEY=your_key"
  echo "  GEMINI_API_KEY=your_key"
  exit 0
fi

# Start / restart
pm2 delete semantic-relay-demo 2>/dev/null || true
pm2 start "$APP_DIR/semantic-relay-demo/server.js" \
  --name semantic-relay-demo \
  --env production

pm2 startup | tail -1 | bash 2>/dev/null || true
pm2 save

echo ""
echo "=== Deployment complete ==="
PM2_STATUS=$(pm2 status semantic-relay-demo --no-color 2>/dev/null | tail -3)
echo "$PM2_STATUS"
echo ""
PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo "unknown")
echo "Demo URL: http://$PUBLIC_IP:3100"
```

### .env.example (create in semantic-relay-demo/)

```
COHERE_API_KEY=your_cohere_api_key_here
GEMINI_API_KEY=your_gemini_api_key_here
AI_MODE=adaptive
PORT=3100
RELAY_WINDOW_MS=12
RELAY_THRESHOLD=0.8
```

### EC2 setup steps (do once in AWS console)

1. Launch EC2 → t2.micro → Amazon Linux 2023 → us-east-1
2. Security group: add inbound rule → TCP → port 3100 → source 0.0.0.0/0
3. Download .pem key
4. SSH in: `ssh -i key.pem ec2-user@<public-ip>`
5. Run: `curl -fsSL https://raw.githubusercontent.com/Varundhyani69/Semantic-Relay/main/deploy.sh | bash`
6. Edit `/home/ec2-user/semantic-relay/semantic-relay-demo/.env` with real API keys
7. Run `pm2 restart semantic-relay-demo`
8. Verify: `curl http://localhost:3100/api/ai-decisions`

### Wire Anirudh's onAiDecision callback in server.js

After Anirudh's PR is merged, add this one line to `semantic-relay-demo/server.js`
right after the `relayMiddleware` is created:

```js
const plannerInstance = relayMiddleware.getPlanner && relayMiddleware.getPlanner();
if (plannerInstance) {
  plannerInstance.onDecision = relayMiddleware.onAiDecision;
}
```

---

## Final verification checklist

```bash
cd e:\Sementic-relay\semantic-relay

# All existing tests must pass
npm test

# Eval harness must pass (>= 80% accuracy)
npm run eval

# Demo server must start
cd ..\semantic-relay-demo
node server.js
# Open http://localhost:3100
# Run benchmark
# Check AI panel shows data
# Set COHERE_API_KEY=invalid in .env, restart, verify aiStatus:degraded
```

---

## Git workflow — 5 commits (your branch is the integration branch)

### Setup

```bash
cd e:\Sementic-relay\semantic-relay
git checkout main
git pull origin main

# Merge teammates in order FIRST before creating your own work
git fetch origin
git merge origin/feat/vipul-embedding --no-ff -m "feat: merge PatternCache + EmbeddingModel (Vipul)"
npm test   # must be green

git merge origin/feat/madhav-reasoning --no-ff -m "feat: merge ReasoningModel + Validator (Madhav)"
npm test   # must be green

# Now start your own work on main
```

---

### Commit 1 — package.json + src/ai/ directory + planner.js

Create the planner and update package.json:
- `src/ai/planner.js` — full implementation from Task 2 of this brief
- Update `semantic-relay/package.json` — add `eval` script and `optionalDependencies`

Verify before committing:
```bash
npm test
# All existing tests must still pass
# planner.js has no test file — it is tested via eval.js in Commit 2
# Quick smoke test:
node -e "const P = require('./src/ai/planner'); const p = new P({ aiMode: 'safe' }); p.evaluate({resource:'/a',filters:{},page:1,limit:20},{resource:'/b',filters:{},page:1,limit:20}).then(r => console.log('planner ok:', r.decision))"
# Must print: planner ok: fallback
```

Commit:
```bash
git add src/ai/planner.js package.json
git commit -m "feat(ai): add SemanticPlanner orchestrating cache→embedding→reasoning→validator

- Tiered decision flow: pattern cache → Cohere → Gemini (if ambiguous) → Validator
- safe mode: returns fallback immediately, no API calls
- adaptive mode: AI invoked for ambiguous pairs (Cohere score 0.1-0.79)
- aggressive mode: AI invoked for all sub-threshold pairs
- Cohere unavailable (score -1): sets aiStatus=degraded, returns fallback
- Gemini unavailable: returns split, does not degrade aiStatus
- Validator rejection: returns split, increments validatorRejects counter
- Any unhandled error: returns fallback, never throws to middleware
- getStats() returns all 11 AI metric fields for getMetrics() extension
- onDecision callback hook for demo server to record decisions
- add eval script and optionalDependencies to package.json"
```

---

### Commit 2 — test/eval.js (evaluation harness)

Create the 20-case evaluation harness from Task 4 of this brief:
- `test/eval.js`

Verify before committing:
```bash
npm run eval
# Must show:
# - All 20 cases PASS or at most 1 FAIL
# - Classification acc >= 80%
# - Exit code 0
```

Commit:
```bash
git add test/eval.js
git commit -m "feat(eval): add 20-case evaluation harness with mocked Cohere + Gemini

- 6 semantic equivalence cases (should merge)
- 6 semantic non-equivalence cases (must not merge)
- 3 validator rejection cases (AI says merge, validator rejects)
- 2 fallback/degradation cases (Cohere error, Gemini parse failure)
- 3 performance/latency cases (embedding <2s, reasoning <5s, cache <5ms)
- All API calls mocked — zero real network calls, CI-safe
- Outputs: classification accuracy, FP rate, FN rate, backend reduction,
  avg latency, cache hit rate, estimated cost
- Exits with code 1 if accuracy < 80%
- Run with: npm run eval"
```

---

### Commit 3 — src/index.js AI integration

Make the surgical changes to `src/index.js` from Task 3 of this brief:
- Add optional SemanticPlanner require
- Add `aiMode` and `aiOptions` to options destructuring
- Instantiate planner after WindowManager
- Add planner hook in `handleAggregatedGroup` for ambiguous pairs
- Extend `getMetrics()` with AI fields
- Expose `middleware.getPlanner()`

Verify before committing:
```bash
npm test
# ALL existing 9 tests must pass — this is the most critical check
npm run eval
# Eval must still pass

# Smoke test adaptive mode end-to-end:
node -e "
const { semanticRelay } = require('./src/index');
const mw = semanticRelay({ aiMode: 'safe' });
console.log('safe mode metrics:', JSON.stringify(mw.getMetrics(), null, 2));
"
# Must show aiStatus: 'not-installed' or 'disabled' with all AI fields at 0
```

Commit:
```bash
git add src/index.js
git commit -m "feat: wire SemanticPlanner into semanticRelay() middleware

- Add aiMode option: safe | adaptive | aggressive (default: adaptive)
- Add aiOptions object: cohereApiKey, geminiApiKey, thresholds, cacheSize
- Planner instantiated after WindowManager, falls back gracefully if module missing
- AI path triggered in handleAggregatedGroup for pairs with ambiguous score (0 < s < threshold)
- canonicalFilter from planner patched onto intent.filters before supersetBuilder runs
- getMetrics() extended with 11 AI fields (aiInvocations, validatorRejects, aiStatus, etc.)
- middleware.getPlanner() exposed for demo server onDecision wiring
- All 9 existing tests pass unchanged
- Backward compatible: existing usage without aiMode/aiOptions unaffected"
```

---

### Commit 4 — deploy.sh + .env.example + merge Anirudh's demo PR

```bash
# Merge Anirudh's branch
git fetch origin
git merge origin/feat/anirudh-demo --no-ff -m "feat: merge AI decisions UI panel (Anirudh)"

# Wire planner.onDecision callback in demo server
# Open semantic-relay-demo/server.js
# Find the block Anirudh added with relayMiddleware.onAiDecision = recordAiDecision
# Add immediately after it:
#
#   const plannerInstance = relayMiddleware.getPlanner && relayMiddleware.getPlanner();
#   if (plannerInstance) {
#     plannerInstance.onDecision = relayMiddleware.onAiDecision;
#   }
```

Verify before committing:
```bash
cd e:\Sementic-relay\semantic-relay-demo
# Create a .env file for local testing
echo COHERE_API_KEY=test > .env
echo GEMINI_API_KEY=test >> .env
echo AI_MODE=adaptive >> .env
echo PORT=3100 >> .env

npm start
# Open http://localhost:3100
# Run benchmark
# Check /api/ai-decisions — should now show decisions in the log
# AI panel in UI should show aiStatus and invocation counts
# Ctrl+C
```

Commit:
```bash
git add semantic-relay-demo/server.js
git add semantic-relay-demo/.env.example
git add deploy.sh
git commit -m "feat: wire planner.onDecision to demo AI log, add deploy.sh and .env.example

- planner.onDecision now feeds into Anirudh's recordAiDecision buffer
- AI decisions panel in UI shows live data after running benchmark
- deploy.sh: bootstraps EC2 t2.micro (Node 20, PM2, repo clone, .env setup)
- .env.example: documents all required environment variables
- pattern-cache.json and .env added to .gitignore"
```

---

### Commit 5 — final push + tag

```bash
# Full final verification
cd e:\Sementic-relay\semantic-relay
npm test        # must be green
npm run eval    # must show >= 80% accuracy

# Push main
git push origin main

# Tag the hackathon submission
git tag -a v2.0.0-ai -m "semantic-relay v2.0.0 — AI-native adaptive execution layer

Stack: Cohere embed-english-v3.0 + Gemini 1.5 Flash + deterministic validator
Deployment: EC2 t2.micro + PM2
Cost: \$0/day on free tiers

Hackathon constraints satisfied:
- Two models: Cohere (embedding) + Gemini (reasoning)
- Graceful degradation: AI unavailable → deterministic fallback
- Handle being wrong: validator has hard veto authority
- Not top Google result: no prior art for this architecture
- Cost ceiling: \$0/day demo, \$1.52/day at 10K users"

git push origin v2.0.0-ai
```

---

## Complete commit history that judges will see on GitHub

```
* feat: wire planner.onDecision to demo AI log, add deploy.sh (Varun)
* feat: wire SemanticPlanner into semanticRelay() middleware (Varun)
* feat(eval): add 20-case evaluation harness (Varun)
* feat(ai): add SemanticPlanner orchestrating cache→embedding→reasoning→validator (Varun)
* feat: merge AI decisions UI panel (Anirudh)     ← merge commit
* feat: merge ReasoningModel + Validator (Madhav) ← merge commit
* feat: merge PatternCache + EmbeddingModel (Vipul) ← merge commit
```

Clean, linear, reviewable. Every file traceable to one person.
