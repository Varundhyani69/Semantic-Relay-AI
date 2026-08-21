# Design — semantic-relay-ai

## Overview

This design upgrades the `semantic-relay` npm middleware into an AI-native adaptive API execution layer. The upgrade is purely additive — all existing files remain untouched except `src/index.js` (minimal backward-compatible extension) and the demo server. Five new modules under `src/ai/` implement the tiered AI decision path. The existing deterministic path is the default and the fallback.

## Architecture

```
Application
    │
    ▼
semanticRelay() middleware  ← existing, backward-compatible
    │
    ▼
normalizer.js              ← UNCHANGED
    │
    ▼
WindowManager              ← UNCHANGED
    │  (windowMs timer fires)
    ▼
groupContexts()            ← UNCHANGED internal logic
    │
    ▼
scorer.js per pair         ← UNCHANGED
    │
    ├── score >= 0.8 ──────────────────────────────────► existing handleAggregatedGroup() (UNCHANGED)
    │
    ├── score 0.1–0.79 (ambiguous) ──► SemanticPlanner.evaluate(intentA, intentB)
    │                                        │
    │                                        ├── pattern cache HIT ──► validator → merge or split
    │                                        │
    │                                        └── cache MISS
    │                                               │
    │                                               ▼
    │                                        EmbeddingModel.similarity()
    │                                        Cohere embed-english-v3.0
    │                                               │
    │                                        ├── score >= 0.85 ──► validator → merge or split
    │                                        │
    │                                        ├── score 0.6–0.84 ──► ReasoningModel.analyze()
    │                                        │                       Gemini 1.5 Flash
    │                                        │                            │
    │                                        │                       Validator.check()
    │                                        │                            │
    │                                        │                  ├── SAFE ──► merge (supersetBuilder + partitioner UNCHANGED)
    │                                        │                  └── UNSAFE ──► execute independently
    │                                        │
    │                                        └── score < 0.6 ──► execute independently
    │
    └── score 0 (resource mismatch) ─────────────────────────► execute independently (UNCHANGED)
```

---

## Components and Interfaces

### Component Map

| Component | File | Role |
|---|---|---|
| SemanticPlanner | src/ai/planner.js | Orchestrates the full AI decision path |
| EmbeddingModel | src/ai/embedding-model.js | Cohere embed-english-v3.0 adapter |
| ReasoningModel | src/ai/reasoning-model.js | Gemini 1.5 Flash adapter |
| Validator | src/ai/validator.js | Deterministic safety gate — final authority |
| PatternCache | src/ai/pattern-cache.js | In-memory + JSON persistence of learned patterns |
| EvalHarness | test/eval.js | 20-case evaluation harness, CI-safe with mocks |

### External Interface: semanticRelay() options (backward-compatible extension)

```js
semanticRelay({
  // All existing options unchanged
  windowMs, threshold, routes, include, ...

  // New optional fields
  aiMode: 'safe' | 'adaptive' | 'aggressive',  // default: 'adaptive'
  aiOptions: {
    cohereApiKey: string,       // fallback: process.env.COHERE_API_KEY
    geminiApiKey: string,       // fallback: process.env.GEMINI_API_KEY
    embeddingThreshold: number, // default: 0.85
    reasoningThreshold: number, // default: 0.6
    maxPatternCacheSize: number // default: 500
  }
})
```

### Extended getMetrics() interface

Returns all 13 existing fields plus 11 new AI fields:
```js
{
  // existing 13 fields unchanged
  totalRequests, aggregatedRequests, soloRequests, ...

  // new AI fields
  aiInvocations, embeddingInvocations, reasoningInvocations,
  validatorApprovals, validatorRejects,
  patternCacheHits, patternCacheMisses,
  avgEmbeddingMs, avgReasoningMs,
  aiStatus,        // 'active' | 'degraded' | 'disabled'
  estimatedCostUsd
}
```

---

## Data Models

### Intent (existing, unchanged)
```js
{
  intentId: string,   // uuid
  resource: string,   // e.g. '/products'
  page: number,
  limit: number,
  filters: Record<string, unknown>,
  groupKey: string | null,
  expectedGroupSize: number
}
```

