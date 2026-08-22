# Value Equivalence Implementation Spec

## Overview
Pivot the semantic-relay demo and pitch materials from key equivalence to value equivalence (synonym matching) to make the hackathon submission more compelling and realistic.

## Requirements

### R1: Demo Data with Synonym Groups
- **Priority**: CRITICAL
- Create synonym groups for product categories (electronics, clothing, books, kitchen)
- Each group contains 4 synonym variants
- Backend must map all synonyms to the same base category

### R2: Benchmark Request Generation
- **Priority**: CRITICAL
- Update `/api/benchmark` to generate requests with VALUE synonyms (not key variants)
- Same filter key (`category`) across all requests
- Different filter values (synonyms) across requests
- Example: `{ category: "electronics" }`, `{ category: "gadgets" }`, `{ category: "tech devices" }`

### R3: Product Selection Logic
- **Priority**: CRITICAL
- Update `selectProducts()` to handle synonym mapping
- When filter contains a synonym, return products for the base category
- Example: Query for "gadgets" → returns products with category="electronics"

### R4: Comparison Endpoint
- **Priority**: HIGH
- Add `/api/comparison` endpoint showing historical approaches vs semantic-relay
- Show: Naive (2010), DataLoader (2016), nginx (2010), Elasticsearch (2015), semantic-relay (2024)
- Include cost comparison (2023 vs 2024)

### R5: Frontend Synonym Selector
- **Priority**: MEDIUM
- Add synonym group selector to demo UI
- Show which synonyms were detected in results
- Display AI decision about equivalence

### R6: Pitch Material Updates
- **Priority**: CRITICAL
- Update PITCH-SCRIPT.md problem statement
- Update ARCHITECTURE-DIAGRAM.md examples
- Add pivot explanation to FAILURE-LOG.md

## Design

### Synonym Groups Structure
```javascript
const synonymGroups = {
  electronics: ["electronics", "gadgets", "tech devices", "electronic items"],
  clothing: ["clothing", "apparel", "garments", "fashion items"],
  books: ["books", "literature", "reading material", "publications"],
  kitchen: ["kitchen", "cookware", "culinary items", "cooking supplies"]
};
```

### Request Generation Flow
1. User selects requests=16, synonymGroup="electronics"
2. System generates 16 requests cycling through synonym variants
3. Each request has SAME key (`category`) but DIFFERENT value (synonym)
4. AI detects semantic equivalence across values
5. Merges into 1 DB call (93.75% reduction)

### Backend Processing Flow
1. Request arrives with `category=gadgets`
2. `selectProducts()` checks synonym groups
3. Finds "gadgets" in electronics group
4. Returns products where `category=electronics` (base category)
5. All synonyms map to same data set

## Tasks

### Phase 1: Server Data Updates (1 hour)
- [ ] T1.1: Define synonym groups constant
- [ ] T1.2: Update product data to use base categories only
- [ ] T1.3: Update `selectProducts()` with synonym mapping
- [ ] T1.4: Update product index to use base categories

### Phase 2: Benchmark Updates (1 hour)
- [ ] T2.1: Update `/api/benchmark` request generation for synonyms
- [ ] T2.2: Update `runEnhancedHttpRelayScenario` for synonym variants
- [ ] T2.3: Remove old key-variant logic

### Phase 3: Comparison Endpoint (2 hours)
- [ ] T3.1: Create `/api/comparison` endpoint
- [ ] T3.2: Add approach comparison logic (5 approaches)
- [ ] T3.3: Add cost comparison (2023 vs 2024)
- [ ] T3.4: Test endpoint returns correct data

### Phase 4: Frontend Updates (1 hour)
- [ ] T4.1: Add synonym group selector to UI
- [ ] T4.2: Update results display to show synonyms detected
- [ ] T4.3: Add AI decision visualization

### Phase 5: Pitch Materials (2 hours)
- [ ] T5.1: Update PITCH-SCRIPT.md problem statement
- [ ] T5.2: Update PITCH-SCRIPT.md "couldn't exist in 2023" section
- [ ] T5.3: Update ARCHITECTURE-DIAGRAM.md examples
- [ ] T5.4: Add pivot entry to FAILURE-LOG.md

### Phase 6: Testing & Verification (1 hour)
- [ ] T6.1: Test 4 requests with synonyms → expect 1 DB call
- [ ] T6.2: Test cache hit behavior (run twice)
- [ ] T6.3: Test different category groups don't merge
- [ ] T6.4: Test comparison endpoint
- [ ] T6.5: Rebuild package and reinstall in demo

## Success Criteria
- ✅ 4 requests with synonyms merge into 1 DB call (75% reduction)
- ✅ AI invocations: 1, Cohere score >0.7
- ✅ Second run: cache hit, $0 cost, <5ms latency
- ✅ Different domains (electronics vs books) don't merge
- ✅ Comparison endpoint shows all 5 approaches correctly
- ✅ Pitch materials updated with realistic problem statement

## Testing
```bash
# Test 1: Synonym detection
curl "http://localhost:3100/api/benchmark?requests=4&limit=12&category=electronics"
# Expected: relay.calls=1, raw.calls=4, reductionPercent=75

# Test 2: Cache hit
curl "http://localhost:3100/api/benchmark?requests=4&limit=12&category=electronics"
# Expected: patternCacheHits=1, cost=$0

# Test 3: Comparison endpoint
curl "http://localhost:3100/api/comparison"
# Expected: JSON with 5 approaches, cost comparison

# Test 4: Verify AI decision
curl "http://localhost:3100/api/ai-decisions"
# Expected: cohereScore >0.7, geminiUsed=true, validatorApproved=true
```

## Notes
- The AI logic already compares values correctly (no changes needed in planner.js or embedding-model.js)
- This is primarily a demo data + narrative pivot
- 95% of core middleware code stays the same
- Total time estimate: 8 hours (can parallelize phases 1-4 and phase 5)
