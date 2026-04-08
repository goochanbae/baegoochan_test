require('dotenv').config();
const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const rootDir = __dirname;
const publicDir = path.join(rootDir, 'public');
const resultPath = path.join(rootDir, 'result.json');
const resultV2Path = path.join(rootDir, 'v2_result.json');
const resultV3Path = path.join(rootDir, 'v3_result.json');
const historyV2Dir = path.join(rootDir, 'history', 'v2');
const historyV2IndexPath = path.join(historyV2Dir, 'index.json');
const historyV3Dir = path.join(rootDir, 'history', 'v3');
const historyV3IndexPath = path.join(historyV3Dir, 'index.json');
const clickablePath = path.join(rootDir, 'clickable.json');
const cardsPath = path.join(rootDir, 'cards.json');
const overflowPath = path.join(rootDir, 'overflow.json');

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use(express.static(publicDir, { etag: false, lastModified: false }));

const analysisState = {
  running: false,
  lastUrl: null,
  startedAt: null,
  endedAt: null,
  exitCode: null,
  error: null,
  logs: []
};

const analysisStateV2 = {
  running: false,
  lastUrl: null,
  startedAt: null,
  endedAt: null,
  exitCode: null,
  error: null,
  logs: []
};

const analysisStateV3 = {
  running: false,
  lastUrl: null,
  startedAt: null,
  endedAt: null,
  exitCode: null,
  error: null,
  logs: []
};

function pushLog(line, target = analysisState) {
  if (!line) return;
  target.logs.push(`[${new Date().toISOString()}] ${line}`);
  if (target.logs.length > 400) {
    target.logs = target.logs.slice(-400);
  }
}

function resetStateForRun(url, target = analysisState) {
  target.running = true;
  target.lastUrl = url;
  target.startedAt = new Date().toISOString();
  target.endedAt = null;
  target.exitCode = null;
  target.error = null;
  target.logs = [];
}

async function sendJsonFile(res, filePath, notFoundMessage) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    return res.json(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: notFoundMessage });
    }
    return res.status(500).json({ error: `Failed to load ${path.basename(filePath)}`, detail: err.message });
  }
}

app.get('/api/result', async (_req, res) => {
  return sendJsonFile(res, resultPath, 'result.json not found. Run analysis first.');
});

app.get('/api/v2/result', async (_req, res) => {
  return sendJsonFile(res, resultV2Path, 'v2_result.json not found. Run V2 analysis first.');
});

app.get('/api/v3/result', async (_req, res) => {
  return sendJsonFile(res, resultV3Path, 'v3_result.json not found. Run V3 analysis first.');
});

app.get('/api/v2/history', async (_req, res) => {
  try {
    const raw = await fs.readFile(historyV2IndexPath, 'utf8');
    const data = JSON.parse(raw);
    return res.json(Array.isArray(data) ? data : []);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.json([]);
    }
    return res.status(500).json({ error: 'Failed to load V2 history.', detail: err.message });
  }
});

app.get('/api/v3/history', async (_req, res) => {
  try {
    const raw = await fs.readFile(historyV3IndexPath, 'utf8');
    const data = JSON.parse(raw);
    return res.json(Array.isArray(data) ? data : []);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.json([]);
    }
    return res.status(500).json({ error: 'Failed to load V3 history.', detail: err.message });
  }
});

app.get('/api/v2/history/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) {
    return res.status(400).json({ error: 'history id is required.' });
  }

  try {
    const raw = await fs.readFile(historyV2IndexPath, 'utf8');
    const index = JSON.parse(raw);
    const item = Array.isArray(index) ? index.find(entry => entry.id === id) : null;
    if (!item?.filename) {
      return res.status(404).json({ error: 'History item not found.' });
    }
    return sendJsonFile(res, path.join(historyV2Dir, item.filename), 'History result not found.');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'History not found.' });
    }
    return res.status(500).json({ error: 'Failed to load V2 history item.', detail: err.message });
  }
});

app.get('/api/v3/history/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) {
    return res.status(400).json({ error: 'history id is required.' });
  }

  try {
    const raw = await fs.readFile(historyV3IndexPath, 'utf8');
    const index = JSON.parse(raw);
    const item = Array.isArray(index) ? index.find(entry => entry.id === id) : null;
    if (!item?.filename) {
      return res.status(404).json({ error: 'History item not found.' });
    }
    return sendJsonFile(res, path.join(historyV3Dir, item.filename), 'History result not found.');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'History not found.' });
    }
    return res.status(500).json({ error: 'Failed to load V3 history item.', detail: err.message });
  }
});

app.get('/api/clickable', async (_req, res) => {
  return sendJsonFile(res, clickablePath, 'clickable.json not found. Run analysis first.');
});

app.get('/api/cards', async (_req, res) => {
  return sendJsonFile(res, cardsPath, 'cards.json not found. Run analysis first.');
});

app.get('/api/overflow', async (_req, res) => {
  return sendJsonFile(res, overflowPath, 'overflow.json not found. Run analysis first.');
});

app.get('/api/status', (_req, res) => {
  res.json(analysisState);
});

app.get('/api/v2/status', (_req, res) => {
  res.json(analysisStateV2);
});

