require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const VISUAL_MODELS = [
  'qwen/qwen3.6-plus:free',
  'z-ai/glm-4.5-air:free'
];
const TEXT_MODELS = [
  'stepfun/step-3.5-flash:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-nano-30b-a3b:free'
];
const CACHE_PATH = path.join(process.cwd(), 'analysis_cache.json');
const KEY_STATE_PATH = path.join(process.cwd(), 'openrouter_key_state.json');
const KEY_COOLDOWN_MS = 30 * 60 * 1000;

let textQueue = Promise.resolve();

function getConfiguredApiKeys() {
  const keys = [];

  const csv = process.env.OPENROUTER_API_KEYS;
  if (csv) {
    csv
      .split(',')
      .map(v => v.trim())
      .filter(Boolean)
      .forEach(v => keys.push(v));
  }

  if (process.env.OPENROUTER_API_KEY) {
    keys.push(process.env.OPENROUTER_API_KEY.trim());
  }
  Object.keys(process.env)
    .filter(name => /^OPENROUTER_API_KEY_\d+$/.test(name))
    .sort((a, b) => {
      const na = Number(a.split('_').pop());
      const nb = Number(b.split('_').pop());
      return na - nb;
    })
    .forEach(name => {
      const v = String(process.env[name] || '').trim();
      if (v) keys.push(v);
    });

  return Array.from(new Set(keys.filter(Boolean)));
}

