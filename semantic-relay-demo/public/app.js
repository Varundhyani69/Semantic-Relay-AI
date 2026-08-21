const requestCount = document.querySelector('#requestCount');
const pageSize = document.querySelector('#pageSize');
const category = document.querySelector('#category');
const runButton = document.querySelector('#runBenchmark');

const requestCountValue = document.querySelector('#requestCountValue');
const pageSizeValue = document.querySelector('#pageSizeValue');

const fields = {
  rawTime: document.querySelector('#rawTime'),
  rawCalls: document.querySelector('#rawCalls'),
  rawItems: document.querySelector('#rawItems'),
  batchTime: document.querySelector('#batchTime'),
  batchCalls: document.querySelector('#batchCalls'),
  batchSavedCalls: document.querySelector('#batchSavedCalls'),
  semanticBatchTime: document.querySelector('#semanticBatchTime'),
  semanticBatchCalls: document.querySelector('#semanticBatchCalls'),
  semanticBatchSavedCalls: document.querySelector('#semanticBatchSavedCalls'),
  relayTime: document.querySelector('#relayTime'),
  relayCalls: document.querySelector('#relayCalls'),
  relaySavedCalls: document.querySelector('#relaySavedCalls'),
  rawBar: document.querySelector('#rawBar'),
  batchBar: document.querySelector('#batchBar'),
  semanticBatchBar: document.querySelector('#semanticBatchBar'),
  relayBar: document.querySelector('#relayBar'),
  summaryText: document.querySelector('#summaryText'),
  pageStrip: document.querySelector('#pageStrip'),
  productGrid: document.querySelector('#productGrid')
};

function setText(node, value) {
  node.textContent = value;
}

function updateControlLabels() {
  setText(requestCountValue, requestCount.value);
  setText(pageSizeValue, pageSize.value);
  renderPageStrip(Number(requestCount.value));
}

function renderPageStrip(count) {
  fields.pageStrip.innerHTML = '';
  for (let page = 1; page <= count; page++) {
    const tile = document.createElement('div');
    tile.className = 'page-tile';
    tile.textContent = `P${page}`;
    fields.pageStrip.appendChild(tile);
  }
}

function renderProducts(items) {
  fields.productGrid.innerHTML = '';
  items.slice(0, 8).forEach((product) => {
    const card = document.createElement('article');
    card.className = 'product-card';
    card.innerHTML = `
      <div class="product-thumb"></div>
      <strong>${product.name}</strong>
      <span>${product.category} - $${product.price}</span>
      <span>Rating ${product.rating}</span>
    `;
    fields.productGrid.appendChild(card);
  });
}

function paintBars(rawMs, batchMs, semanticBatchMs, relayMs) {
  const max = Math.max(rawMs, batchMs, semanticBatchMs, relayMs, 1);
  fields.rawBar.style.width = `${Math.max(4, (rawMs / max) * 100)}%`;
  fields.batchBar.style.width = `${Math.max(4, (batchMs / max) * 100)}%`;
  fields.semanticBatchBar.style.width = `${Math.max(4, (semanticBatchMs / max) * 100)}%`;
  fields.relayBar.style.width = `${Math.max(4, (relayMs / max) * 100)}%`;
}

function resetUiForRun() {
  fields.rawTime.textContent = '...';
  fields.rawCalls.textContent = '...';
  fields.rawItems.textContent = '...';
  fields.batchTime.textContent = '...';
  fields.batchCalls.textContent = '...';
  fields.batchSavedCalls.textContent = '...';
  fields.semanticBatchTime.textContent = '...';
  fields.semanticBatchCalls.textContent = '...';
  fields.semanticBatchSavedCalls.textContent = '...';
  fields.relayTime.textContent = '...';
  fields.relayCalls.textContent = '...';
  fields.relaySavedCalls.textContent = '...';
  fields.rawBar.style.width = '0';
  fields.batchBar.style.width = '0';
  fields.semanticBatchBar.style.width = '0';
  fields.relayBar.style.width = '0';
  fields.productGrid.innerHTML = '';
  fields.summaryText.textContent = 'Server is running raw requests, transport batch, semantic batch, and normal requests through semantic-relay.';
}

