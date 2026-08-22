# 🧪 Semantic Relay AI Caching - Manual Testing Guide

> **Updated**: Gemini upgraded to `gemini-3.6-flash`. New AI modes available. Groups of any size supported.

## 📋 Prerequisites

### Optimal Settings (Already configured in `.env`)
```env
RELAY_WINDOW_MS=500        # Time window to group requests
RELAY_THRESHOLD=0.5        # Grouping threshold
EMBEDDING_THRESHOLD=0.75   # AI similarity threshold
REASONING_THRESHOLD=0.45   # Gemini reasoning threshold
MIN_CONFIDENCE=0.6         # Minimum confidence for AI decisions
AI_MODE=adaptive           # Uses AI for ambiguous cases
```

### Available AI Modes
```
adaptive          — Full pipeline: Cache → Cohere → Gemini → Validator (default)
safe / disabled   — No AI, deterministic only
deterministic-only— Same as safe
cohere-only       — Cohere embeddings but no Gemini calls
gemini-reasoning  — Force Gemini even for high-confidence Cohere results
pattern-cache-test— Cache lookup only, skip Cohere
```

You can switch modes at runtime: `POST /api/ai-mode { "mode": "cohere-only" }`

### Start the Server
```bash
cd semantic-relay-demo
npm start
```

Server will run at: **http://localhost:3100**

---

## 🎯 Test Scenario 1: First Run (Cold Start - No Cache)

### Goal
Demonstrate AI layer calling Cohere API for unknown patterns.

### Steps

1. **Delete pattern cache** (optional - for clean demo):
   ```bash
   # Windows PowerShell
   Remove-Item "e:\Sementic-relay\semantic-relay-demo\node_modules\semantic-relay\pattern-cache.json" -ErrorAction SilentlyContinue
   ```

2. **Restart server**:
   ```bash
   # Stop with Ctrl+C, then:
   npm start
   ```

3. **Open UI**: http://localhost:3100

4. **Configure benchmark**:
   - **Requests**: 2 (triggers AI for pairs)
   - **Page size**: 12 or 15
   - **Category**: Hardware
   
5. **Click "Run benchmark"**

6. **Expected Results** (after clicking Refresh):
   ```
   AI Layer Stats:
   ✓ AI Invocations: 1
   ✓ Embedding Calls: 1  ← Cohere API called
   ✓ Cache Hits: 0
   ✓ Cache Misses: 1
   ✓ Validator Approvals: 1
   ✓ Est. Cost: $0.0001
   
   Performance:
   ✓ Time: ~700-1500ms (slower due to API call)
   ```

7. **Check Decision Logs**:
   - Click "View Decision Logs"
   - Look for:
     - `source: "embedding"` (Cohere was used)
     - `cohereScore: 0.9+` (high similarity)
     - `canonicalFilter: {category: "hardware"}`
     - `mergeExecuted: true`

---

## 🚀 Test Scenario 2: Second Run (Warm - Using Cache)

### Goal
Demonstrate pattern cache working - NO API calls.

### Steps

1. **Same settings as before**:
   - Requests: 2
   - Page size: 12 or 15
   - Category: Hardware (same category!)

2. **Click "Run benchmark"** again

3. **Click "Refresh"** to update stats

4. **Expected Results**:
   ```
   AI Layer Stats:
   ✓ AI Invocations: 2 (1 new)
   ✓ Embedding Calls: 1 (no new calls!)
   ✓ Cache Hits: 1 (pattern cache used!)
   ✓ Cache Misses: 1
   ✓ Est. Cost: $0.0001 (no additional cost)
   
   Performance:
   ✓ Time: ~200-300ms (6x faster!)
   ```

5. **Check Decision Logs**:
   - Look for latest decision:
     - `source: "cache"` ← Pattern retrieved from cache
     - `latencyMs: 1-2` (instant!)
     - `cohereScore: null` (no API call)

---

## 🔄 Test Scenario 3: Server Restart (Persistent Cache)

### Goal
Demonstrate pattern cache survives server restarts.

### Steps

1. **Stop server**: Press Ctrl+C in terminal

2. **Restart server**:
   ```bash
   npm start
   ```

3. **Open UI**: http://localhost:3100

4. **Notice**: AI stats show 0 (in-memory metrics reset)

5. **Run benchmark**:
   - Requests: 2
   - Category: Hardware (same as before)

6. **Click "Run benchmark"**

7. **Expected Results**:
   ```
   AI Layer Stats (after restart):
   ✓ AI Invocations: 1 (fresh count)
   ✓ Embedding Calls: 0 ← No API call! (cache persisted)
   ✓ Cache Hits: 1 ← Used persisted cache
   ✓ Est. Cost: $0
   
   Performance:
   ✓ Time: ~200-300ms (still fast!)
   ```

**Key Point**: Despite restart, pattern cache survived and was used!

---

## 🆕 Test Scenario 4: Unknown Pattern (Cache Miss)

### Goal
Demonstrate AI calling API for new, unknown patterns.

### Steps

1. **Change category**:
   - Requests: 2
   - Category: **Apparel** (new category!)

2. **Click "Run benchmark"**