async function readKeyState() {
  try {
    const raw = await fs.readFile(KEY_STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeKeyState(state) {
  await fs.writeFile(KEY_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function getKeyPoolState(state, poolName) {
  const pools = state.pools && typeof state.pools === 'object' ? state.pools : {};
  const pool = pools[poolName] && typeof pools[poolName] === 'object' ? pools[poolName] : {};
  return {
    ...state,
    pools,
    poolName,
    pool
  };
}

function getModelPoolState(scoped) {
  return scoped.pool.models && typeof scoped.pool.models === 'object' ? scoped.pool.models : {};
}

async function getNextApiKey(poolName, excludedIndexes = []) {
  const keys = getConfiguredApiKeys();
  if (!keys.length) {
    throw new Error('Missing OpenRouter API key. Set OPENROUTER_API_KEY (and optional OPENROUTER_API_KEY_2).');
  }

  if (keys.length === 1) {
    return { key: keys[0], index: 0, total: 1 };
  }

  const state = await readKeyState();
  const scoped = getKeyPoolState(state, poolName);
  const cooldowns = scoped.pool.cooldowns && typeof scoped.pool.cooldowns === 'object' ? scoped.pool.cooldowns : {};
  const now = Date.now();
  const available = [];
  for (let i = 0; i < keys.length; i += 1) {
    if (excludedIndexes.includes(i)) continue;
    const until = Number(cooldowns[i] || 0);
    if (!until || until <= now) {
      available.push(i);
    }
  }

  if (!available.length) {
    const earliest = Math.min(...Object.values(cooldowns).map(v => Number(v || 0)).filter(Boolean));
    const waitMs = Math.max(0, earliest - now);
    const waitMin = Math.ceil(waitMs / 60000);
    const err = new Error(`All API keys are cooling down due to 429. Try again in about ${waitMin} minute(s).`);
    err.code = 'ALL_KEYS_COOLDOWN';
    throw err;
  }

  const poolLastIndex = Number.isInteger(scoped.pool?.lastIndex) ? scoped.pool.lastIndex : -1;
  const sorted = [...available].sort((a, b) => a - b);
  const nextIndex = sorted.find(i => i > poolLastIndex) ?? sorted[0];

  scoped.pools[poolName] = {
    ...scoped.pool,
    lastIndex: nextIndex,
    total: keys.length,
    cooldowns,
    updatedAt: new Date().toISOString()
  };
  await writeKeyState({
    ...state,
    total: keys.length,
    pools: scoped.pools,
    updatedAt: new Date().toISOString()
  });

  return { key: keys[nextIndex], index: nextIndex, total: keys.length };
}

async function markApiKeyCooldown(poolName, index) {
  const state = await readKeyState();
  const scoped = getKeyPoolState(state, poolName);
  const cooldowns = scoped.pool.cooldowns && typeof scoped.pool.cooldowns === 'object' ? scoped.pool.cooldowns : {};
  cooldowns[index] = Date.now() + KEY_COOLDOWN_MS;
  scoped.pools[poolName] = {
    ...scoped.pool,
    cooldowns,
    updatedAt: new Date().toISOString()
  };
  await writeKeyState({
    ...state,
    pools: scoped.pools,
    updatedAt: new Date().toISOString()
  });
}

async function getAvailableModels(poolName, models) {
  const state = await readKeyState();
  const scoped = getKeyPoolState(state, poolName);
  const modelState = getModelPoolState(scoped);
  const now = Date.now();
  const available = (models || []).filter(model => {
    const until = Number(modelState[model]?.cooldownUntil || 0);
    return !until || until <= now;
  });

  return {
    available,
    state,
    scoped,
    modelState
  };
}

async function markModelCooldown(poolName, model) {
  const state = await readKeyState();
  const scoped = getKeyPoolState(state, poolName);
  const modelState = getModelPoolState(scoped);
  modelState[model] = {
    cooldownUntil: Date.now() + KEY_COOLDOWN_MS,
    updatedAt: new Date().toISOString()
  };
  scoped.pools[poolName] = {
    ...scoped.pool,
    models: modelState,
    updatedAt: new Date().toISOString()
  };
  await writeKeyState({
    ...state,
    pools: scoped.pools,
    updatedAt: new Date().toISOString()
  });
}

function isModelInputMismatch(err, pool) {
  if (!err) return false;
  const body = String(err.responseBody || '').toLowerCase();
  if (pool === 'visual') {
    return err.status === 404 && body.includes('no endpoints found that support image input');
  }
  return false;
}

async function callOpenRouter({ models, messages, timeoutMs = 90000, pool = 'shared' }) {
  const keys = getConfiguredApiKeys();
  const attemptedIndexes = [];
  let lastError;
  const modelList = Array.isArray(models) ? models.filter(Boolean) : [models].filter(Boolean);

  if (!modelList.length) {
    throw new Error(`No models configured for pool "${pool}".`);
  }

  const modelAvailability = await getAvailableModels(pool, modelList);
  if (!modelAvailability.available.length) {
    const cooldowns = modelList
      .map(model => Number(modelAvailability.modelState[model]?.cooldownUntil || 0))
      .filter(Boolean);
    const earliest = cooldowns.length ? Math.min(...cooldowns) : 0;
    const waitMs = Math.max(0, earliest - Date.now());
    const waitMin = Math.ceil(waitMs / 60000);
    const err = new Error(`All ${pool} models are cooling down. Try again in about ${waitMin} minute(s).`);
    err.code = 'ALL_MODELS_COOLDOWN';
    throw err;
  }

  while (attemptedIndexes.length < keys.length) {
    const { key: apiKey, index, total } = await getNextApiKey(pool, attemptedIndexes);
    attemptedIndexes.push(index);
    let allModelsRateLimited = true;

    for (const model of modelAvailability.available) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response;
      try {
        response = await fetch(OPENROUTER_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://localhost',
            'X-Title': 'Playwright UX Spatial Analyzer'
          },
          body: JSON.stringify({ model, messages, temperature: 0 }),
          signal: controller.signal
        });
      } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
          throw new Error(`OpenRouter request timed out after ${timeoutMs}ms for model ${model}.`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const body = await response.text();
        const err = new Error(`OpenRouter request failed (${response.status}) for model ${model}: ${body}`);
        err.status = response.status;
        err.responseBody = body;
        err.keyIndex = index;
        err.model = model;
        lastError = err;
        if (response.status === 429) {
          await markModelCooldown(pool, model);
          console.log(`OpenRouter ${pool} model fallback: key ${index + 1}/${total}, model ${model} hit 429; trying next model.`);
          continue;
        }
        if (isModelInputMismatch(err, pool)) {
          console.log(`OpenRouter ${pool} model fallback: model ${model} does not support current input type; trying next model.`);
          continue;
        }
        allModelsRateLimited = false;
        throw err;
      }

      allModelsRateLimited = false;
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error(`No model response content returned for model ${model}.`);
      }
      if (total > 1 || modelList.length > 1) {
        console.log(`OpenRouter ${pool} success: key ${index + 1}/${total}, model ${model}`);
      }
      return content;
    }

    if (allModelsRateLimited) {
      await markApiKeyCooldown(pool, index);
      console.log(`OpenRouter ${pool} key ${index + 1}/${total} entered cooldown after all models hit 429; trying next key.`);
      continue;
    }
  }

  if (lastError?.status === 429) {
    const err = new Error('All available API keys returned 429 and were placed into cooldown.');
    err.code = 'ALL_KEYS_COOLDOWN';
    throw err;
  }
  throw lastError || new Error('OpenRouter request failed with no available API keys.');
}

function enqueueTextTask(task) {
  const next = textQueue.then(task, task);
  textQueue = next.catch(() => {});
  return next;
}

async function readCache() {
  try {
    const raw = await fs.readFile(CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeCache(cache) {
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

function parseJsonStrict(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error(`${label}: JSON.parse failed and no JSON object found.`);
    }
    try {
      return JSON.parse(match[0]);
    } catch (err) {
      throw new Error(`${label}: Failed to parse JSON. Raw: ${raw}\nError: ${err.message}`);
    }
  }
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function normalizeDensity(value, fallback) {
  const valid = ['low', 'medium', 'high'];
  return typeof value === 'string' && valid.includes(value) ? value : fallback;
}

function normalizeDominant(value, fallback) {
  const valid = ['text', 'visual'];
  return typeof value === 'string' && valid.includes(value) ? value : fallback;
}

function normalizeInteractionDensity(value) {
  const valid = ['low', 'medium', 'high'];
  return typeof value === 'string' && valid.includes(value) ? value : 'medium';
}

function normalizeVisualAnalysis(raw, clickableCount, cardCount, pageMeta, overflowCount = 0) {
  const safe = raw && typeof raw === 'object' ? raw : {};

  const ctaElements = isStringArray(safe.cta_elements) ? safe.cta_elements : [];
  const hasClickable = clickableCount > 0;
  const ctaRaw = safe.cta_analysis && typeof safe.cta_analysis === 'object' ? safe.cta_analysis : {};
  const contentBalanceRaw = safe.content_balance && typeof safe.content_balance === 'object' ? safe.content_balance : {};
  const cardRaw = safe.card_analysis && typeof safe.card_analysis === 'object' ? safe.card_analysis : {};
  const confidenceRaw = safe.structure_confidence && typeof safe.structure_confidence === 'object' ? safe.structure_confidence : {};
  const spatialRaw = safe.spatial_analysis && typeof safe.spatial_analysis === 'object' ? safe.spatial_analysis : {};

  const pageArea = Math.max(1, (pageMeta?.width || 1) * (pageMeta?.height || 1));
  const densityScore = (clickableCount + cardCount) / pageArea * 100000;
  const computedDensity = densityScore > 8 ? 'high' : densityScore > 3 ? 'medium' : 'low';

  return {
    cta_elements: ctaElements,
    layout: typeof safe.layout === 'string' ? safe.layout : '레이아웃 정보를 충분히 해석하지 못했습니다.',
    sections: isStringArray(safe.sections) ? safe.sections : [],
    visual_hierarchy: isStringArray(safe.visual_hierarchy) ? safe.visual_hierarchy : [],
    cta_analysis: {
      exists: Boolean(hasClickable || ctaElements.length > 0 || ctaRaw.exists === true),
      visibility:
        typeof ctaRaw.visibility === 'string' && ctaRaw.visibility.trim()
          ? ctaRaw.visibility
          : '클릭 가능한 요소는 존재하지만 대비와 위치에 따라 노출 강도는 섹션별 편차가 있습니다.',
      clarity:
        typeof ctaRaw.clarity === 'string' && ctaRaw.clarity.trim()
          ? ctaRaw.clarity
          : 'CTA 문구는 일부 명확하지만 주요 행동 유도 문구의 일관성은 추가 점검이 필요합니다.',
      recognizability:
        typeof ctaRaw.recognizability === 'string' && ctaRaw.recognizability.trim()
          ? ctaRaw.recognizability
          : '버튼/링크 인지는 가능하나 주요 CTA와 탐색 링크의 구분성이 구간별로 다를 수 있습니다.',
      position_priority:
        typeof ctaRaw.position_priority === 'string' && ctaRaw.position_priority.trim()
          ? ctaRaw.position_priority
          : '상단과 하단에 CTA가 분산되어 있어 기본 동선은 형성되지만 우선순위는 더 선명하게 만들 수 있습니다.',
      issues: isStringArray(ctaRaw.issues)
        ? ctaRaw.issues
        : ['CTA는 존재하지만 시선 집중 지점 대비 우선순위 신호가 약한 구간이 있을 수 있습니다.']
    },
    content_balance: {
      text_density: normalizeDensity(contentBalanceRaw.text_density, 'medium'),
      visual_density: normalizeDensity(contentBalanceRaw.visual_density, 'medium'),
      dominant: normalizeDominant(contentBalanceRaw.dominant, 'text'),
      first_impression:
        typeof contentBalanceRaw.first_impression === 'string' && contentBalanceRaw.first_impression.trim()
          ? contentBalanceRaw.first_impression
          : '첫 화면에서 텍스트와 비주얼의 비중은 비교적 균형적이나 메시지 우선순위는 섹션마다 편차가 있습니다.',
      reading_load:
        typeof contentBalanceRaw.reading_load === 'string' && contentBalanceRaw.reading_load.trim()
          ? contentBalanceRaw.reading_load
          : '텍스트 블록 길이와 카드 반복 패턴 기준으로 읽기 부담은 중간 수준으로 보입니다.'
    },
    card_analysis: {
      preview_sufficiency:
        typeof cardRaw.preview_sufficiency === 'string' && cardRaw.preview_sufficiency.trim()
          ? cardRaw.preview_sufficiency
          : '카드 미리보기는 기본 정보 전달은 가능하지만 클릭 전 의사결정 신호는 카드별 편차가 있습니다.',
      decision_support_before_click:
        typeof cardRaw.decision_support_before_click === 'string' && cardRaw.decision_support_before_click.trim()
          ? cardRaw.decision_support_before_click
          : '사용자는 클릭 전 관련성을 대략 판단할 수 있으나 선택 확신을 높일 보조 정보가 더 필요할 수 있습니다.',
      reason:
        typeof cardRaw.reason === 'string' && cardRaw.reason.trim()
          ? cardRaw.reason
          : '카드의 제목, 보조 텍스트, 시각 요소의 조합으로 사전 판단 가능성을 평가했습니다.'
    },
    structure_confidence: {
      confidence:
        confidenceRaw.confidence === 'high' || confidenceRaw.confidence === 'medium' || confidenceRaw.confidence === 'low'
          ? confidenceRaw.confidence
          : 'low',
      reason:
        typeof confidenceRaw.reason === 'string' && confidenceRaw.reason.trim()
          ? confidenceRaw.reason
          : '일부 구조 판단은 시각 증거 의존도가 높아 추가 검증이 필요합니다.'
    },
    visual_insight_reasoning: isStringArray(safe.visual_insight_reasoning)
      ? safe.visual_insight_reasoning
      : ['시각 인사이트는 크기, 위치, 대비, 반복 패턴을 기반으로 도출되었습니다.'],
    spatial_analysis: {
      cta_distribution:
        typeof spatialRaw.cta_distribution === 'string' && spatialRaw.cta_distribution.trim()
          ? spatialRaw.cta_distribution
          : 'CTA 후보는 상단 내비게이션 영역과 하단 전환 영역에 분포하며 중간 구간은 탐색형 링크 비중이 높습니다.',
      primary_cta_detected:
        typeof spatialRaw.primary_cta_detected === 'boolean' ? spatialRaw.primary_cta_detected : Boolean(hasClickable),
      interaction_density: normalizeInteractionDensity(spatialRaw.interaction_density || computedDensity)
    },
    overflow_insight:
      overflowCount > 0
        ? '가로 스크롤 영역에 숨겨진 콘텐츠가 있어 사용자가 추가 콘텐츠를 즉시 인지하지 못할 수 있습니다.'
        : ''
  };
}

function validateTextResult(obj) {
  if (
    !obj ||
    !isStringArray(obj.Structure) ||
    !isStringArray(obj.Problems) ||
    !isStringArray(obj.Improvements) ||
    !isStringArray(obj.KeyMessages) ||
    typeof obj.Summary !== 'string'
  ) {
    throw new Error('Text analysis schema mismatch.');
  }
}

function normalizeTextAnalysis(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const toArray = value => {
    if (Array.isArray(value)) {
      return value
        .map(item => (typeof item === 'string' ? item.trim() : JSON.stringify(item)))
        .filter(Boolean);
    }
    if (typeof value === 'string' && value.trim()) {
      return [value.trim()];
    }
    return [];
  };

  const normalized = {
    Structure: toArray(src.Structure || src.structure),
    Problems: toArray(src.Problems || src.problems),
    Improvements: toArray(src.Improvements || src.improvements),
    KeyMessages: toArray(src.KeyMessages || src.key_messages || src.keymessages),
    Summary: typeof (src.Summary || src.summary) === 'string' ? (src.Summary || src.summary) : ''
  };

  if (!normalized.Summary) {
    normalized.Summary = '텍스트 분석 응답 형식이 불완전하여 요약을 자동 보정했습니다.';
  }
  if (!normalized.Structure.length) normalized.Structure = ['구조 분석 항목이 부족해 자동 보정된 기본 문장입니다.'];
  if (!normalized.Problems.length) normalized.Problems = ['문제 분석 항목이 부족해 자동 보정된 기본 문장입니다.'];
  if (!normalized.Improvements.length) normalized.Improvements = ['개선안 항목이 부족해 자동 보정된 기본 문장입니다.'];
  if (!normalized.KeyMessages.length) normalized.KeyMessages = ['핵심 메시지 항목이 부족해 자동 보정된 기본 문장입니다.'];

  validateTextResult(normalized);
  return normalized;
}

async function analyzeVisualWithQwen({ screenshotPath, clickableBoxes, cardBoxes, overflowBoxes, pageMeta }) {
  const imageBuffer = await fs.readFile(screenshotPath);
  const dataUrl = `data:image/png;base64,${imageBuffer.toString('base64')}`;

  const spatialPayload = {
    page: pageMeta,
    clickable_boxes: clickableBoxes.slice(0, 250),
    card_boxes: cardBoxes.slice(0, 250),
    overflow_boxes: overflowBoxes.slice(0, 120)
  };

  const prompt = `Analyze this webpage screenshot and bounding-box data. Return JSON only.

Goal shift:
Do NOT answer only "whether CTA exists".
Answer whether users can SEE and UNDERSTAND where to click.

You must evaluate:
1) CTA visibility and quality
- CTA includes buttons, links, clickable cards.
- Even visually weak links still count as CTA candidates.
- Detect weak/hidden/misleading clickable areas.

2) Layout & sections
- hero, cards, grid/single-column tendency, section boundaries.

3) Spatial hierarchy
- size, position, contrast, spacing, overlap.

4) Content balance
- text_density: low|medium|high
- visual_density: low|medium|high
- dominant: text|visual
- first_impression
- reading_load

5) Card evaluation
- preview_sufficiency
- decision_support_before_click
- reason

6) Structure confidence
- confidence: low|medium|high
- reason (especially when text-only evidence is insufficient)

7) Spatial analysis output
- cta_distribution
- primary_cta_detected
- interaction_density: low|medium|high

Output values in Korean.
Return EXACT schema:
{
  "cta_elements": ["..."],
  "layout": "...",
  "sections": ["..."],
  "visual_hierarchy": ["..."],
  "cta_analysis": {
    "exists": true,
    "visibility": "...",
    "clarity": "...",
    "recognizability": "...",
    "position_priority": "...",
    "issues": ["..."]
  },
  "content_balance": {
    "text_density": "low|medium|high",
    "visual_density": "low|medium|high",
    "dominant": "text|visual",
    "first_impression": "...",
    "reading_load": "..."
  },
  "card_analysis": {
    "preview_sufficiency": "...",
    "decision_support_before_click": "...",
    "reason": "..."
  },
  "structure_confidence": {
    "confidence": "low|medium|high",
    "reason": "..."
  },
  "visual_insight_reasoning": ["..."],
  "spatial_analysis": {
    "cta_distribution": "...",
    "primary_cta_detected": true,
    "interaction_density": "low|medium|high"
  }
}

Bounding-box data:
${JSON.stringify(spatialPayload, null, 2)}`;

  const raw = await callOpenRouter({
    models: VISUAL_MODELS,
    timeoutMs: 120000,
    pool: 'visual',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ]
  });

  return parseJsonStrict(raw, 'visual analysis');
}

async function analyzeTextWithStepfun({ text, clickableElements, importantTexts, visualAnalysis }) {
  const clickablePreview = clickableElements
    .slice(0, 60)
    .map(item => `- [${item.tag}] ${item.text || '(텍스트 없음)'} ${item.href ? `(${item.href})` : ''}`)
    .join('\n');

  const importantTextPreview = importantTexts
    .map(item => `- ${item.text} (font-size: ${item.fontSize})`)
    .join('\n');

  const prompt = `You are a web UX analyzer.

Focus on webpage UX, not business/content subject meaning.

Rules:
- CTA includes buttons, links, clickable cards.
- If clickable elements exist, never claim CTA is missing.
- Evaluate action discoverability and clarity, not binary existence only.
- Do not output vague "information is missing". Evaluate preview sufficiency and decision support before click.
- Prioritize visual analysis for layout truth.

Return JSON only:
{
  "Structure": ["..."],
  "Problems": ["..."],
  "Improvements": ["..."],
  "KeyMessages": ["..."],
  "Summary": "..."
}

All values in Korean.
Each problem sentence must include what is wrong, why UX issue, and user behavior impact.
Each improvement sentence must directly address UX fix and expected effect.

[VISUAL ANALYSIS INPUT]
${JSON.stringify(visualAnalysis, null, 2)}

[CLICKABLE ELEMENTS]
${clickablePreview || '- 없음'}

[IMPORTANT TEXTS]
${importantTextPreview || '- 없음'}

[PAGE TEXT]
${text.slice(0, 5000)}`;

  const raw = await callOpenRouter({
    models: TEXT_MODELS,
    timeoutMs: 90000,
    pool: 'text',
    messages: [{ role: 'user', content: prompt }]
  });

  const parsed = parseJsonStrict(raw, 'text analysis');
  return normalizeTextAnalysis(parsed);
}

function analyzePageType(textLength, imageCount) {
  if (textLength < 300 && imageCount > 5) return 'image-heavy';
  if (textLength > 1000) return 'text-heavy';
  return 'mixed';
}

async function extractImportantTexts(page) {
  const candidates = await page.evaluate(() => {
    const tags = 'h1,h2,h3,h4,h5,h6,p,a,button,li,span,strong,em,label,div';
    const elements = Array.from(document.querySelectorAll(tags));
    const seen = new Set();
    const items = [];

    for (const el of elements) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length >= 100) continue;

      const fontSize = Number.parseFloat(window.getComputedStyle(el).fontSize || '0');
      if (Number.isNaN(fontSize) || fontSize < 18) continue;

      const key = `${text}::${fontSize}`;
      if (seen.has(key)) continue;
      seen.add(key);

      items.push({ text, fontSize: Number(fontSize.toFixed(2)) });
    }
    return items;
  });

  return candidates.sort((a, b) => b.fontSize - a.fontSize).slice(0, 10);
}

async function extractSpatialData(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const pageMeta = {
      width: Math.ceil(Math.max(doc.scrollWidth, doc.clientWidth, window.innerWidth)),
      height: Math.ceil(Math.max(doc.scrollHeight, doc.clientHeight, window.innerHeight))
    };

    const toBox = (el, extra = {}) => {
      const rect = el.getBoundingClientRect();
      const x = rect.x;
      const y = rect.y + window.scrollY;
      const width = rect.width;
      const height = rect.height;
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      return {
        text,
        ...extra,
        x: Number(x.toFixed(2)),
        y: Number(y.toFixed(2)),
        width: Number(width.toFixed(2)),
        height: Number(height.toFixed(2))
      };
    };

    const clickableRaw = Array.from(document.querySelectorAll('a, button, [role="button"], input[type="button"], input[type="submit"]'))
      .map((el, idx) => {
        const style = window.getComputedStyle(el);
        const textFallback = (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || '').trim();
        const href = typeof el.href === 'string' ? el.href : null;
        const box = toBox(el, {
          id: `cta-${idx + 1}`,
          type: 'cta',
          tag: el.tagName,
          href,
          text: ((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() || textFallback)
        });
        return { box, style, href };
      });

    const clickableFiltered = clickableRaw
      .filter(item => {
        if (!item?.box) return false;
        const { box, style, href } = item;
        const text = (box.text || '').trim();
        const hrefLow = String(href || '').toLowerCase();

        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (Number(style.opacity || '1') <= 0.02) return false;
        if (style.pointerEvents === 'none') return false;
        if (!text || text.length < 2) return false;
        if (box.width < 40 || box.height < 20) return false;
        if (box.x + box.width < 0 || box.x > pageMeta.width) return false;
        if (box.y + box.height < 0 || box.y > pageMeta.height) return false;
        if (hrefLow.startsWith('javascript:')) return false;
        if (hrefLow === '#') return false;
        return Number.isFinite(box.x) && Number.isFinite(box.y);
      })
      .map(item => item.box);

    const seenCta = new Set();
    const clickable = clickableFiltered
      .filter(box => {
        if (!box) return false;
        const key = [
          (box.text || '').toLowerCase(),
          String(box.href || '').toLowerCase(),
          Math.round(box.x / 8),
          Math.round(box.y / 8),
          Math.round(box.width / 8),
          Math.round(box.height / 8)
        ].join('|');
        if (seenCta.has(key)) return false;
        seenCta.add(key);
        return true;
      })
      .sort((a, b) => (a.y - b.y) || (a.x - b.x))
      .slice(0, 180);

    const cardSelectors = [
      'section',
      'article',
      '[class*="card" i]',
      '[class*="item" i]',
      '[data-card]',
      '[role="article"]'
    ];

    const cards = Array.from(document.querySelectorAll(cardSelectors.join(',')))
      .map((el, idx) => toBox(el, { id: `card-${idx + 1}`, type: 'card', tag: el.tagName, href: null }))
      .filter(item => item.width > 120 && item.height > 80)
      .slice(0, 400);

    const overflow = Array.from(document.querySelectorAll('section, article, main, div, ul, ol'))
      .filter(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 240 || rect.height < 90) return false;
        if (el.scrollWidth <= el.clientWidth + 20) return false;
        return true;
      })
      .map((el, idx) => {
        const label = (el.getAttribute('aria-label') || el.getAttribute('data-testid') || el.className || '').toString();
        return toBox(el, { id: `overflow-${idx + 1}`, type: 'overflow', tag: el.tagName, href: null, label });
      })
      .filter(item => item.width > 120 && item.height > 60)
      .slice(0, 80);

    return { clickable, cards, overflow, pageMeta };
  });
}

