'use strict';

const COHERE_EMBED_URL = 'https://api.cohere.ai/v1/embed';
const DEFAULT_TIMEOUT_MS = 2000;

class EmbeddingModel {
  constructor(options = {}) {
    this.apiKey = options.apiKey || '';
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.model = 'embed-english-v3.0';
  }

  /**
   * Compute semantic similarity between two intents.
   * @param {object} intentA - { resource, filters, page, limit, ... }
   * @param {object} intentB - { resource, filters, page, limit, ... }
   * @returns {{ score: number, latencyMs: number, error?: string }}
   *   score is 0.0–1.0, or -1 if unavailable
   */
  async similarity(intentA, intentB) {
    const start = Date.now();
    try {
      const textA = this._intentToText(intentA);
      const textB = this._intentToText(intentB);
      const vectors = await this._callCohere([textA, textB]);
      const score = this._cosineSimilarity(vectors[0], vectors[1]);
      return { score, latencyMs: Date.now() - start };
    } catch (err) {
      return { score: -1, latencyMs: Date.now() - start, error: err.message };
    }
  }

  /**
   * Convert an intent into a text string for embedding.
   * Keys are sorted alphabetically for stable output.
   * Example: "resource: /products | brand: apple | category: laptops"
   */
  _intentToText(intent) {
    const filters = intent.filters || {};
    const sortedKeys = Object.keys(filters).sort();
    const filterParts = sortedKeys.map(k => `${k}: ${filters[k]}`);
    const parts = [`resource: ${intent.resource}`, ...filterParts];
    return parts.join(' | ');
  }

  /**
   * Cosine similarity between two float arrays.
   * Returns 0.0–1.0. Returns 0 if either vector is zero-length.
   */
  _cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0;
    // Clamp to [0, 1] — floating point can produce slightly > 1
    return Math.min(1, Math.max(0, dot / denom));
  }

  /**
   * Call Cohere /v1/embed endpoint.
   * @param {string[]} texts - array of text strings to embed
   * @returns {number[][]} - array of embedding vectors
   * @throws if request fails or times out
   */
  async _callCohere(texts) {
    if (!this.apiKey) {
      throw new Error('COHERE_API_KEY not set');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(COHERE_EMBED_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          texts,
          input_type: 'search_document',
          truncate: 'END'
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Cohere API ${response.status}: ${body.slice(0, 200)}`);
      }

      const data = await response.json();

      if (!data.embeddings || !Array.isArray(data.embeddings)) {
        throw new Error('Cohere response missing embeddings array');
      }

      return data.embeddings;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = EmbeddingModel;
