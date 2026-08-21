'use strict';

/**
 * semantic-relay-ai evaluation harness
 * Run with: npm run eval
 *
 * All Cohere and Gemini calls are mocked — zero real API calls.
 * Exit code 0 if classification accuracy >= 80%, else exit code 1.
 */

// Mock fetch before any module loads
global.fetch = async () => { throw new Error('fetch not mocked for this test case'); };

const SemanticPlanner = require('../src/ai/planner');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mkIntent = (resource, filters, page = 1, limit = 20) => ({
    intentId: Math.random().toString(36).slice(2),
    resource,
    filters,
    page,
    limit,
    groupKey: null,
    expectedGroupSize: 0
});

// ─── Test cases ───────────────────────────────────────────────────────────────

const CASES = [
    // ── Semantic equivalence (should merge) ──────────────────────────────────
    {
        id: 'eq-001',
        category: 'equivalence',
        description: 'category=laptops vs type=laptop',
        intentA: mkIntent('/products', { category: 'laptops' }),
        intentB: mkIntent('/products', { type: 'laptop' }),
        mockCohereScore: 0.72,
        mockGemini: {
            equivalent: true,
            canonicalFilter: { category: 'laptops' },
            confidence: 0.91,
            reason: 'category=laptops is semantically equivalent to type=laptop'
        },
        expected: 'merge'
    },
    {
        id: 'eq-002',
        category: 'equivalence',
        description: 'maxPrice=50000 vs price_lt=50000',
        intentA: mkIntent('/products', { maxPrice: '50000' }),
        intentB: mkIntent('/products', { price_lt: '50000' }),
        mockCohereScore: 0.68,
        mockGemini: {
            equivalent: true,
            canonicalFilter: { maxPrice: '50000' },
            confidence: 0.88,
            reason: 'same upper price ceiling expressed differently'
        },
        expected: 'merge'
    },
    {
        id: 'eq-003',
        category: 'equivalence',
        description: 'sort=newest vs order=desc&sortBy=date',
        intentA: mkIntent('/products', { sort: 'newest' }),
        intentB: mkIntent('/products', { order: 'desc', sortBy: 'date' }),
        mockCohereScore: 0.65,
        mockGemini: {
            equivalent: true,
            canonicalFilter: { sort: 'newest' },
            confidence: 0.82,
            reason: 'both request descending date sort'
        },
        expected: 'merge'
    },
    {
        id: 'eq-004',
        category: 'equivalence',
        description: 'brand=apple vs manufacturer=apple',
        intentA: mkIntent('/products', { brand: 'apple' }),
        intentB: mkIntent('/products', { manufacturer: 'apple' }),
        mockCohereScore: 0.75,
        mockGemini: {
            equivalent: true,
            canonicalFilter: { brand: 'apple' },
            confidence: 0.93,
            reason: 'brand and manufacturer refer to the same attribute'
        },
        expected: 'merge'
    },
    {
        id: 'eq-005',
        category: 'equivalence',
        description: 'status=active vs isActive=true',
        intentA: mkIntent('/users', { status: 'active' }),
        intentB: mkIntent('/users', { isActive: 'true' }),
        mockCohereScore: 0.71,
        mockGemini: {
            equivalent: true,
            canonicalFilter: { status: 'active' },
            confidence: 0.87,
            reason: 'both filter for active/enabled users'
        },
        expected: 'merge'
    },
    {
        id: 'eq-006',
        category: 'equivalence',
        description: 'color=red vs colour=red (UK/US spelling) — high Cohere confidence, no Gemini needed',
        intentA: mkIntent('/products', { color: 'red' }),
        intentB: mkIntent('/products', { colour: 'red' }),
        mockCohereScore: 0.92, // >= embeddingThreshold (0.85) → Gemini NOT called
        mockGemini: null,       // must remain null — test verifies Gemini is skipped
        expected: 'merge'
    },

    // ── Semantic non-equivalence (must NOT merge) ─────────────────────────────
    {
        id: 'neq-001',
        category: 'non-equivalence',
        description: 'category=laptops vs category=phones — different values',
        intentA: mkIntent('/products', { category: 'laptops' }),
        intentB: mkIntent('/products', { category: 'phones' }),
        mockCohereScore: 0.31, // < reasoningThreshold (0.6) → split, Gemini NOT called
        mockGemini: null,
        expected: 'split'
    },
    {
        id: 'neq-002',
        category: 'non-equivalence',
        description: 'maxPrice=50000 vs maxPrice=100000 — different price ceilings',
        intentA: mkIntent('/products', { maxPrice: '50000' }),
        intentB: mkIntent('/products', { maxPrice: '100000' }),
        mockCohereScore: 0.62,
        mockGemini: {
            equivalent: false,
            canonicalFilter: null,
            confidence: 0.95,
            reason: 'different price ceilings return different product sets'
        },
        expected: 'split'
    },
    {
        id: 'neq-003',
        category: 'non-equivalence',
        description: 'userId=123 vs userId=456 — different users',
        intentA: mkIntent('/orders', { userId: '123' }),
        intentB: mkIntent('/orders', { userId: '456' }),
        mockCohereScore: 0.45, // < 0.6 → split immediately
        mockGemini: null,
        expected: 'split'
    },
    {
        id: 'neq-004',
        category: 'non-equivalence',
        description: 'status=active vs status=deleted',
        intentA: mkIntent('/users', { status: 'active' }),
        intentB: mkIntent('/users', { status: 'deleted' }),
        mockCohereScore: 0.38,
        mockGemini: null,
        expected: 'split'
    },
    {
        id: 'neq-005',
        category: 'non-equivalence',
        description: 'inStock=true vs inStock=false — opposite values',
        intentA: mkIntent('/products', { inStock: 'true' }),
        intentB: mkIntent('/products', { inStock: 'false' }),
        mockCohereScore: 0.44,
        mockGemini: null,
        expected: 'split'
    },
    {
        id: 'neq-006',
        category: 'non-equivalence',
        description: '/users vs /admins — different resources, no shared route',
        intentA: mkIntent('/users', { status: 'active' }),
        intentB: mkIntent('/admins', { status: 'active' }),
        mockCohereScore: 0.62,
        mockGemini: {
            equivalent: true,
            canonicalFilter: { status: 'active' },
            confidence: 0.80,
            reason: 'both request active records'
        },
        // Validator rejects because resources differ and no matching knownRoutes entry
        expected: 'split'
    },

    // ── Validator rejection (AI says merge, validator says no) ────────────────
    {
        id: 'val-001',
        category: 'validator-reject',
        description: 'AI injects unknown filter key __inject',
        intentA: mkIntent('/products', { category: 'laptops' }),
        intentB: mkIntent('/products', { type: 'laptop' }),
        mockCohereScore: 0.72,
        mockGemini: {
            equivalent: true,
            canonicalFilter: { __inject: 'evil', category: 'laptops' },
            confidence: 0.91,
            reason: 'test injection'
        },
        expected: 'split' // validator rejects: unknown-filter-keys
    },
    {
        id: 'val-002',
        category: 'validator-reject',
        description: 'AI confidence 0.55 below minConfidence floor 0.7',
        intentA: mkIntent('/products', { brand: 'apple' }),
        intentB: mkIntent('/products', { make: 'apple' }),
        mockCohereScore: 0.63,
        mockGemini: {
            equivalent: true,
            canonicalFilter: { brand: 'apple' },
            confidence: 0.55,
            reason: 'possibly the same brand'
        },
        expected: 'split' // validator rejects: low-confidence
    },
    {
        id: 'val-003',
        category: 'validator-reject',
        description: 'AI proposes merge that would exceed maxSupersetLimit=1000',
        intentA: mkIntent('/products', { category: 'all' }, 1, 600),
        intentB: mkIntent('/products', { type: 'all' }, 2, 600),
        mockCohereScore: 0.70,
        mockGemini: {
            equivalent: true,
            canonicalFilter: { category: 'all' },
            confidence: 0.85,
            reason: 'semantically equivalent'
        },
        // page 1 limit 600 = records 0-600, page 2 limit 600 = records 600-1200
        // combined = 1200 > maxSupersetLimit 1000
        expected: 'split' // validator rejects: superset-too-large
    },

    // ── Fallback / degradation ────────────────────────────────────────────────
    {
        id: 'fb-001',
        category: 'fallback',
        description: 'Cohere API unavailable (score -1) → degrade gracefully',
        intentA: mkIntent('/products', { category: 'laptops' }),
        intentB: mkIntent('/products', { type: 'laptop' }),
        mockCohereScore: -1, // simulates Cohere returning error
        mockGemini: null,
        expected: 'fallback'
    },
    {
        id: 'fb-002',
        category: 'fallback',
        description: 'Gemini returns parse-error → split (not crash)',
        intentA: mkIntent('/products', { category: 'laptops' }),
        intentB: mkIntent('/products', { type: 'laptop' }),
        mockCohereScore: 0.72,
        mockGemini: 'PARSE_ERROR', // special signal → reasoning model returns parse-error result
        expected: 'split'
    },

    // ── Performance / latency ─────────────────────────────────────────────────
    {
        id: 'perf-001',
        category: 'performance',
        description: 'Full embedding path must complete under 2000ms (mocked)',
        intentA: mkIntent('/products', { category: 'laptops' }),
        intentB: mkIntent('/products', { type: 'laptop' }),
        mockCohereScore: 0.92, // high confidence → no Gemini
        mockGemini: null,
        expected: 'merge',
        maxLatencyMs: 2000
    },
    {
        id: 'perf-002',
        category: 'performance',
        description: 'Full reasoning path must complete under 5000ms (mocked)',
        intentA: mkIntent('/products', { category: 'laptops' }),
        intentB: mkIntent('/products', { type: 'laptop' }),
        mockCohereScore: 0.72, // ambiguous → Gemini called
        mockGemini: {
            equivalent: true,
            canonicalFilter: { category: 'laptops' },
            confidence: 0.91,
            reason: 'semantically equivalent'
        },
        expected: 'merge',
        maxLatencyMs: 5000
    },
    {
        id: 'perf-003',
        category: 'performance',
        description: 'Pattern cache hit must return in under 5ms',
        intentA: mkIntent('/products', { category: 'laptops' }),
        intentB: mkIntent('/products', { category: 'laptops' }), // same filters → cache
        mockCohereScore: 0.92,
        mockGemini: null,
        expected: 'merge',
        maxLatencyMs: 5,
        primeCache: true // pre-populate cache before running
    }
];

