# AI Grouping Filter Normalization Bugfix Design

## Overview

The semantic-relay AI layer is non-functional because the `groupBySimilarity()` function in `src/index.js` creates bucket keys that include stringified filter objects. This causes requests with semantically equivalent filters but different key names (e.g., `{category:"hardware"}` vs `{type:"hardware"}`) to be placed in separate buckets, preventing semantic evaluation. As a result, all requests are processed as SOLO, AI evaluation is never triggered, and the system fails to demonstrate its core semantic grouping capability.

The fix will modify the bucketing strategy to enable semantic grouping while preserving all existing deterministic grouping behavior for identical filters, different resources, and different limits.

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug - when semantically equivalent filters with different key names prevent bucket consolidation
- **Property (P)**: The desired behavior - requests with the same resource and limit should be bucketed together for similarity evaluation, regardless of filter key names
- **Preservation**: Existing deterministic bucketing behavior that must remain unchanged (identical filters, different resources, different limits, explicit groupKey hints)
- **groupBySimilarity()**: The function in `src/index.js` lines 45-80 that creates buckets and forms groups based on similarity scoring
- **stableStringify()**: Helper function that deterministically stringifies objects by sorting keys
- **intent**: An object containing `resource`, `limit`, `filters`, `page`, and optionally `groupKey` properties
- **bucket**: A collection of request contexts with the same bucket key, sorted by page number
- **scorer**: Deterministic function that computes similarity scores between intents

## Bug Details

### Bug Condition

The bug manifests when two or more requests have the same `resource` and `limit` values but semantically equivalent filters with different key names (e.g., `{category:"hardware"}` vs `{type:"hardware"}`). The `groupBySimilarity()` function creates bucket keys by concatenating `['auto', intent.resource, intent.limit, stableStringify(intent.filters)]`, which causes different filter structures to produce different bucket keys even when they are semantically equivalent. This prevents the scorer and AI layer from ever evaluating their semantic similarity.

**Formal Specification:**
```
FUNCTION isBugCondition(intentA, intentB)
  INPUT: intentA, intentB of type Intent
  OUTPUT: boolean
  
  RETURN intentA.resource = intentB.resource
         AND intentA.limit = intentB.limit
         AND NOT intentA.groupKey
         AND NOT intentB.groupKey
         AND stableStringify(intentA.filters) ≠ stableStringify(intentB.filters)
         AND areSemanticallySimilar(intentA.filters, intentB.filters)
         AND bucketsAreDifferent(intentA, intentB)
END FUNCTION

FUNCTION bucketsAreDifferent(intentA, intentB)
  keyA := ['auto', intentA.resource, intentA.limit, stableStringify(intentA.filters)].join('|')
  keyB := ['auto', intentB.resource, intentB.limit, stableStringify(intentB.filters)].join('|')
  RETURN keyA ≠ keyB
END FUNCTION
```

### Examples

**Example 1: Hardware Filter Variants**
- Request A: `GET /products?category=hardware&page=1&limit=10`
  - Intent: `{resource: '/products', filters: {category: 'hardware'}, page: 1, limit: 10}`
  - Current Bucket Key: `auto|/products|10|{"category":"hardware"}`
- Request B: `GET /products?type=hardware&page=1&limit=10`
  - Intent: `{resource: '/products', filters: {type: 'hardware'}, page: 1, limit: 10}`
  - Current Bucket Key: `auto|/products|10|{"type":"hardware"}`
- **Expected**: Both should be in the same bucket for similarity evaluation
- **Actual**: Placed in separate buckets, processed as SOLO

**Example 2: Multiple Semantically Similar Requests**
- Request A: `{category: 'hardware'}` → Bucket: `auto|/products|10|{"category":"hardware"}`
- Request B: `{type: 'hardware'}` → Bucket: `auto|/products|10|{"type":"hardware"}`
- Request C: `{genre: 'hardware'}` → Bucket: `auto|/products|10|{"genre":"hardware"}`
- Request D: `{productType: 'hardware'}` → Bucket: `auto|/products|10|{"productType":"hardware"}`
- **Expected**: All 4 requests in same bucket, AI evaluates similarity
- **Actual**: 4 separate buckets, all processed as SOLO, AI stats remain at zero

