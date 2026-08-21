'use strict';

const { validate } = require('../src/ai/validator');

const intentA = { resource: '/products', filters: { category: 'laptops' }, page: 1, limit: 20 };
const intentB = { resource: '/products', filters: { type: 'laptop' }, page: 1, limit: 20 };

const validPlan = {
  equivalent: true,
  canonicalFilter: { category: 'laptops' },
  confidence: 0.91,
  reason: 'semantically equivalent'
};

describe('validate — incomplete plan checks', () => {
  it('rejects null plan', () => {
    const result = validate(null, intentA, intentB);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('incomplete-plan');
  });

  it('rejects plan missing equivalent field', () => {
    const result = validate({ canonicalFilter: {}, confidence: 0.9, reason: 'ok' }, intentA, intentB);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('incomplete-plan');
  });

  it('rejects plan missing canonicalFilter', () => {
    const result = validate({ equivalent: true, confidence: 0.9, reason: 'ok' }, intentA, intentB);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('incomplete-plan');
  });

  it('rejects plan missing confidence', () => {
    const result = validate({ equivalent: true, canonicalFilter: {}, reason: 'ok' }, intentA, intentB);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('incomplete-plan');
  });
});

describe('validate — equivalence check', () => {
  it('rejects when AI says not equivalent', () => {
    const plan = { ...validPlan, equivalent: false, canonicalFilter: null };
    const result = validate(plan, intentA, intentB);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('ai-says-not-equivalent');
  });
});

describe('validate — confidence check', () => {
  it('rejects when confidence is below default floor (0.7)', () => {
    const plan = { ...validPlan, confidence: 0.55 };
    const result = validate(plan, intentA, intentB);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('low-confidence');
  });

  it('rejects when confidence is below custom floor', () => {
    const plan = { ...validPlan, confidence: 0.8 };
    const result = validate(plan, intentA, intentB, { minConfidence: 0.85 });
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('low-confidence');
  });

  it('accepts when confidence exactly meets floor', () => {
    const plan = { ...validPlan, confidence: 0.7 };
    const result = validate(plan, intentA, intentB);
    expect(result.safe).toBe(true);
  });
});

describe('validate — unknown filter key check', () => {
  it('rejects canonicalFilter with key not in either intent', () => {
    const plan = { ...validPlan, canonicalFilter: { __inject: 'malicious' } };
    const result = validate(plan, intentA, intentB);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('unknown-filter-keys');
  });

  it('accepts canonicalFilter with keys from intentA', () => {
    const plan = { ...validPlan, canonicalFilter: { category: 'laptops' } };
    const result = validate(plan, intentA, intentB);
    expect(result.safe).toBe(true);
  });

  it('accepts canonicalFilter with keys from intentB', () => {
    const plan = { ...validPlan, canonicalFilter: { type: 'laptop' } };
    const result = validate(plan, intentA, intentB);
    expect(result.safe).toBe(true);
  });
});

describe('validate — superset size check', () => {
  it('rejects when combined pages exceed maxSupersetLimit', () => {
    const bigIntentA = { resource: '/products', filters: {}, page: 1, limit: 600 };
    const bigIntentB = { resource: '/products', filters: {}, page: 2, limit: 600 };
    const plan = { ...validPlan, canonicalFilter: {} };
    const result = validate(plan, bigIntentA, bigIntentB, { maxSupersetLimit: 1000 });
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('superset-too-large');
  });

  it('accepts when combined pages are within limit', () => {
    const plan = { ...validPlan, canonicalFilter: { category: 'laptops' } };
    const result = validate(plan, intentA, intentB, { maxSupersetLimit: 1000 });
    expect(result.safe).toBe(true);
  });
});

describe('validate — cross-resource route check', () => {
  it('rejects when resources differ and no route mapping', () => {
    const crossA = { ...intentA, resource: '/api/v1/products' };
    const crossB = { ...intentB, resource: '/api/v2/products' };
    const result = validate(validPlan, crossA, crossB, { knownRoutes: {} });
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('unverified-route-equivalence');
  });

  it('accepts when resources differ but both match same registered route prefix', () => {
    const crossA = { ...intentA, resource: '/api/products/list' };
    const crossB = { ...intentB, resource: '/api/products/search' };
    const plan = { ...validPlan, canonicalFilter: { category: 'laptops' } };
    const result = validate(plan, crossA, crossB, {
      knownRoutes: { '/api/products': { fetch: () => {} } }
    });
    expect(result.safe).toBe(true);
  });
});

describe('validate — full valid plan', () => {
  it('returns safe:true for a clean valid plan', () => {
    const result = validate(validPlan, intentA, intentB);
    expect(result.safe).toBe(true);
    expect(result.reason).toBe('validated');
  });
});

describe('validate — defensive edge cases', () => {
  it('never throws for undefined inputs', () => {
    expect(() => validate(undefined, undefined, undefined)).not.toThrow();
  });

  it('never throws for empty objects', () => {
    expect(() => validate({}, {}, {})).not.toThrow();
  });
});
