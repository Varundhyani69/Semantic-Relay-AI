'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const PatternCache = require('../src/ai/pattern-cache');

describe('PatternCache', () => {
  let tmpFile;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `pattern-cache-test-${Date.now()}.json`);
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  });

  it('returns null on empty cache', () => {
    const cache = new PatternCache({ cacheFile: tmpFile });
    expect(cache.get({ category: 'laptops' }, { type: 'laptop' })).toBeNull();
  });

  it('set then get returns canonical filter', () => {
    const cache = new PatternCache({ cacheFile: tmpFile });
    const canonical = { category: 'laptops' };
    cache.set({ category: 'laptops' }, { type: 'laptop' }, canonical);
    expect(cache.get({ category: 'laptops' }, { type: 'laptop' })).toEqual(canonical);
  });

  it('get is order-independent (A,B === B,A)', () => {
    const cache = new PatternCache({ cacheFile: tmpFile });
    const canonical = { category: 'laptops' };
    cache.set({ category: 'laptops' }, { type: 'laptop' }, canonical);
    expect(cache.get({ type: 'laptop' }, { category: 'laptops' })).toEqual(canonical);
  });

  it('evicts oldest entry when at maxSize', () => {
    const cache = new PatternCache({ cacheFile: tmpFile, maxSize: 2 });
    cache.set({ a: '1' }, { b: '1' }, { x: '1' });
    cache.set({ a: '2' }, { b: '2' }, { x: '2' });
    cache.set({ a: '3' }, { b: '3' }, { x: '3' }); // should evict first
    expect(cache.getStats().size).toBe(2);
    expect(cache.get({ a: '1' }, { b: '1' })).toBeNull(); // evicted
    expect(cache.get({ a: '3' }, { b: '3' })).toEqual({ x: '3' }); // present
  });

  it('getStats counts hits and misses', () => {
    const cache = new PatternCache({ cacheFile: tmpFile });
    cache.set({ a: '1' }, { b: '1' }, { x: '1' });
    cache.get({ a: '1' }, { b: '1' }); // hit
    cache.get({ a: '2' }, { b: '2' }); // miss
    cache.get({ a: '2' }, { b: '2' }); // miss
    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(2);
  });

  it('save and load round-trips correctly', () => {
    const cache1 = new PatternCache({ cacheFile: tmpFile });
    cache1.set({ category: 'laptops' }, { type: 'laptop' }, { category: 'laptops' });
    cache1._save();

    const cache2 = new PatternCache({ cacheFile: tmpFile });
    expect(cache2.get({ category: 'laptops' }, { type: 'laptop' })).toEqual({ category: 'laptops' });
  });

  it('starts empty if cache file is corrupt', () => {
    fs.writeFileSync(tmpFile, 'not valid json', 'utf8');
    const cache = new PatternCache({ cacheFile: tmpFile });
    expect(cache.getStats().size).toBe(0);
  });

  it('starts empty if cache file does not exist', () => {
    const cache = new PatternCache({ cacheFile: '/tmp/nonexistent-cache-xyz.json' });
    expect(cache.getStats().size).toBe(0);
  });
});