**Example 3: Edge Case - Empty Filters**
- Request A: `{resource: '/products', filters: {}, page: 1, limit: 10}`
- Request B: `{resource: '/products', filters: {}, page: 1, limit: 10}`
- **Expected**: Same bucket (identical filters)
- **Actual**: Same bucket - this case works correctly

**Example 4: Edge Case - Null/Undefined Filters**
- Request A: `{resource: '/products', filters: null, page: 1, limit: 10}`
- Request B: `{resource: '/products', filters: undefined, page: 1, limit: 10}`
- **Expected**: Same bucket after normalization
- **Current**: Both normalize to empty string via `stableStringify()`, same bucket - this works correctly

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- **Identical Filters**: Requests with identical filter objects (same keys and values) must continue to be bucketed together deterministically
- **Different Resources**: Requests with different `resource` values must continue to be bucketed separately
- **Different Limits**: Requests with different `limit` values must continue to be bucketed separately
- **Explicit groupKey Hints**: Requests with explicit `groupKey` values must continue to be bucketed according to those hints, separate from auto-bucketed requests
- **Deterministic Scoring**: When the scorer returns a score >= threshold for requests in the same bucket, they must continue to be grouped without requiring AI evaluation
- **Guardrail Enforcement**: When maxGroupSize, maxSupersetLimit, or maxPageGap are violated, the system must continue to split groups or fall back to SOLO as before
- **Page Sorting**: Within each bucket, requests must continue to be sorted by page number
- **Sequential Group Formation**: Within each bucket, groups must continue to be formed sequentially based on scorer comparisons

**Scope:**
All inputs where filters are identical (same key-value pairs) should be completely unaffected by this fix. This includes:
- Requests with identical filters already being bucketed together
- Requests with different resources being bucketed separately
- Requests with different limits being bucketed separately
- Requests with explicit groupKey values being bucketed by hint
- Deterministic grouping decisions based on scorer >= threshold
- Guardrail splits and fallbacks

## Hypothesized Root Cause

Based on the bug description and code analysis, the root cause is:

1. **Over-Specific Bucket Key**: The bucket key formula `['auto', intent.resource, intent.limit, stableStringify(intent.filters)].join('|')` includes the stringified filter object, making the key unique for each filter structure even when filters are semantically equivalent.

2. **Premature Bucketing Decision**: The bucketing happens before any similarity evaluation occurs. Once requests are in different buckets, the scorer and AI layer never get a chance to compare them.

3. **Missing Filter Normalization**: The system treats filter key names as semantically significant when they are often just syntactic variations (category vs type vs genre vs productType).

4. **Correct Design, Wrong Granularity**: The bucketing strategy correctly separates by resource and limit (which are structurally significant), but incorrectly separates by filter structure (which may not be semantically significant).

## Correctness Properties

Property 1: Bug Condition - Semantic Filter Grouping

_For any_ pair of intents where the bug condition holds (same resource, same limit, no explicit groupKey, different filter key names but semantically similar values), the fixed groupBySimilarity function SHALL place them in the same bucket, allowing the scorer and AI layer to evaluate their semantic similarity and potentially group them together.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**

Property 2: Preservation - Deterministic Bucketing Behavior

_For any_ pair of intents where the bug condition does NOT hold (identical filters, different resources, different limits, or explicit groupKey), the fixed groupBySimilarity function SHALL produce the same bucketing behavior as the original function, preserving all existing deterministic grouping logic.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `semantic-relay/src/index.js`

**Function**: `groupBySimilarity()` (lines 45-80)

**Specific Changes**:

1. **Remove Filter from Bucket Key**: Modify the bucket key to only include `resource` and `limit`, removing `stableStringify(intent.filters)` from the key construction:
   ```javascript
   // OLD:
   const key = intent.groupKey
     ? `hint:${intent.groupKey}`
     : ['auto', intent.resource, intent.limit, stableStringify(intent.filters)].join('|');
   
   // NEW:
   const key = intent.groupKey
     ? `hint:${intent.groupKey}`
     : ['auto', intent.resource, intent.limit].join('|');
   ```

