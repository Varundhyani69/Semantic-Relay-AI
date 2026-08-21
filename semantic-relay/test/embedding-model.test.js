'use strict';

const EmbeddingModel = require('../src/ai/embedding-model');

// We mock fetch globally for these tests
global.fetch = jest.fn();

afterEach(() => {
  jest.resetAllMocks();
});

describe('EmbeddingModel._intentToText', () => {
  const model = new EmbeddingModel({ apiKey: 'test' });

  it('produces stable output regardless of filter key insertion order', () => {
    const intentA = { resource: '/products', filters: { category: 'laptops', maxPrice: '50000' } };
    const intentB = { resource: '/products', filters: { maxPrice: '50000', category: 'laptops' } };
    expect(model._intentToText(intentA)).toBe(model._intentToText(intentB));
  });

  it('sorts keys alphabetically', () => {
    const intent = { resource: '/products', filters: { z: '1', a: '2', m: '3' } };
    expect(model._intentToText(intent)).toBe('resource: /products | a: 2 | m: 3 | z: 1');
  });

  it('handles empty filters', () => {
    const intent = { resource: '/products', filters: {} };
    expect(model._intentToText(intent)).toBe('resource: /products');
  });
});

describe('EmbeddingModel._cosineSimilarity', () => {
  const model = new EmbeddingModel({ apiKey: 'test' });

  it('returns 1.0 for identical vectors', () => {
    expect(model._cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1.0);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    expect(model._cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
  });

  it('returns 0 for zero-length vectors', () => {
    expect(model._cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it('returns 0 for mismatched lengths', () => {
    expect(model._cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('clamps result to [0, 1]', () => {
    const score = model._cosineSimilarity([1, 1, 1], [1, 1, 1]);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe('EmbeddingModel.similarity', () => {
  it('returns score -1 when API key is not set', async () => {
    const model = new EmbeddingModel({ apiKey: '' });
    const result = await model.similarity(
      { resource: '/products', filters: { category: 'laptops' } },
      { resource: '/products', filters: { type: 'laptop' } }
    );
    expect(result.score).toBe(-1);
    expect(result.error).toBeDefined();
  });

  it('returns score -1 when Cohere returns non-200', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'rate limit exceeded'
    });
    const model = new EmbeddingModel({ apiKey: 'test-key' });
    const result = await model.similarity(
      { resource: '/products', filters: { category: 'laptops' } },
      { resource: '/products', filters: { type: 'laptop' } }
    );
    expect(result.score).toBe(-1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns score -1 on timeout', async () => {
    global.fetch.mockImplementationOnce(() =>
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('AbortError')), 100)
      )
    );
    const model = new EmbeddingModel({ apiKey: 'test-key', timeoutMs: 50 });
    const result = await model.similarity(
      { resource: '/products', filters: { category: 'laptops' } },
      { resource: '/products', filters: { type: 'laptop' } }
    );
    expect(result.score).toBe(-1);
  });

  it('returns score -1 when response has no embeddings field', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'abc' }) // missing embeddings
    });
    const model = new EmbeddingModel({ apiKey: 'test-key' });
    const result = await model.similarity(
      { resource: '/products', filters: { a: '1' } },
      { resource: '/products', filters: { b: '2' } }
    );
    expect(result.score).toBe(-1);
  });

  it('returns a score between 0 and 1 on successful response', async () => {
    const vecA = [1, 0, 0];
    const vecB = [0.9, 0.1, 0];
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [vecA, vecB] })
    });
    const model = new EmbeddingModel({ apiKey: 'test-key' });
    const result = await model.similarity(
      { resource: '/products', filters: { category: 'laptops' } },
      { resource: '/products', filters: { type: 'laptop' } }
    );
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
