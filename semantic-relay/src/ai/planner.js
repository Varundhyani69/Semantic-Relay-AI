'use strict';

const EmbeddingModel = require('./embedding-model');
const ReasoningModel = require('./reasoning-model');
const PatternCache = require('./pattern-cache');
const { validate } = require('./validator');

class SemanticPlanner {
    /**
     * Orchestrates the full AI decision path:
     *   PatternCache → EmbeddingModel (Cohere) → ReasoningModel (Gemini) → Validator
     *
     * @param {object} options
     * @param {string} [options.cohereApiKey]
     * @param {string} [options.geminiApiKey]
     * @param {number} [options.embeddingThreshold=0.85]  score >= this → confident match, skip Gemini
     * @param {number} [options.reasoningThreshold=0.6]   score < this  → definite mismatch, skip Gemini
     * @param {number} [options.maxSupersetLimit=1000]
     * @param {number} [options.minConfidence=0.7]
     * @param {string} [options.aiMode='adaptive']        'safe' | 'adaptive' | 'aggressive'
     * @param {object} [options.knownRoutes={}]
     * @param {number} [options.maxPatternCacheSize=500]
     */
    constructor(options = {}) {
        this.embeddingThreshold = options.embeddingThreshold || 0.85;
        this.reasoningThreshold = options.reasoningThreshold || 0.6;
        this.maxSupersetLimit = options.maxSupersetLimit || 1000;
        this.minConfidence = options.minConfidence || 0.7;
        this.aiMode = options.aiMode || 'adaptive';
        this.knownRoutes = options.knownRoutes || {};

        this.embedder = new EmbeddingModel({ apiKey: options.cohereApiKey });
        this.reasoner = new ReasoningModel({ apiKey: options.geminiApiKey });
        this.cache = new PatternCache({ maxSize: options.maxPatternCacheSize || 500 });

        // Metrics counters
        this._aiInvocations = 0;
        this._embeddingInvocations = 0;
        this._reasoningInvocations = 0;
        this._validatorApprovals = 0;
        this._validatorRejects = 0;
        this._totalEmbeddingMs = 0;
        this._totalReasoningMs = 0;
        this._totalCostUsd = 0;
        this._aiStatus = 'active';

        /**
         * Optional callback wired by the demo server.
         * Called with a decision record after every evaluate() call.
         * @type {function|null}
         */
        this.onDecision = null;
    }

