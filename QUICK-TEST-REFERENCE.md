# ⚡ Quick Test Reference Card

## 🎯 Recommended Settings

```
UI Controls:
├─ Requests: 2         ← Perfect for AI triggering
├─ Page size: 12-15    ← Any value works
└─ Category: Hardware  ← Start with this
```

## 🧪 Essential Tests (5 minutes)

### Test 1: Cold Start ❄️
```
Category: Hardware → Run → Refresh
Expected:
✓ Embedding Calls: 1 (API called)
✓ Time: ~700-1500ms (slow)
✓ Cost: $0.0001
```

### Test 2: Warm Cache 🔥
```
Category: Hardware → Run → Refresh (same category!)
Expected:
✓ Embedding Calls: 1 (no change - cached!)
✓ Cache Hits: 1 (pattern cache used)
✓ Time: ~200-300ms (6x faster!)
✓ Cost: $0.0001 (no additional cost)
```

### Test 3: New Pattern 🆕
```
Category: Apparel → Run → Refresh (different category!)
Expected:
✓ Embedding Calls: 2 (new API call)
✓ Cache Misses: 2
✓ Time: ~700-1500ms (slow again)
```

### Test 4: Cached Pattern ✅
```
Category: Apparel → Run → Refresh (same as test 3)
Expected:
✓ Embedding Calls: 2 (no change - now cached!)
✓ Cache Hits: 2
✓ Time: ~200-300ms (fast!)
```

### Test 5: Restart Persistence 🔄
```
Stop server (Ctrl+C) → npm start → Open UI
Category: Hardware → Run → Refresh
Expected:
✓ Embedding Calls: 0 (cache survived restart!)
✓ Cache Hits: 1
✓ Time: ~200-300ms (still fast!)
```

## 📊 What to Look For

### Success Indicators ✅
- **First run**: Embedding call = 1, Time = 700-1500ms
- **Second run**: Embedding call stays same, Time = 200-300ms
- **Cache hits**: Increment with each cached pattern use
- **Decision logs**: Show "source: cache" for cached patterns

### Problem Indicators ❌
- **No cache hits**: Requests ≠ 2 or different categories
- **Stats at 0**: Forgot to click "Refresh" button
- **Always slow**: Cache not persisting (check file)
- **No logs**: Haven't run benchmark yet

## 🎭 Demo Flow

```
1. Show UI (all zeros)
2. Run Hardware benchmark
   → "See? API call, costs money, slow"
3. Run Hardware again
   → "Instant! Cached! Free!"
4. Run Apparel
   → "New pattern, API call again"
5. Run Apparel again
   → "Cached now!"
6. Restart server
7. Run Hardware
   → "Cache survived restart!"
```

## 🔑 Key Numbers

| Scenario | Embedding Calls | Time | Cost |
|----------|----------------|------|------|
| First use | 1 | ~1000ms | $0.0001 |
| Cached | 0 | ~250ms | $0 |
| **Speedup** | **- | **4x faster** | **100% saved** |

## 💡 Pro Tips

1. **Always click "Refresh"** after running benchmark
2. **Use Requests=2** for AI demonstration (pairs only)
3. **Same category twice** to show caching
4. **Different categories** to show API calls
5. **Check Decision Logs** to see AI reasoning
6. **Restart server** to prove persistence

## 🚨 Quick Fixes

**Stats won't update?**
→ Click the "Refresh" button!

**No cache hits?**
→ Use same category twice + Requests=2

**Always calling API?**
→ Check category name matches previous run

**No AI activity?**
→ Requests must be exactly 2

---

**Ready?** Open http://localhost:3100 and try Test 1! 🚀
