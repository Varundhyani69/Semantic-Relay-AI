# Bugfix Requirements Document

## Introduction

The AI layer in semantic-relay is non-functional because requests with semantically equivalent filters (e.g., `{category:"hardware"}`, `{type:"hardware"}`, `{genre:"hardware"}`) are never grouped together for AI evaluation. The `groupBySimilarity()` function creates bucket keys that include the stringified filter object, causing requests with different filter key names to be placed in separate buckets. As a result, AI evaluation is never triggered, stats remain at zero, and the system cannot demonstrate its core semantic grouping capability.

This bug prevents stakeholder demos from showcasing AI capabilities and eliminates any performance benefit from semantic caching and grouping.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN two requests have semantically equivalent filters with different key names (e.g., `{category:"hardware"}` and `{type:"hardware"}`) THEN the system creates different bucket keys using `stableStringify(intent.filters)` and places them in separate buckets

1.2 WHEN requests are placed in separate buckets due to different filter key names THEN each bucket contains only 1 request, causing all requests to be processed as SOLO

1.3 WHEN all requests are processed as SOLO THEN AI evaluation is never triggered, resulting in zero AI stats (embeddingInvocations=0, reasoningInvocations=0, validatorApprovals=0)

1.4 WHEN running a benchmark with diverse filter keys (category/type/genre/productType) all with the same value THEN decision logs show `SOLO reason=solo` for every request despite semantic equivalence

1.5 WHEN the second benchmark run executes THEN it is slower instead of faster because the AI layer never cached any semantic patterns

### Expected Behavior (Correct)

2.1 WHEN two requests have semantically equivalent filters with different key names but the same resource and limit THEN the system SHALL place them in the same bucket for similarity evaluation

2.2 WHEN requests with different filter structures are grouped in the same bucket THEN the system SHALL allow the deterministic scorer and AI layer to evaluate their semantic similarity

2.3 WHEN semantically equivalent filters trigger AI evaluation THEN the system SHALL increment AI stats (embeddingInvocations, reasoningInvocations, validatorApprovals > 0)

2.4 WHEN running a benchmark with diverse filter keys all with the same value THEN the system SHALL group semantically equivalent requests and show AI evaluation in decision logs

2.5 WHEN the second benchmark run executes after AI has learned semantic patterns THEN it SHALL be faster due to pattern caching and improved grouping decisions

### Unchanged Behavior (Regression Prevention)

3.1 WHEN two requests have identical filters (same keys and values) THEN the system SHALL CONTINUE TO bucket them together as before

3.2 WHEN requests have different resources THEN the system SHALL CONTINUE TO bucket them separately as before

3.3 WHEN requests have different limit values THEN the system SHALL CONTINUE TO bucket them separately as before

3.4 WHEN requests have explicitly different groupKey hints THEN the system SHALL CONTINUE TO bucket them separately as before

3.5 WHEN the deterministic scorer returns a score >= threshold for requests in the same bucket THEN the system SHALL CONTINUE TO group them without requiring AI evaluation

3.6 WHEN guardrails (maxGroupSize, maxSupersetLimit, maxPageGap) are violated THEN the system SHALL CONTINUE TO split groups or fall back to SOLO as before