function parseProblemPayload(problem) {
  if (typeof problem !== 'string') return '';
  const trimmed = problem.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      const parts = [
        obj['what is wrong'] || obj.what || obj.problem || obj.issue || '',
        obj['why UX issue'] || obj.why || '',
        obj['user behavior impact'] || obj.impact || ''
      ].filter(Boolean);
      return parts.join(' ');
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function classifySeverity(problemText) {
  const t = problemText.toLowerCase();
  if (/접근성|결제|전환|이탈|실패|치명|critical|신뢰/.test(t)) {
    return 'critical';
  }
  if (/혼란|가독성|우선순위|인지|탐색|major|명확/.test(t)) {
    return 'major';
  }
  return 'minor';
}

function buildProblemTitle(problemText) {
  const compact = problemText.replace(/\s+/g, ' ').trim();
  if (!compact) return '문제 진단';
  const firstSentence = compact.split(/(?<=[.!?])\s/)[0];
  return firstSentence.length > 64 ? `${firstSentence.slice(0, 64).trim()}...` : firstSentence;
}

function rankClickableElements(clickableElements, viewportHeight = 900) {
  const actionPattern = /(문의|상담|contact|start|get|learn|more|book|apply|download|demo|explore|discover|문의하기|자세히)/i;
  const navPattern = /^(home|about|news|blog|careers|ir|esg|products|service|services|ko|en)$/i;
  return [...(clickableElements || [])]
    .map(el => {
      const text = String(el.text || '').trim();
      const area = Math.min(25000, Math.max(0, el.width * el.height));
      let score = area / 500;
      if (el.y < viewportHeight) score += 25;
      if (actionPattern.test(text)) score += 30;
      if (navPattern.test(text)) score -= 12;
      return { ...el, _score: score };
    })
    .sort((a, b) => b._score - a._score || a.y - b.y);
}

function createRelatedObjects(problemText, clickableElements, cardElements, problemIndex = 0) {
  const t = problemText.toLowerCase();
  const related = [];
  const used = new Set();
  const prioritizedCtas = rankClickableElements(clickableElements);
  const push = (id, role, reason) => {
    if (!id || used.has(id)) return;
    used.add(id);
    related.push({ id, role, reason });
  };

  const genericReason = '해당 요소가 문제 현상이 나타나는 주요 상호작용 위치이기 때문입니다.';

  if (/cta|버튼|링크|클릭|행동/.test(t)) {
    prioritizedCtas.slice(0, 2).forEach(el => {
      push(el.id, 'primary', 'CTA 인지/행동 유도 문제의 핵심 인터랙션 요소입니다.');
    });
    prioritizedCtas.slice(2, 5).forEach(el => {
      push(el.id, 'secondary', 'CTA 주변 보조 인터랙션 요소로 비교 관찰이 필요한 대상입니다.');
    });
  }
  if (/카드|그리드|미리보기|preview|썸네일/.test(t)) {
    cardElements.slice(0, 2).forEach(el => {
      push(el.id, 'primary', '카드 구조/미리보기 품질 문제의 직접적인 발생 위치입니다.');
    });
    cardElements.slice(2, 5).forEach(el => {
      push(el.id, 'secondary', '동일 카드 패턴 내 비교를 위한 관련 요소입니다.');
    });
  }
  if (/상단|헤더|히어로|hero/.test(t)) {
    prioritizedCtas
      .filter(el => el.y < 500)
      .slice(0, 2)
      .forEach(el => push(el.id, 'primary', '상단 동선에서 문제를 유발하는 주요 요소입니다.'));
  }
  if (/하단|푸터|footer/.test(t)) {
    prioritizedCtas
      .slice()
      .sort((a, b) => b.y - a.y)
      .slice(0, 2)
      .forEach(el => push(el.id, 'primary', '하단 전환 구간에서 핵심적으로 관찰되는 요소입니다.'));
  }

  if (related.length === 0) {
    const pool = [...prioritizedCtas, ...cardElements];
    const fallback = pool[problemIndex % Math.max(1, pool.length)];
    push(fallback?.id || clickableElements[0]?.id || cardElements[0]?.id, 'primary', genericReason);
  }
  return related.slice(0, 8);
}

function buildProblemObjects(problems, clickableElements, cardElements) {
  return (problems || [])
    .map((problem, idx) => {
      const description = parseProblemPayload(problem);
      if (!description) return null;
      const relatedElements = createRelatedObjects(description, clickableElements, cardElements, idx);
      const primary = relatedElements.find(r => r.role === 'primary') || relatedElements[0];
      return {
        id: `problem-${idx + 1}`,
        title: buildProblemTitle(description),
        description,
        severity: classifySeverity(description),
        related_elements: relatedElements,
        thumbnail: primary?.id ? `/thumbs/thumb_${primary.id}.png` : null
      };
    })
    .filter(Boolean);
}

async function createAnnotatedScreenshot(page, clickableBoxes, cardBoxes, overflowBoxes, outputPath, viewport, pageMeta) {
  await page.evaluate(({ clickable, cards, overflows }) => {
    const existing = document.getElementById('__ux_overlay__');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = '__ux_overlay__';
    overlay.style.position = 'absolute';
    overlay.style.left = '0';
    overlay.style.top = '0';
    overlay.style.width = Math.max(document.documentElement.scrollWidth, window.innerWidth) + 'px';
    overlay.style.height = Math.max(document.documentElement.scrollHeight, window.innerHeight) + 'px';
    overlay.style.pointerEvents = 'none';
    overlay.style.zIndex = '2147483647';

    const makeBox = (item, color, label) => {
      const box = document.createElement('div');
      box.style.position = 'absolute';
      box.style.left = `${item.x}px`;
      box.style.top = `${item.y}px`;
      box.style.width = `${item.width}px`;
      box.style.height = `${item.height}px`;
      box.style.border = `2px solid ${color}`;
      box.style.background = color === 'red' ? 'rgba(255,0,0,0.08)' : 'rgba(0,102,255,0.08)';

      const tag = document.createElement('span');
      tag.textContent = label;
      tag.style.position = 'absolute';
      tag.style.left = '0';
      tag.style.top = '-16px';
      tag.style.fontSize = '10px';
      tag.style.fontFamily = 'monospace';
      tag.style.color = '#fff';
      tag.style.background = color;
      tag.style.padding = '1px 4px';

      box.appendChild(tag);
      return box;
    };

    cards.slice(0, 200).forEach(item => overlay.appendChild(makeBox(item, 'blue', 'CARD')));
    clickable.slice(0, 300).forEach(item => overlay.appendChild(makeBox(item, 'red', 'CTA')));
    overflows.slice(0, 100).forEach(item => overlay.appendChild(makeBox(item, 'orange', 'OVERFLOW')));

    document.body.appendChild(overlay);
  }, { clickable: clickableBoxes, cards: cardBoxes, overflows: overflowBoxes });

  await captureStitchedScreenshot(page, outputPath, viewport, pageMeta.height);

  await page.evaluate(() => {
    const overlay = document.getElementById('__ux_overlay__');
    if (overlay) overlay.remove();
  });
}

async function captureStitchedScreenshot(page, outputPath, viewport, pageHeight) {
  const tempDir = path.join(process.cwd(), '.stitch_tmp');
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(tempDir, { recursive: true });

  await page.evaluate(() => {
    const STYLE_ID = '__ux_capture_freeze_style__';
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        * {
          animation: none !important;
          transition: none !important;
          scroll-behavior: auto !important;
        }
        html, body {
          scroll-snap-type: none !important;
        }
        [class*="parallax" i],
        [data-parallax],
        [data-scroll],
        [data-speed],
        [style*="background-attachment: fixed"],
        [style*="translate3d"],
        [style*="transform"] {
          transform: none !important;
          animation: none !important;
          transition: none !important;
          background-attachment: scroll !important;
          will-change: auto !important;
        }
      `;
      document.head.appendChild(style);
    }

    document.querySelectorAll('*').forEach(el => {
      const computed = window.getComputedStyle(el);
      if (computed.position !== 'fixed' && computed.position !== 'sticky') return;
      if (el.dataset.uxCaptureAdjusted === '1') return;

      const rect = el.getBoundingClientRect();
      const absTop = rect.top + window.scrollY;
      const absLeft = rect.left + window.scrollX;

      el.dataset.uxCaptureAdjusted = '1';
      el.dataset.uxCaptureOrigPosition = el.style.position || '';
      el.dataset.uxCaptureOrigTop = el.style.top || '';
      el.dataset.uxCaptureOrigLeft = el.style.left || '';
      el.dataset.uxCaptureOrigWidth = el.style.width || '';
      el.dataset.uxCaptureOrigZIndex = el.style.zIndex || '';

      el.style.position = 'absolute';
      el.style.top = `${absTop}px`;
      el.style.left = `${absLeft}px`;
      el.style.width = `${Math.max(1, rect.width)}px`;
      el.style.zIndex = '999999';
    });

    document.querySelectorAll('*').forEach(el => {
      const computed = window.getComputedStyle(el);
      const isParallaxLike =
        computed.transform !== 'none' ||
        computed.perspective !== 'none' ||
        computed.backgroundAttachment === 'fixed' ||
        (computed.willChange || '').includes('transform') ||
        (computed.willChange || '').includes('scroll-position') ||
        /\bparallax\b/i.test(el.className || '') ||
        el.hasAttribute('data-parallax') ||
        el.hasAttribute('data-speed');

      if (!isParallaxLike) return;
      if (el.dataset.uxCaptureParallaxAdjusted === '1') return;

      el.dataset.uxCaptureParallaxAdjusted = '1';
      el.dataset.uxCaptureOrigTransform = el.style.transform || '';
      el.dataset.uxCaptureOrigBackgroundAttachment = el.style.backgroundAttachment || '';
      el.dataset.uxCaptureOrigWillChange = el.style.willChange || '';

      el.style.transform = 'none';
      el.style.backgroundAttachment = 'scroll';
      el.style.willChange = 'auto';
    });
  });

  await page.waitForTimeout(180);

  const measuredHeight = await page.evaluate(() => {
    const doc = document.documentElement;
    return Math.ceil(Math.max(doc.scrollHeight, doc.clientHeight, window.innerHeight));
  });
  const totalHeight = Math.max(viewport.height, Math.floor(pageHeight), measuredHeight);

  const positions = [];
  for (let y = 0; y < totalHeight; y += viewport.height) {
    positions.push(y);
  }
  const lastStart = Math.max(0, totalHeight - viewport.height);
  if (positions[positions.length - 1] !== lastStart) {
    positions.push(lastStart);
  }

  try {
    const composites = [];
    for (let i = 0; i < positions.length; i += 1) {
      const y = positions[i];
      const tilePath = path.join(tempDir, `tile_${i}.png`);
      await captureTileWithRecovery(page, y, viewport, tilePath);

      const visibleHeight = Math.min(viewport.height, totalHeight - y);
      if (visibleHeight <= 0) continue;
      const buffer = visibleHeight === viewport.height
        ? await fs.readFile(tilePath)
        : await sharp(tilePath).extract({ left: 0, top: 0, width: viewport.width, height: visibleHeight }).png().toBuffer();
      composites.push({ input: buffer, left: 0, top: y });
    }

    await sharp({
      create: {
        width: viewport.width,
        height: totalHeight,
        channels: 4,
        background: '#ffffff'
      }
    })
      .composite(composites)
      .png()
      .toFile(outputPath);
  } finally {
    await page.evaluate(() => {
      document.querySelectorAll('[data-ux-capture-adjusted="1"]').forEach(el => {
        const origPosition = el.dataset.uxCaptureOrigPosition || '';
        const origTop = el.dataset.uxCaptureOrigTop || '';
        const origLeft = el.dataset.uxCaptureOrigLeft || '';
        const origWidth = el.dataset.uxCaptureOrigWidth || '';
        const origZIndex = el.dataset.uxCaptureOrigZIndex || '';

        if (origPosition) el.style.position = origPosition;
        else el.style.removeProperty('position');
        if (origTop) el.style.top = origTop;
        else el.style.removeProperty('top');
        if (origLeft) el.style.left = origLeft;
        else el.style.removeProperty('left');
        if (origWidth) el.style.width = origWidth;
        else el.style.removeProperty('width');
        if (origZIndex) el.style.zIndex = origZIndex;
        else el.style.removeProperty('z-index');

        delete el.dataset.uxCaptureAdjusted;
        delete el.dataset.uxCaptureOrigPosition;
        delete el.dataset.uxCaptureOrigTop;
        delete el.dataset.uxCaptureOrigLeft;
        delete el.dataset.uxCaptureOrigWidth;
        delete el.dataset.uxCaptureOrigZIndex;
      });

      document.querySelectorAll('[data-ux-capture-parallax-adjusted="1"]').forEach(el => {
        const origTransform = el.dataset.uxCaptureOrigTransform || '';
        const origBackgroundAttachment = el.dataset.uxCaptureOrigBackgroundAttachment || '';
        const origWillChange = el.dataset.uxCaptureOrigWillChange || '';

        if (origTransform) el.style.transform = origTransform;
        else el.style.removeProperty('transform');
        if (origBackgroundAttachment) el.style.backgroundAttachment = origBackgroundAttachment;
        else el.style.removeProperty('background-attachment');
        if (origWillChange) el.style.willChange = origWillChange;
        else el.style.removeProperty('will-change');

        delete el.dataset.uxCaptureParallaxAdjusted;
        delete el.dataset.uxCaptureOrigTransform;
        delete el.dataset.uxCaptureOrigBackgroundAttachment;
        delete el.dataset.uxCaptureOrigWillChange;
      });

      const style = document.getElementById('__ux_capture_freeze_style__');
      if (style) style.remove();
    });

    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function settleAfterScroll(page, y, viewportHeight) {
  await page.evaluate(
    ({ scrollTop, viewportH }) => {
      const warmup = Math.max(0, scrollTop - Math.min(120, Math.floor(viewportH * 0.15)));
      window.scrollTo(0, warmup);
      window.scrollTo(0, scrollTop);
    },
    { scrollTop: y, viewportH: viewportHeight }
  );
  await page.evaluate(
    () =>
      new Promise(resolve => {
        requestAnimationFrame(() => {
          requestAnimationFrame(resolve);
        });
      })
  );
}

async function isLikelyBlankTile(tilePath) {
  try {
    const stats = await sharp(tilePath).stats();
    const channels = stats.channels || [];
    const mean = channels.reduce((sum, ch) => sum + ch.mean, 0) / Math.max(1, channels.length);
    const stdev = channels.reduce((sum, ch) => sum + ch.stdev, 0) / Math.max(1, channels.length);
    return mean > 245 && stdev < 8;
  } catch {
    return false;
  }
}

async function captureTileWithRecovery(page, y, viewport, tilePath) {
  const attempts = [220, 550, 950];

  for (let i = 0; i < attempts.length; i += 1) {
    await settleAfterScroll(page, y, viewport.height);
    await page.waitForTimeout(attempts[i]);
    await page.screenshot({ path: tilePath, fullPage: false });

    const blank = await isLikelyBlankTile(tilePath);
    if (!blank || i === attempts.length - 1) {
      return;
    }
  }
}

async function generateElementThumbnails(screenshotPath, elements, pageMeta, outDir) {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const meta = await sharp(screenshotPath).metadata();
  const imageWidth = Number(meta.width || pageMeta?.width || 0);
  const imageHeight = Number(meta.height || pageMeta?.height || 0);
  if (imageWidth <= 0 || imageHeight <= 0) return;

  for (const el of elements) {
    if (!el?.id) continue;
    if (![el.x, el.y, el.width, el.height].every(Number.isFinite)) continue;

    const rawLeft = Math.floor(el.x);
    const rawTop = Math.floor(el.y);
    const rawRight = Math.floor(el.x + el.width);
    const rawBottom = Math.floor(el.y + el.height);

    const safeCrop = {
      left: Math.max(0, rawLeft),
      top: Math.max(0, rawTop),
      width: Math.max(0, Math.min(imageWidth, rawRight) - Math.max(0, rawLeft)),
      height: Math.max(0, Math.min(imageHeight, rawBottom) - Math.max(0, rawTop))
    };

    if (safeCrop.width < 5 || safeCrop.height < 5) continue;

    const outPath = path.join(outDir, `thumb_${el.id}.png`);
    try {
      await sharp(screenshotPath)
        .extract({
          left: safeCrop.left,
          top: safeCrop.top,
          width: safeCrop.width,
          height: safeCrop.height
        })
        .toFile(outPath);
    } catch {
      // 개별 요소 썸네일 실패는 전체 파이프라인을 중단하지 않음
    }
  }
}

async function generateOverflowPreviews(screenshotPath, overflowElements, outDir) {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const meta = await sharp(screenshotPath).metadata();
  const imageWidth = Number(meta.width || 0);
  const imageHeight = Number(meta.height || 0);
  if (imageWidth <= 0 || imageHeight <= 0) return;

  for (const el of overflowElements) {
    if (!el?.id) continue;
    const rawLeft = Math.floor(el.x);
    const rawTop = Math.floor(el.y);
    const rawRight = Math.floor(el.x + el.width);
    const rawBottom = Math.floor(el.y + el.height);
    const left = Math.max(0, rawLeft);
    const top = Math.max(0, rawTop);
    const width = Math.max(0, Math.min(imageWidth, rawRight) - left);
    const height = Math.max(0, Math.min(imageHeight, rawBottom) - top);
    if (width < 20 || height < 20) continue;
    try {
      await sharp(screenshotPath)
        .extract({ left, top, width, height })
        .toFile(path.join(outDir, `overflow_${el.id}.png`));
    } catch {
      // ignore per-element crop error
    }
  }
}

async function generateProblemThumbnails(screenshotPath, problems, elementMap, outDir) {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const meta = await sharp(screenshotPath).metadata();
  const imageWidth = Number(meta.width || 0);
  const imageHeight = Number(meta.height || 0);
  if (imageWidth <= 0 || imageHeight <= 0) return problems;

  const updated = [];
  for (const problem of problems || []) {
    const relatedIds = (problem.related_elements || [])
      .filter(rel => rel?.role === 'primary')
      .map(rel => rel.id);
    const targetIds = relatedIds.length
      ? relatedIds
      : (problem.related_elements || []).map(rel => rel.id);

    const boxes = targetIds
      .map(id => elementMap.get(id))
      .filter(Boolean)
      .filter(el => [el.x, el.y, el.width, el.height].every(Number.isFinite));

    if (!boxes.length) {
      updated.push(problem);
      continue;
    }

    const minX = Math.min(...boxes.map(el => el.x));
    const minY = Math.min(...boxes.map(el => el.y));
    const maxX = Math.max(...boxes.map(el => el.x + el.width));
    const maxY = Math.max(...boxes.map(el => el.y + el.height));

    const padX = 24;
    const padY = 24;
    const left = Math.max(0, Math.floor(minX - padX));
    const top = Math.max(0, Math.floor(minY - padY));
    const right = Math.min(imageWidth, Math.ceil(maxX + padX));
    const bottom = Math.min(imageHeight, Math.ceil(maxY + padY));
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);

    if (width < 12 || height < 12) {
      updated.push(problem);
      continue;
    }

    const outName = `problem_${problem.id}.png`;
    const outPath = path.join(outDir, outName);
    try {
      await sharp(screenshotPath)
        .extract({ left, top, width, height })
        .resize({ width: 320, height: 200, fit: 'inside', withoutEnlargement: true })
        .png()
        .toFile(outPath);
      updated.push({
        ...problem,
        thumbnail: `/problem_thumbs/${outName}`
      });
    } catch {
      updated.push(problem);
    }
  }

  return updated;
}

async function stabilizeDomForCapture(page) {
  await page.evaluate(() => {
    window.IntersectionObserver = class {
      constructor(callback) {
        this.callback = callback;
      }
      observe(target) {
        if (typeof this.callback === 'function') {
          const rect = target.getBoundingClientRect();
          this.callback([
            {
              isIntersecting: true,
              intersectionRatio: 1,
              target,
              boundingClientRect: rect,
              intersectionRect: rect,
              rootBounds: null,
              time: performance.now()
            }
          ], this);
        }
      }
      unobserve() {}
      disconnect() {}
    };
  });

  await page.addStyleTag({
    content: `
      * {
        animation: none !important;
        transition: none !important;
      }
    `
  });

  await page.evaluate(() => {
    document.querySelectorAll('img, iframe, video, source').forEach(el => {
      if (el.hasAttribute('loading')) {
        el.setAttribute('loading', 'eager');
      }
      const dataSrc = el.getAttribute('data-src') || el.getAttribute('data-lazy-src');
      const dataSrcset = el.getAttribute('data-srcset') || el.getAttribute('data-lazy-srcset');
      if (dataSrc && !el.getAttribute('src')) {
        el.setAttribute('src', dataSrc);
      }
      if (dataSrcset && !el.getAttribute('srcset')) {
        el.setAttribute('srcset', dataSrcset);
      }
      if (el.tagName === 'VIDEO') {
        el.setAttribute('preload', 'auto');
      }
    });

    window.scrollTo(0, document.body.scrollHeight);
  });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await page.evaluate(async () => {
    const images = Array.from(document.images || []);
    await Promise.all(
      images.map(img => {
        if (img.complete) return Promise.resolve();
        return new Promise(resolve => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
          setTimeout(resolve, 1500);
        });
      })
    );
  });
  await page.waitForTimeout(150);
}

async function navigateWithFallback(page, url) {
  const attempts = [
    { waitUntil: 'domcontentloaded', timeout: 45000 },
    { waitUntil: 'load', timeout: 60000 }
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      await page.goto(url, attempt);
      try {
        await page.waitForLoadState('networkidle', { timeout: 10000 });
      } catch {
        // Some sites keep long-lived connections; this is non-fatal.
      }
      return;
    } catch (err) {
      lastError = err;
      console.log(
        `goto failed (waitUntil=${attempt.waitUntil}, timeout=${attempt.timeout}): ${err.message}`
      );
    }
  }
  throw lastError;
}

async function detectSecurityChallenge(page, pageText) {
  const text = String(pageText || '').toLowerCase();
  const url = String(page.url() || '').toLowerCase();
  const indicators = [
    'additional security check is required',
    'imperva',
    'hcaptcha',
    'captcha challenge',
    'verify you are human',
    'i am human',
    '보안 검사',
    '사람입니다'
  ];
  const matched = indicators.filter(token => text.includes(token) || url.includes(token));

  let hasCaptchaNode = false;
  try {
    hasCaptchaNode = await page.evaluate(() => {
      const selectors = [
        'iframe[src*="hcaptcha"]',
        'iframe[src*="captcha"]',
        '[class*="captcha"]',
        '[id*="captcha"]',
        '[data-sitekey]'
      ];
      return selectors.some(sel => document.querySelector(sel));
    });
  } catch {
    hasCaptchaNode = false;
  }

  const blocked = matched.length > 0 || hasCaptchaNode;
  return {
    blocked,
    reason: blocked
      ? `Security challenge detected: ${matched.slice(0, 3).join(', ') || 'captcha element found'}`
      : ''
  };
}

function filterProblemsByRules(problems, clickableExists) {
  if (!Array.isArray(problems)) return [];

  const invalidContentPatterns = [/클라이언트/, /비즈니스 문제/, /기업 전략/, /마케팅 전략/, /서비스 자체 문제/];

  return problems.filter(problem => {
    if (typeof problem !== 'string') return false;
    if (invalidContentPatterns.some(pattern => pattern.test(problem))) return false;
    if (clickableExists && /CTA.*없|CTA.*부재|행동 유도.*없|행동 유도.*부재/i.test(problem)) return false;
    return true;
  });
}

function mergeResults({
  visualAnalysis,
  textAnalysis,
  clickableElements,
  cardElements,
  overflowElements,
  viewport,
  pageMeta,
  textAnalysisStatus = { status: 'ok', reason: '' },
  visualAnalysisStatus = { status: 'ok', reason: '' }
}) {
  const clickableExists = clickableElements.length > 0;
  const problems = filterProblemsByRules(textAnalysis.Problems, clickableExists);
  const problemObjects = buildProblemObjects(problems, clickableElements, cardElements);

  const ctaAnalysis = {
    ...visualAnalysis.cta_analysis,
    exists: Boolean(clickableExists || visualAnalysis.cta_elements.length > 0)
  };

  if (overflowElements.length > 0) {
    const overflowProblem = {
      id: `problem-overflow-${overflowElements[0].id}`,
      title: '가로 스크롤 영역의 콘텐츠 발견성이 낮습니다.',
      description: '일부 섹션에 가로 스크롤로 숨겨진 콘텐츠가 있어 사용자가 추가 정보를 놓치기 쉽고, 의사결정 전에 핵심 비교 정보를 충분히 확인하지 못할 수 있습니다.',
      severity: 'major',
      related_elements: overflowElements.slice(0, 2).map((el, idx) => ({
        id: el.id,
        role: idx === 0 ? 'primary' : 'secondary',
        reason: '가로 오버플로우로 인해 콘텐츠 발견성이 저하되는 실제 영역입니다.'
      })),
      thumbnail: `/overflows/overflow_${overflowElements[0].id}.png`
    };
    problemObjects.push(overflowProblem);
  }

  const visualInsights = {
    layout: visualAnalysis.layout,
    cta_strength: `${ctaAnalysis.visibility} ${ctaAnalysis.position_priority}`,
    content_balance: `${visualAnalysis.content_balance.dominant} / text:${visualAnalysis.content_balance.text_density} / visual:${visualAnalysis.content_balance.visual_density}`,
    section_clarity: visualAnalysis.structure_confidence.reason
  };

  return {
    Structure: textAnalysis.Structure,
    Problems: problemObjects,
    Improvements: textAnalysis.Improvements,
    KeyMessages: textAnalysis.KeyMessages,
    content_balance: visualAnalysis.content_balance,
    cta_analysis: ctaAnalysis,
    card_analysis: visualAnalysis.card_analysis,
    structure_confidence: visualAnalysis.structure_confidence,
    visual_insight_reasoning: [
      ...visualAnalysis.visual_insight_reasoning,
      ...(visualAnalysis.overflow_insight ? [visualAnalysis.overflow_insight] : [])
    ],
    spatial_analysis: {
      ...visualAnalysis.spatial_analysis,
      primary_cta_detected: Boolean(visualAnalysis.spatial_analysis.primary_cta_detected || ctaAnalysis.exists),
      interaction_density: visualAnalysis.spatial_analysis.interaction_density
    },
    overflow_sections: overflowElements,
    VisualInsights: visualInsights,
    Summary: textAnalysis.Summary,
    visual_analysis_status: visualAnalysisStatus.status,
    visual_analysis_reason: visualAnalysisStatus.reason || '',
    text_analysis_status: textAnalysisStatus.status,
    text_analysis_reason: textAnalysisStatus.reason || '',
    meta: {
      clickable_count: clickableElements.length,
      card_count: cardElements.length,
      overflow_count: overflowElements.length,
      viewport,
      page: pageMeta
    }
  };
}

function buildFallbackTextAnalysis(visualAnalysis, reason) {
  return {
    Structure: [
      `시각 분석 기준 레이아웃은 "${visualAnalysis.layout}"로 해석되었습니다.`,
      `구조 신뢰도는 ${visualAnalysis.structure_confidence.confidence}이며 사유는 "${visualAnalysis.structure_confidence.reason}" 입니다.`
    ],
    Problems: [
      '텍스트 분석 단계 실패로 문제-영향 매핑 정밀도가 제한되어 자동 진단 신뢰도가 낮아질 수 있습니다.',
      '시각 기반 CTA 품질 평가는 가능하지만 텍스트 맥락 결합이 약해 행동 유도 문구의 의미 정확도가 떨어질 수 있습니다.'
    ],
    Improvements: [
      '텍스트 입력 분할, 재시도, 스키마 정규화를 강화해 텍스트 분석 안정성을 높이면 UX 문제 추출 정확도가 개선됩니다.',
      '시각 분석 결과와 텍스트 분석 결과를 단계별 검증해 병합 시 누락/오판을 줄이는 파이프라인 가드레일을 추가하는 것이 좋습니다.'
    ],
    KeyMessages: [
      '현재 결과는 시각 분석 중심의 부분 통합 결과입니다.',
      `텍스트 분석 실패 원인: ${reason}`,
      '재실행 시 텍스트 근거를 보강하면 종합 진단 품질이 향상됩니다.'
    ],
    Summary:
      '시각 및 공간 분석은 완료되었으나 텍스트 분석이 실패해 최종 리포트가 부분 자동 보정 상태로 생성되었습니다. CTA 위치/인지성, 콘텐츠 밀도, 카드 프리뷰 품질은 판단되었지만 메시지 해석 정밀도는 제한적입니다.'
  };
}

async function run() {
  const url = process.argv[2] || 'https://saltcake.com';
  const cache = await readCache();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const viewport = { width: 1440, height: 900 };
  await page.setViewportSize(viewport);
  await page.addInitScript(() => {
    window.IntersectionObserver = class {
      constructor(callback) {
        this.callback = callback;
      }
      observe(target) {
        if (typeof this.callback === 'function') {
          const rect = target.getBoundingClientRect();
          this.callback([
            {
              isIntersecting: true,
              intersectionRatio: 1,
              target,
              boundingClientRect: rect,
              intersectionRect: rect,
              rootBounds: null,
              time: performance.now()
            }
          ], this);
        }
      }
      unobserve() {}
      disconnect() {}
    };
  });
  await navigateWithFallback(page, url);
  await page.addStyleTag({
    content: `
      body {
        overflow-x: hidden !important;
      }
      * {
        animation: none !important;
        transition: none !important;
      }
    `
  });
  await stabilizeDomForCapture(page);

  const text = await page.innerText('body');
  const challenge = await detectSecurityChallenge(page, text);
  if (challenge.blocked) {
    const pageMeta = await page.evaluate(() => {
      const doc = document.documentElement;
      return {
        width: Math.ceil(Math.max(doc.scrollWidth, doc.clientWidth, window.innerWidth)),
        height: Math.ceil(Math.max(doc.scrollHeight, doc.clientHeight, window.innerHeight))
      };
    });

    await captureStitchedScreenshot(page, 'screenshot.png', viewport, pageMeta.height);
    await fs.writeFile('clickable.json', JSON.stringify([], null, 2), 'utf8');
    await fs.writeFile('cards.json', JSON.stringify([], null, 2), 'utf8');
    await fs.writeFile('overflow.json', JSON.stringify([], null, 2), 'utf8');
    await fs.mkdir(path.join(process.cwd(), 'public'), { recursive: true });
    await fs.copyFile('screenshot.png', path.join(process.cwd(), 'public', 'annotated.png'));
    await fs.copyFile('screenshot.png', path.join(process.cwd(), 'public', 'page.png'));

    const blockedResult = {
      analysis_status: 'blocked_by_security_challenge',
      analysis_reason: challenge.reason,
      Structure: [],
      Problems: [],
      Improvements: [],
      KeyMessages: [],
      VisualInsights: {},
      Summary: '보안 인증(Imperva/hCaptcha) 페이지가 감지되어 실제 웹페이지 분석을 진행할 수 없습니다. 브라우저에서 인증 완료 후 다시 실행해주세요.',
      visual_analysis_status: 'failed',
      visual_analysis_reason: 'blocked_by_security_challenge',
      text_analysis_status: 'failed',
      text_analysis_reason: 'blocked_by_security_challenge',
      meta: {
        clickable_count: 0,
        card_count: 0,
        overflow_count: 0,
        viewport,
        page: pageMeta
      }
    };

    await fs.writeFile('visual.json', JSON.stringify({}, null, 2), 'utf8');
    await fs.writeFile('text_analysis.json', JSON.stringify({}, null, 2), 'utf8');
    await fs.writeFile('final.json', JSON.stringify(blockedResult, null, 2), 'utf8');
    await fs.writeFile('result.json', JSON.stringify(blockedResult, null, 2), 'utf8');
    await browser.close();

    console.log('Analysis blocked by security challenge.');
    console.log('\n=== 최종 분석 결과 ===');
    console.log(JSON.stringify(blockedResult, null, 2));
    return;
  }
  const importantTexts = await extractImportantTexts(page);
  const { clickable, cards, overflow, pageMeta } = await extractSpatialData(page);

  await fs.writeFile('clickable.json', JSON.stringify(clickable, null, 2), 'utf8');
  await fs.writeFile('cards.json', JSON.stringify(cards, null, 2), 'utf8');
  await fs.writeFile('overflow.json', JSON.stringify(overflow, null, 2), 'utf8');

  await captureStitchedScreenshot(page, 'screenshot.png', viewport, pageMeta.height);
  await createAnnotatedScreenshot(page, clickable, cards, overflow, 'annotated.png', viewport, pageMeta);
  await captureStitchedScreenshot(page, 'page.png', viewport, pageMeta.height);

  const allElementsForThumbs = [...clickable, ...cards];
  await generateElementThumbnails('screenshot.png', allElementsForThumbs, pageMeta, path.join(process.cwd(), 'public', 'thumbs'));
  await generateOverflowPreviews('screenshot.png', overflow, path.join(process.cwd(), 'public', 'overflows'));

  try {
    await fs.mkdir(path.join(process.cwd(), 'public'), { recursive: true });
    await fs.copyFile('annotated.png', path.join(process.cwd(), 'public', 'annotated.png'));
    await fs.copyFile('screenshot.png', path.join(process.cwd(), 'public', 'page.png'));
  } catch {
    // ignore copy failure
  }

  const imageCount = await page.$$eval('img', imgs => imgs.length);
  const textLength = text.length;
  const pageType = analyzePageType(textLength, imageCount);

  console.log('Text length:', textLength);
  console.log('Image count:', imageCount);
  console.log('Page type:', pageType);
  console.log('Clickable count:', clickable.length);
  console.log('Card count:', cards.length);
  console.log('Overflow section count:', overflow.length);

  await browser.close();

  console.log('Stage: visual analysis...');
  let visualAnalysisStatus = { status: 'ok', reason: '' };
  let visualRaw;
  try {
    visualRaw = await analyzeVisualWithQwen({
      screenshotPath: 'annotated.png',
      clickableBoxes: clickable,
      cardBoxes: cards,
      overflowBoxes: overflow,
      pageMeta
    });
  } catch (err) {
    console.error(`Visual analysis failed: ${err.message}`);
    visualAnalysisStatus = {
      status: 'failed',
      reason:
        err?.code === 'ALL_MODELS_COOLDOWN'
          ? 'all_models_cooling_down'
          : err?.code === 'ALL_KEYS_COOLDOWN'
            ? 'all_keys_cooling_down'
            : err?.status === 429
              ? 'rate_limited'
              : 'unknown_error'
    };
    visualRaw = {};
  }
  const visualAnalysis = normalizeVisualAnalysis(visualRaw, clickable.length, cards.length, pageMeta, overflow.length);
  await fs.writeFile('visual.json', JSON.stringify(visualAnalysis, null, 2), 'utf8');

  await fs.writeFile(
    'result.json',
    JSON.stringify(
      {
        Structure: ['시각/공간 분석 완료, 텍스트 분석 진행 중입니다.'],
        Problems: [],
        Improvements: [],
        KeyMessages: [],
        content_balance: visualAnalysis.content_balance,
        cta_analysis: visualAnalysis.cta_analysis,
        card_analysis: visualAnalysis.card_analysis,
        structure_confidence: visualAnalysis.structure_confidence,
        visual_insight_reasoning: visualAnalysis.visual_insight_reasoning,
        spatial_analysis: visualAnalysis.spatial_analysis,
        VisualInsights: {
          layout: visualAnalysis.layout,
          cta_strength: `${visualAnalysis.cta_analysis.visibility} ${visualAnalysis.cta_analysis.position_priority}`,
          content_balance: `${visualAnalysis.content_balance.dominant} / text:${visualAnalysis.content_balance.text_density} / visual:${visualAnalysis.content_balance.visual_density}`,
          section_clarity: visualAnalysis.structure_confidence.reason
        },
        overflow_sections: overflow,
        visual_analysis_status: visualAnalysisStatus.status,
        visual_analysis_reason: visualAnalysisStatus.reason || '',
        Summary: '중간 결과: 시각/공간 분석 완료, 텍스트 분석 대기'
      },
      null,
      2
    ),
    'utf8'
  );

  console.log('Stage: text analysis...');
  let textAnalysis;
  let textAnalysisStatus = { status: 'ok', reason: '' };
  try {
    textAnalysis = await enqueueTextTask(() =>
      analyzeTextWithStepfun({
        text,
        clickableElements: clickable,
        importantTexts,
        visualAnalysis
      })
    );
  } catch (err) {
    console.error(`Text analysis failed: ${err.message}`);
    textAnalysisStatus = {
      status: 'failed',
      reason:
        err?.code === 'ALL_MODELS_COOLDOWN'
          ? 'all_models_cooling_down'
          : err?.code === 'ALL_KEYS_COOLDOWN'
            ? 'all_keys_cooling_down'
            : err?.status === 429
              ? 'rate_limited'
              : 'unknown_error'
    };
    textAnalysis = buildFallbackTextAnalysis(visualAnalysis, err.message);
  }
  await fs.writeFile('text_analysis.json', JSON.stringify(textAnalysis, null, 2), 'utf8');

  const finalResult = mergeResults({
    visualAnalysis,
    textAnalysis,
    clickableElements: clickable,
    cardElements: cards,
    overflowElements: overflow,
    viewport,
    pageMeta,
    textAnalysisStatus,
    visualAnalysisStatus
  });

  const problemElementMap = new Map();
  [...clickable, ...cards, ...overflow].forEach(el => {
    if (el?.id) problemElementMap.set(el.id, el);
  });
  finalResult.Problems = await generateProblemThumbnails(
    'screenshot.png',
    finalResult.Problems,
    problemElementMap,
    path.join(process.cwd(), 'public', 'problem_thumbs')
  );

  await fs.writeFile('final.json', JSON.stringify(finalResult, null, 2), 'utf8');
  await fs.writeFile('result.json', JSON.stringify(finalResult, null, 2), 'utf8');

  cache[url] = {
    updatedAt: new Date().toISOString(),
    finalResult,
    visualAnalysis,
    textAnalysis,
    clickable,
    cards,
    overflow
  };
  await writeCache(cache);

  console.log('\n=== 최종 분석 결과 ===');
  console.log(JSON.stringify(finalResult, null, 2));
}

run().catch(err => {
  console.error('Run failed:', err.message);
  if (err.cause) {
    console.error('Cause:', err.cause.message || err.cause);
  }
  process.exitCode = 1;
});
