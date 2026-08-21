# Anirudh — Implementation Brief
## Branch: feat/anirudh-demo
## Working directory: semantic-relay-demo/
## Files to modify (additions only): server.js, public/index.html, public/app.js
## Files to NOT touch: anything inside semantic-relay/src/, semantic-relay/test/

---

## Project Context

You are working on the demo server for `semantic-relay`, an Express middleware that
groups similar API requests and reduces backend DB calls.

The project is being upgraded with an AI layer (Cohere embeddings + Gemini reasoning).
Your job is to extend the existing demo server and UI to show what the AI layer is doing.

You do NOT need to implement any AI code. You only need to:
1. Add a circular buffer and endpoint to the demo server that captures AI decisions
2. Add an AI panel to the existing benchmark UI that shows those decisions live

The AI decisions data will come from the middleware's `getMetrics()` and a new
`/api/ai-decisions` endpoint you will create. When the full AI layer is wired up by
Varun, your panel will automatically show live data.

---

## Understanding the existing codebase

The demo server (`server.js`) already has:
- A `relayMiddleware` instance created with `semanticRelay({ ... })`
- `onAggregate(group)` callback — fires when requests are grouped
- `onFallback()` callback — fires when a request is not grouped
- `GET /api/metrics` endpoint — returns `relayMiddleware.getMetrics()`
- `GET /api/benchmark` endpoint — runs a full comparison scenario

The existing UI (`public/app.js`) already:
- Runs the benchmark and displays results in `.scoreboard`
- Shows Raw / Batch / Semantic Batch / Relay panels

You are ADDING to these files. Do not remove or modify anything that already exists.

---

## Task 1 — Add AI decision log to server.js

Add the following block AFTER the existing `relayMiddleware` definition and BEFORE
the `app.use(express.static(...))` line. Do not modify anything above or below.

```js
// ─── AI Decision Log ──────────────────────────────────────────────────────────
const aiDecisionLog = [];
const AI_DECISION_LOG_MAX = 50;

/**
 * Record one AI planner decision into the circular buffer.
 * Called by the planner callback once Varun wires it up.
 * Safe to call with any object shape — it just stores what it gets.
 */
function recordAiDecision(decision) {
  aiDecisionLog.unshift({
    timestamp: Date.now(),
    resourceA: decision.resourceA || '',
    resourceB: decision.resourceB || '',
    filtersA: decision.filtersA || {},
    filtersB: decision.filtersB || {},
    cohereScore: typeof decision.cohereScore === 'number' ? decision.cohereScore : null,
    geminiUsed: decision.geminiUsed === true,
    geminiConfidence: typeof decision.geminiConfidence === 'number' ? decision.geminiConfidence : null,
    validatorApproved: decision.validatorApproved === true,
    mergeExecuted: decision.mergeExecuted === true,
    latencyMs: typeof decision.latencyMs === 'number' ? decision.latencyMs : 0
  });
  if (aiDecisionLog.length > AI_DECISION_LOG_MAX) {
    aiDecisionLog.pop();
  }
}

// Expose recordAiDecision so Varun can wire it from the planner callback
// Usage: relayMiddleware.onAiDecision = recordAiDecision;
relayMiddleware.onAiDecision = recordAiDecision;
// ─────────────────────────────────────────────────────────────────────────────
```

Then add this endpoint AFTER the existing `/api/metrics` endpoint:

```js
app.get('/api/ai-decisions', (req, res) => {
  res.json({
    decisions: aiDecisionLog,
    summary: relayMiddleware.getMetrics()
  });
});
```

---

## Task 2 — Add AI panel to public/index.html

Add the following section BETWEEN the `.scoreboard` section and the `.insights` section.
Find the closing `</section>` of the scoreboard and paste this immediately after it:

