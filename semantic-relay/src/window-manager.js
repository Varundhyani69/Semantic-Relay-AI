const MemoryWindow = require('./adapters/memory-window');
const scorer = require('./scorer');

function stableStringify(obj) {
  if (obj === null || obj === undefined) return '';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

class WindowManager {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 20;
    this.threshold = options.threshold || 0.8;
    this.earlyFlushMinSize = options.earlyFlushMinSize || 0;
    this.maxPendingPerKey = options.maxPendingPerKey || 1000;
    this.maxPageGap = options.maxPageGap || Infinity;
    this.storage = options.window || new MemoryWindow();
    this.timers = new Map();
    this.onFlushCallback = null;
  }

  onFlush(cb) {
    this.onFlushCallback = cb;
  }

  add(ctx) {
    const resourceKey = this.resourceKey(ctx.intent);
    this.storage.add(resourceKey, ctx);

    if (!this.timers.has(resourceKey)) {
      const timer = setTimeout(() => {
        this.timers.delete(resourceKey);
        this.flushResource(resourceKey);
      }, this.windowMs);
      this.timers.set(resourceKey, timer);
    }

    if (this.shouldEarlyFlush(resourceKey)) {
      const timer = this.timers.get(resourceKey);
      if (timer) clearTimeout(timer);
      this.timers.delete(resourceKey);
      this.flushResource(resourceKey);
    }
  }

  resourceKey(intent) {
    return intent.groupKey ? `${intent.resource}::${intent.groupKey}` : intent.resource;
  }

  shouldEarlyFlush(resourceKey) {
    const contexts = typeof this.storage.peek === 'function' ? this.storage.peek(resourceKey) : [];
    if (!Array.isArray(contexts) || contexts.length < 2) return false;
    return this.groupContexts(contexts).some(group => {
      const expectedSize = group.reduce((max, ctx) => {
        return Math.max(max, ctx.intent.expectedGroupSize || 0);
      }, 0);
      const targetSize = expectedSize || this.earlyFlushMinSize;
      return targetSize >= 2 && group.length >= targetSize && this.pageGap(group) <= this.maxPageGap;
    });
  }

  bucketKey(intent) {
    if (intent.groupKey) return `hint:${intent.groupKey}`;
    return [
      'auto',
      intent.resource,
      intent.limit,
      stableStringify(intent.filters)
    ].join('|');
  }

  pageGap(group) {
    let minPage = Infinity;
    let maxPage = 0;
    for (const ctx of group) {
      minPage = Math.min(minPage, ctx.intent.page);
      maxPage = Math.max(maxPage, ctx.intent.page);
    }
    return maxPage - minPage;
  }

  groupContexts(contexts) {
    const buckets = new Map();
    for (const ctx of contexts) {
      const key = this.bucketKey(ctx.intent);
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

        const matchesGroup = scorer(current[current.length - 1].intent, ctx.intent) >= this.threshold
          || current.some(existing => scorer(existing.intent, ctx.intent) >= this.threshold);
        const nextGroup = current.concat(ctx);

        if (
          matchesGroup
          && nextGroup.length <= this.maxPendingPerKey
          && this.pageGap(nextGroup) <= this.maxPageGap
        ) {
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

  async flushResource(resourceKey) {
    const contexts = await this.storage.flush(resourceKey);
    if (!contexts || contexts.length === 0) return;

    const groups = this.groupContexts(contexts);

    if (this.onFlushCallback) {
      groups.forEach(group => this.onFlushCallback(group));
    }
  }
}

module.exports = WindowManager;
