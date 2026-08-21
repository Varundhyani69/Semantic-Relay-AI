# Requirements Document

## Introduction

Upgrade the `semantic-relay` npm middleware into an AI-native adaptive API execution layer. The system must discover semantic equivalences between API requests that were not explicitly programmed, validate those discoveries for safety, execute optimised backend calls, and learn successful patterns for future requests.

The existing deterministic functionality must remain fully intact. All 7 protected files must not be modified. The upgrade is purely additive except for minimal, backward-compatible changes to `src/index.js` and the demo server.

## Requirements

### FR-1 — Tiered Execution Path

The system must process incoming request groups through a tiered decision path:

- **FR-1.1** When the deterministic scorer returns >= 0.8, use the existing aggregation path unchanged.
- **FR-1.2** When the deterministic scorer returns 0.1–0.79 (ambiguous zone), invoke the SemanticPlanner.
- **FR-1.3** When the deterministic scorer returns 0 (resource mismatch), skip AI and execute independently.
- **FR-1.4** The SemanticPlanner must first check the pattern cache before making any API call.
- **FR-1.5** On a cache miss, the SemanticPlanner must call Cohere embed-english-v3.0 to compute cosine similarity between the two request filter representations.
- **FR-1.6** If Cohere cosine similarity >= 0.85, treat as confident match and proceed to validator without calling Gemini.
- **FR-1.7** If Cohere cosine similarity is 0.6–0.84 (ambiguous), escalate to Gemini 1.5 Flash for reasoning.
- **FR-1.8** If Cohere cosine similarity < 0.6, treat as non-equivalent and execute independently without calling Gemini.

### FR-2 — Embedding Model (Model 1 — Cohere)

- **FR-2.1** The embedding model must call the Cohere `/v1/embed` endpoint with model `embed-english-v3.0` and `input_type: search_document`.
- **FR-2.2** The embedding model must represent each request as a text string combining resource path and filter key-value pairs.
- **FR-2.3** The embedding model must compute cosine similarity between two embedding vectors and return a score 0.0–1.0.
- **FR-2.4** The embedding model must return a fallback score of -1 when the Cohere API is unavailable, allowing the planner to degrade gracefully.
- **FR-2.5** The embedding model must record latency in milliseconds for every call.

### FR-3 — Reasoning Model (Model 2 — Gemini)

- **FR-3.1** The reasoning model must call the Gemini 1.5 Flash API only when Cohere confidence is in the ambiguous range (0.6–0.84).
- **FR-3.2** The reasoning model must send a structured prompt that asks Gemini to return a JSON object with fields: `equivalent` (boolean), `canonicalFilter` (object), `confidence` (0.0–1.0), `reason` (string).
- **FR-3.3** The reasoning model must parse the JSON response and validate that all required fields are present.
- **FR-3.4** If Gemini returns malformed JSON or missing fields, the reasoning model must return `{ equivalent: false, confidence: 0, reason: 'parse-error' }` and not throw.
- **FR-3.5** The reasoning model must return a fallback result when the Gemini API is unavailable, allowing the planner to degrade gracefully.
- **FR-3.6** The reasoning model must record latency in milliseconds and estimated token count for every call.

### FR-4 — Deterministic Validator

- **FR-4.1** The validator must receive the AI-proposed plan and the two original intents, and return `{ safe: boolean, reason: string }`.
- **FR-4.2** The validator must reject any plan where `canonicalFilter` contains keys not present in either original intent's filters or resource path.
- **FR-4.3** The validator must reject any plan where the proposed superset limit would exceed `maxSupersetLimit`.
- **FR-4.4** The validator must reject any plan where the two resource paths differ unless the plan explicitly marks them as route-equivalent and the validator can confirm both map to the same registered route handler.
- **FR-4.5** The validator must never call any external API or model. It is purely deterministic.
- **FR-4.6** The validator must be the final authority. No AI output may bypass it.

### FR-5 — Pattern Cache

- **FR-5.1** The pattern cache must store validated-safe filter equivalence pairs keyed by a stable hash of both filter objects.
- **FR-5.2** The pattern cache must be checked before any Cohere or Gemini call.
- **FR-5.3** The pattern cache must persist to a JSON file (`pattern-cache.json`) on process exit via `process.on('exit')` and `process.on('SIGINT')`.
- **FR-5.4** The pattern cache must load from `pattern-cache.json` on startup if the file exists.
- **FR-5.5** The pattern cache must cap at 500 entries, evicting the oldest entry when full.
- **FR-5.6** The pattern cache must record hit and miss counts for metrics.

### FR-6 — Graceful Degradation

- **FR-6.1** When Cohere is unavailable (network error, invalid key, timeout), the planner must log the error, set `aiStatus` to `'degraded'`, and fall back to the deterministic scorer result.
- **FR-6.2** When Gemini is unavailable, the planner must use the Cohere score alone as the decision signal.
- **FR-6.3** When both are unavailable, the system must behave exactly as the existing semantic-relay without any AI upgrade — all existing tests must continue to pass.
- **FR-6.4** The degraded state must be visible in `getMetrics()` as `aiStatus: 'degraded'`.
- **FR-6.5** Degradation must be demonstrable live by setting an invalid API key.

### FR-7 — Extended Metrics

`getMetrics()` must return all existing 13 fields plus:

