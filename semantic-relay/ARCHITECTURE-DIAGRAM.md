# Architecture Diagram — semantic-relay-ai

> One page. Every box, arrow, model call and data store labelled.

---

## Full Request Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER REQUESTS                           │
│  GET /api/relay/products?page=1&category=electronics            │
│  GET /api/relay/products?page=2&category=gadgets                │
│  GET /api/relay/products?page=3&category=tech%20devices         │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    EXPRESS MIDDLEWARE                           │
│              semanticRelay({ windowMs, threshold })             │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                        NORMALIZER                               │
│        Extract: resource, page, limit, filters, groupKey        │
│                  Output: Intent { intentId, ... }               │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                      WINDOW MANAGER                             │
│     Collect requests within windowMs (default: 20ms) window     │
│          Early flush if x-relay-expected-size reached           │
│               Data store: MemoryWindow (in-memory)              │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                   DETERMINISTIC SCORER                          │
│   Compare resource, filters, page per pair  →  score 0.0–1.0    │
│   Same filters + adjacent pages = 0.9                           │
│   Different filter VALUES (e.g., "electronics" vs "gadgets")    │
│     → score = 0.3 (ambiguous, triggers AI)                      │
│   Different resource  = 0.0                                     │
└───────┬──────────────────┬──────────────────┬───────────────────┘
        │                  │                  │
   score >= 0.8      score 0.1–0.79       score = 0
        │              (ambiguous)             │
        ▼                  │                  ▼
   ┌─────────┐             │            ┌──────────┐
   │  MERGE  │             │            │  SPLIT   │
   │ (direct)│             │            │ (direct) │
   └────┬────┘             │            └────┬─────┘
        │                  ▼                 │
        │      ┌───────────────────────┐     │
        │      │     SEMANTIC PLANNER  │     │
        │      │  (src/ai/planner.js)  │     │
        │      └───────────┬───────────┘     │
        │                  ▼                 │
        │      ┌───────────────────────┐     │
        │      │     PATTERN CACHE     │     │
        │      │  src/ai/pattern-      │     │
        │      │  cache.js             │     │
        │      │  ─────────────────    │     │
        │      │  Key: SHA-256 hash    │     │
        │      │  of (filterA,filterB) │     │
        │      │  Max: 500 entries     │     │
        │      │  LRU eviction         │     │
        │      │  Persists: JSON file  │◄────┼──── pattern-cache.json
        │      └───────────┬───────────┘     │       (disk, 500 entries)
        │                  │                 │
        │           ┌──────┴──────┐          │
        │           │             │          │
        │         HIT           MISS         │
        │           │             │          │
        │           ▼             ▼          │
        │    ┌──────────┐  ┌─────────────────────────────────────┐
        │    │  RETURN  │  │         EMBEDDING MODEL             │
        │    │  CACHED  │  │     src/ai/embedding-model.js       │
        │    │  ~0ms    │  │  ───────────────────────────────────│
        │    │  $0 cost │  │  _intentToText(): sorted key=val    │
        │    └────┬─────┘  │  _callCohere(): POST /v1/embed      │
        │         │        │  model: embed-english-v3.0          │
        │         │        │  timeout: 2000ms                    │
        │         │        │  _cosineSimilarity(): dot / (|a||b|) │
        │         │        │  ─────────────────────────────────── │
        │         │        │  ► COHERE API (external)             │
        │         │        │    embed-english-v3.0                │
        │         │        │    ~565ms avg latency                │
        │         │        │    cost: $0.0001/call                │
        │         │        │  ─────────────────────────────────── │
        │         │        │  Returns: { score, latencyMs }       │
        │         │        │  On failure: { score: -1, error }    │
        │         │        └──────────────┬──────────────────────┘
        │         │                       │
        │         │          ┌────────────┼────────────┐
        │         │          │            │            │
        │         │       < 0.6      0.6–0.84      >= 0.85
        │         │       SPLIT           │          MERGE
        │         │          │            ▼             │
        │         │          │  ┌──────────────────┐   │
        │         │          │  │  REASONING MODEL  │   │
        │         │          │  │ src/ai/reasoning- │   │
        │         │          │  │ model.js          │   │
        │         │          │  │ ────────────────  │   │
        │         │          │  │ _buildPrompt()    │   │
        │         │          │  │ _callGemini()     │   │
        │         │          │  │ timeout: 5000ms   │   │
        │         │          │  │ ────────────────  │   │
        │         │          │  │ ► GEMINI 3.6      │   │
        │         │          │  │   FLASH (external)│   │
        │         │          │  │   ~800ms latency  │   │
        │         │          │  │   $0.075/1M tokens│   │
        │         │          │  │ ────────────────  │   │
        │         │          │  │ Returns:          │   │
        │         │          │  │ { equivalent,     │   │
        │         │          │  │   canonicalFilter,│   │
        │         │          │  │   confidence,     │   │
        │         │          │  │   reason }        │   │
        │         │          │  └────────┬──────────┘   │
        │         │          │           ▼              │
        │         │          │  ┌──────────────────┐   │
        │         │          │  │    VALIDATOR      │◄──┘
        │         │          │  │  src/ai/          │
        │         │          │  │  validator.js     │
        │         │          │  │  ──────────────── │
        │         │          │  │  Hard veto checks:│
        │         │          │  │  1. Unknown keys  │
        │         │          │  │  2. Confidence <  │
        │         │          │  │     minConfidence │
        │         │          │  │  3. Superset >    │
        │         │          │  │     maxLimit      │
        │         │          │  │  4. Diff resource │
        │         │          │  │     no route map  │
        │         │          │  │  No external calls│
        │         │          │  └────────┬──────────┘
        │         │          │           │
        │         │          │    ┌──────┴──────┐
        │         │          │    │             │
        │         │          │  SAFE         UNSAFE
        │         │          │    │             │
        │         │          │    ▼             ▼
        │         │          │  ┌──────┐    ┌──────┐
        │         │          │  │MERGE │    │SPLIT │
        │         │          │  │+SAVE │    │      │
        │         │          │  │cache │    └──┬───┘
        │         │          │  └──┬───┘       │
        └─────────┴──────────┴─────┤           │
                                   ▼           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      SUPERSET BUILDER                            │