async function runBenchmark() {
  runButton.disabled = true;
  resetUiForRun();

  const count = Number(requestCount.value);
  const limit = Number(pageSize.value);
  const selectedCategory = category.value;

  try {
    const params = new URLSearchParams({
      requests: String(count),
      limit: String(limit)
    });

    if (selectedCategory) params.set('category', selectedCategory);

    const result = await fetch(`/api/benchmark?${params.toString()}`, { cache: 'no-store' })
      .then((response) => response.json());

    fields.rawTime.textContent = `${result.raw.elapsedMs}ms`;
    fields.rawCalls.textContent = result.raw.calls;
    fields.rawItems.textContent = result.raw.items.length;

    fields.batchTime.textContent = `${result.batch.elapsedMs}ms`;
    fields.batchCalls.textContent = result.batch.calls;
    fields.batchSavedCalls.textContent = result.batchSavedCalls;

    fields.semanticBatchTime.textContent = `${result.semanticBatch.elapsedMs}ms`;
    fields.semanticBatchCalls.textContent = result.semanticBatch.calls;
    fields.semanticBatchSavedCalls.textContent = result.semanticBatchSavedCalls;

    fields.relayTime.textContent = `${result.relay.elapsedMs}ms`;
    fields.relayCalls.textContent = result.relay.calls;
    fields.relaySavedCalls.textContent = result.relaySavedCalls;
    paintBars(result.raw.elapsedMs, result.batch.elapsedMs, result.semanticBatch.elapsedMs, result.relay.elapsedMs);
    renderProducts(result.relay.items);

    const groupWord = result.metrics.relayDemo.aggregateGroups === 1 ? 'batch' : 'batches';
    const directFetches = result.metrics.semanticRelay.directGroupedFetches || 0;
    const guardrails = result.metrics.semanticRelay.guardrailSplits || result.metrics.semanticRelay.guardrailFallbacks
      ? ` Guardrails split ${result.metrics.semanticRelay.guardrailSplits} group(s) and fell back ${result.metrics.semanticRelay.guardrailFallbacks} request(s).`
      : ' Guardrails allowed the grouped fetch.';
    const cacheText = result.metrics.semanticRelay.cacheHits
      ? ` Cache hits: ${result.metrics.semanticRelay.cacheHits}.`
      : '';
    const batchCorrectness = result.sameBatchItems ? 'Transport batch matched raw item IDs.' : 'Transport batch item IDs did not match raw.';
    const semanticBatchCorrectness = result.sameSemanticBatchItems ? 'Semantic batch matched raw item IDs.' : 'Semantic batch item IDs did not match raw.';
    const relayCorrectness = result.sameRelayItems ? 'semantic-relay matched raw item IDs.' : 'semantic-relay item IDs did not match raw.';

    fields.summaryText.textContent =
      `Raw Express used ${result.raw.calls} DB calls. Transport Batch API used ${result.batch.calls}. Semantic Batch used ${result.semanticBatch.calls}. Transparent semantic-relay used ${result.relay.calls}, grouping ${result.metrics.relayDemo.aggregatedRequests} normal GET requests into ${result.metrics.relayDemo.aggregateGroups} ${groupWord} with ${directFetches} direct grouped fetch. ${guardrails}${cacheText} Semantic Batch finished ${result.semanticBatchFasterByMs}ms faster than raw; transparent relay finished ${result.relayFasterByMs}ms faster than raw. ${batchCorrectness} ${semanticBatchCorrectness} ${relayCorrectness}`;
  } catch (error) {
    fields.summaryText.textContent = `Benchmark failed: ${error.message}`;
  } finally {
    runButton.disabled = false;
  }
}

requestCount.addEventListener('input', updateControlLabels);
pageSize.addEventListener('input', updateControlLabels);
runButton.addEventListener('click', runBenchmark);

updateControlLabels();

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
