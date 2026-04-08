require('dotenv').config();
const fs = require('fs/promises');
const sharp = require('sharp');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_TIMEOUT_MS = Number(process.env.OPENROUTER_V3_TIMEOUT_MS || 90000);
const MODEL_LIMIT_PER_MINUTE = Number(process.env.OPENROUTER_V3_MODEL_RPM || 5);
const IMAGE_WIDTH = Number(process.env.OPENROUTER_V3_IMAGE_WIDTH || 1120);
const IMAGE_QUALITY = Number(process.env.OPENROUTER_V3_IMAGE_QUALITY || 72);

const modelStates = new Map();
let modelCursor = 0;

function truncateText(value, limit = 900) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function getConfiguredApiKeys() {
  const keys = [];

  if (process.env.OPENROUTER_API_KEYS) {
    process.env.OPENROUTER_API_KEYS
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
      .forEach(value => keys.push(value));
  }

  if (process.env.OPENROUTER_API_KEY) {
    keys.push(process.env.OPENROUTER_API_KEY.trim());
  }

  Object.keys(process.env)
    .filter(name => /^OPENROUTER_API_KEY_\d+$/.test(name))
    .sort((a, b) => Number(a.split('_').pop()) - Number(b.split('_').pop()))
    .forEach(name => {
      const value = String(process.env[name] || '').trim();
      if (value) keys.push(value);
    });

  return Array.from(new Set(keys.filter(Boolean)));
}

function getConfiguredModels() {
  const models = [];

  if (process.env.OPENROUTER_V3_MODELS) {
    process.env.OPENROUTER_V3_MODELS
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
      .forEach(value => models.push(value));
  }

  if (process.env.OPENROUTER_V3_MODEL) {
    models.push(process.env.OPENROUTER_V3_MODEL.trim());
  }

  Object.keys(process.env)
    .filter(name => /^OPENROUTER_V3_MODEL_\d+$/.test(name))
    .sort((a, b) => Number(a.split('_').pop()) - Number(b.split('_').pop()))
    .forEach(name => {
      const value = String(process.env[name] || '').trim();
      if (value) models.push(value);
    });

  const unique = Array.from(new Set(models.filter(Boolean)));
  if (unique.length) {
    return unique.slice(0, 4);
  }

  return ['google/gemma-4-26b-a4b-it:free'];
}