2. **Preserve Explicit groupKey Behavior**: Keep the explicit `groupKey` handling unchanged to maintain backward compatibility with hint-based bucketing.

3. **Rely on Scorer for Filter Similarity**: Allow the existing scorer and AI layer to evaluate filter similarity within each bucket, rather than pre-filtering by filter structure.

4. **Maintain Page Sorting**: Keep the existing page-based sorting within buckets unchanged.

5. **Maintain Sequential Group Formation**: Keep the existing logic that compares each context against the current group using the scorer, unchanged.

### Implementation Notes

- The fix is minimal and localized to a single line in the bucket key construction
- No changes required to scorer, AI layer, guardrails, or partitioning logic
- The deterministic scorer will handle obviously identical filters (score >= threshold)
- The AI layer will handle ambiguous cases (0 < score < threshold) for semantically similar but structurally different filters
- Requests with identical filters will still be grouped deterministically (scorer will return high scores)
- Requests with different resources or limits will still be in separate buckets (unchanged bucket key for those dimensions)

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code to confirm the root cause, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm that requests with semantically equivalent filters but different key names are being bucketed separately and processed as SOLO. If we observe different behavior, we will need to re-hypothesize.

**Test Plan**: Create test scenarios with semantically equivalent filters using different key names (category/type/genre/productType), run them through the UNFIXED `groupBySimilarity()` function, and observe bucket assignment and processing decisions. Run these tests on the UNFIXED code to confirm the bug manifests as described.

**Test Cases**:
1. **Basic Semantic Equivalence Test**: Create 2 requests with `{category:"hardware"}` and `{type:"hardware"}`, same resource and limit
   - Observe: Different bucket keys created, separate buckets, processed as SOLO
   - Expected Counterexample: Both requests should be in same bucket but are not (will fail on unfixed code)

2. **Multi-Variant Test**: Create 4 requests with category/type/genre/productType all set to "hardware", same resource and limit
   - Observe: 4 different bucket keys, 4 separate buckets, all processed as SOLO
   - Expected Counterexample: All 4 should be in same bucket but are not (will fail on unfixed code)

3. **AI Stats Zero Test**: Run a batch of semantically equivalent requests through the system and check AI metrics
   - Observe: `embeddingInvocations=0`, `reasoningInvocations=0`, `validatorApprovals=0`
   - Expected Counterexample: AI should be invoked but is not (will fail on unfixed code)

4. **Decision Log Test**: Run semantically equivalent requests and inspect decision log
   - Observe: All entries show `type: 'solo', reason: 'solo'`
   - Expected Counterexample: Should see deterministic-check or ai-trigger entries but do not (will fail on unfixed code)

**Expected Counterexamples**:
- Semantically equivalent filters with different key names produce different bucket keys
- Each bucket contains only 1 request despite semantic equivalence
- All requests processed as SOLO, AI layer never triggered
- AI stats remain at zero even with semantic equivalence present
- Possible root cause confirmed: `stableStringify(intent.filters)` in bucket key prevents consolidation

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior (same bucket for same resource+limit regardless of filter key names).

**Pseudocode:**
```
FOR ALL intentA, intentB WHERE isBugCondition(intentA, intentB) DO
  buckets := groupBySimilarity_fixed([contextA, contextB], threshold)
  bucketKeyA := getBucketKey(intentA)
  bucketKeyB := getBucketKey(intentB)
  ASSERT bucketKeyA = bucketKeyB
  ASSERT contextsAreInSameBucket(contextA, contextB, buckets)
  ASSERT scorerOrAICanEvaluateSimilarity(contextA, contextB)
END FOR
```

**Testing Approach**: Property-based testing is recommended because:
- It generates many test cases automatically with varying filter structures
- It catches edge cases like empty filters, null filters, nested objects
- It provides strong guarantees across the input domain of filter variations

**Test Plan**: After applying the fix, generate diverse combinations of semantically equivalent filters with different key names, verify they are bucketed together, and verify the scorer or AI layer is invoked to evaluate their similarity.