```html
<!-- AI Layer Panel -->
<section class="ai-panel" aria-label="AI layer status">
  <div class="panel-header">
    <h2>AI Layer</h2>
    <span id="aiStatusBadge" class="badge badge-ai">-</span>
  </div>

  <div class="ai-stats">
    <div class="ai-stat">
      <span>AI invocations</span>
      <strong id="aiInvocations">-</strong>
    </div>
    <div class="ai-stat">
      <span>Validator rejects</span>
      <strong id="validatorRejects">-</strong>
    </div>
    <div class="ai-stat">
      <span>Cache hits</span>
      <strong id="patternCacheHits">-</strong>
    </div>
    <div class="ai-stat">
      <span>Avg embed</span>
      <strong id="avgEmbeddingMs">-</strong>
    </div>
    <div class="ai-stat">
      <span>Avg reason</span>
      <strong id="avgReasoningMs">-</strong>
    </div>
    <div class="ai-stat">
      <span>Est. cost</span>
      <strong id="estimatedCost">-</strong>
    </div>
  </div>

  <div class="decision-log-header">
    <h3>Last AI Decisions</h3>
    <button id="refreshDecisions" type="button">Refresh</button>
  </div>
  <div id="aiDecisionLog" class="decision-log" aria-live="polite">
    <p class="decision-empty">No AI decisions recorded yet. Run the benchmark first.</p>
  </div>
</section>
```

---

## Task 3 — Add AI panel logic to public/app.js

Add the following block at the END of the existing app.js file.
Do not modify anything above.

```js
// ─── AI Decisions Panel ────────────────────────────────────────────────────────

const aiPanelFields = {
  aiStatusBadge:    document.querySelector('#aiStatusBadge'),
  aiInvocations:    document.querySelector('#aiInvocations'),
  validatorRejects: document.querySelector('#validatorRejects'),
  patternCacheHits: document.querySelector('#patternCacheHits'),
  avgEmbeddingMs:   document.querySelector('#avgEmbeddingMs'),
  avgReasoningMs:   document.querySelector('#avgReasoningMs'),
  estimatedCost:    document.querySelector('#estimatedCost'),
  aiDecisionLog:    document.querySelector('#aiDecisionLog'),
  refreshDecisions: document.querySelector('#refreshDecisions')
};

function renderAiDecisionRow(d) {
  const row = document.createElement('div');
  row.className = 'decision-row';

  const time = new Date(d.timestamp).toLocaleTimeString();
  const cohere = d.cohereScore !== null ? d.cohereScore.toFixed(3) : 'n/a';
  const gemini = d.geminiUsed
    ? `Gemini ${d.geminiConfidence !== null ? d.geminiConfidence.toFixed(2) : '?'}`
    : 'embed only';
  const outcome = d.mergeExecuted
    ? '<span class="outcome merged">MERGED</span>'
    : '<span class="outcome split">SPLIT</span>';
  const validator = d.validatorApproved
    ? '<span class="validator approved">✓ validator</span>'
    : '<span class="validator rejected">✗ validator</span>';

  row.innerHTML = `
    <span class="d-time">${time}</span>
    <span class="d-resource">${d.resourceA || '-'}</span>
    <span class="d-cohere">Cohere: ${cohere}</span>
    <span class="d-gemini">${gemini}</span>
    ${validator}
    ${outcome}
    <span class="d-latency">${d.latencyMs}ms</span>
  `;
  return row;
}

async function fetchAndRenderAiDecisions() {
  try {
    const data = await fetch('/api/ai-decisions', { cache: 'no-store' }).then(r => r.json());
    const m = data.summary || {};

    // Update stats
    const status = m.aiStatus || 'disabled';
    if (aiPanelFields.aiStatusBadge) {
      aiPanelFields.aiStatusBadge.textContent = status;
      aiPanelFields.aiStatusBadge.className = `badge badge-ai badge-${status}`;
    }
    if (aiPanelFields.aiInvocations)    aiPanelFields.aiInvocations.textContent    = m.aiInvocations    ?? '-';
    if (aiPanelFields.validatorRejects) aiPanelFields.validatorRejects.textContent = m.validatorRejects  ?? '-';
    if (aiPanelFields.patternCacheHits) aiPanelFields.patternCacheHits.textContent = m.patternCacheHits  ?? '-';
    if (aiPanelFields.avgEmbeddingMs)   aiPanelFields.avgEmbeddingMs.textContent   = m.avgEmbeddingMs    ? `${Math.round(m.avgEmbeddingMs)}ms` : '-';
    if (aiPanelFields.avgReasoningMs)   aiPanelFields.avgReasoningMs.textContent   = m.avgReasoningMs    ? `${Math.round(m.avgReasoningMs)}ms` : '-';
    if (aiPanelFields.estimatedCost)    aiPanelFields.estimatedCost.textContent    = m.estimatedCostUsd  != null ? `$${m.estimatedCostUsd.toFixed(5)}` : '$0.00000';

    // Render decision rows
    if (aiPanelFields.aiDecisionLog) {
      if (!data.decisions || data.decisions.length === 0) {
        aiPanelFields.aiDecisionLog.innerHTML =
          '<p class="decision-empty">No AI decisions recorded yet. Run the benchmark first.</p>';
      } else {
        aiPanelFields.aiDecisionLog.innerHTML = '';
        data.decisions.forEach(d => {
          aiPanelFields.aiDecisionLog.appendChild(renderAiDecisionRow(d));
        });
      }
    }
  } catch (err) {
    if (aiPanelFields.aiDecisionLog) {
      aiPanelFields.aiDecisionLog.innerHTML =
        `<p class="decision-empty">Could not load AI decisions: ${err.message}</p>`;
    }
  }
}

// Wire up refresh button
if (aiPanelFields.refreshDecisions) {
  aiPanelFields.refreshDecisions.addEventListener('click', fetchAndRenderAiDecisions);
}

// Auto-refresh every 5 seconds
setInterval(fetchAndRenderAiDecisions, 5000);

// Initial fetch
fetchAndRenderAiDecisions();
// ──────────────────────────────────────────────────────────────────────────────
```

