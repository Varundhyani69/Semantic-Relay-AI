'use strict';

/**
 * Validates an AI-proposed merge plan against the two original intents.
 *
 * This is the final authority. The AI cannot bypass this.
 * If this returns { safe: false }, the requests execute independently.
 *
 * @param {object} plan - { equivalent, canonicalFilter, confidence, reason }
 * @param {object} intentA - normalized intent (resource, filters, page, limit, ...)
 * @param {object} intentB - normalized intent
 * @param {object} options - { maxSupersetLimit?, minConfidence?, knownRoutes? }
 * @returns {{ safe: boolean, reason: string }}
 */
function validate(plan, intentA, intentB, options = {}) {
  const minConfidence = typeof options.minConfidence === 'number' ? options.minConfidence : 0.7;
  const maxSupersetLimit = typeof options.maxSupersetLimit === 'number' ? options.maxSupersetLimit : 1000;
  const knownRoutes = options.knownRoutes || {};

  try {
    // Check 1: plan must exist and have required fields
    if (!plan || typeof plan !== 'object') {
      return { safe: false, reason: 'incomplete-plan' };
    }
    if (typeof plan.equivalent !== 'boolean') {
      return { safe: false, reason: 'incomplete-plan' };
    }
    if (typeof plan.confidence !== 'number') {
      return { safe: false, reason: 'incomplete-plan' };
    }

    // Check 2: AI must say equivalent=true
    if (!plan.equivalent) {
      return { safe: false, reason: 'ai-says-not-equivalent' };
    }

    // canonicalFilter is required when equivalent=true
    if (!plan.canonicalFilter || typeof plan.canonicalFilter !== 'object') {
      return { safe: false, reason: 'incomplete-plan' };
    }

    // Check 3: confidence must meet floor
    if (plan.confidence < minConfidence) {
      return { safe: false, reason: 'low-confidence' };
    }

    // Check 4: canonicalFilter must not introduce unknown keys
    const filtersA = (intentA && intentA.filters) ? intentA.filters : {};
    const filtersB = (intentB && intentB.filters) ? intentB.filters : {};
    const allowedKeys = new Set([
      ...Object.keys(filtersA),
      ...Object.keys(filtersB)
    ]);
    for (const key of Object.keys(plan.canonicalFilter)) {
      if (!allowedKeys.has(key)) {
        return { safe: false, reason: 'unknown-filter-keys' };
      }
    }

    // Check 5: projected superset size must not exceed limit
    const pageA = (intentA && intentA.page) ? intentA.page : 1;
    const limitA = (intentA && intentA.limit) ? intentA.limit : 20;
    const pageB = (intentB && intentB.page) ? intentB.page : 1;
    const limitB = (intentB && intentB.limit) ? intentB.limit : 20;
    const skipA = (pageA - 1) * limitA;
    const skipB = (pageB - 1) * limitB;
    const endA = skipA + limitA;
    const endB = skipB + limitB;
    const combinedLimit = Math.max(endA, endB) - Math.min(skipA, skipB);
    if (combinedLimit > maxSupersetLimit) {
      return { safe: false, reason: 'superset-too-large' };
    }

    // Check 6: if resources differ, both must map to the same registered route
    const resourceA = intentA && intentA.resource;
    const resourceB = intentB && intentB.resource;
    if (resourceA && resourceB && resourceA !== resourceB) {
      const routeKeys = Object.keys(knownRoutes);
      const routeA = routeKeys.find(r => resourceA.startsWith(r));
      const routeB = routeKeys.find(r => resourceB.startsWith(r));
      if (!routeA || !routeB || routeA !== routeB) {
        return { safe: false, reason: 'unverified-route-equivalence' };
      }
    }

    return { safe: true, reason: 'validated' };

  } catch (err) {
    // Defensive — validation must never throw
    return { safe: false, reason: 'validator-internal-error' };
  }
}

module.exports = { validate };