app.get('/api/v3/status', (_req, res) => {
  res.json(analysisStateV3);
});

app.post('/api/analyze', (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url) {
    return res.status(400).json({ error: 'url is required.' });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format.' });
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'URL must start with http:// or https://.' });
  }

  if (analysisState.running) {
    return res.status(409).json({ error: 'Analysis is already running.', status: analysisState });
  }

  resetStateForRun(url, analysisState);

  const child = spawn(process.execPath, ['index.js', url], {
    cwd: rootDir,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  pushLog(`Started analysis for ${url}`, analysisState);

  child.stdout.on('data', chunk => {
    pushLog(chunk.toString().trim(), analysisState);
  });

  child.stderr.on('data', chunk => {
    pushLog(`ERR: ${chunk.toString().trim()}`, analysisState);
  });

  child.on('close', code => {
    analysisState.running = false;
    analysisState.endedAt = new Date().toISOString();
    analysisState.exitCode = code;
    if (code !== 0) {
      analysisState.error = `Analysis exited with code ${code}`;
      pushLog(analysisState.error, analysisState);
    } else {
      pushLog('Analysis completed successfully.', analysisState);
    }
  });

  child.on('error', err => {
    analysisState.running = false;
    analysisState.endedAt = new Date().toISOString();
    analysisState.exitCode = -1;
    analysisState.error = err.message;
    pushLog(`Process error: ${err.message}`, analysisState);
  });

  return res.json({ ok: true, message: 'Analysis started.', status: analysisState });
});

app.post('/api/analyze-v2', (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url) {
    return res.status(400).json({ error: 'url is required.' });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format.' });
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'URL must start with http:// or https://.' });
  }

  if (analysisStateV2.running) {
    return res.status(409).json({ error: 'V2 analysis is already running.', status: analysisStateV2 });
  }

  resetStateForRun(url, analysisStateV2);

  const child = spawn(process.execPath, ['analysis/v2/runV2.js', url], {
    cwd: rootDir,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  pushLog(`Started V2 analysis for ${url}`, analysisStateV2);

  child.stdout.on('data', chunk => {
    pushLog(chunk.toString().trim(), analysisStateV2);
  });

  child.stderr.on('data', chunk => {
    pushLog(`ERR: ${chunk.toString().trim()}`, analysisStateV2);
  });

  child.on('close', code => {
    analysisStateV2.running = false;
    analysisStateV2.endedAt = new Date().toISOString();
    analysisStateV2.exitCode = code;
    if (code !== 0) {
      analysisStateV2.error = `V2 analysis exited with code ${code}`;
      pushLog(analysisStateV2.error, analysisStateV2);
    } else {
      pushLog('V2 analysis completed successfully.', analysisStateV2);
    }
  });

  child.on('error', err => {
    analysisStateV2.running = false;
    analysisStateV2.endedAt = new Date().toISOString();
    analysisStateV2.exitCode = -1;
    analysisStateV2.error = err.message;
    pushLog(`Process error: ${err.message}`, analysisStateV2);
  });

  return res.json({ ok: true, message: 'V2 analysis started.', status: analysisStateV2 });
});

app.post('/api/analyze-v3', (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url) {
    return res.status(400).json({ error: 'url is required.' });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format.' });
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'URL must start with http:// or https://.' });
  }

  if (analysisStateV3.running) {
    return res.status(409).json({ error: 'V3 analysis is already running.', status: analysisStateV3 });
  }

  resetStateForRun(url, analysisStateV3);

  const child = spawn(process.execPath, ['analysis/v3/runV3.js', url], {
    cwd: rootDir,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  pushLog(`Started V3 analysis for ${url}`, analysisStateV3);

  child.stdout.on('data', chunk => {
    pushLog(chunk.toString().trim(), analysisStateV3);
  });

  child.stderr.on('data', chunk => {
    pushLog(`ERR: ${chunk.toString().trim()}`, analysisStateV3);
  });

  child.on('close', code => {
    analysisStateV3.running = false;
    analysisStateV3.endedAt = new Date().toISOString();
    analysisStateV3.exitCode = code;
    if (code !== 0) {
      analysisStateV3.error = `V3 analysis exited with code ${code}`;
      pushLog(analysisStateV3.error, analysisStateV3);
    } else {
      pushLog('V3 analysis completed successfully.', analysisStateV3);
    }
  });

  child.on('error', err => {
    analysisStateV3.running = false;
    analysisStateV3.endedAt = new Date().toISOString();
    analysisStateV3.exitCode = -1;
    analysisStateV3.error = err.message;
    pushLog(`Process error: ${err.message}`, analysisStateV3);
  });

  return res.json({ ok: true, message: 'V3 analysis started.', status: analysisStateV3 });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/v1', (_req, res) => {
  res.sendFile(path.join(publicDir, 'v1.html'));
});

app.get('/v2', (_req, res) => {
  res.sendFile(path.join(publicDir, 'v2.html'));
});

app.get('/v3', (_req, res) => {
  res.sendFile(path.join(publicDir, 'v3.html'));
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`UX dashboard running at http://localhost:${PORT}`);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Close existing process or use PORT=3001 npm start`);
    process.exit(1);
  }
  console.error(err.message);
  process.exit(1);
});
