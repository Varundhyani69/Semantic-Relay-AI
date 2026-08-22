# Prior Art — semantic-relay-ai

**One sentence:** Express middleware that groups concurrent API requests whose filter *values* mean the same thing, so four users searching "electronics", "gadgets", "tech devices" and "electronic items" cost one database call instead of four.

Every number below is measured by `GET /api/benchmark-all`, not estimated. Scenario: 16 concurrent requests spread across 4 synonym values, 12 items per page.

---

## The three closest existing products

### 1. DataLoader — https://github.com/graphql/dataloader

Facebook's batching and caching layer for data fetching, 2016. Collects loads within a tick and issues one batched query per key.

**How we differ:** DataLoader merges requests whose *key* is byte-identical; it has no way to learn that `electronics` and `gadgets` are the same key, so it floors at one query per distinct value.

**Measured:** 16 requests → **4 DB calls** (one per synonym value). semantic-relay: **1**.

### 2. nginx request coalescing — https://nginx.org/en/docs/http/ngx_http_proxy_module.html

`proxy_cache_lock` collapses concurrent requests for the same cache key onto a single upstream fetch, available since 2010.

**How we differ:** The cache key is the URL. Any differing query param produces a different key, and synonym values live in query params.

**Measured:** 16 requests → **16 DB calls**, `coalescedHits: 0`. With `?dupes=2` (identical URLs) it correctly collapses 16 → **8**, `coalescedHits: 8` — the mechanism works perfectly and contributes nothing to this problem.

### 3. Elasticsearch synonym token filter — https://www.elastic.co/guide/en/elasticsearch/reference/current/analysis-synonym-tokenfilter.html

Expands query terms through a synonym list at index or search time, mature since 2015. This is the closest competitor and the one worth taking seriously.

**How we differ:** The synonym list is hand-maintained. Elasticsearch matches us exactly on terms a human already wrote down, and fails completely on terms nobody enumerated.

**Measured, and this is the whole argument:**

| Scenario | Elasticsearch | semantic-relay-ai |
|---|---|---|
| `electronics` group — **in** its dictionary | **1 DB call** (795ms) | 1 DB call |
| `clothing` group — **not** in its dictionary | **4 DB calls** (1002ms) | 1 DB call |

On dictionary hits it ties us and is 3x faster. On a synonym pair absent from the dictionary it degrades to per-value queries, while Gemini judged `apparel` ≡ `garments` at 0.92 confidence at runtime with no dictionary at all.

---

## Full measured comparison

16 requests, 4 synonym values, `category=electronics`:

| Approach | Mechanism | DB calls | Latency |
|---|---|---|---|
| Naive | none | 16 | 1627ms |
| Manual batch API | client-declared page list | 16 | 1594ms |
| DataLoader | key batching | 4 | 1012ms |
| nginx | URL coalescing | 16 | 1589ms |
| Elasticsearch | synonym dictionary | 1 | 795ms |
| **semantic-relay-ai** | embeddings + reasoning | **1** | 2997ms |

Every approach receives the identical per-request filters and the same 500ms collection window, so the comparison isolates *can this technique tell two filter values are equivalent* rather than *does this technique batch at all*.

Read the numbers honestly: batching alone gets you 16 → 4. The remaining 4 → 1 is the only part synonym detection buys, and Elasticsearch buys it too when its dictionary happens to cover your terms. We are not faster than Elasticsearch; we cost 2997ms against its 795ms because two model calls sit in the request path. What we offer is that the merge still happens on vocabulary nobody predicted.

---

## Where we genuinely have no competitor

Not "nobody batches requests" — plenty do. The gap is: **no middleware decides at runtime that two different filter values are semantically equivalent, without a human-authored synonym list.**

That gap only became fillable recently. In 2023 an embedding pass at this volume cost roughly $45/day at 3–5s latency, which is unusable inside a synchronous request path. Cohere `embed-english-v3.0` plus Gemini Flash puts the same work at ~$0.14/day and 2–3s. The technique was obvious before; the price and latency were not survivable.

---

## Honest caveats

- Elasticsearch operates at the search layer and semantic-relay at the middleware layer, so they compose rather than compete. A production system would sensibly run both: the dictionary catches known terms for free, the AI catches the rest.
- The baseline implementations here are faithful reproductions of each mechanism against the same in-memory store, not the real products. nginx is not in the request path; its coalescing rule is reimplemented and verified. Treat these as mechanism comparisons, not vendor benchmarks.
- The 795ms vs 2997ms gap is real and counts against us wherever the database is cheap. Our case only pays off when a database call costs more than a model call.