function getModelState(model) {
  if (!modelStates.has(model)) {
    modelStates.set(model, { inFlight: false, timestamps: [], disabledReason: '', disabledAt: null });
  }
  return modelStates.get(model);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pruneOldTimestamps(state) {
  const cutoff = Date.now() - 60000;
  state.timestamps = state.timestamps.filter(value => value > cutoff);
}

function getModelOrder(models) {
  const start = modelCursor % models.length;
  const ordered = [];
  for (let index = 0; index < models.length; index += 1) {
    ordered.push(models[(start + index) % models.length]);
  }
  return ordered;
}

function getEnabledModels(models) {
  return models.filter(model => !getModelState(model).disabledReason);
}

function disableModel(model, reason) {
  const state = getModelState(model);
  state.disabledReason = reason;
  state.disabledAt = new Date().toISOString();
}

function getModelDebugSnapshot(models = getConfiguredModels()) {
  return models.map(model => {
    const state = getModelState(model);
    pruneOldTimestamps(state);
    return {
      model,
      disabled: Boolean(state.disabledReason),
      disabledReason: state.disabledReason || '',
      requestsLastMinute: state.timestamps.length
    };
  });
}

async function acquireModelSlot(model) {
  while (true) {
    const state = getModelState(model);
    pruneOldTimestamps(state);

    if (!state.inFlight && state.timestamps.length < MODEL_LIMIT_PER_MINUTE) {
      state.inFlight = true;
      state.timestamps.push(Date.now());
      return;
    }

    const waitForRate = state.timestamps.length >= MODEL_LIMIT_PER_MINUTE
      ? Math.max(250, 60000 - (Date.now() - state.timestamps[0]) + 50)
      : 250;
    await sleep(waitForRate);
  }
}

function releaseModelSlot(model) {
  const state = getModelState(model);
  state.inFlight = false;
  pruneOldTimestamps(state);
}

function advanceCursor(models, model) {
  const index = models.indexOf(model);
  if (index >= 0) {
    modelCursor = (index + 1) % models.length;
  }
}

function buildChunkPrompt(payload) {
  return `
You are a UX expert analyzing a website scroll timeline from multiple screenshots.

You are given:
- DOM analysis results
- frame metadata
- multiple screenshots in the same order as the frame list

Important rules:
- Respond in Korean.
- All text fields in the JSON must be written in Korean.
- Analyze every frame included in this batch.
- Use the images as the primary source of truth and use DOM metadata as supporting context.
- Keep observations grounded in what is actually visible.
- Do not omit issues just because they seem minor.
- If the page contains repeated card sections or carousels, explicitly note discoverability and continuation risks.

Return JSON only using this schema:
{
  "summary": "...",
  "frame_observations": [
    {
      "frame_index": 0,
      "observation": "..."
    }
  ],
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

Frame order and metadata:
${JSON.stringify(payload, null, 2)}
  `.trim();
}

function buildSynthesisPrompt(payload) {
  return `
You are a UX expert.

You are given:
- DOM analysis results
- summarized multimodal chunk analyses that together cover the full scroll timeline

Important rules:
- Respond in Korean.
- All text fields in the JSON must be written in Korean.
- Preserve coverage from all chunk analyses.
- Do not drop issues unless they are clearly duplicates.
- Synthesize one coherent whole-page judgment instead of repeating chunk summaries.

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
  if (mode === 'synthesis') return buildSynthesisPrompt(payload);
  return buildChunkPrompt(payload);
}

function extractFirstJsonObject(raw) {
  const text = String(raw || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '');
  const start = text.indexOf('{');

  if (start === -1) {
    throw new Error('Gemma response did not include a JSON object.');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  throw new Error('Gemma response contained an incomplete JSON object.');
}

function parseJsonBlock(raw) {
  try {
    return JSON.parse(raw);
  } catch (firstError) {
    const candidate = extractFirstJsonObject(raw);
    try {
      return JSON.parse(candidate);
    } catch (secondError) {
      throw new Error(`Failed to parse Gemma JSON. First error: ${firstError.message}. Second error: ${secondError.message}.`);
    }
  }
}

async function buildDataUrl(imagePath) {
  const imageBuffer = await fs.readFile(imagePath);
  const resized = await sharp(imageBuffer)
    .rotate()
    .resize({ width: IMAGE_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: IMAGE_QUALITY, mozjpeg: true })
    .toBuffer();

  return `data:image/jpeg;base64,${resized.toString('base64')}`;
}

async function requestOpenRouter({ apiKey, model, messages }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://localhost',
        'X-Title': 'UX Spatial Viewer V3'
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages
      }),
      signal: controller.signal
    });

    const bodyText = await response.text();
    if (!response.ok) {
      const err = new Error(`Gemma request failed (${response.status}) for model ${model}: ${bodyText}`);
      err.status = response.status;
      err.model = model;
      throw err;
    }

    let data;
    try {
      data = JSON.parse(bodyText);
    } catch (err) {
      throw new Error(`Gemma returned non-JSON response: ${err.message}`);
    }

    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(`Gemma response was empty for model ${model}.`);
    }

    return parseJsonBlock(content);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Gemma request timed out after ${OPENROUTER_TIMEOUT_MS}ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function shouldDisableModelFromError(err) {
  const text = String(err?.message || '').toLowerCase();
  return (
    text.includes('no endpoints found that support image input') ||
    text.includes('free model has been deprecated') ||
    text.includes('deprecated') ||
    text.includes('not a valid model id')
  );
}

async function sendWithPolicy(messages) {
  const apiKeys = getConfiguredApiKeys();
  const models = getConfiguredModels();

  if (!apiKeys.length) {
    throw new Error('Missing OpenRouter API key. Set OPENROUTER_API_KEY or OPENROUTER_API_KEY_1..4 in .env.');
  }

  let lastError = null;

  for (const apiKey of apiKeys) {
    const enabledModels = getEnabledModels(models);
    if (!enabledModels.length) {
      break;
    }
    const orderedModels = getModelOrder(enabledModels);

    for (const model of orderedModels) {
      await acquireModelSlot(model);
      try {
        const result = await requestOpenRouter({ apiKey, model, messages });
        advanceCursor(models, model);
        return result;
      } catch (err) {
        lastError = err;
        if (shouldDisableModelFromError(err)) {
          disableModel(model, err.message);
        }
        advanceCursor(models, model);
      } finally {
        releaseModelSlot(model);
      }
    }
  }

  throw lastError || new Error('Gemma request failed with no available API keys or models.');
}

function normalizeChunkResult(result) {
  return {
    summary: result?.summary || '',
    frame_observations: Array.isArray(result?.frame_observations) ? result.frame_observations : [],
    enhanced_issues: Array.isArray(result?.enhanced_issues) ? result.enhanced_issues : [],
    timeline_analysis: Array.isArray(result?.timeline_analysis) ? result.timeline_analysis : [],
    flow_analysis: result?.flow_analysis || '',
    cta_analysis: result?.cta_analysis || '',
    spatial_analysis: result?.spatial_analysis || ''
  };
}

async function runGemmaVisionReasoning(payload, frames) {
  const prompt = buildPrompt(payload, 'chunk');
  const content = [{ type: 'text', text: prompt }];

  for (const frame of frames) {
    content.push({
      type: 'image_url',
      image_url: {
        url: await buildDataUrl(frame.imagePath)
      }
    });
  }

  const messages = [
    {
      role: 'user',
      content
    }
  ];

  return normalizeChunkResult(await sendWithPolicy(messages));
}

async function runGemmaSynthesisReasoning(payload) {
  const prompt = buildPrompt(payload, 'synthesis');
  const messages = [
    {
      role: 'user',
      content: prompt
    }
  ];

  return await sendWithPolicy(messages);
}

function buildCompactSynthesisPayload(payload) {
  return {
    ...payload,
    chunk_analyses: (payload.chunk_analyses || []).map(chunk => ({
      chunk_index: chunk.chunk_index,
      frame_range: chunk.frame_range,
      summary: truncateText(chunk.summary, 100),
      issue_count: chunk.issue_count,
      issues: (chunk.issues || []).slice(0, 2),
      timeline_analysis: (chunk.timeline_analysis || []).slice(0, 2),
      flow_signal: truncateText(chunk.flow_signal, 80),
      cta_signal: truncateText(chunk.cta_signal, 80),
      spatial_signal: truncateText(chunk.spatial_signal, 80)
    }))
  };
}

module.exports = {
  buildCompactSynthesisPayload,
  getConfiguredApiKeys,
  getModelDebugSnapshot,
  getConfiguredModels,
  runGemmaSynthesisReasoning,
  runGemmaVisionReasoning,
  truncateText
};