**Test Cases**:
1. **Basic Fix Verification**: Test that `{category:"hardware"}` and `{type:"hardware"}` are in the same bucket
2. **Multi-Variant Fix Verification**: Test that category/type/genre/productType all with "hardware" are in the same bucket
3. **AI Invocation Verification**: Verify that AI metrics show non-zero invocations when semantically equivalent filters are present
4. **Decision Log Verification**: Verify that decision log shows deterministic-check or ai-trigger entries (not just solo)
5. **Property-Based Filter Variations**: Generate random filter key names with the same value, verify same bucket
6. **Edge Case - Empty Filters**: Verify `{}` and `{}` remain in same bucket (preservation)
7. **Edge Case - Null/Undefined**: Verify null and undefined filters are handled correctly

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same bucketing result as the original function.

**Pseudocode:**
```
FOR ALL contexts WHERE NOT isBugCondition(contexts) DO
  bucketsOriginal := groupBySimilarity_original(contexts, threshold)
  bucketsFixed := groupBySimilarity_fixed(contexts, threshold)
  ASSERT bucketsOriginal = bucketsFixed
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain
- It catches edge cases that manual unit tests might miss
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs

**Test Plan**: Observe behavior on UNFIXED code first for identical filters, different resources, different limits, and explicit groupKey hints. Capture the exact bucketing behavior, then write property-based tests to verify the FIXED code produces identical bucketing for these cases.

**Test Cases**:
1. **Identical Filters Preservation**: Observe that `{category:"hardware"}` and `{category:"hardware"}` are bucketed together on unfixed code, verify same on fixed code
2. **Different Resources Preservation**: Observe that `/products` and `/items` with same filters are in separate buckets on unfixed code, verify same on fixed code
3. **Different Limits Preservation**: Observe that limit=10 and limit=20 with same filters are in separate buckets on unfixed code, verify same on fixed code
4. **Explicit groupKey Preservation**: Observe that explicit groupKey hints create separate buckets from auto-bucketed requests on unfixed code, verify same on fixed code
5. **Deterministic Scoring Preservation**: Observe that scorer >= threshold causes grouping without AI on unfixed code, verify same on fixed code
6. **Guardrail Enforcement Preservation**: Observe that maxGroupSize/maxSupersetLimit/maxPageGap violations cause splits on unfixed code, verify same on fixed code
7. **Page Sorting Preservation**: Observe that requests are sorted by page within buckets on unfixed code, verify same on fixed code
8. **Property-Based Identical Filters**: Generate many requests with identical filter structures, verify bucketing is unchanged
9. **Property-Based Resource Variations**: Generate many requests with different resources, verify bucketing is unchanged
10. **Property-Based Limit Variations**: Generate many requests with different limits, verify bucketing is unchanged

### Unit Tests

- Test bucket key generation for same resource+limit produces same key regardless of filter structure
- Test bucket key generation for different resources produces different keys
- Test bucket key generation for different limits produces different keys
- Test explicit groupKey produces hint-prefixed key separate from auto-bucketed keys
- Test that semantically equivalent filters are placed in same bucket after fix
- Test that edge cases (empty filters, null filters) are handled correctly
- Test that page sorting within buckets remains unchanged
- Test that sequential group formation logic remains unchanged

### Property-Based Tests

- Generate random filter structures with same semantic meaning (random key names, same values) and verify same bucket
- Generate random requests with identical filters and verify bucketing unchanged from original
- Generate random requests with different resources and verify bucketing unchanged from original
- Generate random requests with different limits and verify bucketing unchanged from original
- Generate random requests with explicit groupKey and verify bucketing unchanged from original
- Generate random page numbers and verify sorting within buckets is preserved
- Test with large batches (100+ requests) to verify no performance degradation

### Integration Tests

- Test full flow with semantically equivalent filters triggering AI evaluation and producing non-zero AI stats
- Test that decision log shows ai-trigger events when semantically equivalent filters are grouped
- Test that benchmark runs show improved performance on second run due to AI pattern caching
- Test that guardrails continue to work correctly with broader bucketing
- Test that partitioning logic correctly handles results from semantically merged groups
- Test that cache behavior (if enabled) works correctly with new bucketing strategy