---

## Task 4 — Add styles to public/styles.css

Add these styles at the END of the existing styles.css file:

```css
/* ── AI Panel ─────────────────────────────────────────────────────────────── */
.ai-panel {
  margin: 2rem 0;
  padding: 1.5rem;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.panel-header h2 { margin: 0; }

.badge-ai { font-size: 0.75rem; padding: 0.2rem 0.5rem; border-radius: 4px; }
.badge-active   { background: #d1fae5; color: #065f46; }
.badge-degraded { background: #fef3c7; color: #92400e; }
.badge-disabled { background: #f1f5f9; color: #64748b; }

.ai-stats {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.ai-stat { display: flex; flex-direction: column; gap: 0.2rem; }
.ai-stat span { font-size: 0.75rem; color: #64748b; }
.ai-stat strong { font-size: 1rem; }

.decision-log-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

.decision-log-header h3 { margin: 0; font-size: 0.9rem; }

.decision-log {
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  font-size: 0.8rem;
  font-family: monospace;
}

.decision-row {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid #f1f5f9;
  flex-wrap: wrap;
}

.decision-row:last-child { border-bottom: none; }
.decision-row:nth-child(even) { background: #f8fafc; }

.d-time     { color: #94a3b8; min-width: 70px; }
.d-resource { color: #334155; min-width: 120px; font-weight: 500; }
.d-cohere   { color: #6366f1; }
.d-gemini   { color: #8b5cf6; }
.d-latency  { color: #94a3b8; margin-left: auto; }

.outcome        { padding: 0.15rem 0.4rem; border-radius: 3px; font-weight: 600; }
.outcome.merged { background: #d1fae5; color: #065f46; }
.outcome.split  { background: #fee2e2; color: #991b1b; }

.validator          { font-size: 0.75rem; }
.validator.approved { color: #059669; }
.validator.rejected { color: #dc2626; }

.decision-empty { padding: 1rem; color: #94a3b8; text-align: center; margin: 0; }
```

---

## How to verify your work before opening a PR

1. Start the demo server:
```bash
cd e:\Sementic-relay\semantic-relay-demo
npm start
```

2. Open http://localhost:3100

3. Verify:
   - The AI Layer section appears below the scoreboard
   - The stats show `-` (expected — AI not wired yet)
   - Clicking "Refresh" calls `/api/ai-decisions` without errors (check browser console)
   - Running the benchmark still works (existing panels still show data)
   - `/api/ai-decisions` returns `{ decisions: [], summary: { ... } }` in the browser

4. Test the endpoint directly:
```bash
curl http://localhost:3100/api/ai-decisions
```
Should return JSON with `decisions` array and `summary` object.

---

## Notes