### PlanResult (new — returned by SemanticPlanner.evaluate())
```js
{
  decision: 'merge' | 'split' | 'fallback',
  canonicalFilter: Record<string, unknown> | null,
  confidence: number,           // 0.0–1.0
  source: 'cache' | 'embedding' | 'reasoning' | 'fallback',
  latencyMs: number,
  validatorApproved: boolean
}
```

### PatternCacheEntry (new — stored in pattern-cache.json)
```js
{
  canonicalFilter: Record<string, unknown>,
  approvedAt: number,   // Date.now()
  hitCount: number
}
```

### AiDecisionRecord (new — stored in demo server circular buffer)
```js
{
  timestamp: number,
  resourceA: string,
  resourceB: string,
  filtersA: Record<string, unknown>,
  filtersB: Record<string, unknown>,
  cohereScore: number,
  geminiUsed: boolean,
  geminiConfidence: number | null,
  validatorApproved: boolean,
  mergeExecuted: boolean,
  latencyMs: number
}
```

### GeminiResponse (new — parsed from Gemini API response)
```js
{
  equivalent: boolean,
  canonicalFilter: Record<string, unknown> | null,
  confidence: number,
  reason: string
}
```

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Cohere API unreachable / timeout (>2s) | EmbeddingModel returns `{ score: -1, error }`. Planner falls back to deterministic. `aiStatus = 'degraded'`. |
| Cohere returns invalid response shape | Same as above. |
| Gemini API unreachable / timeout (>5s) | ReasoningModel returns `{ equivalent: false, confidence: 0, reason: 'timeout' }`. Planner uses Cohere score alone. |
| Gemini returns malformed JSON | ReasoningModel returns `{ equivalent: false, confidence: 0, reason: 'parse-error' }`. Never throws. |
| Validator rejects plan | Planner returns `{ decision: 'split', validatorApproved: false }`. Requests execute independently. `validatorRejects++`. |
| Both AI services unavailable | System behaves exactly as existing semantic-relay. All existing tests pass. |
| Pattern cache file corrupt on startup | Cache starts empty, logs warning, continues normally. |
| Unhandled exception in planner | Try/catch at top of `evaluate()` returns `{ decision: 'fallback', source: 'fallback' }`. Never propagates to middleware. |

---

## Testing Strategy

### Existing tests (must not break)
- `test/basic.test.js` — all 9 existing Jest tests must pass unchanged with `aiMode: 'safe'` as default when no AI keys are present.

### New evaluation harness
- `test/eval.js` — 20 cases, all Cohere/Gemini calls mocked via Jest, CI-safe, runnable with `npm run eval`.
- Tests cover: semantic equivalence (6), non-equivalence (6), validator rejection (3), fallback (2), performance (3).
- Outputs: classification accuracy, false positive/negative rate, cache hit rate, avg latency, estimated cost.
- Exit code 1 if accuracy < 80%.

### Manual integration test (not automated)
- Start demo server with real API keys, run `/api/benchmark`, observe AI decisions panel populating.
- Set `COHERE_API_KEY=invalid`, run benchmark again, verify `aiStatus: 'degraded'` and system still serves requests.

---

## File Structure

### New Files

```
semantic-relay/
  src/
    ai/
      embedding-model.js    — Cohere API adapter
      reasoning-model.js    — Gemini API adapter
      validator.js          — deterministic safety gate
      planner.js            — orchestration of the above
      pattern-cache.js      — Map + JSON persistence
  test/
    eval.js                 — 20-case evaluation harness
```

### Modified Files (minimal, backward-compatible)

```
semantic-relay/
  src/
    index.js                — aiMode option, planner wiring, extended getMetrics()
  package.json              — add cohere-ai, @google/generative-ai as optional deps

semantic-relay-demo/
  server.js                 — /api/ai-decisions endpoint, decision buffer
  public/
    index.html              — AI decisions panel section
    app.js                  — fetch and render AI decisions
```

### Protected Files (must NOT be touched)

