// Use built-in fetch in Node.js 18+

const GEMINI_API_KEY = 'AIzaSyCDva7UuCy456i20HntEPBjUe8B4USWmP0';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent';

const prompt = `You are an API semantics analyzer for an e-commerce product catalog. Determine if these two API requests would return the exact same products (i.e., the filter values are SYNONYMS).

Request A: GET /api/relay/products with filters {"category":"apparel"}
Request B: GET /api/relay/products with filters {"category":"garments"}
Cohere embedding similarity score: 0.968

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

async function testGemini() {
    const url = `${GEMINI_URL}?key=${GEMINI_API_KEY}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 512
            }
        })
    });

    const data = await response.json();
    console.log('Full response:', JSON.stringify(data, null, 2));

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    console.log('\nExtracted text:', text);

    // Try to parse
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
        cleaned = cleaned
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/, '')
            .trim();
    }

    const parsed = JSON.parse(cleaned);
    console.log('\nParsed:', parsed);
}

testGemini().catch(console.error);