- Do NOT add any npm packages. Use only what is already in package.json.
- Do NOT modify any files in semantic-relay/ (the npm package folder).
- The `recordAiDecision` function and `relayMiddleware.onAiDecision` hook are
  intentionally no-ops until Varun merges the planner. Your code works independently.
- Keep existing benchmark functionality 100% intact. Only add new things.

---

## Git workflow — exactly 3 commits

### Setup (run once)
```bash
git clone https://github.com/Varundhyani69/Semantic-Relay.git
cd Semantic-Relay
git checkout -b feat/anirudh-demo
```

---

### Commit 1 — Demo server endpoint

Make ONLY the server.js changes from Task 1 of this brief:
- Add `aiDecisionLog` circular buffer
- Add `recordAiDecision()` function
- Attach `relayMiddleware.onAiDecision = recordAiDecision`
- Add `GET /api/ai-decisions` endpoint

Verify before committing:
```bash
cd semantic-relay-demo
npm start
# In another terminal:
curl http://localhost:3100/api/ai-decisions
# Must return: {"decisions":[],"summary":{...}}
# Ctrl+C to stop server
```

Commit:
```bash
git add semantic-relay-demo/server.js
git commit -m "feat(demo): add AI decisions circular buffer and /api/ai-decisions endpoint

- Maintains in-memory buffer of last 50 AI planner decisions
- Each record: timestamp, resourceA/B, filtersA/B, cohereScore,
  geminiUsed, geminiConfidence, validatorApproved, mergeExecuted, latencyMs
- GET /api/ai-decisions returns decisions array + full getMetrics() summary
- relayMiddleware.onAiDecision hook ready for Varun to wire the planner"
```

---

### Commit 2 — UI panel HTML + CSS

Make the changes from Task 2 and Task 4 of this brief:
- Add AI panel section to `public/index.html`
- Add AI panel styles to `public/styles.css`

Verify before committing:
```bash
cd semantic-relay-demo
npm start
# Open http://localhost:3100
# Verify AI Layer section appears below the scoreboard
# Stats should show "-" (expected — AI not wired yet)
# Section should be visible and styled correctly
```

Commit:
```bash
git add semantic-relay-demo/public/index.html semantic-relay-demo/public/styles.css
git commit -m "feat(demo): add AI Layer panel to benchmark UI

- Panel appears below scoreboard with 6 stat fields:
  AI invocations, validator rejects, cache hits,
  avg embed ms, avg reason ms, estimated cost
- Decision log area with live:polite aria attribute
- Refresh button for manual update
- Status badge with active/degraded/disabled colour coding
- Styled decision rows showing Cohere score, Gemini confidence,
  validator result, merge/split outcome, latency"
```

---

### Commit 3 — UI panel JavaScript + PR

Make the changes from Task 3 of this brief:
- Add AI panel fetch + render logic to `public/app.js`

Verify before committing:
```bash
cd semantic-relay-demo
npm start
# Open http://localhost:3100
# Open browser devtools → Network tab
# Run the existing benchmark — it must still work completely
# Check /api/ai-decisions is fetched every 5 seconds (Network tab)
# Click Refresh button — must not show any console errors
# Verify existing benchmark panels (Raw/Batch/Relay) are unaffected
```

Commit:
```bash
git add semantic-relay-demo/public/app.js
git commit -m "feat(demo): add AI decisions panel fetch and auto-refresh logic

- Fetches /api/ai-decisions on load and every 5 seconds
- Renders decision rows: time, resource, Cohere score, Gemini label,
  validator tick/cross, MERGED/SPLIT badge, latency
- Updates all 6 stat fields from getMetrics() summary
- Refresh button for manual trigger
- Handles fetch errors gracefully (shows error message in log area)
- Does not modify any existing benchmark code"
```

Then push and open PR:
```bash
git push -u origin feat/anirudh-demo
```

Go to https://github.com/Varundhyani69/Semantic-Relay and open a Pull Request:
- Base: `main`
- Compare: `feat/anirudh-demo`
- Title: `feat: AI decisions UI panel and endpoint (Anirudh)`
- Fill in the PR template checklist

Key thing to confirm in the PR description:
"Existing benchmark (Raw/Batch/Relay panels) works unchanged. AI panel shows empty state gracefully when no decisions recorded."
