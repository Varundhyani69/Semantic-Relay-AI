const requestCount = document.querySelector('#requestCount');
const pageSize = document.querySelector('#pageSize');
const category = document.querySelector('#category');
const runButton = document.querySelector('#runBenchmark');

const requestCountValue = document.querySelector('#requestCountValue');
const pageSizeValue = document.querySelector('#pageSizeValue');

const fields = {
  naiveCalls: document.querySelector('#naiveCalls'),
  naiveTime: document.querySelector('#naiveTime'),
  relayCalls: document.querySelector('#relayCalls'),
  relayTime: document.querySelector('#relayTime'),
  reductionPercent: document.querySelector('#reductionPercent'),
  timeSaved: document.querySelector('#timeSaved'),
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

function resetUiForRun() {
  fields.naiveTime.textContent = '...';
  fields.relayTime.textContent = '...';
  fields.naiveCalls.textContent = '...';
  fields.relayCalls.textContent = '...';
  fields.reductionPercent.textContent = '...';
  fields.timeSaved.textContent = '...';
  fields.productGrid.innerHTML = '';
  fields.summaryText.textContent = 'Running comparison of historical approaches vs semantic-relay-ai...';
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

    // Update comparison table
    fields.naiveCalls.textContent = result.raw.calls;
    fields.naiveTime.textContent = `${result.raw.elapsedMs}ms`;
    fields.relayCalls.textContent = result.relay.calls;
    fields.relayTime.textContent = `${result.relay.elapsedMs}ms`;

    const reduction = ((result.raw.calls - result.relay.calls) / result.raw.calls) * 100;
    fields.reductionPercent.textContent = `${Math.round(reduction)}%`;

    const timeSavedMs = result.raw.elapsedMs - result.relay.elapsedMs;
    fields.timeSaved.textContent = `${timeSavedMs}ms`;

    renderProducts(result.relay.items);

    // Show synonym detection info if available
    const synonymInfo = document.querySelector('#synonymInfo');
    const synonymList = document.querySelector('#synonymList');
    if (result.synonymVariants && result.synonymVariants.length > 1) {
      synonymList.textContent = result.synonymVariants.join(', ');
      synonymInfo.classList.remove('hidden');
    } else {
      synonymInfo.classList.add('hidden');
    }

    const relayCorrectness = result.sameRelayItems ? 'semantic-relay-ai matched naive item IDs.' : 'semantic-relay-ai item IDs did not match naive.';
    const aiInvocations = result.metrics.semanticRelay.aiInvocations || 0;
    const embeddingInvocations = result.metrics.semanticRelay.embeddingInvocations || 0;
    const reasoningInvocations = result.metrics.semanticRelay.reasoningInvocations || 0;

    fields.summaryText.textContent =
      `Naive exact matching: ${result.raw.calls} DB calls in ${result.raw.elapsedMs}ms. semantic-relay-ai: ${result.relay.calls} DB calls in ${result.relay.elapsedMs}ms (${Math.round(reduction)}% reduction). AI invoked ${aiInvocations} times (${embeddingInvocations} embeddings, ${reasoningInvocations} reasoning). ${relayCorrectness}`;

    // Refresh AI metrics
    await fetchAndRenderAiDecisions();
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
  aiStatusBadge: document.querySelector('#aiStatusBadge'),
  aiInvocations: document.querySelector('#aiInvocations'),
  validatorRejects: document.querySelector('#validatorRejects'),
  patternCacheHits: document.querySelector('#patternCacheHits'),
  avgEmbeddingMs: document.querySelector('#avgEmbeddingMs'),
  avgReasoningMs: document.querySelector('#avgReasoningMs'),
  estimatedCost: document.querySelector('#estimatedCost'),
  aiDecisionLog: document.querySelector('#aiDecisionLog'),
  refreshDecisions: document.querySelector('#refreshDecisions'),
  viewDecisionLogs: document.querySelector('#viewDecisionLogs'),
  aiModeSelect: document.querySelector('#aiModeSelect'),
  clearCacheButton: document.querySelector('#clearCache')
};

const modalElements = {
  modal: document.querySelector('#logModal'),
  closeButton: document.querySelector('#closeModal'),
  logContent: document.querySelector('#modalLogContent')
};

function renderAiDecisionRow(d) {
  const row = document.createElement('div');
  row.className = 'decision-row';

  const time = new Date(d.timestamp).toLocaleTimeString();

  // Show filter values for better debugging
  const filterA = d.filtersA && d.filtersA.category ? d.filtersA.category : '-';
  const filterB = d.filtersB && d.filtersB.category ? d.filtersB.category : '-';

  // Cohere score or reason for n/a
  let cohereText = 'n/a';
  if (d.cohereScore !== null && d.cohereScore !== undefined) {
    cohereText = d.cohereScore.toFixed(3);
  } else if (d.validatorApproved && d.mergeExecuted) {
    cohereText = '<span style="color: #10b981; font-weight: 600;">✓ cached</span>';  // From pattern cache
  } else {
    cohereText = '<span style="color: #94a3b8;">skipped</span>';  // Deterministic or split
  }

  // Gemini usage
  const geminiUsedBadge = d.geminiUsed
    ? '<span class="gemini-used yes">Gemini ✓</span>'
    : '<span class="gemini-used no">Gemini ✗</span>';
  const geminiConfText = d.geminiConfidence !== null ? ` (${d.geminiConfidence.toFixed(2)})` : '';

  const outcome = d.mergeExecuted
    ? '<span class="outcome merged">MERGED</span>'
    : '<span class="outcome split">SPLIT</span>';
  const validator = d.validatorApproved
    ? '<span class="validator approved">✓ validator</span>'
    : '<span class="validator rejected">✗ validator</span>';

  row.innerHTML = `
    <span class="d-time">${time}</span>
    <span class="d-filters">${filterA} vs ${filterB}</span>
    <span class="d-cohere">Cohere: ${cohereText}</span>
    ${geminiUsedBadge}${geminiConfText}
    ${validator}
    ${outcome}
    <span class="d-latency">${d.latencyMs}ms</span>
  `;
  return row;
}

function renderLogEntry(entry) {
  const line = document.createElement('div');
  line.className = `log-entry log-${entry.type}`;

  const time = new Date(entry.timestamp).toLocaleTimeString();
  const typeLabel = entry.type.toUpperCase().padEnd(20);

  let details = '';
  switch (entry.type) {
    case 'solo':
      details = `reason=${entry.reason} resource=${entry.resource} filters=${JSON.stringify(entry.filters)}`;
      break;
    case 'deterministic-check':
      details = `score=${entry.score?.toFixed(3)} threshold=${entry.threshold} willTriggerAI=${entry.willTriggerAI}`;
      break;
    case 'ai-trigger':
      details = `deterministicScore=${entry.deterministicScore?.toFixed(3)} filtersA=${JSON.stringify(entry.filtersA)} filtersB=${JSON.stringify(entry.filtersB)}`;
      break;
    case 'ai-result':
      details = `decision=${entry.decision} confidence=${entry.confidence?.toFixed(3)} source=${entry.source} latency=${entry.latencyMs}ms`;
      break;
    case 'ai-split':
      details = `resource=${entry.resource}`;
      break;
    case 'deterministic-handled':
      details = `outcome=${entry.outcome} score=${entry.score?.toFixed(3)}`;
      break;
    case 'ai-error':
      details = `error=${entry.error}`;
      break;
    default:
      details = JSON.stringify(entry);
  }

  line.textContent = `[${time}] ${typeLabel} ${details}`;
  return line;
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
    if (aiPanelFields.aiInvocations) aiPanelFields.aiInvocations.textContent = m.aiInvocations ?? '-';
    if (aiPanelFields.validatorRejects) aiPanelFields.validatorRejects.textContent = m.validatorRejects ?? '-';
    if (aiPanelFields.patternCacheHits) aiPanelFields.patternCacheHits.textContent = m.patternCacheHits ?? '-';
    if (aiPanelFields.avgEmbeddingMs) aiPanelFields.avgEmbeddingMs.textContent = m.avgEmbeddingMs ? `${Math.round(m.avgEmbeddingMs)}ms` : '-';
    if (aiPanelFields.avgReasoningMs) aiPanelFields.avgReasoningMs.textContent = m.avgReasoningMs ? `${Math.round(m.avgReasoningMs)}ms` : '-';
    if (aiPanelFields.estimatedCost) aiPanelFields.estimatedCost.textContent = m.estimatedCostUsd != null ? `$${m.estimatedCostUsd.toFixed(5)}` : '$0.00000';

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

async function openDecisionLogModal() {
  try {
    const data = await fetch('/api/decision-logs', { cache: 'no-store' }).then(r => r.json());

    if (modalElements.logContent) {
      modalElements.logContent.innerHTML = '';

      if (!data.logs || data.logs.length === 0) {
        modalElements.logContent.innerHTML = '<p class="log-empty">No decision logs available.</p>';
      } else {
        data.logs.forEach(entry => {
          modalElements.logContent.appendChild(renderLogEntry(entry));
        });
      }
    }

    if (modalElements.modal) {
      modalElements.modal.classList.remove('hidden');
    }
  } catch (err) {
    if (modalElements.logContent) {
      modalElements.logContent.innerHTML = `<p class="log-empty">Error loading logs: ${err.message}</p>`;
    }
  }
}

function closeModal() {
  if (modalElements.modal) {
    modalElements.modal.classList.add('hidden');
  }
}

// Wire up refresh button
if (aiPanelFields.refreshDecisions) {
  aiPanelFields.refreshDecisions.addEventListener('click', fetchAndRenderAiDecisions);
}

// Wire up view logs button
if (aiPanelFields.viewDecisionLogs) {
  aiPanelFields.viewDecisionLogs.addEventListener('click', openDecisionLogModal);
}

// Wire up modal close button
if (modalElements.closeButton) {
  modalElements.closeButton.addEventListener('click', closeModal);
}

// Close modal when clicking outside
if (modalElements.modal) {
  modalElements.modal.addEventListener('click', (e) => {
    if (e.target === modalElements.modal) {
      closeModal();
    }
  });
}

// Auto-refresh every 5 seconds
setInterval(fetchAndRenderAiDecisions, 5000);

// Initial fetch
fetchAndRenderAiDecisions();

// Load current AI mode on page load
async function loadCurrentAiMode() {
  try {
    const response = await fetch('/api/ai-mode', { cache: 'no-store' });
    const data = await response.json();
    if (aiPanelFields.aiModeSelect && data.mode) {
      aiPanelFields.aiModeSelect.value = data.mode;
    }
  } catch (err) {
    console.error('Failed to load AI mode:', err);
  }
}

loadCurrentAiMode();

// Handle AI mode change
if (aiPanelFields.aiModeSelect) {
  aiPanelFields.aiModeSelect.addEventListener('change', async (e) => {
    const newMode = e.target.value;
    try {
      const response = await fetch('/api/ai-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: newMode })
      });
      const data = await response.json();

      if (data.ok) {
        console.log(`✅ AI mode changed to: ${newMode}`);
        // Show notification
        const oldSummary = fields.summaryText.textContent;
        fields.summaryText.textContent = `✅ AI mode changed to: ${newMode}`;
        fields.summaryText.style.color = '#059669';
        setTimeout(() => {
          fields.summaryText.textContent = oldSummary;
          fields.summaryText.style.color = '';
        }, 2000);

        // Refresh AI metrics to reflect new mode
        await fetchAndRenderAiDecisions();
      } else {
        console.error('Failed to change AI mode:', data.error || data.message);
        fields.summaryText.textContent = `❌ Failed to change mode: ${data.error || data.message}`;
        fields.summaryText.style.color = '#dc2626';
      }
    } catch (err) {
      console.error('Error changing AI mode:', err);
      fields.summaryText.textContent = `❌ Error changing mode: ${err.message}`;
      fields.summaryText.style.color = '#dc2626';
    }
  });
}

// Handle clear cache button
if (aiPanelFields.clearCacheButton) {
  aiPanelFields.clearCacheButton.addEventListener('click', async () => {
    try {
      aiPanelFields.clearCacheButton.disabled = true;
      aiPanelFields.clearCacheButton.textContent = 'Clearing...';

      const response = await fetch('/api/clear-cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await response.json();

      if (data.ok) {
        console.log('✅ Pattern cache cleared');
        // Show notification
        const oldSummary = fields.summaryText.textContent;
        fields.summaryText.textContent = '✅ Pattern cache cleared successfully';
        fields.summaryText.style.color = '#059669';
        setTimeout(() => {
          fields.summaryText.textContent = oldSummary;
          fields.summaryText.style.color = '';
        }, 2000);

        // Refresh AI metrics
        await fetchAndRenderAiDecisions();
      } else {
        console.error('Failed to clear cache:', data.error || data.message);
        fields.summaryText.textContent = `❌ Failed to clear cache: ${data.error || data.message}`;
        fields.summaryText.style.color = '#dc2626';
      }
    } catch (err) {
      console.error('Error clearing cache:', err);
      fields.summaryText.textContent = `❌ Error clearing cache: ${err.message}`;
      fields.summaryText.style.color = '#dc2626';
    } finally {
      aiPanelFields.clearCacheButton.disabled = false;
      aiPanelFields.clearCacheButton.textContent = 'Clear Pattern Cache';
    }
  });
}
// ──────────────────────────────────────────────────────────────────────────────

