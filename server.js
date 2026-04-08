require('dotenv').config();
const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function loadHistoryIndex(indexPath) {
  try {
    const raw = await fs.readFile(indexPath, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function loadV3ResultById(id) {
  if (!id) {
    const raw = await fs.readFile(resultV3Path, 'utf8');
    return JSON.parse(raw);
  }

  const index = await loadHistoryIndex(historyV3IndexPath);
  const item = index.find(entry => entry.id === id);
  if (!item?.filename) {
    const err = new Error('History item not found.');
    err.status = 404;
    throw err;
  }
  const raw = await fs.readFile(path.join(historyV3Dir, item.filename), 'utf8');
  return JSON.parse(raw);
}

function buildPdfList(items, emptyText, renderItem) {
  if (!Array.isArray(items) || items.length === 0) {
    return `<div class="empty">${escapeHtml(emptyText)}</div>`;
  }
  return items.map(renderItem).join('');
}

function buildV3PdfHtml(result) {
  const summary = escapeHtml(result?.summary || '');
  const meta = result?.analysis_meta || {};
  const requests = meta.openrouter_requests || {};
  const multimodal = meta.multimodal || {};
  const synthesis = meta.synthesis || {};
  const issues = Array.isArray(result?.enhanced_issues) ? result.enhanced_issues : [];
  const timeline = Array.isArray(result?.timeline_analysis) ? result.timeline_analysis : [];
  const url = escapeHtml(result?.dom_analysis?.page?.url || result?.url || '');

  const metricCards = [
    ['논리 요청', requests.logicalCalls ?? '-'],
    ['HTTP 시도', requests.httpAttempts ?? '-'],
    ['성공', requests.successes ?? '-'],
    ['429 응답', requests.rateLimitErrors ?? '-'],
    ['프레임 수', multimodal.frame_count ?? '-'],
    ['청크 / 배치', `${multimodal.chunk_count ?? '-'} / ${multimodal.batch_size ?? '-'}`]
  ].map(([label, value]) => `
    <div class="metric">
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-value">${escapeHtml(value)}</div>
    </div>
  `).join('');

  return `
    <!doctype html>
    <html lang="ko">
    <head>
      <meta charset="UTF-8" />
      <style>
        body {
          margin: 0;
          padding: 32px;
          color: #0f172a;
          background: #f8fafc;
          font-family: "Apple SD Gothic Neo", "Malgun Gothic", Arial, sans-serif;
        }
        .page-title {
          font-size: 28px;
          font-weight: 700;
          margin-bottom: 6px;
        }
        .sub {
          color: #64748b;
          font-size: 12px;
          margin-bottom: 20px;
        }
        .panel {
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 18px;
          padding: 18px;
          margin-bottom: 16px;
        }
        .panel h2 {
          margin: 0 0 12px;
          font-size: 16px;
        }
        .summary {
          white-space: pre-wrap;
          line-height: 1.8;
          font-size: 14px;
        }
        .grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
        }
        .metric {
          border: 1px solid #e2e8f0;
          border-radius: 14px;
          padding: 12px;
          background: #f8fafc;
        }
        .metric-label {
          font-size: 11px;
          color: #64748b;
          margin-bottom: 6px;
        }
        .metric-value {
          font-size: 22px;
          font-weight: 700;
        }
        .issue, .timeline-item {
          border-top: 1px solid #e2e8f0;
          padding-top: 12px;
          margin-top: 12px;
        }
        .issue:first-child, .timeline-item:first-child {
          border-top: none;
          padding-top: 0;
          margin-top: 0;
        }
        .issue-title {
          font-weight: 700;
          font-size: 14px;
        }
        .muted {
          color: #64748b;
          font-size: 12px;
        }
        .desc, .risk {
          margin-top: 6px;
          line-height: 1.7;
          font-size: 13px;
          white-space: pre-wrap;
        }
        .empty {
          color: #94a3b8;
          font-size: 13px;
        }
      </style>
    </head>
    <body>
      <div class="page-title">V3 UX 분석 보고서</div>
      <div class="sub">URL: ${url || '-'} / 생성 시각: ${escapeHtml(new Date().toISOString())}</div>

      <section class="panel">
        <h2>요약</h2>
        <div class="summary">${summary || '요약 정보가 없습니다.'}</div>
      </section>

      <section class="panel">
        <h2>실행 메타</h2>
        <div class="grid">${metricCards}</div>
        <div class="desc" style="margin-top:12px;">
          요청 전략: ${escapeHtml(meta.request_strategy || '-')}<br />
          총 대기 시간: ${escapeHtml(`${((Number(requests.waitedMs || 0)) / 1000).toFixed(1)}s`)}<br />
          통합 추론: ${escapeHtml(synthesis.skipped ? `생략 (${synthesis.skipReason || '-'})` : synthesis.completed ? '수행' : '-')}<br />
          축약 재시도: ${escapeHtml(synthesis.compactRetryAttempted ? '예' : synthesis.compactRetrySkipped ? `생략 (${synthesis.compactRetrySkipReason || '-'})` : '아니오')}
        </div>
      </section>

      <section class="panel">
        <h2>주요 이슈</h2>
        ${buildPdfList(issues, '이슈가 없습니다.', issue => `
          <div class="issue">
            <div class="issue-title">${escapeHtml(issue.title || '이슈')}</div>
            <div class="muted">심각도: ${escapeHtml(issue.severity || '-')} / 프레임: ${escapeHtml(Number.isInteger(issue.frame_index) ? issue.frame_index + 1 : '-')}</div>
            <div class="desc">${escapeHtml(issue.description || '')}</div>
          </div>
        `)}
      </section>

      <section class="panel">
        <h2>타임라인 분석</h2>
        ${buildPdfList(timeline, '타임라인 분석 결과가 없습니다.', item => `
          <div class="timeline-item">
            <div class="issue-title">프레임 ${escapeHtml(Number.isInteger(item.frame_index) ? item.frame_index + 1 : '-')}</div>
            <div class="desc">${escapeHtml(item.summary || '')}</div>
            <div class="risk">${escapeHtml(item.risk || '')}</div>
          </div>
        `)}
      </section>
    </body>
    </html>
  `;
}

async function renderPdfBufferFromHtml(html) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', right: '12mm', bottom: '16mm', left: '12mm' }
    });
  } finally {
    await browser.close();
  }
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