    /**
     * Evaluate whether two intents should be merged, split, or fall back.
     *
     * Decision flow:
     *  1. safe mode        → fallback immediately (no API calls)
     *  2. pattern cache HIT → validate cached plan → merge or split
     *  3. Cohere embedding:
     *       score === -1        → Cohere unavailable → fallback, aiStatus=degraded
     *       score < 0.6         → definite mismatch → split
     *       score >= 0.85       → confident match → validate directly → merge or split
     *       score 0.6–0.84      → ambiguous → call Gemini
     *  4. Gemini: equivalent=false → split
     *             equivalent=true  → validate → merge or split
     *  5. Any unhandled error → fallback, never throw
     *
     * @param {object} intentA
     * @param {object} intentB
     * @returns {Promise<{
     *   decision: 'merge'|'split'|'fallback',
     *   canonicalFilter: object|null,
     *   confidence: number,
     *   source: 'cache'|'embedding'|'reasoning'|'fallback',
     *   latencyMs: number,
     *   validatorApproved: boolean,
     *   cohereScore: number|null,
     *   geminiUsed: boolean,
     *   geminiConfidence: number|null
     * }>}
     */
    async evaluate(intentA, intentB) {
        const start = Date.now();
        this._aiInvocations++;

        // Helper: finalise a result, fire onDecision callback, return
        const done = (d) => {
            const result = { latencyMs: Date.now() - start, ...d };
            if (typeof this.onDecision === 'function') {
                try {
                    this.onDecision({
                        resourceA: intentA && intentA.resource,
                        resourceB: intentB && intentB.resource,
                        filtersA: intentA && intentA.filters,
                        filtersB: intentB && intentB.filters,
                        cohereScore: result.cohereScore ?? null,
                        geminiUsed: result.geminiUsed ?? false,
                        geminiConfidence: result.geminiConfidence ?? null,
                        validatorApproved: result.validatorApproved ?? false,
                        mergeExecuted: result.decision === 'merge',
                        latencyMs: result.latencyMs
                    });
                } catch (_) { /* callback errors must never propagate */ }
            }
            return result;
        };

        try {
            // ── Step 1: safe mode bypass ────────────────────────────────────────────
            if (this.aiMode === 'safe') {
                return done({
                    decision: 'fallback', canonicalFilter: null,
                    confidence: 0, source: 'fallback',
                    validatorApproved: false, cohereScore: null,
                    geminiUsed: false, geminiConfidence: null
                });
            }

            // ── Step 2: pattern cache ───────────────────────────────────────────────
            const cachedFilter = this.cache.get(
                (intentA && intentA.filters) || {},
                (intentB && intentB.filters) || {}
            );
            if (cachedFilter !== null) {
                const plan = {
                    equivalent: true, canonicalFilter: cachedFilter,
                    confidence: 1.0, reason: 'from-cache'
                };
                const v = validate(plan, intentA, intentB, {
                    maxSupersetLimit: this.maxSupersetLimit,
                    minConfidence: this.minConfidence,
                    knownRoutes: this.knownRoutes
                });
                if (v.safe) {
                    this._validatorApprovals++;
                    return done({
                        decision: 'merge', canonicalFilter: cachedFilter,
                        confidence: 1.0, source: 'cache',
                        validatorApproved: true, cohereScore: null,
                        geminiUsed: false, geminiConfidence: null
                    });
                }
                // Cache entry failed validator — fall through to fresh evaluation
            }

            // ── Step 3: Cohere embedding ────────────────────────────────────────────
            this._embeddingInvocations++;
            const embResult = await this.embedder.similarity(intentA, intentB);
            this._totalEmbeddingMs += embResult.latencyMs || 0;
            this._totalCostUsd += 0.0001; // $0.0001 per Cohere call (free tier estimate)

            if (embResult.score === -1) {
                // Cohere unavailable → degrade gracefully
                this._aiStatus = 'degraded';
                return done({
                    decision: 'fallback', canonicalFilter: null,
                    confidence: 0, source: 'fallback',
                    validatorApproved: false, cohereScore: null,
                    geminiUsed: false, geminiConfidence: null
                });
            }

            const cohereScore = embResult.score;

            // Definite mismatch — below reasoning threshold
            if (cohereScore < this.reasoningThreshold) {
                return done({
                    decision: 'split', canonicalFilter: null,
                    confidence: cohereScore, source: 'embedding',
                    validatorApproved: false, cohereScore,
                    geminiUsed: false, geminiConfidence: null
                });
            }

            // ── Step 3a: high-confidence embedding match (skip Gemini) ─────────────
            if (cohereScore >= this.embeddingThreshold) {
                const plan = {
                    equivalent: true,
                    canonicalFilter: Object.assign({}, (intentA && intentA.filters) || {}),
                    confidence: cohereScore,
                    reason: 'high-embedding-similarity'
                };
                const v = validate(plan, intentA, intentB, {
                    maxSupersetLimit: this.maxSupersetLimit,
                    minConfidence: this.minConfidence,
                    knownRoutes: this.knownRoutes
                });
                if (!v.safe) {
                    this._validatorRejects++;
                    return done({
                        decision: 'split', canonicalFilter: null,
                        confidence: plan.confidence, source: 'embedding',
                        validatorApproved: false, cohereScore,
                        geminiUsed: false, geminiConfidence: null
                    });
                }
                this.cache.set(
                    (intentA && intentA.filters) || {},
                    (intentB && intentB.filters) || {},
                    plan.canonicalFilter
                );
                this._validatorApprovals++;
                return done({
                    decision: 'merge', canonicalFilter: plan.canonicalFilter,
                    confidence: plan.confidence, source: 'embedding',
                    validatorApproved: true, cohereScore,
                    geminiUsed: false, geminiConfidence: null
                });
            }

            // ── Step 4: ambiguous zone (0.6–0.84) → call Gemini ────────────────────
            this._reasoningInvocations++;
            const gemResult = await this.reasoner.analyze(intentA, intentB, cohereScore);
            this._totalReasoningMs += gemResult.latencyMs || 0;
            // $0.075 per 1M tokens, estimate 500 tokens per call
            this._totalCostUsd += ((gemResult.tokenCount || 500) / 1_000_000) * 0.075;

            if (!gemResult.equivalent) {
                return done({
                    decision: 'split', canonicalFilter: null,
                    confidence: gemResult.confidence, source: 'reasoning',
                    validatorApproved: false, cohereScore,
                    geminiUsed: true, geminiConfidence: gemResult.confidence
                });
            }

            // ── Step 5: validate Gemini's proposal ─────────────────────────────────
            const plan = {
                equivalent: gemResult.equivalent,
                canonicalFilter: gemResult.canonicalFilter,
                confidence: gemResult.confidence,
                reason: gemResult.reason
            };
            const v = validate(plan, intentA, intentB, {
                maxSupersetLimit: this.maxSupersetLimit,
                minConfidence: this.minConfidence,
                knownRoutes: this.knownRoutes
            });

            if (!v.safe) {
                this._validatorRejects++;
                return done({
                    decision: 'split', canonicalFilter: null,
                    confidence: plan.confidence, source: 'reasoning',
                    validatorApproved: false, cohereScore,
                    geminiUsed: true, geminiConfidence: plan.confidence
                });
            }

            // ── Step 6: validated merge — store in cache ────────────────────────────
            this.cache.set(
                (intentA && intentA.filters) || {},
                (intentB && intentB.filters) || {},
                plan.canonicalFilter
            );
            this._validatorApprovals++;
            return done({
                decision: 'merge', canonicalFilter: plan.canonicalFilter,
                confidence: plan.confidence, source: 'reasoning',
                validatorApproved: true, cohereScore,
                geminiUsed: true, geminiConfidence: plan.confidence
            });

        } catch (err) {
            // Unhandled error — always fall back, never crash the middleware
            return done({
                decision: 'fallback', canonicalFilter: null,
                confidence: 0, source: 'fallback',
                validatorApproved: false, cohereScore: null,
                geminiUsed: false, geminiConfidence: null
            });
        }
    }

    /**
     * Returns all AI metric fields for inclusion in getMetrics().
     */
    getStats() {
        const cacheStats = this.cache.getStats();
        const embCount = this._embeddingInvocations;
        const reaCount = this._reasoningInvocations;
        return {
            aiInvocations: this._aiInvocations,
            embeddingInvocations: embCount,
            reasoningInvocations: reaCount,
            validatorApprovals: this._validatorApprovals,
            validatorRejects: this._validatorRejects,
            patternCacheHits: cacheStats.hits,
            patternCacheMisses: cacheStats.misses,
            avgEmbeddingMs: embCount ? this._totalEmbeddingMs / embCount : 0,
            avgReasoningMs: reaCount ? this._totalReasoningMs / reaCount : 0,
            aiStatus: this._aiStatus,
            estimatedCostUsd: this._totalCostUsd
        };
    }
}

module.exports = SemanticPlanner;
