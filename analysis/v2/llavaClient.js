const fs = require('fs/promises');
const sharp = require('sharp');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/generate';
const LLAVA_MODEL = process.env.OLLAMA_LLAVA_MODEL || 'llava';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_LLAVA_TIMEOUT_MS || process.env.OLLAMA_TIMEOUT_MS || 240000);
const LLAVA_MAX_WIDTH = Number(process.env.OLLAMA_LLAVA_IMAGE_WIDTH || 960);

async function buildBase64Image(imagePath, targetWidth = LLAVA_MAX_WIDTH, quality = 72) {
  const imageBuffer = await fs.readFile(imagePath);
  const processed = await sharp(imageBuffer)
    .rotate()
    .resize({ width: targetWidth, withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
  return processed.toString('base64');
}

async function analyzeFrameWithLlava(imagePath, frameMeta, domAnalysis) {
  const prompt = [
    'Analyze this frame.',
    '',
    'Identify UI elements and layout.',
    'Describe only what is visible in concise Korean.',
    'Output must be Korean only.',
    'Do not use English sentences.',
    'Translate generic UI labels into Korean unless they are brand names or URLs.',
    'Do NOT evaluate UX.',
    '',
    `Frame index: ${frameMeta.index + 1}`,
    `Scroll position: ${frameMeta.scrollY}px`,
    `Page type hint: ${domAnalysis.pageType}`
  ].join('\n');

  const attempts = [
    { width: LLAVA_MAX_WIDTH, quality: 72 },
    { width: Math.max(640, Math.floor(LLAVA_MAX_WIDTH * 0.75)), quality: 58 }
  ];

  let lastError = null;
  for (const attempt of attempts) {
    const payload = {
      model: LLAVA_MODEL,
      stream: false,
      prompt,
      images: [await buildBase64Image(imagePath, attempt.width, attempt.quality)],
      options: {
        temperature: 0.1,
        num_predict: 220
      }
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        lastError = new Error(`LLaVA request timed out after ${OLLAMA_TIMEOUT_MS}ms.`);
      } else {
        lastError = new Error(`LLaVA fetch failed: ${err.message}`);
      }
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text();
      lastError = new Error(`LLaVA request failed (${response.status}): ${body}`);
      continue;
    }

    const data = await response.json();
    return {
      frame_index: frameMeta.index,
      scrollY: frameMeta.scrollY,
      observation: (data.response || '').trim()
    };
  }

  throw lastError || new Error('LLaVA request failed without a specific error.');
}

module.exports = {
  analyzeFrameWithLlava
};
