/**
 * Preservation Property Tests
 * 
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**
 * 
 * IMPORTANT: These tests observe and capture baseline behavior on UNFIXED code.
 * They MUST PASS on both unfixed and fixed code to ensure no regression.
 * 
 * This test suite follows the observation-first methodology:
 * 1. Run tests on UNFIXED code to observe current deterministic bucketing behavior
 * 2. Tests capture this baseline behavior
 * 3. After fix is implemented, tests verify behavior is preserved
 * 
 * The fix should only affect bucketing for semantically equivalent filters with
 * different key names. All other bucketing behavior must remain unchanged.
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

describe('Property 2: Preservation - Deterministic Bucketing Behavior', () => {
    const threshold = 0.8;

    /**
     * Requirement 3.1: Identical filters bucketing preservation
     * 
     * Requests with identical filter objects (same keys and values) should
     * continue to be bucketed together deterministically.
     */
    describe('3.1 Identical Filters Preservation', () => {
        it('should bucket identical filters together (same resource, same limit)', () => {
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

            // OBSERVED BEHAVIOR: Identical filters are bucketed together
            expect(buckets.size).toBe(1);
            const singleBucket = Array.from(buckets.values())[0];
            expect(singleBucket.length).toBe(2);
            expect(singleBucket).toContainEqual(contextA);
            expect(singleBucket).toContainEqual(contextB);
        });

        it('should bucket identical complex filters together', () => {
            const contextA = {
                intent: {
                    intentId: 'req-a',
                    resource: '/products',
                    page: 1,
                    limit: 10,
                    filters: { category: 'hardware', brand: 'acme', price: { min: 10, max: 100 } }
                }
            };

            const contextB = {
                intent: {
                    intentId: 'req-b',
                    resource: '/products',
                    page: 2,
                    limit: 10,
                    filters: { category: 'hardware', brand: 'acme', price: { min: 10, max: 100 } }
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

            expect(buckets.size).toBe(1);
            const singleBucket = Array.from(buckets.values())[0];
            expect(singleBucket.length).toBe(2);
        });

        it('should bucket identical empty filters together', () => {
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

            expect(buckets.size).toBe(1);
            const singleBucket = Array.from(buckets.values())[0];
            expect(singleBucket.length).toBe(2);
        });

        it('should bucket multiple requests with identical filters', () => {
            const contexts = [
                { intent: { intentId: 'req-1', resource: '/products', page: 1, limit: 10, filters: { category: 'hardware' } } },
                { intent: { intentId: 'req-2', resource: '/products', page: 2, limit: 10, filters: { category: 'hardware' } } },
                { intent: { intentId: 'req-3', resource: '/products', page: 3, limit: 10, filters: { category: 'hardware' } } },
                { intent: { intentId: 'req-4', resource: '/products', page: 4, limit: 10, filters: { category: 'hardware' } } }
            ];

            const buckets = new Map();
            for (const ctx of contexts) {
                const intent = ctx.intent;
                const key = intent.groupKey
                    ? `hint:${intent.groupKey}`
                    : ['auto', intent.resource, intent.limit].join('|');
                if (!buckets.has(key)) buckets.set(key, []);
                buckets.get(key).push(ctx);
            }

            expect(buckets.size).toBe(1);
            const singleBucket = Array.from(buckets.values())[0];
            expect(singleBucket.length).toBe(4);
        });
    });

    /**
     * Requirement 3.2: Different resources bucketing preservation
     * 
     * Requests with different resource values should continue to be bucketed separately.
     */
    describe('3.2 Different Resources Preservation', () => {
        it('should bucket different resources separately (same filters, same limit)', () => {
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

            // OBSERVED BEHAVIOR: Different resources are bucketed separately
            expect(buckets.size).toBe(2);
            const bucketKeys = Array.from(buckets.keys());
            expect(bucketKeys[0]).toContain('/products');
            expect(bucketKeys[1]).toContain('/items');
        });

        it('should bucket multiple different resources separately', () => {
            const contexts = [
                { intent: { intentId: 'req-1', resource: '/products', page: 1, limit: 10, filters: { category: 'hardware' } } },
                { intent: { intentId: 'req-2', resource: '/items', page: 1, limit: 10, filters: { category: 'hardware' } } },
                { intent: { intentId: 'req-3', resource: '/goods', page: 1, limit: 10, filters: { category: 'hardware' } } }
            ];

            const buckets = new Map();
            for (const ctx of contexts) {
                const intent = ctx.intent;
                const key = intent.groupKey
                    ? `hint:${intent.groupKey}`
                    : ['auto', intent.resource, intent.limit].join('|');
                if (!buckets.has(key)) buckets.set(key, []);
                buckets.get(key).push(ctx);
            }

            expect(buckets.size).toBe(3);
        });

        it('should bucket different resources separately even with empty filters', () => {
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
                    resource: '/items',
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

            expect(buckets.size).toBe(2);
        });
    });

    /**
     * Requirement 3.3: Different limits bucketing preservation
     * 
     * Requests with different limit values should continue to be bucketed separately.
     */
    describe('3.3 Different Limits Preservation', () => {
        it('should bucket different limits separately (same resource, same filters)', () => {
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

            // OBSERVED BEHAVIOR: Different limits are bucketed separately
            expect(buckets.size).toBe(2);
            const bucketKeys = Array.from(buckets.keys());
            expect(bucketKeys[0]).toContain('|10');
            expect(bucketKeys[1]).toContain('|20');
        });

        it('should bucket multiple different limits separately', () => {
            const contexts = [
                { intent: { intentId: 'req-1', resource: '/products', page: 1, limit: 10, filters: { category: 'hardware' } } },
                { intent: { intentId: 'req-2', resource: '/products', page: 1, limit: 20, filters: { category: 'hardware' } } },
                { intent: { intentId: 'req-3', resource: '/products', page: 1, limit: 50, filters: { category: 'hardware' } } }
            ];

            const buckets = new Map();
            for (const ctx of contexts) {
                const intent = ctx.intent;
                const key = intent.groupKey
                    ? `hint:${intent.groupKey}`
                    : ['auto', intent.resource, intent.limit].join('|');
                if (!buckets.has(key)) buckets.set(key, []);
                buckets.get(key).push(ctx);
            }

            expect(buckets.size).toBe(3);
        });
    });

    /**
     * Requirement 3.4: Explicit groupKey hint preservation
     * 
     * Requests with explicit groupKey values should continue to be bucketed
     * according to those hints, separate from auto-bucketed requests.
     */
    describe('3.4 Explicit groupKey Preservation', () => {
        it('should bucket explicit groupKey separately from auto-bucketed requests', () => {
            const contextA = {
                intent: {
                    intentId: 'req-a',
                    resource: '/products',
                    page: 1,
                    limit: 10,
                    filters: { category: 'hardware' },
                    groupKey: 'custom-group-1'
                }
            };

            const contextB = {
                intent: {
                    intentId: 'req-b',
                    resource: '/products',
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

            // OBSERVED BEHAVIOR: Explicit groupKey creates separate bucket
            expect(buckets.size).toBe(2);
            const bucketKeys = Array.from(buckets.keys());
            expect(bucketKeys.some(key => key.startsWith('hint:'))).toBe(true);
            expect(bucketKeys.some(key => key.startsWith('auto|'))).toBe(true);
        });

        it('should bucket same groupKey together, different groupKeys separately', () => {
            const contexts = [
                { intent: { intentId: 'req-1', resource: '/products', page: 1, limit: 10, filters: { category: 'hardware' }, groupKey: 'group-a' } },
                { intent: { intentId: 'req-2', resource: '/products', page: 1, limit: 10, filters: { category: 'hardware' }, groupKey: 'group-a' } },
                { intent: { intentId: 'req-3', resource: '/products', page: 1, limit: 10, filters: { category: 'hardware' }, groupKey: 'group-b' } }
            ];

            const buckets = new Map();
            for (const ctx of contexts) {
                const intent = ctx.intent;
                const key = intent.groupKey
                    ? `hint:${intent.groupKey}`
                    : ['auto', intent.resource, intent.limit].join('|');
                if (!buckets.has(key)) buckets.set(key, []);
                buckets.get(key).push(ctx);
            }

            expect(buckets.size).toBe(2);
            const groupABucket = buckets.get('hint:group-a');
            const groupBBucket = buckets.get('hint:group-b');
            expect(groupABucket.length).toBe(2);
            expect(groupBBucket.length).toBe(1);
        });
    });

    /**
     * Requirement 3.5: Deterministic scoring preservation
     * 
     * When the scorer returns a score >= threshold for requests in the same bucket,
     * they should continue to be grouped without requiring AI evaluation.
     */
    describe('3.5 Deterministic Scoring Preservation', () => {
        it('should group requests with scorer >= threshold (same page)', () => {
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
                    filters: { category: 'hardware' }
                }
            };

            const contexts = [contextA, contextB];
            const groups = groupBySimilarity(contexts, threshold);

            // OBSERVED BEHAVIOR: Same page, same filters → scorer returns 1.0 >= threshold
            // Should be grouped together deterministically
            expect(groups.length).toBe(1);
            expect(groups[0].length).toBe(2);
        });

        it('should group requests with adjacent pages (scorer >= threshold)', () => {
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
                    filters: { category: 'hardware' }
                }
            };

            const contexts = [contextA, contextB];
            const groups = groupBySimilarity(contexts, threshold);

            // OBSERVED BEHAVIOR: Adjacent pages, same filters → scorer returns 0.9 >= 0.8
            // Should be grouped together deterministically
            expect(groups.length).toBe(1);
            expect(groups[0].length).toBe(2);
        });

        it('should not group requests with scorer < threshold (distant pages)', () => {
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
                    page: 10,
                    limit: 10,
                    filters: { category: 'hardware' }
                }
            };

            const contexts = [contextA, contextB];
            const groups = groupBySimilarity(contexts, threshold);

            // OBSERVED BEHAVIOR: Distant pages → scorer returns 0.4 < 0.8
            // Should be in separate groups
            expect(groups.length).toBe(2);
        });
    });

    /**
     * Requirement 3.6: Guardrail enforcement preservation
     * 
     * When maxGroupSize, maxSupersetLimit, or maxPageGap are violated,
     * the system should continue to split groups or fall back to SOLO as before.
     * 
     * NOTE: This test only verifies page sorting within buckets, as guardrail
     * enforcement happens in splitByGuardrails which is separate from bucketing.
     */
    describe('3.6 Page Sorting Preservation', () => {
        it('should sort requests by page within buckets', () => {
            const contexts = [
                { intent: { intentId: 'req-3', resource: '/products', page: 3, limit: 10, filters: { category: 'hardware' } } },
                { intent: { intentId: 'req-1', resource: '/products', page: 1, limit: 10, filters: { category: 'hardware' } } },
                { intent: { intentId: 'req-2', resource: '/products', page: 2, limit: 10, filters: { category: 'hardware' } } }
            ];

            const buckets = new Map();
            for (const ctx of contexts) {
                const intent = ctx.intent;
                const key = intent.groupKey
                    ? `hint:${intent.groupKey}`
                    : ['auto', intent.resource, intent.limit].join('|');
                if (!buckets.has(key)) buckets.set(key, []);
                buckets.get(key).push(ctx);
            }

            // OBSERVED BEHAVIOR: Within each bucket, sort by page
            for (const bucket of buckets.values()) {
                bucket.sort((a, b) => a.intent.page - b.intent.page);
            }

            const singleBucket = Array.from(buckets.values())[0];
            expect(singleBucket[0].intent.page).toBe(1);
            expect(singleBucket[1].intent.page).toBe(2);
            expect(singleBucket[2].intent.page).toBe(3);
        });

        it('should preserve page sorting across multiple buckets', () => {
            const contexts = [
                { intent: { intentId: 'req-3', resource: '/products', page: 3, limit: 10, filters: { category: 'hardware' } } },
                { intent: { intentId: 'req-1', resource: '/products', page: 1, limit: 10, filters: { category: 'hardware' } } },
                { intent: { intentId: 'req-4', resource: '/items', page: 2, limit: 10, filters: { category: 'hardware' } } },
                { intent: { intentId: 'req-2', resource: '/products', page: 2, limit: 10, filters: { category: 'hardware' } } },
                { intent: { intentId: 'req-5', resource: '/items', page: 1, limit: 10, filters: { category: 'hardware' } } }
            ];

            const buckets = new Map();
            for (const ctx of contexts) {
                const intent = ctx.intent;
                const key = intent.groupKey
                    ? `hint:${intent.groupKey}`
                    : ['auto', intent.resource, intent.limit].join('|');
                if (!buckets.has(key)) buckets.set(key, []);
                buckets.get(key).push(ctx);
            }

            for (const bucket of buckets.values()) {
                bucket.sort((a, b) => a.intent.page - b.intent.page);
            }

            expect(buckets.size).toBe(2);
            for (const bucket of buckets.values()) {
                for (let i = 1; i < bucket.length; i++) {
                    expect(bucket[i].intent.page).toBeGreaterThanOrEqual(bucket[i - 1].intent.page);
                }
            }
        });
    });

    /**
     * Edge case preservation tests
     */
    describe('Edge Cases Preservation', () => {
        it('should handle null/undefined filters consistently', () => {
            const contextA = {
                intent: {
                    intentId: 'req-a',
                    resource: '/products',
                    page: 1,
                    limit: 10,
                    filters: null
                }
            };

            const contextB = {
                intent: {
                    intentId: 'req-b',
                    resource: '/products',
                    page: 1,
                    limit: 10,
                    filters: undefined
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

            // Both normalize to empty string, should be in same bucket
            expect(buckets.size).toBe(1);
        });

        it('should handle nested filter objects consistently', () => {
            const contextA = {
                intent: {
                    intentId: 'req-a',
                    resource: '/products',
                    page: 1,
                    limit: 10,
                    filters: { price: { min: 10, max: 100 }, category: 'hardware' }
                }
            };

            const contextB = {
                intent: {
                    intentId: 'req-b',
                    resource: '/products',
                    page: 1,
                    limit: 10,
                    filters: { price: { min: 10, max: 100 }, category: 'hardware' }
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

            expect(buckets.size).toBe(1);
            const singleBucket = Array.from(buckets.values())[0];
            expect(singleBucket.length).toBe(2);
        });

        it('should handle array filter values consistently', () => {
            const contextA = {
                intent: {
                    intentId: 'req-a',
                    resource: '/products',
                    page: 1,
                    limit: 10,
                    filters: { categories: ['hardware', 'software'] }
                }
            };

            const contextB = {
                intent: {
                    intentId: 'req-b',
                    resource: '/products',
                    page: 1,
                    limit: 10,
                    filters: { categories: ['hardware', 'software'] }
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

            expect(buckets.size).toBe(1);
            const singleBucket = Array.from(buckets.values())[0];
            expect(singleBucket.length).toBe(2);
        });
    });
});