// ─── Test runner ──────────────────────────────────────────────────────────────

async function runCase(tc) {
    const planner = new SemanticPlanner({
        cohereApiKey: 'eval-test-key',
        geminiApiKey: 'eval-test-key',
        embeddingThreshold: 0.85,
        reasoningThreshold: 0.6,
        maxSupersetLimit: 1000,
        minConfidence: 0.7,
        aiMode: 'adaptive',
        knownRoutes: {} // no shared routes → cross-resource merges rejected by validator
    });

    // Stub EmbeddingModel.similarity
    planner.embedder.similarity = async () => ({
        score: tc.mockCohereScore,
        latencyMs: 1
    });

    // Stub ReasoningModel.analyze
    planner.reasoner.analyze = async () => {
        if (tc.mockGemini === 'PARSE_ERROR') {
            return {
                equivalent: false,
                canonicalFilter: null,
                confidence: 0,
                reason: 'parse-error',
                latencyMs: 1,
                tokenCount: 100
            };
        }
        if (tc.mockGemini === null || tc.mockGemini === undefined) {
            // Should not be called — throw so test catches the unexpected call
            throw new Error(`[eval] Gemini called unexpectedly for case ${tc.id} (mockGemini is null)`);
        }
        return { ...tc.mockGemini, latencyMs: 1, tokenCount: 100 };
    };

    // Prime cache if required
    if (tc.primeCache) {
        planner.cache.set(tc.intentA.filters, tc.intentB.filters, tc.intentA.filters);
    }

    const start = Date.now();
    const result = await planner.evaluate(tc.intentA, tc.intentB);
    const elapsed = Date.now() - start;

    const decisionOk = result.decision === tc.expected;
    const latencyOk = !tc.maxLatencyMs || elapsed <= tc.maxLatencyMs;
    const pass = decisionOk && latencyOk;

    return {
        id: tc.id,
        category: tc.category,
        description: tc.description,
        pass,
        expected: tc.expected,
        actual: result.decision,
        source: result.source,
        latencyMs: elapsed,
        maxLatencyMs: tc.maxLatencyMs || null,
        failReason: !decisionOk
            ? `expected ${tc.expected}, got ${result.decision}`
            : !latencyOk
                ? `latency ${elapsed}ms exceeds limit ${tc.maxLatencyMs}ms`
                : null
    };
}

