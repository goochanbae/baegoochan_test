const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/generate';
const LLAMA_MODEL = process.env.OLLAMA_LLAMA_MODEL || 'llama3:8b';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_LLAMA_TIMEOUT_MS || process.env.OLLAMA_TIMEOUT_MS || 240000);

function buildChunkPrompt(payload) {
  return `
You are a UX expert.

You are analyzing only part of a scroll timeline.
The input contains:
- DOM analysis results
- a subset of visual observations
- a subset of the scroll timeline

Important rules:
- Respond in Korean.
- All text fields in the JSON must be written in Korean.
- Do not return English sentences unless a brand name or URL must remain as-is.
- Analyze every frame included in this chunk.
- Do not omit issues just because they seem minor.
- Focus on local observations for this chunk only.

Return JSON only using this schema:
{
  "summary": "...",
  "enhanced_issues": [
    {
      "id": "...",
      "title": "...",
      "description": "...",
      "severity": "critical|major|minor",
      "frame_index": 0,
      "related_elements": ["..."]
    }
  ],
  "timeline_analysis": [
    {
      "frame_index": 0,
      "summary": "...",
      "risk": "..."
    }
  ],
  "flow_analysis": "...",
  "cta_analysis": "...",
  "spatial_analysis": "..."
}

Input:
${JSON.stringify(payload, null, 2)}
  `.trim();
}

function buildSynthesisPrompt(payload) {
  return `
You are a UX expert.

You are given:
- DOM analysis results
- summarized chunk analyses that together cover the full scroll timeline

Important rules:
- Respond in Korean.
- All text fields in the JSON must be written in Korean.
- Do not return English sentences unless a brand name or URL must remain as-is.
- Preserve coverage from all chunk analyses.
- Do not drop issues unless they are clearly duplicates.
- Synthesize the overall user flow across the whole page.

Return JSON only using this schema:
{
  "summary": "...",
  "enhanced_issues": [
    {
      "id": "...",
      "title": "...",
      "description": "...",
      "severity": "critical|major|minor",
      "frame_index": 0,
      "related_elements": ["..."]
    }
  ],
  "new_issues": [],
  "validated_issues": [],
  "timeline_analysis": [
    {
      "frame_index": 0,
      "summary": "...",
      "risk": "..."
    }
  ],
  "flow_analysis": "...",
  "cta_analysis": "...",
  "spatial_analysis": "..."
}

Input:
${JSON.stringify(payload, null, 2)}
  `.trim();
}

function buildDefaultPrompt(payload) {
  return `
You are a UX expert.

You are given:
- DOM analysis results
- visual observations
- scroll timeline

Analyze:
- user flow
- drop-off risks
- UX issues
- improvement suggestions

Respond in Korean.
All text fields in the JSON must be written in Korean.
Do not return English sentences unless a brand name or URL must remain as-is.
Return JSON only using this schema:
{
  "summary": "...",
  "enhanced_issues": [
    {
      "id": "...",
      "title": "...",
      "description": "...",
      "severity": "critical|major|minor",
      "frame_index": 0,
      "related_elements": ["..."]
    }
  ],
  "new_issues": [],
  "validated_issues": [],
  "timeline_analysis": [
    {
      "frame_index": 0,
      "summary": "...",
      "risk": "..."
    }
  ],
  "flow_analysis": "...",
  "cta_analysis": "...",
  "spatial_analysis": "..."
}

Input:
${JSON.stringify(payload, null, 2)}
  `.trim();
}

function buildPrompt(payload, mode) {
  if (mode === 'chunk') return buildChunkPrompt(payload);
  if (mode === 'synthesis') return buildSynthesisPrompt(payload);
  return buildDefaultPrompt(payload);
}

function extractFirstJsonObject(raw) {
  const text = String(raw || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  if (start === -1) {
    throw new Error('Llama3 response did not include a JSON object.');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  throw new Error('Llama3 response contained an incomplete JSON object.');
}

function parseJsonBlock(raw) {
  try {
    return JSON.parse(raw);
  } catch (firstError) {
    const candidate = extractFirstJsonObject(raw);
    try {
      return JSON.parse(candidate);
    } catch (secondError) {
      throw new Error(`Failed to parse Llama3 JSON. First error: ${firstError.message}. Second error: ${secondError.message}.`);
    }
  }
}

async function runLlamaReasoning(payload, options = {}) {
  const prompt = buildPrompt(payload, options.mode || 'default');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLAMA_MODEL,
        stream: false,
        format: 'json',
        prompt,
        options: {
          temperature: 0.2,
          num_predict: 900
        }
      }),
      signal: controller.signal
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Llama3 request timed out after ${OLLAMA_TIMEOUT_MS}ms.`);
    }
    throw new Error(`Llama3 fetch failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Llama3 request failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  return parseJsonBlock(data.response || '{}');
}

module.exports = {
  runLlamaReasoning
};