3. **Expected Results**:
   ```
   AI Layer Stats:
   ✓ AI Invocations: 2 (1 new)
   ✓ Embedding Calls: 1 (new API call for unknown pattern!)
   ✓ Cache Hits: 1
   ✓ Cache Misses: 2 (new miss for "apparel")
   ✓ Est. Cost: $0.0001 (additional cost for new pattern)
   
   Performance:
   ✓ Time: ~700-1500ms (slower - API call)
   ```

4. **Run same benchmark again** (Apparel):
   ```
   ✓ Embedding Calls: 1 (no new calls)
   ✓ Cache Hits: 2 (now cached!)
   ✓ Time: ~200-300ms (fast again!)
   ```

---

## 📊 Test Scenario 5: Large Batch (Deterministic Only)

### Goal
Show that AI only triggers for ambiguous pairs (size=2).

### Steps

1. **Configure**:
   - Requests: 8 or 16 (large batch)
   - Category: Hardware

2. **Click "Run benchmark"**

3. **Expected Results**:
   ```
   AI Layer Stats:
   ✓ AI Invocations: 0 (no new - batch too large)
   ✓ Embedding Calls: 0 (deterministic grouping used)
   
   Performance:
   ✓ Saved Calls: 7-15 (high query reduction)
   ✓ Time: Fast (deterministic is instant)
   ```

**Why?**: AI only evaluates pairs (2 requests). Larger groups use deterministic scoring.

---

## 🎭 Test Scenario 6: Different Filter Keys (AI Semantic Matching)

### Goal
Show AI detecting semantic equivalence with different key names.

### Steps

This is **automatically tested** in scenarios 1-4. The benchmark alternates filter keys:
- Request 1: `{category: "hardware"}`
- Request 2: `{type: "hardware"}` ← Different key, same meaning!

The AI layer:
1. Detects filters are different
2. Calls Cohere to check semantic similarity
3. Finds high similarity (0.9+)
4. Merges them with canonical filter: `{category: "hardware"}`
5. Caches the pattern for future use

**Check Decision Logs** to see:
```json
{
  "filtersA": {"category": "hardware"},
  "filtersB": {"type": "hardware"},
  "cohereScore": 0.92,
  "decision": "merge",
  "canonicalFilter": {"category": "hardware"}
}
```

---

## 🎯 Key Metrics to Watch

### AI Layer Indicators

| Metric | What It Means | Good Values |
|--------|---------------|-------------|
| **AI Invocations** | Total AI evaluations | Increases with requests |
| **Embedding Calls** | Cohere API calls | 0 for cached patterns |
| **Cache Hits** | Patterns retrieved from cache | Should increase over time |
| **Cache Misses** | New patterns requiring API | First occurrence of each pattern |
| **Validator Approvals** | AI decisions approved | Should match invocations |
| **Est. Cost** | Total API costs | ~$0.0001 per embedding call |

### Performance Indicators

| Metric | Cold (API) | Warm (Cache) |
|--------|------------|--------------|
| **Time** | 700-1500ms | 200-300ms |
| **Embedding Calls** | 1 | 0 |
| **Latency** | 700-800ms | 1-2ms |
| **Cost** | $0.0001 | $0 |

---

## 🔍 Troubleshooting

### "AI stats stay at 0"
- **Solution**: Click "Refresh" button after running benchmark
- Stats update after each benchmark completes

### "No cache hits"
- **Check**: Requests parameter = 2 (AI only works on pairs)
- **Check**: Same category used in previous test
- **Solution**: Run benchmark twice with same category

### "Embedding calls keep happening"
- **Check**: Using same category name?
- **Check**: Pattern cache file exists?
  ```bash
  ls node_modules/semantic-relay/pattern-cache.json
  ```
- **Solution**: Delete cache and restart to reset

### "Decision logs empty"
- **Solution**: Run a benchmark first
- Logs only appear after AI evaluation

### "Slow performance despite cache"
- **Check**: RELAY_WINDOW_MS=500 (not too short)
- **Check**: Network not throttled in browser DevTools

---

## 📝 Quick Demo Script

**Perfect 2-minute demo**:

1. **Clean start**: Delete cache, restart server
2. **First run** (Hardware): "Watch the embedding call - slower, costs money"
3. **Second run** (Hardware): "Now instant - cached pattern, free!"
4. **New category** (Apparel): "Unknown pattern - API call again"
5. **Second run** (Apparel): "Cached now - instant again!"
6. **Restart server**: "Cache survives restart - still fast!"

---

## 🎓 What You're Demonstrating

### The Problem
Requests with semantically equivalent filters but different key names:
- `{category: "hardware"}` vs `{type: "hardware"}`
- Without AI: These would be treated as different
- Database: Would execute separate queries

### The Solution
AI-powered semantic matching:
1. **Deterministic scorer** flags as ambiguous (score 0.6)
2. **AI layer** evaluates with Cohere embeddings
3. **High similarity detected** (0.9+)
4. **Requests merged** with canonical filter
5. **Pattern cached** for instant future lookups
6. **Database**: Single query instead of two

### The Results
- ✅ 87-91% query reduction
- ✅ 6x faster for cached patterns
- ✅ Cost-effective (cache after first use)
- ✅ Persistent (survives restarts)

---

## 🚀 Ready to Test!

Open http://localhost:3100 and follow the scenarios above. Each scenario builds on the previous one to show the full AI caching workflow.

**Tip**: Keep Decision Logs open to see real-time AI decisions!