async function main() {
    console.log('\nsemantic-relay-ai evaluation harness');
    console.log('=====================================');
    console.log(`Running ${CASES.length} test cases...\n`);

    const results = [];
    for (const tc of CASES) {
        let r;
        try {
            r = await runCase(tc);
        } catch (err) {
            r = {
                id: tc.id, category: tc.category, description: tc.description,
                pass: false, expected: tc.expected, actual: 'error',
                source: 'error', latencyMs: 0, maxLatencyMs: tc.maxLatencyMs || null,
                failReason: `threw: ${err.message}`
            };
        }
        results.push(r);

        const mark = r.pass ? 'PASS' : 'FAIL';
        const detail = r.pass
            ? `[${r.actual}] source:${r.source} ${r.latencyMs}ms`
            : `— ${r.failReason}`;
        console.log(`  ${mark}  ${r.id.padEnd(10)} ${r.description} ${detail}`);
    }

    // ─── Score computation ──────────────────────────────────────────────────────
    const total = results.length;
    const passed = results.filter(r => r.pass).length;
    const failed = total - passed;

    const equiv = results.filter(r => r.category === 'equivalence');
    const nonEq = results.filter(r => r.category === 'non-equivalence');

    // False positive: equivalence case classified as split (missed valid merge)
    const fpCount = equiv.filter(r => r.actual === 'split').length;
    // False negative: non-equivalence case classified as merge (unsafe merge)
    const fnCount = nonEq.filter(r => r.actual === 'merge').length;

    const accuracy = (passed / total * 100).toFixed(1);
    const fpRate = equiv.length ? (fpCount / equiv.length * 100).toFixed(1) : '0.0';
    const fnRate = nonEq.length ? (fnCount / nonEq.length * 100).toFixed(1) : '0.0';
    const merges = results.filter(r => r.actual === 'merge').length;
    const reduction = ((1 - merges / total) * 100).toFixed(1);
    const avgLatMs = (results.reduce((s, r) => s + r.latencyMs, 0) / total).toFixed(1);

    console.log('\nResults');
    console.log('-------');
    console.log(`Total:                ${total}`);
    console.log(`Passed:               ${passed}`);
    console.log(`Failed:               ${failed}`);
    console.log(`Classification acc:   ${accuracy}%`);
    console.log(`False positive rate:  ${fpRate}%  (valid merges classified as split)`);
    console.log(`False negative rate:  ${fnRate}%  (unsafe merges not caught)`);
    console.log(`Backend reduction:    ${reduction}%`);
    console.log(`Avg latency (mock):   ${avgLatMs}ms`);
    console.log(`Est. cost (mock):     $0.00000`);

    if (parseFloat(accuracy) < 80) {
        console.error(`\nFAIL: accuracy ${accuracy}% is below 80% threshold\n`);
        process.exit(1);
    }

    console.log(`\nPASS: accuracy ${accuracy}% meets the 80% threshold\n`);
    process.exit(0);
}

main().catch(err => {
    console.error('Eval harness crashed:', err);
    process.exit(1);
});
