require('dotenv').config();

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const model = process.argv[2] || 'google/gemma-4-31b-it:free';
const prompt = process.argv.slice(3).join(' ').trim() || 'Say hello in Korean and English in one short sentence.';
const REQUEST_TIMEOUT_MS = 20000;

function getConfiguredApiKeys() {
  const keys = [];

  if (process.env.OPENROUTER_API_KEYS) {
    process.env.OPENROUTER_API_KEYS
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
    .sort((a, b) => Number(a.split('_').pop()) - Number(b.split('_').pop()))
    .forEach(name => {
      const value = String(process.env[name] || '').trim();
      if (value) keys.push(value);
    });

  return Array.from(new Set(keys.filter(Boolean)));
}

async function requestWithKey(apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://localhost',
      'X-Title': 'OpenRouter Model Test'
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    }),
    signal: controller.signal
  }).finally(() => {
    clearTimeout(timeout);
  });

  const bodyText = await response.text();
  let data;

  try {
    data = JSON.parse(bodyText);
  } catch {
    data = null;
  }

  if (!response.ok) {
    const err = new Error(`OpenRouter error ${response.status}: ${bodyText}`);
    err.status = response.status;
    throw err;
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`No content returned: ${bodyText}`);
  }

  return content;
}

async function main() {
  const apiKeys = getConfiguredApiKeys();

  if (!apiKeys.length) {
    throw new Error('Missing OPENROUTER_API_KEY in .env');
  }

  let lastError;

  for (let i = 0; i < apiKeys.length; i += 1) {
    try {
      const content = await requestWithKey(apiKeys[i]);
      console.log(`MODEL: ${model}`);
      console.log(`KEY SLOT: ${i + 1}/${apiKeys.length}`);
      console.log('RESPONSE:');
      console.log(content);
      return;
    } catch (err) {
      lastError = err;
      if (err.name === 'AbortError') {
        lastError = new Error(`OpenRouter request timed out after ${REQUEST_TIMEOUT_MS}ms.`);
      }
      if (err.status === 429 && i < apiKeys.length - 1) {
        continue;
      }
      throw lastError;
    }
  }

  throw lastError || new Error('OpenRouter request failed.');
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