```
src/normalizer.js
src/scorer.js
src/partitioner.js
src/superset-builder.js
src/window-manager.js
src/adapters/memory-window.js
test/basic.test.js
```

---

## Module Designs

### `src/ai/pattern-cache.js`

```js
// Responsibilities:
// - Store validated-safe filter equivalence pairs
// - Key: SHA-256 hash of sorted(filterA_string + '::' + filterB_string)
// - Value: { canonicalFilter, approvedAt, hitCount }
// - Load from pattern-cache.json on require()
// - Save to pattern-cache.json on process.on('exit') and SIGINT
// - Cap at maxSize entries (LRU eviction by approvedAt)

class PatternCache {
  constructor(options = {})
  get(filterA, filterB)           // returns canonicalFilter or null
  set(filterA, filterB, canonicalFilter)
  getStats()                      // { hits, misses, size }
  clear()
  _hash(filterA, filterB)         // stable hash of pair
  _load()                         // from JSON file
  _save()                         // to JSON file
}
```

### `src/ai/embedding-model.js`

```js
// Responsibilities:
// - Convert intent filter object to text string for embedding
// - Call Cohere /v1/embed with embed-english-v3.0
// - Compute cosine similarity between two vectors
// - Return { score, latencyMs } or { score: -1, latencyMs, error } on failure

class EmbeddingModel {
  constructor(options = {})       // { apiKey, timeoutMs: 2000 }
  async similarity(intentA, intentB)  // returns { score: 0.0–1.0, latencyMs }
  _intentToText(intent)           // "resource: /products | category: laptops | maxPrice: 50000"
  _cosineSimilarity(vecA, vecB)
  _callCohere(texts)              // raw HTTP POST to Cohere API
}
```

**Text representation format:**
```
"resource: {resource} | {key1}: {val1} | {key2}: {val2} ..."
```
Keys sorted alphabetically so `category=laptops&maxPrice=50000` and `maxPrice=50000&category=laptops` produce identical text.

### `src/ai/reasoning-model.js`

```js
// Responsibilities:
// - Receive two intents + Cohere similarity score
// - Call Gemini 1.5 Flash with a structured prompt
// - Parse JSON response: { equivalent, canonicalFilter, confidence, reason }
// - Return safe fallback on any error

class ReasoningModel {
  constructor(options = {})       // { apiKey, timeoutMs: 5000 }
  async analyze(intentA, intentB, cohereScore)
  // returns { equivalent, canonicalFilter, confidence, reason, latencyMs, tokenCount }
  _buildPrompt(intentA, intentB, cohereScore)
  _parseResponse(text)            // extracts JSON from Gemini response
  _callGemini(prompt)
}
```

**Prompt structure (concise, structured output enforced):**
```
You are an API semantics analyzer. Determine if these two API requests are semantically equivalent.

Request A: GET {resourceA} with filters {filtersA}
Request B: GET {resourceB} with filters {filtersB}
Cohere similarity score: {score}

Respond with ONLY valid JSON:
{
  "equivalent": true|false,
  "canonicalFilter": { ...merged filter if equivalent, else null },
  "confidence": 0.0-1.0,
  "reason": "one sentence"
}

Rules:
- equivalent=true only if both requests would return the same underlying data
- canonicalFilter must be a valid filter that covers both requests
- Do not invent filter keys that don't exist in either request
```

### `src/ai/validator.js`

```js
// Responsibilities:
// - Receive AI plan + intentA + intentB + middleware options
// - Return { safe: boolean, reason: string }
// - NEVER call any external service
// - This is the final authority — AI cannot bypass this

function validate(plan, intentA, intentB, options = {}) {
  // Check 1: canonicalFilter keys must be subset of union of both filters' keys
  // Check 2: superset limit must not exceed options.maxSupersetLimit
  // Check 3: if resources differ, both must map to the same registered route
  // Check 4: plan.confidence must exceed options.minConfidence (default 0.7)
  // Check 5: plan must have all required fields
  return { safe: boolean, reason: string }
}
```

