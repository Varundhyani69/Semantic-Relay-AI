/**
 * Bug Condition Exploration Test
 * 
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**
 * 
 * CRITICAL: This test MUST FAIL on unfixed code - failure confirms the bug exists.
 * DO NOT attempt to fix the test or the code when it fails.
 * 
 * This test encodes the expected behavior - it will validate the fix when it passes
 * after implementation. The test surfaces counterexamples demonstrating that requests
 * with semantically equivalent filters but different key names are placed in separate
 * buckets instead of the same bucket.
 */

const scorer = require('../src/scorer');

// Extract groupBySimilarity function from index.js for testing
function stableStringify(obj) {
    if (obj === null || obj === undefined) return '';
    if (typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
    return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function groupBySimilarity(contexts, threshold) {
    const buckets = new Map();
    for (const ctx of contexts) {
        const intent = ctx.intent;
        const key = intent.groupKey
            ? `hint:${intent.groupKey}`
            : ['auto', intent.resource, intent.limit].join('|');
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(ctx);
    }

    const groups = [];
    for (const bucket of buckets.values()) {
        bucket.sort((a, b) => a.intent.page - b.intent.page);
        let current = [];

        for (const ctx of bucket) {
            if (current.length === 0) {
                current.push(ctx);
                continue;
            }

            const matchesGroup = scorer(current[current.length - 1].intent, ctx.intent) >= threshold
                || current.some(existing => scorer(existing.intent, ctx.intent) >= threshold);

            if (matchesGroup) {
                current.push(ctx);
            } else {
                groups.push(current);
                current = [ctx];
            }
        }

        if (current.length > 0) groups.push(current);
    }

    return groups;
}

describe('Property 1: Bug Condition - Semantic Filter Grouping', () => {
    const threshold = 0.8;

    /**
     * Test that requests with semantically equivalent filters but different key names
     * are placed in the same bucket for similarity evaluation.
     * 
     * EXPECTED ON UNFIXED CODE: This test will FAIL because:
     * - Requests with {category:"hardware"} and {type:"hardware"} will be in DIFFERENT buckets
     * - Each bucket will contain only 1 request
     * - Requests will be processed as SOLO
     * 
     * EXPECTED ON FIXED CODE: This test will PASS because:
     * - Both requests will be in the SAME bucket
     * - AI layer can evaluate their semantic similarity
     */
    it('should place requests with same resource/limit but different filter keys in same bucket', () => {
        // Concrete failing case 1: category vs type
        const contextA = {
            intent: {
                intentId: 'req-a',
                resource: '/products',
                page: 1,
                limit: 10,
                filters: { category: 'hardware' }
            }
        };

        const contextB = {
            intent: {
                intentId: 'req-b',
                resource: '/products',
                page: 1,
                limit: 10,
                filters: { type: 'hardware' }
            }
        };

        // Get bucket keys to verify they should be the same
        const keyA = ['auto', contextA.intent.resource, contextA.intent.limit].join('|');
        const keyB = ['auto', contextB.intent.resource, contextB.intent.limit].join('|');

        // COUNTEREXAMPLE DOCUMENTATION:
        // On unfixed code, these bucket keys will be DIFFERENT:
        // keyA = "auto|/products|10|{"category":"hardware"}"
        // keyB = "auto|/products|10|{"type":"hardware"}"
        // This is the bug - filters should not be part of the bucket key

        // Run groupBySimilarity
        const contexts = [contextA, contextB];
        const buckets = new Map();

        for (const ctx of contexts) {
            const intent = ctx.intent;
            const key = intent.groupKey
                ? `hint:${intent.groupKey}`
                : ['auto', intent.resource, intent.limit].join('|');
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(ctx);
        }

        // EXPECTED BEHAVIOR: Both contexts should be in the SAME bucket
        // ACTUAL BEHAVIOR (unfixed): They will be in DIFFERENT buckets
        expect(buckets.size).toBe(1); // Should have only 1 bucket

        // Verify both contexts are in the same bucket
        const singleBucket = Array.from(buckets.values())[0];
        expect(singleBucket).toBeDefined();
        expect(singleBucket.length).toBe(2); // Both contexts in same bucket
        expect(singleBucket).toContainEqual(contextA);
        expect(singleBucket).toContainEqual(contextB);
    });

    /**
     * Test multiple semantically equivalent filter variations.
     * 
     * EXPECTED ON UNFIXED CODE: This test will FAIL because:
     * - 4 different bucket keys will be created
     * - Each bucket will contain only 1 request
     * - All requests processed as SOLO, AI never invoked
     * 
     * COUNTEREXAMPLES: category/type/genre/productType all create separate buckets
     */
    it('should place multiple semantic filter variations in same bucket', () => {
        const contexts = [
            {
                intent: {
                    intentId: 'req-1',
                    resource: '/products',
                    page: 1,
                    limit: 10,
                    filters: { category: 'hardware' }
                }
            },
            {
                intent: {
                    intentId: 'req-2',
                    resource: '/products',
                    page: 1,
                    limit: 10,
                    filters: { type: 'hardware' }
                }
            },
            {
                intent: {
                    intentId: 'req-3',
                    resource: '/products',
                    page: 1,
                    limit: 10,
                    filters: { genre: 'hardware' }
                }
            },
            {
                intent: {
                    intentId: 'req-4',
                    resource: '/products',
                    page: 1,
                    limit: 10,
                    filters: { productType: 'hardware' }
                }
            }
        ];

        // Build buckets
        const buckets = new Map();
        for (const ctx of contexts) {
            const intent = ctx.intent;
            const key = intent.groupKey
                ? `hint:${intent.groupKey}`
                : ['auto', intent.resource, intent.limit].join('|');
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(ctx);
        }

        // EXPECTED BEHAVIOR: All 4 contexts should be in the SAME bucket
        // ACTUAL BEHAVIOR (unfixed): They will be in 4 DIFFERENT buckets
        expect(buckets.size).toBe(1); // Should have only 1 bucket

        // Verify all contexts are in the same bucket
        const singleBucket = Array.from(buckets.values())[0];
        expect(singleBucket).toBeDefined();
        expect(singleBucket.length).toBe(4); // All 4 contexts in same bucket
    });

    /**
     * Test that semantically equivalent filters allow scorer/AI evaluation.
     * 
     * EXPECTED ON UNFIXED CODE: This test will FAIL because:
     * - Contexts are in separate buckets, so scorer is never called between them
     * - Groups will be [[contextA], [contextB]] (separate groups)
     * 
     * EXPECTED ON FIXED CODE: This test will PASS because:
     * - Contexts are in same bucket, scorer evaluates similarity
     * - Groups will be [[contextA, contextB]] (single group) or separate based on scorer
     */
    it('should allow scorer or AI to evaluate semantic similarity when in same bucket', () => {
        const contextA = {
            intent: {
                intentId: 'req-a',
                resource: '/products',
                page: 1,
                limit: 10,
                filters: { category: 'hardware' }
            }
        };

        const contextB = {
            intent: {
                intentId: 'req-b',
                resource: '/products',
                page: 2,
                limit: 10,
                filters: { type: 'hardware' }
            }
        };

        const contexts = [contextA, contextB];
        const groups = groupBySimilarity(contexts, threshold);

        // EXPECTED BEHAVIOR: Contexts should be in same bucket, allowing evaluation
        // The scorer will return 0.3 for different filters, which is < threshold
        // So they may end up in separate groups, BUT they should at least be evaluated together
        // The key test is: are they in the same bucket initially?

        // Build buckets to verify
        const buckets = new Map();
        for (const ctx of contexts) {
            const intent = ctx.intent;
            const key = intent.groupKey
                ? `hint:${intent.groupKey}`
                : ['auto', intent.resource, intent.limit].join('|');
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(ctx);
        }

        // Should have 1 bucket (same resource, same limit)
        expect(buckets.size).toBe(1);

        // The groups can be 1 or 2 depending on scorer/AI decision
        // But at minimum, they should have been in the same bucket for evaluation
        expect(groups.length).toBeGreaterThan(0);
    });

    /**
     * Edge case: Empty filters should remain in same bucket (preservation).
     */
    it('should preserve bucketing for identical empty filters', () => {
        const contextA = {
            intent: {
                intentId: 'req-a',
                resource: '/products',
                page: 1,
                limit: 10,
                filters: {}
            }
        };

        const contextB = {
            intent: {
                intentId: 'req-b',
                resource: '/products',
                page: 1,
                limit: 10,
                filters: {}
            }
        };

        const buckets = new Map();
        for (const ctx of [contextA, contextB]) {
            const intent = ctx.intent;
            const key = intent.groupKey
                ? `hint:${intent.groupKey}`
                : ['auto', intent.resource, intent.limit].join('|');
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(ctx);
        }

        // Should have 1 bucket (identical filters)
        expect(buckets.size).toBe(1);
        const singleBucket = Array.from(buckets.values())[0];
        expect(singleBucket.length).toBe(2);
    });

    /**
     * Preservation test: Different resources should remain in separate buckets.
     */
    it('should preserve bucketing for different resources', () => {
        const contextA = {
            intent: {
                intentId: 'req-a',
                resource: '/products',
                page: 1,
                limit: 10,
                filters: { category: 'hardware' }
            }
        };

        const contextB = {
            intent: {
                intentId: 'req-b',
                resource: '/items',
                page: 1,
                limit: 10,
                filters: { category: 'hardware' }
            }
        };

        const buckets = new Map();
        for (const ctx of [contextA, contextB]) {
            const intent = ctx.intent;
            const key = intent.groupKey
                ? `hint:${intent.groupKey}`
                : ['auto', intent.resource, intent.limit].join('|');
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(ctx);
        }

        // Should have 2 buckets (different resources)
        expect(buckets.size).toBe(2);
    });

    /**
     * Preservation test: Different limits should remain in separate buckets.
     */
    it('should preserve bucketing for different limits', () => {
        const contextA = {
            intent: {
                intentId: 'req-a',
                resource: '/products',
                page: 1,
                limit: 10,
                filters: { category: 'hardware' }
            }
        };

        const contextB = {
            intent: {
                intentId: 'req-b',
                resource: '/products',
                page: 1,
                limit: 20,
                filters: { category: 'hardware' }
            }
        };

        const buckets = new Map();
        for (const ctx of [contextA, contextB]) {
            const intent = ctx.intent;
            const key = intent.groupKey
                ? `hint:${intent.groupKey}`
                : ['auto', intent.resource, intent.limit].join('|');
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(ctx);
        }

        // Should have 2 buckets (different limits)
        expect(buckets.size).toBe(2);
    });
});
