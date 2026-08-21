'use strict';

const ReasoningModel = require('../src/ai/reasoning-model');

global.fetch = jest.fn();

afterEach(() => {
  jest.resetAllMocks();
});

const intentA = { resource: '/products', filters: { category: 'laptops' }, page: 1, limit: 20 };
const intentB = { resource: '/products', filters: { type: 'laptop' }, page: 1, limit: 20 };

describe('ReasoningModel._buildPrompt', () => {
  const model = new ReasoningModel({ apiKey: 'test' });

  it('includes both resources in the prompt', () => {
    const prompt = model._buildPrompt(intentA, intentB, 0.72);
    expect(prompt).toContain('/products');
    expect(prompt).toContain('category');
    expect(prompt).toContain('type');
  });

  it('includes the cohere score', () => {
    const prompt = model._buildPrompt(intentA, intentB, 0.72);
    expect(prompt).toContain('0.720');
  });

  it('instructs model to return only JSON', () => {
    const prompt = model._buildPrompt(intentA, intentB, 0.72);
    expect(prompt).toContain('ONLY valid JSON');
  });
});

describe('ReasoningModel._parseResponse', () => {
  const model = new ReasoningModel({ apiKey: 'test' });

  it('parses valid JSON response', () => {
    const raw = JSON.stringify({
      equivalent: true,
      canonicalFilter: { category: 'laptops' },
      confidence: 0.91,
      reason: 'category=laptops is semantically equivalent to type=laptop'
    });
    const result = model._parseResponse(raw);
    expect(result.equivalent).toBe(true);
    expect(result.confidence).toBe(0.91);
    expect(result.canonicalFilter).toEqual({ category: 'laptops' });
  });

  it('parses JSON wrapped in markdown code block', () => {
    const raw = '```json\n{"equivalent":false,"canonicalFilter":null,"confidence":0.3,"reason":"different values"}\n```';
    const result = model._parseResponse(raw);
    expect(result.equivalent).toBe(false);
  });

  it('throws on malformed JSON', () => {
    expect(() => model._parseResponse('not json at all')).toThrow();
  });

  it('throws when equivalent field is missing', () => {
    const raw = JSON.stringify({ canonicalFilter: {}, confidence: 0.9, reason: 'ok' });
    expect(() => model._parseResponse(raw)).toThrow();
  });

  it('throws when equivalent=true but canonicalFilter is missing', () => {
    const raw = JSON.stringify({ equivalent: true, canonicalFilter: null, confidence: 0.9, reason: 'ok' });
    expect(() => model._parseResponse(raw)).toThrow();
  });

  it('clamps confidence to [0, 1]', () => {
    const raw = JSON.stringify({ equivalent: false, canonicalFilter: null, confidence: 1.5, reason: 'ok' });
    const result = model._parseResponse(raw);
    expect(result.confidence).toBe(1);
  });
});

describe('ReasoningModel.analyze', () => {
  it('returns api-error fallback when API key is not set', async () => {
    const model = new ReasoningModel({ apiKey: '' });
    const result = await model.analyze(intentA, intentB, 0.72);
    expect(result.equivalent).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.reason).toBe('api-error');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns timeout fallback when fetch times out', async () => {
    global.fetch.mockImplementation(() =>
      new Promise((_, reject) =>
        setTimeout(() => { const e = new Error('AbortError'); e.name = 'AbortError'; reject(e); }, 50)
      )
    );
    const model = new ReasoningModel({ apiKey: 'test', timeoutMs: 30 });
    const result = await model.analyze(intentA, intentB, 0.72);
    expect(result.equivalent).toBe(false);
    expect(result.reason).toBe('timeout');
  });

  it('returns api-error when Gemini returns non-200', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'service unavailable'
    });
    const model = new ReasoningModel({ apiKey: 'test' });
    const result = await model.analyze(intentA, intentB, 0.72);
    expect(result.equivalent).toBe(false);
    expect(result.reason).toBe('api-error');
  });

  it('returns parse-error fallback when Gemini returns malformed JSON', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'not valid json' }] } }]
      })
    });
    const model = new ReasoningModel({ apiKey: 'test' });
    const result = await model.analyze(intentA, intentB, 0.72);
    expect(result.equivalent).toBe(false);
    expect(result.reason).toBe('parse-error');
  });

  it('returns correct parsed result on successful response', async () => {
    const mockResponse = {
      equivalent: true,
      canonicalFilter: { category: 'laptops' },
      confidence: 0.91,
      reason: 'semantically equivalent'
    };
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(mockResponse) }] } }]
      })
    });
    const model = new ReasoningModel({ apiKey: 'test' });
    const result = await model.analyze(intentA, intentB, 0.72);
    expect(result.equivalent).toBe(true);
    expect(result.canonicalFilter).toEqual({ category: 'laptops' });
    expect(result.confidence).toBe(0.91);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.tokenCount).toBeGreaterThan(0);
  });

  it('never throws even with null inputs', async () => {
    const model = new ReasoningModel({ apiKey: 'test' });
    const result = await model.analyze(null, null, 0);
    expect(result.equivalent).toBe(false);
    expect(typeof result.reason).toBe('string');
  });
});