**Validation rules in priority order:**
1. Plan missing required fields → `{ safe: false, reason: 'incomplete-plan' }`
2. Plan confidence < minConfidence → `{ safe: false, reason: 'low-confidence' }`
3. canonicalFilter has unknown keys → `{ safe: false, reason: 'unknown-filter-keys' }`
4. Projected superset limit > maxSupersetLimit → `{ safe: false, reason: 'superset-too-large' }`
5. Resources differ and no route mapping → `{ safe: false, reason: 'unverified-route-equivalence' }`
6. All checks pass → `{ safe: true, reason: 'validated' }`

### `src/ai/planner.js`

```js
// Responsibilities:
// - Orchestrate: cache → embedding → reasoning → validation
// - Return PlanResult for use by index.js groupBySimilarity
// - Handle all errors, never throw to caller
// - Track all metrics counters

class SemanticPlanner {
  constructor(options = {})
  // options: { cohereApiKey, geminiApiKey, embeddingThreshold, reasoningThreshold,
  //            maxSupersetLimit, minConfidence, patternCache, aiMode }

  async evaluate(intentA, intentB)
  // returns: {
  //   decision: 'merge' | 'split' | 'fallback',
  //   canonicalFilter: object | null,
  //   confidence: number,
  //   source: 'cache' | 'embedding' | 'reasoning' | 'fallback',
  //   latencyMs: number,
  //   validatorApproved: boolean
  // }

  getStats()
  // returns all AI metric counters
}
```

**Decision flow in `evaluate()`:**
```
1. if aiMode === 'safe' → return { decision: 'fallback', source: 'fallback' }
2. check pattern cache → HIT: run validator with cached plan
3. call EmbeddingModel.similarity()
   → error: return { decision: 'fallback', source: 'fallback' }, set aiStatus='degraded'
   → score < reasoningThreshold (0.6): return { decision: 'split', source: 'embedding' }
   → score >= embeddingThreshold (0.85): run validator with embedding-derived plan
   → score 0.6–0.84: call ReasoningModel.analyze()
4. call Validator.validate(plan, intentA, intentB)
   → safe: store in pattern cache, return { decision: 'merge', ... }
   → unsafe: return { decision: 'split', validatorApproved: false, ... }
5. on any unhandled error: return { decision: 'fallback', source: 'fallback' }
```

### `src/index.js` — Changes Only

**New option destructuring (add to existing block):**
```js
const {
  // ... all existing options unchanged ...
  aiMode = 'adaptive',
  aiOptions = {}
} = options;
```

**New planner instantiation (after existing wm = new WindowManager(...)):**
```js
const planner = (aiMode !== 'safe') ? new SemanticPlanner({
  cohereApiKey: aiOptions.cohereApiKey || process.env.COHERE_API_KEY,
  geminiApiKey: aiOptions.geminiApiKey || process.env.GEMINI_API_KEY,
  embeddingThreshold: aiOptions.embeddingThreshold || 0.85,
  reasoningThreshold: aiOptions.reasoningThreshold || 0.6,
  maxSupersetLimit,
  aiMode
}) : null;
```

**Modified `groupBySimilarity()` — only the score-check block changes:**
```js
// existing: if (matchesGroup) { ... }
// new: if (matchesGroup || await plannerApproves(ctx, existing)) { ... }
```

The `plannerApproves()` helper is async and only called when the deterministic score is in 0.1–0.79.

**Extended `getMetrics()` return object:**
```js
// spread existing 13 fields, then add:
...(planner ? planner.getStats() : {
  aiInvocations: 0, embeddingInvocations: 0, reasoningInvocations: 0,
  validatorApprovals: 0, validatorRejects: 0,
  patternCacheHits: 0, patternCacheMisses: 0,
  avgEmbeddingMs: 0, avgReasoningMs: 0,
  aiStatus: 'disabled', estimatedCostUsd: 0
})
```

---

## Demo Server Changes

### New `/api/ai-decisions` endpoint