│   Merge all N requests → skip=0, limit=N×pageSize, filter={}    │
│   Result: 1 superset query covering all individual requests      │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                      RESPONSE CACHE                              │
│   In-memory Map  |  TTL: 150ms  |  Max: 64 entries              │
│   Key: resource|skip|limit|stableStringify(filter)              │
│   HIT → skip DB call entirely                                    │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                       DATABASE CALL                              │
│              1 call instead of 16 (93.75% reduction)            │
│              Demo: in-memory constrained store (180ms delay)     │
│              Production: MongoDB / any DB                        │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                        PARTITIONER                               │
│       arrayOffset = intentSkip - superset.skip                  │
│       slice = results[arrayOffset : arrayOffset + limit]        │
│       Returns: Map<intentId, slice[]>                            │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    16 INDIVIDUAL RESPONSES                       │
│              Each caller gets exactly their page slice           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Stores

| Store | Type | Location | Size Limit | TTL |
|---|---|---|---|---|
| MemoryWindow | In-memory Map | `src/adapters/memory-window.js` | `maxPendingPerKey` (default 1000) | Flushed on `windowMs` timer |
| Response Cache | In-memory Map | `src/index.js` | 128 entries | configurable via `cacheTtlMs` |
| Pattern Cache | In-memory Map + JSON file | `src/ai/pattern-cache.js` + `pattern-cache.json` | 500 entries (LRU) | Persistent across restarts |

---

## External API Calls

| API | Model | When Called | Timeout | Cost | Fallback |
|---|---|---|---|---|---|
| Cohere `/v1/embed` | `embed-english-v3.0` | Deterministic score 0.1–0.79, cache miss | 2000ms | $0.0001/call | score: -1 → deterministic fallback |
| Gemini 3.6 Flash | `gemini-3.6-flash` | Cohere score 0.6–0.84 | 5000ms | ~$0.075/1M tokens | `{ equivalent: false, confidence: 0 }` |

---

## Guardrails (All Deterministic — No AI)

| Guardrail | Default | What it prevents |
|---|---|---|
| `maxGroupSize` | 32 | Groups too large to partition correctly |
| `maxSupersetLimit` | 1000 | DB queries returning too many rows |
| `maxPageGap` | 32 | Page ranges too far apart to merge |
| `responseTimeoutMs` | 30000ms | Followers stalled if leader never responds |
| Validator hard veto | always on | Unsafe AI merges — unknown keys, low confidence, oversized superset |

---

## AI Metrics Tracked (in `getMetrics()`)

```
aiInvocations       — times SemanticPlanner.evaluate() was called
embeddingInvocations — Cohere API calls made
reasoningInvocations — Gemini API calls made
validatorApprovals  — AI plans approved
validatorRejects    — AI plans vetoed
patternCacheHits    — cache hits (zero-cost decisions)
patternCacheMisses  — cache misses (API call needed)
avgEmbeddingMs      — rolling average Cohere latency
avgReasoningMs      — rolling average Gemini latency
aiStatus            — 'active' | 'degraded' | 'disabled'
estimatedCostUsd    — running cost estimate
aiMode              — current mode: 'adaptive' | 'safe' | 'cohere-only' | 'gemini-reasoning' | 'deterministic-only' | 'disabled'
```

---

## AI Modes

| Mode | Behaviour |
|---|---|
| `adaptive` (default) | Full pipeline: Pattern Cache → Cohere → Gemini (if ambiguous) → Validator |
| `safe` / `disabled` | AI layer bypassed entirely — deterministic scorer only |
| `deterministic-only` | Same as safe — no API calls |
| `cohere-only` | Uses Cohere embeddings but never calls Gemini |
| `gemini-reasoning` | Forces Gemini call even when Cohere is confident |
| `pattern-cache-test` | Uses cache but skips Cohere (testing mode) |

AI mode can be changed at runtime via `middleware.setAiMode(newMode)`.

---

## New Middleware Methods (v2.0)

| Method | Description |
|---|---|
| `middleware.getMetrics()` | Returns all metrics including 12 AI fields |
| `middleware.getDecisionLog()` | Returns last 100 AI decisions (circular buffer) |
| `middleware.setAiMode(mode)` | Change AI mode at runtime without restart |
| `middleware.getAiMode()` | Get current AI mode |
| `middleware.clearPatternCache()` | Flush the pattern cache |
| `middleware.getPlanner()` | Access the SemanticPlanner instance directly |

---

## Key Insight: Why 1 DB Call Instead of 16

```
Request 1: page=1, limit=10  →  skip=0,  needs rows 0–9
Request 2: page=2, limit=10  →  skip=10, needs rows 10–19
...
Request 16: page=16, limit=10 →  skip=150, needs rows 150–159

Superset query: skip=0, limit=160  →  ONE DB call
Partitioner: slice rows 0–9 for req1, 10–19 for req2, ... etc.
```


