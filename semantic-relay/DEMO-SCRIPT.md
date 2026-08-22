# Demo Video Script — semantic-relay-ai

**Target: 4 minutes.** Bold = spoken. `CLICK` = what you do. Setup before recording: server on http://localhost:3100, **Clear Pattern Cache** pressed once, Requests slider at **16**, AI Mode on **Adaptive**.

---

## [0:00–0:25] What it is

> **This is semantic-relay-ai, an Express middleware. One line in your app, and it batches concurrent API requests into a single database call.**
>
> **Batching isn't new. What's new is *what* it can batch. Four users search your product catalogue at the same time — one types "electronics", one types "gadgets", one types "tech devices", one types "electronic items". Same products. Four different strings.**
>
> **Every existing batching layer sees four different requests, because it compares strings. This middleware understands they mean the same thing, and makes one query.**

---

## [0:25–1:05] Run it, and read the comparison table

`CLICK` Demo Scenario → **🎯 High Confidence — Cohere Only (electronics synonyms)** → **Run benchmark**

> **Sixteen concurrent requests across those four synonyms. Every approach here gets the identical input and the same 500-millisecond window, so we're measuring one thing only: can it tell two filter values are equivalent?**

Point at the rows top to bottom:

> **Naive, no batching — sixteen database calls.**
>
> **DataLoader, Facebook's batching layer — four calls. It batches by key, so it merges the pages that share a filter, but it can't know "electronics" and "gadgets" are the same key. It floors at one query per distinct value.**
>
> **nginx URL coalescing — sixteen. It collapses identical URLs, and these URLs differ in a query param, so it never fires.**
>
> **Elasticsearch — one call. And I want to be straight about this: it ties us, and it's faster.**
>
> **semantic-relay — one call.**

---

## [1:05–1:35] The two panels are answering different questions

> **Two sets of numbers on this page, and they're not the same thing.**
>
> **The comparison table is a cross-approach benchmark — six architectures, same input, DB calls and latency each. It answers "how do we compare to prior art." The strip underneath — DB Call Reduction, Time Saved — is just that benchmark summarised.**
>
> **The AI Layer panel is different. That's not a comparison, it's the internals of our request only. It answers "what did the AI actually do to earn that one call."**

Point at the AI Layer fields:

> **AI invocations: how many times the planner ran. Avg embed and Avg reason: latency of each model separately, so you can see which one costs you. Validator rejects: merges the AI proposed that our safety layer refused. Cache hits: pairs we'd already learned. Est. cost: real dollars for this run.**
>
> **And Last AI Decisions is the audit trail — one row per pair, showing the Cohere score, whether Gemini was consulted, its confidence, and the validator's verdict. Nothing here is inferred. It's logged from the actual decision path.**

---

## [1:35–2:20] The part that matters: the dictionary miss

> **Elasticsearch tied us because it has a synonym dictionary, and "electronics equals gadgets" is in it. Someone wrote that line by hand. So watch what happens on vocabulary nobody wrote down.**

`CLICK` Demo Scenario → **🤔 Ambiguous — Cohere + Gemini (clothing synonyms)** → **Run benchmark**

> **Same shape — sixteen requests, four synonyms: apparel, garments, attire, clothes. Not in the dictionary.**

Point at Elasticsearch, then semantic-relay:

> **Elasticsearch just went from one call to four. Its dictionary doesn't cover these words, so it's back to one query per value.**
>
> **We're still at one.**

`CLICK` Last AI Decisions — point at the row:

> **Here's why. Cohere scored "apparel" against "garments" at 0.968 — high, but under our 0.975 confidence bar, so it escalated to Gemini. Gemini returned equivalent, confidence 0.92. The validator approved it. One call.**
>
> **No dictionary. No configuration. It worked that out at runtime, on words we never listed anywhere.**

---

## [2:20–2:50] It learns

`CLICK` **Run benchmark** again, same scenario.

> **Same requests, second time.**

Point at AI Layer → Cache hits, then Est. cost:

> **Cache hit. Avg reason is gone — Gemini wasn't called. The pattern is stored, so this merge is now free and effectively instant. We pay the model once per new pair, not once per request.**

---

## [2:50–3:20] What happens when the AI fails

`CLICK` AI Mode → **Cohere Embeddings Only** → **Run benchmark**

> **Killing the reasoning layer. Still merging — Cohere alone handles the confident cases, and the status badge tells you you're degraded rather than pretending everything's fine.**
>
> **This mattered more than I expected. Earlier in the build, a dead API key and a genuine "these aren't synonyms" verdict both showed up as confidence zero. Indistinguishable. We spent hours tuning thresholds against a broken key. So failures now report their error class explicitly — that amber "Gemini api-error" is a different thing from a red "not equivalent", and the difference is visible.**

---

## [3:20–3:50] Why the AI isn't decoration, and the honest cost

`CLICK` AI Mode → **Deterministic Only (No AI)** → **Run benchmark**

> **AI off. Sixteen calls. The whole value proposition is gone — it's naive batching again. Remove the model and this project doesn't degrade, it collapses.**
>
> **And the tradeoff, plainly: we're slower than Elasticsearch — about 3 seconds against 795 milliseconds — because two model calls sit in the request path. That only pays for itself when a database call costs more than a model call: cross-region reads, heavy joins, per-query billing. On a cheap local database, use the dictionary.**

---

## [3:50–4:00] Close

> **Two years ago this embedding pass cost around $45 a day at three-to-five second latency — unusable inside a request. Today it's fourteen cents and two seconds. The idea was always obvious. The price wasn't survivable until about eighteen months ago.**
>
> **Twenty-case eval harness, ninety-nine tests, and a failure log that tells you exactly what's still broken.**

---

## If asked: which numbers are real

Everything on screen comes from `GET /api/benchmark-all`, live, per run. Nothing hardcoded. The baselines are faithful reimplementations of each mechanism against the same store — not the vendor products — and `PRIOR-ART.md` states that caveat. Earlier in the build two of them were stubs and the table was wrong; `FAILURE-LOG.md` entries 5 and 6 document that and how it was caught.

## Recovery if something misbehaves

- Relay shows 4 calls instead of 1 → Gemini failed. Check the decision row for amber `api-error`. Say the degradation line and move on; it proves the fallback.
- Cache hit doesn't appear → **Clear Pattern Cache** was pressed between runs, or scenario changed. Rerun the same scenario twice.
- Latency spikes → cold model call. Mention the cache is what removes it, then rerun.
