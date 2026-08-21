'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_CACHE_FILE = path.join(__dirname, '..', '..', 'pattern-cache.json');
const DEFAULT_MAX_SIZE = 500;

class PatternCache {
  constructor(options = {}) {
    this.maxSize = options.maxSize || DEFAULT_MAX_SIZE;
    this.cacheFile = options.cacheFile || DEFAULT_CACHE_FILE;
    // Map: hash → { canonicalFilter, approvedAt, hitCount }
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;

    this._load();

    // Persist on shutdown
    process.on('exit', () => this._save());
    process.on('SIGINT', () => {
      this._save();
      process.exit(0);
    });
  }

  /**
   * Look up a known equivalence for two filter objects.
   * Order-independent: get(A, B) === get(B, A)
   * @returns {object|null} canonicalFilter or null if not cached
   */
  get(filterA, filterB) {
    const key = this._hash(filterA, filterB);
    const entry = this.cache.get(key);
    if (entry) {
      entry.hitCount++;
      this.hits++;
      return entry.canonicalFilter;
    }
    this.misses++;
    return null;
  }

  /**
   * Store a validated-safe equivalence.
   * Evicts oldest entry (by approvedAt) when at capacity.
   */
  set(filterA, filterB, canonicalFilter) {
    const key = this._hash(filterA, filterB);

    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      // Evict oldest
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.cache.entries()) {
        if (v.approvedAt < oldestTime) {
          oldestTime = v.approvedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      canonicalFilter,
      approvedAt: Date.now(),
      hitCount: 0
    });
  }

  getStats() {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size
    };
  }

  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Stable, order-independent hash of two filter objects.
   * hash(A, B) === hash(B, A)
   */
  _hash(filterA, filterB) {
    const strA = _stableStringify(filterA);
    const strB = _stableStringify(filterB);
    // Sort the two strings so order doesn't matter
    const combined = [strA, strB].sort().join('::');
    return crypto.createHash('sha256').update(combined).digest('hex');
  }

  _load() {
    try {
      if (!fs.existsSync(this.cacheFile)) return;
      const raw = fs.readFileSync(this.cacheFile, 'utf8');
      const entries = JSON.parse(raw);
      if (!Array.isArray(entries)) return;
      for (const [key, value] of entries) {
        this.cache.set(key, value);
      }
    } catch (err) {
      // Corrupt or missing file — start empty
      console.warn('[semantic-relay] pattern cache load failed, starting empty:', err.message);
    }
  }

  _save() {
    try {
      const entries = Array.from(this.cache.entries());
      fs.writeFileSync(this.cacheFile, JSON.stringify(entries), 'utf8');
    } catch (err) {
      // Non-fatal — just means patterns aren't persisted this session
    }
  }
}

function _stableStringify(obj) {
  if (obj === null || obj === undefined) return '';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(_stableStringify).join(',')}]`;
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${_stableStringify(obj[k])}`).join(',')}}`;
}

module.exports = PatternCache;