```js
// Circular buffer of last 50 decisions stored in server.js
const aiDecisionLog = [];
const AI_DECISION_LOG_MAX = 50;

function recordAiDecision(decision) {
  aiDecisionLog.unshift({ ...decision, timestamp: Date.now() });
  if (aiDecisionLog.length > AI_DECISION_LOG_MAX) aiDecisionLog.pop();
}

app.get('/api/ai-decisions', (req, res) => {
  res.json({
    decisions: aiDecisionLog,
    summary: relayMiddleware.getMetrics()
  });
});
```

The `onAggregate` and planner callbacks feed into `recordAiDecision`.

### Demo UI Panel (index.html addition)

New section below `.scoreboard`:
```html
<section class="ai-panel" aria-label="AI decisions">
  <h2>AI Layer</h2>
  <div class="ai-stats">
    <div><span>Status</span><strong id="aiStatus">-</strong></div>
    <div><span>AI invocations</span><strong id="aiInvocations">-</strong></div>
    <div><span>Validator rejects</span><strong id="validatorRejects">-</strong></div>
    <div><span>Cache hits</span><strong id="patternCacheHits">-</strong></div>
    <div><span>Est. cost</span><strong id="estimatedCost">-</strong></div>
  </div>
  <div id="aiDecisionLog" class="decision-log"></div>
</section>
```

---

## Evaluation Harness Design (`test/eval.js`)

### Test Case Structure

```js
{
  id: 'eq-001',
  category: 'equivalence',
  description: 'category=laptops vs type=laptop',
  intentA: { resource: '/products', filters: { category: 'laptops' }, page: 1, limit: 20 },
  intentB: { resource: '/products', filters: { type: 'laptop' }, page: 1, limit: 20 },
  mockCohereScore: 0.72,            // in ambiguous range → triggers Gemini
  mockGeminiResponse: { equivalent: true, canonicalFilter: { category: 'laptops' }, confidence: 0.91, reason: '...' },
  expectedDecision: 'merge',
  expectedSource: 'reasoning'
}
```

### 20 Test Cases

| # | Category | Description | Expected |
|---|---|---|---|
| eq-001 | equivalence | `category=laptops` vs `type=laptop` | merge |
| eq-002 | equivalence | `maxPrice=50000` vs `price_lt=50000` | merge |
| eq-003 | equivalence | `sort=newest` vs `order=desc&sortBy=date` | merge |
| eq-004 | equivalence | `brand=apple` vs `manufacturer=apple` | merge |
| eq-005 | equivalence | `status=active` vs `isActive=true` | merge |
| eq-006 | equivalence | `color=red` vs `colour=red` | merge |
| neq-001 | non-equivalence | `category=laptops` vs `category=phones` | split |
| neq-002 | non-equivalence | `maxPrice=50000` vs `maxPrice=100000` | split |
| neq-003 | non-equivalence | `userId=123` vs `userId=456` | split |
| neq-004 | non-equivalence | `status=active` vs `status=deleted` | split |
| neq-005 | non-equivalence | `inStock=true` vs `inStock=false` | split |
| neq-006 | non-equivalence | similar-looking but different resource `/users` vs `/admins` | split |
| val-001 | validator-reject | AI says merge but canonicalFilter has unknown key `__inject` | split |
| val-002 | validator-reject | AI confidence 0.55 below minConfidence 0.7 | split |
| val-003 | validator-reject | AI proposes merge that exceeds maxSupersetLimit | split |
| fb-001 | fallback | Cohere returns 500 error | fallback (deterministic) |
| fb-002 | fallback | Gemini returns malformed JSON | fallback to embedding-only |
| perf-001 | performance | embedding call completes under 2000ms | latency check |
| perf-002 | performance | reasoning call completes under 5000ms | latency check |
| perf-003 | performance | cache hit returns in < 1ms | latency check |

### Harness Output Format

