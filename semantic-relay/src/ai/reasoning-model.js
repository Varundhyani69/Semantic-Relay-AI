'use strict';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent';
const DEFAULT_TIMEOUT_MS = 5000;

class ReasoningModel {
  constructor(options = {}) {
    this.apiKey = options.apiKey || '';
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  /**
   * Analyze two intents and determine if they are semantically equivalent.
   * Only called when Cohere similarity score is in the ambiguous range (0.6–0.84).
   *
   * @param {object} intentA
   * @param {object} intentB
   * @param {number} cohereScore - the Cohere similarity score that triggered this call
   * @returns {{
   *   equivalent: boolean,
   *   canonicalFilter: object|null,
   *   confidence: number,
   *   reason: string,
   *   latencyMs: number,
   *   tokenCount: number
   * }}
   * Never throws. Returns safe fallback on any error.
   */
  async analyze(intentA, intentB, cohereScore) {
    const start = Date.now();
    try {
      if (!this.apiKey) {
        throw new Error('GEMINI_API_KEY not set');
      }
      const prompt = this._buildPrompt(intentA, intentB, cohereScore);
      const rawText = await this._callGemini(prompt);
      const parsed = this._parseResponse(rawText);
      return {
        ...parsed,
        latencyMs: Date.now() - start,
        tokenCount: this._estimateTokens(prompt + rawText)
      };
    } catch (err) {
      const reason = err.name === 'AbortError' || err.message === 'timeout'
        ? 'timeout'
        : err.message.includes('parse') ? 'parse-error' : 'api-error';
      return {
        equivalent: false,
        canonicalFilter: null,
        confidence: 0,
        reason,
        latencyMs: Date.now() - start,
        tokenCount: 0
      };
    }
  }

  /**
   * Build the prompt sent to Gemini.
   * Instructs the model to return ONLY valid JSON.
   */
  _buildPrompt(intentA, intentB, cohereScore) {
    return `You are an API semantics analyzer for an e-commerce product catalog. Determine if these two API requests would return the exact same products (i.e., the filter values are SYNONYMS).

Request A: GET ${intentA.resource} with filters ${JSON.stringify(intentA.filters || {})}
Request B: GET ${intentB.resource} with filters ${JSON.stringify(intentB.filters || {})}
Cohere embedding similarity score: ${cohereScore.toFixed(3)}

IMPORTANT: You are checking if filter VALUES are SYNONYMS that query the same data.
Examples:
- "electronics" vs "gadgets" → SYNONYMS → equivalent=true, confidence=0.95
- "clothing" vs "apparel" → SYNONYMS → equivalent=true, confidence=0.90
- "books" vs "literature" → SYNONYMS → equivalent=true, confidence=0.85
- "fashion" vs "textiles" → NOT synonyms (different concepts) → equivalent=false, confidence=0.10
- "electronics" vs "books" → NOT synonyms → equivalent=false, confidence=0.0

Respond with ONLY valid JSON, no markdown, no explanation outside the JSON:
{
  "equivalent": true or false,
  "canonicalFilter": { use filter from Request A if equivalent, null if not },
  "confidence": number between 0.0 and 1.0,
  "reason": "one sentence explaining if these are synonyms or not"
}

Rules:
- Set equivalent=true ONLY if the filter values are TRUE SYNONYMS that would query the same product category
- If unsure or values are merely related (not synonyms), set equivalent=false
- canonicalFilter should use the filter structure from Request A when equivalent=true
- Confidence should reflect how certain you are they are synonyms (0.85-0.95 for clear synonyms)`;
  }

  /**
   * Parse Gemini's response text into a structured object.
   * Handles JSON wrapped in markdown code blocks.
   * @throws {Error} if JSON cannot be parsed or required fields are missing
   */
  _parseResponse(text) {
    if (!text || typeof text !== 'string') {
      throw new Error('parse-error: empty response');
    }

    // Strip markdown code blocks if present
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      throw new Error('parse-error: invalid JSON from Gemini');
    }

    // Validate required fields
    if (typeof parsed.equivalent !== 'boolean') {
      throw new Error('parse-error: missing equivalent field');
    }
    if (typeof parsed.confidence !== 'number') {
      throw new Error('parse-error: missing confidence field');
    }
    if (typeof parsed.reason !== 'string') {
      throw new Error('parse-error: missing reason field');
    }
    // canonicalFilter can be null when equivalent=false
    if (parsed.equivalent && !parsed.canonicalFilter) {
      throw new Error('parse-error: equivalent=true but no canonicalFilter');
    }

    return {
      equivalent: parsed.equivalent,
      canonicalFilter: parsed.canonicalFilter || null,
      confidence: Math.min(1, Math.max(0, parsed.confidence)),
      reason: parsed.reason
    };
  }

  /**
   * Call the Gemini 1.5 Flash API.
   * @param {string} prompt
   * @returns {string} the model's text response
   * @throws on network error, non-200 response, or timeout
   */
  async _callGemini(prompt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = `${GEMINI_URL}?key=${this.apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt }]
          }],
          generationConfig: {
            temperature: 0.1,      // low temperature for deterministic structured output
            maxOutputTokens: 512
          }
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Gemini API ${response.status}: ${body.slice(0, 200)}`);
      }

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!text) {
        throw new Error('Gemini response missing text content');
      }

      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Rough token count estimate (4 chars ≈ 1 token).
   * Used for cost tracking only — not for billing.
   */
  _estimateTokens(text) {
    return Math.ceil((text || '').length / 4);
  }
}

module.exports = ReasoningModel;
