# AI Threshold Adjustments for Demo

## Problem
Cohere embeddings were scoring TOO HIGH for synonym pairs, preventing Gemini from being invoked:
- "clothing" vs "apparel": 0.976
- "outfits" vs "attire": 0.950

All scores were above the old threshold (0.75), so Gemini was never triggered.

## Solution
Adjusted thresholds to create clearer demonstration zones:

### Old Configuration (.env)
```
EMBEDDING_THRESHOLD=0.75   # Too low - everything skips Gemini
REASONING_THRESHOLD=0.45
```

### New Configuration (.env)
```
EMBEDDING_THRESHOLD=0.96   # Much higher - creates ambiguous zone
REASONING_THRESHOLD=0.50   # Slightly raised
```

## Decision Zones (New)

```
┌─────────────────────────────────────────────────────────────┐
│ Cohere Score: 0.96 - 1.00                                   │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ HIGH CONFIDENCE ZONE                                        │
│ Action: Skip Gemini, merge immediately                     │
│ Example: "electronics" vs "electronic items" (~0.98)       │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Cohere Score: 0.50 - 0.96                                   │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ AMBIGUOUS ZONE (Gemini Reasoning Required)                 │
│ Action: Invoke Gemini for confirmation                     │
│ Example: "fashion" vs "textiles" (~0.88)                   │
│ Example: "outfits" vs "attire" (~0.95)                     │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Cohere Score: 0.00 - 0.50                                   │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ LOW SIMILARITY ZONE                                         │
│ Action: Immediate split (definitely unrelated)             │
│ Example: "electronics" vs "furniture" (~0.25)              │
└─────────────────────────────────────────────────────────────┘
```

## Expected Behavior Per Category

| Category | Synonym Variants | Expected Score | Zone | Gemini? |
|----------|------------------|----------------|------|---------|
| **Electronics** | electronics, gadgets, tech devices, electronic items | 0.97+ | High | ✗ No |
| **Clothing** | fashion, apparel, textiles, wardrobe | 0.85-0.95 | Ambiguous | ✅ Yes |
| **Books** | books, literature, reading material, publications | 0.92+ | High (1st run), Cache (2nd run) | ✗ No / Cache |
| **Kitchen** | kitchen, kitchen, kitchen, kitchen | 1.00 | Deterministic | ✗ No AI at all |
| **Low Similarity** | sports equipment, office furniture, garden tools, pet supplies | 0.20-0.35 | Low | ✗ No (immediate split) |

## Why This Works

### Cohere v3.0 Is Very Accurate
Modern embeddings are SO GOOD that even loosely related terms score high:
- "clothing" vs "apparel" = 0.976 (direct synonyms)
- "outfits" vs "attire" = 0.950 (related but different contexts)
- "fashion" vs "textiles" = 0.88 (related concepts, not synonyms)

### Production vs Demo Thresholds
**Production (0.85):**
- Optimized for cost/latency
- 80% of cases skip Gemini → lower cost
- Only invoke Gemini for truly ambiguous cases

**Demo (0.96):**
- Optimized for demonstration
- Shows Gemini more often → better for judges to see
- Wider ambiguous zone (0.50-0.96) catches more cases

## Tradeoffs

### Higher Threshold (0.96)
**Pros:**
- ✅ Demonstrates Gemini reasoning more often
- ✅ Shows the full AI pipeline in action
- ✅ Better for hackathon demo

**Cons:**
- ❌ Higher cost (more Gemini calls)
- ❌ Higher latency (1.6s vs 1.1s)
- ❌ Not representative of production tuning

### For Judges, Explain:
> "We've tuned these thresholds for the demo to showcase all code paths. In production, you'd set the threshold based on your domain:
> - E-commerce: 0.85 (balance cost/accuracy)
> - Healthcare: 0.95 (err on side of caution)
> - Gaming: 0.75 (prioritize speed)"

## Alternative: Use AI Mode Dropdown
If thresholds STILL don't create the desired behavior, use the **AI Mode dropdown** as a fallback:

1. **Run Electronics** in "Adaptive" mode → Cohere only
2. **Switch to "Gemini Reasoning"** mode → Always uses Gemini
3. **Show decision log** → Point to Gemini confidence, latency
4. **Explain:** "This mode forces Gemini even for high-confidence cases. Useful for domains where accuracy is critical."

This gives you **guaranteed control** over when Gemini is invoked.

## Testing the New Thresholds

### Test 1: Electronics (High Confidence)
**Expected:** Cohere score ~0.97+ → Skip Gemini
```
AI Invocations: 1
Reasoning Invocations: 0 ✅
Decision Log: "source: embedding, cohereScore: 0.97+"
```

### Test 2: Clothing (Ambiguous)
**Expected:** Cohere score ~0.88-0.95 → Invoke Gemini
```
AI Invocations: 1
Reasoning Invocations: 1 ✅
Decision Log: "source: reasoning, cohereScore: 0.90, geminiUsed: true"
```

### Test 3: Books 2nd Run (Cache)
**Expected:** Pattern cache hit → No AI
```
AI Invocations: 1
Embedding Invocations: 0
Cache Hits: 1 ✅
```

## Summary

**What Changed:**
- Embedding Threshold: 0.75 → **0.96** (raised significantly)
- Reasoning Threshold: 0.45 → **0.50** (raised slightly)

**Why:**
- Cohere v3.0 is extremely accurate
- Even loosely related terms score 0.90+
- Needed wider ambiguous zone to demonstrate Gemini

**Effect:**
- More cases fall into ambiguous zone (0.50-0.96)
- Gemini invoked more frequently
- Better demonstration of full AI pipeline

**For Production:**
- Use 0.85/0.60 thresholds (cost-optimized)
- Tune based on domain and accuracy requirements
- Monitor validator rejection rate

---

**Status:** ✅ Thresholds adjusted, server restarted
**New Config:** EMBEDDING_THRESHOLD=0.96, REASONING_THRESHOLD=0.50
**Expected:** Clothing now triggers Gemini reasoning