app.get('/api/v3/export/pdf', async (req, res) => {
  const id = String(req.query?.id || '').trim();

  try {
    const result = await loadV3ResultById(id);
    const html = buildV3PdfHtml(result);
    const pdfBuffer = await renderPdfBufferFromHtml(html);
    const safeName = `v3-analysis-${Date.now()}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    return res.send(pdfBuffer);
  } catch (err) {
    if (err.status === 404 || err.code === 'ENOENT') {
      return res.status(404).json({ error: 'PDF로 내보낼 분석 결과를 찾지 못했습니다.' });
    }
    return res.status(500).json({ error: 'PDF 생성에 실패했습니다.', detail: err.message });
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

  pushLog(`V3 분석을 시작했습니다: ${url}`, analysisStateV3);

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
      analysisStateV3.error = `V3 분석 프로세스가 종료 코드 ${code}로 끝났습니다.`;
      pushLog(analysisStateV3.error, analysisStateV3);
    } else {
      pushLog('V3 분석이 정상적으로 완료되었습니다.', analysisStateV3);
    }
  });

  child.on('error', err => {
    analysisStateV3.running = false;
    analysisStateV3.endedAt = new Date().toISOString();
    analysisStateV3.exitCode = -1;
    analysisStateV3.error = err.message;
    pushLog(`프로세스 오류: ${err.message}`, analysisStateV3);
  });

  return res.json({ ok: true, message: 'V3 분석을 시작했습니다.', status: analysisStateV3 });
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