- **FR-7.1** `aiInvocations` — number of times the SemanticPlanner was invoked
- **FR-7.2** `embeddingInvocations` — number of Cohere API calls made
- **FR-7.3** `reasoningInvocations` — number of Gemini API calls made
- **FR-7.4** `validatorApprovals` — number of AI plans approved by the validator
- **FR-7.5** `validatorRejects` — number of AI plans rejected by the validator
- **FR-7.6** `patternCacheHits` — number of pattern cache hits
- **FR-7.7** `patternCacheMisses` — number of pattern cache misses
- **FR-7.8** `avgEmbeddingMs` — rolling average embedding latency
- **FR-7.9** `avgReasoningMs` — rolling average reasoning latency
- **FR-7.10** `aiStatus` — `'active'` or `'degraded'`
- **FR-7.11** `estimatedCostUsd` — running estimate based on Cohere and Gemini token/call counts

### FR-8 — Configuration

- **FR-8.1** The `semanticRelay()` options object must accept a new optional `aiMode` parameter: `'safe'` | `'adaptive'` | `'aggressive'`. Default: `'adaptive'`.
- **FR-8.2** `safe` mode: AI layer is disabled entirely. Existing deterministic behaviour only.
- **FR-8.3** `adaptive` mode: AI invoked for ambiguous pairs (score 0.1–0.79).
- **FR-8.4** `aggressive` mode: AI invoked for all pairs with score < 0.8, including score-0 pairs on the same resource.
- **FR-8.5** The `semanticRelay()` options object must accept an optional `aiOptions` object with: `cohereApiKey`, `geminiApiKey`, `embeddingThreshold` (default 0.85), `reasoningThreshold` (default 0.6), `maxPatternCacheSize` (default 500).
- **FR-8.6** API keys must also be readable from environment variables `COHERE_API_KEY` and `GEMINI_API_KEY` as fallback.
- **FR-8.7** All existing options (`windowMs`, `threshold`, `routes`, etc.) must remain unchanged and backward compatible.

### FR-9 — Evaluation Harness

- **FR-9.1** `test/eval.js` must contain exactly 20 test cases runnable with `npm run eval`.
- **FR-9.2** All Cohere and Gemini calls must be mocked — no real API calls in the harness.
- **FR-9.3** Test categories must include: semantic equivalence (6 cases), semantic non-equivalence (6 cases), validator rejection (3 cases), fallback/degradation (2 cases), performance/latency (3 cases).
- **FR-9.4** The harness must output: classification accuracy %, false positive rate %, false negative rate %, backend call reduction %, average latency ms, pattern cache hit rate %.
- **FR-9.5** The harness must exit with code 1 if classification accuracy drops below 80%.

### FR-10 — AI Decisions Log and Demo Panel

- **FR-10.1** The demo server must maintain an in-memory circular buffer of the last 50 AI planner decisions.
- **FR-10.2** Each decision record must contain: timestamp, resourceA, resourceB, filtersA, filtersB, cohereScore, geminiUsed, geminiConfidence, validatorApproved, mergeExecuted, latencyMs.
- **FR-10.3** The demo server must expose a `GET /api/ai-decisions` endpoint returning the last 50 decisions.
- **FR-10.4** The demo UI must display an AI Decisions panel below the existing benchmark table showing the live decision log.
- **FR-10.5** The demo UI must show current `aiStatus`, total AI invocations, validator reject count, and pattern cache hit rate.

---

## Non-Functional Requirements

- **NFR-1** AI must not add latency to requests that score >= 0.8 on the deterministic scorer.
- **NFR-2** Embedding calls must complete within 2 seconds or be treated as unavailable.
- **NFR-3** Reasoning calls must complete within 5 seconds or be treated as unavailable.
- **NFR-4** The pattern cache lookup must complete in O(1).
- **NFR-5** The npm package must remain installable with `npm install semantic-relay` and zero new required production dependencies beyond the AI providers.
- **NFR-6** All existing Jest tests in `test/basic.test.js` must continue to pass with zero modification.
- **NFR-7** The system must deploy on EC2 t2.micro (1GB RAM, 1 vCPU) and remain responsive under demo load.
- **NFR-8** Cost must remain at $0/day on free tier quotas (Cohere 1000 calls/month, Gemini 1M tokens/day).

---

## Out of Scope

- Vector databases (Qdrant, Pinecone, Chroma) — flat JSON cache is sufficient
- Authentication or multi-tenant isolation
- POST/PUT/DELETE request optimisation
- Streaming responses
- Mobile or non-Node.js runtimes
- Multiple simultaneous reasoning providers (Gemini only for MVP)

---

## Glossary

| Term | Definition |
|---|---|
| Intent | Normalised representation of an incoming API request: resource, page, limit, filters, groupKey |
| SemanticPlanner | New orchestration module that decides merge/split/fallback for ambiguous request pairs |
| EmbeddingModel | Cohere embed-english-v3.0 adapter — converts intent to vector, computes cosine similarity |
| ReasoningModel | Gemini 1.5 Flash adapter — analyzes ambiguous pairs and proposes a canonical filter |
| Validator | Deterministic safety gate with hard veto authority over all AI proposals |
| PatternCache | In-memory Map + JSON file storing validated-safe filter equivalence pairs |
| PlanResult | Typed output of SemanticPlanner.evaluate(): { decision, canonicalFilter, confidence, source, latencyMs, validatorApproved } |
| aiMode | Configuration option: 'safe' (deterministic only), 'adaptive' (AI for ambiguous), 'aggressive' (AI for all sub-threshold) |
| Canonical filter | The merged filter object that both semantically equivalent requests reduce to |
| Ambiguous zone | Deterministic scorer range 0.1–0.79 where AI is invoked |
| Degraded | aiStatus value when AI services are unavailable — system falls back to deterministic behaviour |