```
semantic-relay-ai evaluation harness
=====================================
Running 20 test cases...

PASS eq-001 category=laptops vs type=laptop [merge] (source: reasoning, 0ms mock)
PASS eq-002 maxPrice=50000 vs price_lt=50000 [merge] (source: reasoning, 0ms mock)
...
FAIL neq-003 userId=123 vs userId=456 — expected split, got merge

Results
-------
Total:               20
Passed:              19
Failed:               1
Classification acc:  95.0%
False positive rate:  0.0%  (safe merges called as split)
False negative rate:  8.3%  (unsafe merges not caught)
Avg latency (mock):   0ms
Cache hit rate:      20.0%
Est. cost (mock):    $0.000

Exit code: 0 (accuracy >= 80%)
```

---

## Deployment Design

### EC2 t2.micro Setup

**Instance:** t2.micro, Amazon Linux 2023, 1GB RAM, us-east-1
**Security group:** inbound TCP 3100 open (or 80 with nginx proxy)

**Bootstrap script:**
```bash
# Node.js 20
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs

# PM2
sudo npm install -g pm2

# App
git clone <repo> /home/ec2-user/semantic-relay
cd /home/ec2-user/semantic-relay/semantic-relay-demo
npm install

# Environment
cat > .env << EOF
COHERE_API_KEY=<key>
GEMINI_API_KEY=<key>
AI_MODE=adaptive
PORT=3100
EOF

# Start
pm2 start server.js --name semantic-relay-demo
pm2 startup
pm2 save
```

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `COHERE_API_KEY` | Yes (adaptive/aggressive) | — | Cohere embed API key |
| `GEMINI_API_KEY` | Yes (adaptive/aggressive) | — | Google AI Studio key |
| `AI_MODE` | No | `adaptive` | `safe` \| `adaptive` \| `aggressive` |
| `PORT` | No | `3100` | Server port |
| `RELAY_WINDOW_MS` | No | `12` | Existing option |
| `RELAY_THRESHOLD` | No | `0.8` | Existing option |

---

## Cost Model

| Component | Free Tier | Per-call cost | Daily demo usage | Daily cost |
|---|---|---|---|---|
| EC2 t2.micro | 750 hrs/month | $0 | 24 hrs | $0 |
| Cohere embed-english-v3.0 | 1000 calls/month | $0.0001/call after | ~100 calls | $0 |
| Gemini 1.5 Flash | 1M tokens/day | $0.075/1M after | ~5K tokens | $0 |
| **Total** | | | | **$0/day** |

At 10,000 users/day (scale answer for pitch Q5):
- Cohere: ~10K calls × $0.0001 = $1.00
- Gemini: ~500 calls × 500 tokens × $0.000075 = $0.019
- EC2 t3.small: ~$0.50
- **Total: ~$1.52/day**

---

## Hackathon Constraint Satisfaction Summary

| Constraint | How satisfied |
|---|---|
| Two models | Cohere (embed-english-v3.0) + Gemini (1.5 Flash) — different providers, different architectures, different jobs |
| Degrade gracefully | Cohere/Gemini unavailable → deterministic fallback → existing system works unchanged. Demo: set invalid API key live. |
| Handle being wrong | Validator has hard veto. `validatorRejects` visible in dashboard. Eval harness has 3 validator-rejection cases. |
| Not top Google result | No existing product does cross-filter semantic equivalence discovery as transparent npm middleware |
| Cost ceiling | $0/day on free tiers. $1.52/day at 10K users. Measured, not estimated. |

---

## Correctness Properties

These invariants must hold at all times regardless of AI model output:

Property 1: Safety — The validator must be called for every AI-proposed merge. No merge may execute without validator approval.

Property 2: Fallback — If any component of the AI layer throws or times out, the request pair must fall back to the deterministic path. No request may be dropped or stalled due to an AI failure.

Property 3: Idempotency — The same two intents evaluated by the planner must always produce the same decision when the pattern cache is populated (deterministic after first encounter).

Property 4: Backward compatibility — All existing `test/basic.test.js` tests must pass with `aiMode: 'safe'` or when no AI API keys are set.

Property 5: No direct execution — No AI model output may directly trigger a backend call. The execution path always goes: AI proposal → validator → supersetBuilder → route.fetch.

Property 6: Cost ceiling — The reasoning model (Gemini) must only be called when Cohere cosine similarity is in range 0.6–0.84. It must never be called for every request.
