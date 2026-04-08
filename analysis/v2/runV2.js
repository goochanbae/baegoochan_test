require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const { analyzeDom } = require('../v1/domAnalysis');
const { createCrawler, closeCrawler } = require('./crawler');
const { collectFrames } = require('./frameCollector');
const { analyzeFrameWithLlava } = require('./llavaClient');
const { runLlamaReasoning } = require('./llamaClient');
const { mergeV2Results } = require('./merger');
const historyDir = path.join(process.cwd(), 'history', 'v2');
const historyIndexPath = path.join(historyDir, 'index.json');

function truncateText(value, limit = 900) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function pickImportantTexts(items, limit = 8) {
  return (items || [])
    .slice()
    .sort((a, b) => (b.fontSize || 0) - (a.fontSize || 0))
    .slice(0, limit)
    .map(item => ({
      text: truncateText(item.text, 120),
      fontSize: item.fontSize
    }));
}

function buildFallbackTimeline(frameObservations) {
  return frameObservations.map(item => ({
    frame_index: item.frame_index,
    summary: item.error
      ? `\ud504\ub808\uc784 ${item.frame_index + 1} \uad00\ucc30\uc5d0 \uc2e4\ud328\ud588\uc2b5\ub2c8\ub2e4.`
      : `\ud504\ub808\uc784 ${item.frame_index + 1}\uc5d0\uc11c \uc2dc\uac01 \uad00\ucc30 \uacb0\uacfc\uac00 \uc218\uc9d1\ub418\uc5c8\uc2b5\ub2c8\ub2e4.`,
    risk: item.error
      ? `\uad00\ucc30 \uc2e4\ud328: ${item.error}`
      : '\uc2dc\uac01 \uad00\ucc30 \uae30\ubc18 \uc784\uc2dc \ubd84\uc11d\uc785\ub2c8\ub2e4.'
  }));
}

function buildFallbackReasoning(frameObservations, domAnalysis, errorMessage) {
  const clickables = domAnalysis.clickable || [];
  const cards = domAnalysis.cards || [];
  const overflow = domAnalysis.overflow || [];

  return {
    summary: 'Llama3 \ucd94\ub860 \ub2e8\uacc4\uac00 \uc2e4\ud328\ud558\uc5ec DOM\uacfc \ud504\ub808\uc784 \uad00\ucc30 \uacb0\uacfc \uc911\uc2ec\uc758 \ubd80\ubd84 \ubd84\uc11d\ub9cc \ubc18\ud658\ud569\ub2c8\ub2e4.',
    enhanced_issues: [],
    new_issues: [],
    validated_issues: [],
    timeline_analysis: buildFallbackTimeline(frameObservations),
    flow_analysis: `\ucd5c\uc885 UX \ucd94\ub860 \ub2e8\uacc4\uac00 \uc2e4\ud328\ud588\uc2b5\ub2c8\ub2e4. \ud604\uc7ac\ub294 DOM \ub370\uc774\ud130\uc640 \ud504\ub808\uc784 \uad00\ucc30\ub9cc \ud45c\uc2dc\ud558\uace0 \uc788\uc2b5\ub2c8\ub2e4. \uc624\ub958: ${errorMessage}`,
    cta_analysis: clickables.length
      ? `DOM \uae30\uc900 CTA \uc694\uc18c ${clickables.length}\uac1c\uac00 \uac10\uc9c0\ub418\uc5c8\uc2b5\ub2c8\ub2e4. \ub2e4\ub9cc \ucd5c\uc885 \ucd94\ub860\uc774 \uc2e4\ud328\ud574 \uac00\uc2dc\uc131, \uc6b0\uc120\uc21c\uc704, \ubb38\uad6c \uc801\ud569\uc131\uc5d0 \ub300\ud55c \uc885\ud569 \ud3c9\uac00\ub294 \uc81c\ud55c\uc801\uc785\ub2c8\ub2e4.`
      : '\uba85\ud655\ud55c CTA \uc694\uc18c\uac00 \uac70\uc758 \uac10\uc9c0\ub418\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4. CTA \ubb38\uad6c\uc640 \uc704\uce58\ub97c \ub2e4\uc2dc \ud655\uc778\ud560 \ud544\uc694\uac00 \uc788\uc2b5\ub2c8\ub2e4.',
    spatial_analysis: `DOM \uae30\uc900 \uce74\ub4dc\ud615 \ube14\ub85d ${cards.length}\uac1c, \uac00\ub85c \uc624\ubc84\ud50c\ub85c\uc6b0 \uad6c\uac04 ${overflow.length}\uac1c\uac00 \uac10\uc9c0\ub418\uc5c8\uc2b5\ub2c8\ub2e4. \uacf5\uac04 \uad6c\uc870\uc5d0 \ub300\ud55c \ucd5c\uc885 \ud3c9\uac00\ub294 \uc2e4\ud328\ud588\uc9c0\ub9cc \uae30\ubcf8 \uad6c\uc870 \uc9d5\ud6c4\ub294 \ud655\uc778\ub418\uc5c8\uc2b5\ub2c8\ub2e4.`
  };
}

function buildCompactReasoningPayload(payload) {
  const observations = payload.frame_observations || [];
  const limit = 8;
  const compact = observations.length <= limit
    ? observations
    : observations.filter((_, index) => {
        if (index === 0 || index === observations.length - 1) return true;
        const stride = Math.max(1, Math.floor(observations.length / (limit - 2)));
        return index % stride === 0;
      }).slice(0, limit);

  return {
    ...payload,
    frame_observations: compact.map(item => ({
      frame_index: item.frame_index,
      scrollY: item.scrollY,
      observation: truncateText(item.observation, 180),
      error: item.error || null
    })),
    timeline: (payload.timeline || []).filter(item =>
      compact.some(observation => observation.frame_index === item.frame_index)
    )
  };
}

function chunkItems(items, maxPerChunk = 3) {
  const chunks = [];
  for (let index = 0; index < items.length; index += maxPerChunk) {
    chunks.push(items.slice(index, index + maxPerChunk));
  }
  return chunks;
}

function buildChunkReasoningPayload(basePayload, observationChunk) {
  const frameIndexes = new Set(observationChunk.map(item => item.frame_index));
  return {
    dom_analysis: basePayload.dom_analysis,
    chunk_meta: {
      start_frame_index: observationChunk[0]?.frame_index ?? 0,
      end_frame_index: observationChunk[observationChunk.length - 1]?.frame_index ?? 0,
      chunk_size: observationChunk.length
    },
    frame_observations: observationChunk,
    timeline: (basePayload.timeline || []).filter(item => frameIndexes.has(item.frame_index))
  };
}

function buildSynthesisPayload(basePayload, chunkAnalyses) {
  return {
    dom_analysis: basePayload.dom_analysis,
    timeline: (basePayload.timeline || []).map(item => ({
      frame_index: item.frame_index,
      scrollPercent: item.scrollPercent
    })),
    chunk_analyses: chunkAnalyses.map((chunk, index) => ({
      chunk_index: index,
      frame_range: chunk.frame_range,
      summary: truncateText(chunk.summary, 120),
      issue_count: Array.isArray(chunk.enhanced_issues) ? chunk.enhanced_issues.length : 0,
      issues: (chunk.enhanced_issues || []).slice(0, 2).map(issue => ({
        title: truncateText(issue.title, 48),
        severity: issue.severity,
        frame_index: issue.frame_index
      })),
      timeline_analysis: (chunk.timeline_analysis || []).slice(0, 2).map(item => ({
        frame_index: item.frame_index,
        summary: truncateText(item.summary, 80),
        risk: truncateText(item.risk, 80)
      })),
      flow_signal: truncateText(chunk.flow_analysis, 100),
      cta_signal: truncateText(chunk.cta_analysis, 100),
      spatial_signal: truncateText(chunk.spatial_analysis, 100)
    }))
  };
}

function dedupeIssues(issues) {
  const seen = new Set();
  return issues.filter(issue => {
    const key = [
      String(issue.title || '').trim().toLowerCase(),
      String(issue.description || '').trim().toLowerCase(),
      issue.frame_index,
      issue.severity
    ].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function combineChunkReasonings(chunkAnalyses, synthesisReasoning) {
  const chunkIssues = dedupeIssues(
    chunkAnalyses.flatMap(chunk => Array.isArray(chunk.enhanced_issues) ? chunk.enhanced_issues : [])
  );
  const chunkTimeline = chunkAnalyses
    .flatMap(chunk => Array.isArray(chunk.timeline_analysis) ? chunk.timeline_analysis : [])
    .sort((a, b) => (a.frame_index || 0) - (b.frame_index || 0));

  const synthesisIssues = Array.isArray(synthesisReasoning?.enhanced_issues)
    ? synthesisReasoning.enhanced_issues
    : [];
  const mergedIssues = dedupeIssues([...chunkIssues, ...synthesisIssues]);

  return {
    summary: synthesisReasoning?.summary || chunkAnalyses.map(item => item.summary).filter(Boolean).join(' '),
    enhanced_issues: mergedIssues,
    new_issues: Array.isArray(synthesisReasoning?.new_issues) ? synthesisReasoning.new_issues : [],
    validated_issues: Array.isArray(synthesisReasoning?.validated_issues) ? synthesisReasoning.validated_issues : [],
    timeline_analysis: Array.isArray(synthesisReasoning?.timeline_analysis) && synthesisReasoning.timeline_analysis.length
      ? synthesisReasoning.timeline_analysis
      : chunkTimeline,
    flow_analysis: synthesisReasoning?.flow_analysis || chunkAnalyses.map(item => item.flow_analysis).filter(Boolean).join(' '),
    cta_analysis: synthesisReasoning?.cta_analysis || chunkAnalyses.map(item => item.cta_analysis).filter(Boolean).join(' '),
    spatial_analysis: synthesisReasoning?.spatial_analysis || chunkAnalyses.map(item => item.spatial_analysis).filter(Boolean).join(' ')
  };
}

async function runChunkReasoningWithRetry(chunkPayload, chunkIndex, totalChunks) {
  const maxAttempts = Number(process.env.V2_REASONING_CHUNK_RETRY || 2) + 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      console.log(`V2 chunk reasoning start ${chunkIndex + 1}/${totalChunks} attempt ${attempt}/${maxAttempts}`);
      const reasoning = await runLlamaReasoning(chunkPayload, { mode: 'chunk' });
      console.log(`V2 chunk reasoning complete ${chunkIndex + 1}/${totalChunks} attempt ${attempt}/${maxAttempts}`);
      return reasoning;
    } catch (err) {
      lastError = err;
      console.error(`V2 chunk reasoning failed ${chunkIndex + 1}/${totalChunks} attempt ${attempt}/${maxAttempts}: ${err.message}`);
      if (attempt < maxAttempts) {
        console.log(`V2 chunk reasoning retry ${chunkIndex + 1}/${totalChunks} next attempt ${attempt + 1}/${maxAttempts}`);
      }
    }
  }

  throw lastError;
}

async function writeV2Result(result) {
  await fs.writeFile(path.join(process.cwd(), 'v2_result.json'), JSON.stringify(result, null, 2), 'utf8');
}

async function saveV2History(result, url) {
  await fs.mkdir(historyDir, { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
  const filename = `${id}.json`;
  const filePath = path.join(historyDir, filename);
  const summary = {
    id,
    url,
    createdAt: new Date().toISOString(),
    summary: result.summary || '',
    reasoning_status: result.reasoning_status || 'ok',
    filename
  };

  let index = [];
  try {
    index = JSON.parse(await fs.readFile(historyIndexPath, 'utf8'));
    if (!Array.isArray(index)) index = [];
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  index.unshift(summary);
  index = index.slice(0, 50);

  await fs.writeFile(filePath, JSON.stringify(result, null, 2), 'utf8');
  await fs.writeFile(historyIndexPath, JSON.stringify(index, null, 2), 'utf8');
}

async function run() {
  const url = process.argv[2];
  if (!url) throw new Error('URL is required for V2 analysis.');

  const viewport = {
    width: Number(process.env.V2_VIEWPORT_WIDTH || 1280),
    height: Number(process.env.V2_VIEWPORT_HEIGHT || 880)
  };

  const domAnalysis = await analyzeDom(url, { viewport });
  console.log(`V2 DOM analysis complete. Clickables: ${domAnalysis.clickable.length}, cards: ${domAnalysis.cards.length}`);

  const session = await createCrawler(url, { viewport });
  try {
    const framesDir = path.join(process.cwd(), 'public', 'v2', 'frames');
    const { frames, pageMeta } = await collectFrames(session.page, {
      outDir: framesDir,
      viewport,
      step: Number(process.env.V2_FRAME_STEP || 520),
      maxFrames: Number(process.env.V2_MAX_FRAMES || 10),
      delayMs: 260
    });
    console.log(`V2 frame collection complete. Frames: ${frames.length}`);

    const frameObservations = [];
    for (const frame of frames) {
      const filePath = path.join(process.cwd(), 'public', frame.image.replace(/^\//, '').replace(/\//g, path.sep));
      try {
        const observation = await analyzeFrameWithLlava(filePath, frame, domAnalysis);
        frameObservations.push(observation);
        console.log(`V2 LLaVA observation complete for frame ${frame.index + 1}/${frames.length}`);
      } catch (err) {
        frameObservations.push({
          frame_index: frame.index,
          scrollY: frame.scrollY,
          observation: '',
          error: err.message
        });
        console.error(`V2 LLaVA observation failed for frame ${frame.index + 1}/${frames.length}: ${err.message}`);
      }
    }

    const reasoningPayload = {
      dom_analysis: {
        page_type: domAnalysis.pageType,
        text_length: domAnalysis.textLength,
        image_count: domAnalysis.imageCount,
        important_texts: pickImportantTexts(domAnalysis.importantTexts, 8),
        clickable_count: domAnalysis.clickable.length,
        card_count: domAnalysis.cards.length,
        overflow_count: domAnalysis.overflow.length
      },
      frame_observations: frameObservations.map(item => ({
        frame_index: item.frame_index,
        scrollY: item.scrollY,
        observation: truncateText(item.observation, 420),
        error: item.error || null
      })),
      timeline: frames.map(frame => ({
        frame_index: frame.index,
        scrollY: frame.scrollY,
        scrollPercent: frame.scrollPercent
      }))
    };

    let reasoning;
    let reasoningStatus = { status: 'ok', reason: '' };
    const chunkSize = Number(process.env.V2_REASONING_CHUNK_SIZE || 3);
    const observationChunks = chunkItems(reasoningPayload.frame_observations, chunkSize);
    const chunkAnalyses = [];
    console.log(`V2 chunk reasoning planned. Chunks: ${observationChunks.length}, chunk size: ${chunkSize}`);

    for (let chunkIndex = 0; chunkIndex < observationChunks.length; chunkIndex += 1) {
      const chunkPayload = buildChunkReasoningPayload(reasoningPayload, observationChunks[chunkIndex]);
      try {
        const chunkReasoning = await runChunkReasoningWithRetry(chunkPayload, chunkIndex, observationChunks.length);
        chunkAnalyses.push({
          ...chunkReasoning,
          frame_range: {
            start: chunkPayload.chunk_meta.start_frame_index,
            end: chunkPayload.chunk_meta.end_frame_index
          }
        });
      } catch (err) {
        chunkAnalyses.push({
          ...buildFallbackReasoning(chunkPayload.frame_observations, domAnalysis, err.message),
          frame_range: {
            start: chunkPayload.chunk_meta.start_frame_index,
            end: chunkPayload.chunk_meta.end_frame_index
          }
        });
        reasoningStatus = { status: 'partial', reason: `chunk ${chunkIndex + 1} fallback: ${err.message}` };
        console.error(`V2 chunk reasoning exhausted ${chunkIndex + 1}/${observationChunks.length}: ${err.message}`);
      }
    }

    try {
      console.log('V2 synthesis reasoning start');
      const synthesisPayload = buildSynthesisPayload(reasoningPayload, chunkAnalyses);
      const synthesisReasoning = await runLlamaReasoning(synthesisPayload, { mode: 'synthesis' });
      reasoning = combineChunkReasonings(chunkAnalyses, synthesisReasoning);
      if (reasoningStatus.status === 'ok') {
        reasoningStatus = { status: 'ok', reason: '' };
      }
      console.log('V2 synthesis reasoning complete');
    } catch (err) {
      console.error(`V2 Llama3 synthesis failed: ${err.message}`);
      try {
        console.log('V2 synthesis compact retry start');
        const compactPayload = buildCompactReasoningPayload(buildSynthesisPayload(reasoningPayload, chunkAnalyses));
        const synthesisReasoning = await runLlamaReasoning(compactPayload, { mode: 'synthesis' });
        reasoning = combineChunkReasonings(chunkAnalyses, synthesisReasoning);
        reasoningStatus = {
          status: reasoningStatus.status === 'ok' ? 'recovered' : reasoningStatus.status,
          reason: `compact synthesis retry after: ${err.message}`
        };
        console.log('V2 Llama3 synthesis recovered with compact payload.');
      } catch (retryErr) {
        console.error(`V2 Llama3 compact synthesis failed: ${retryErr.message}`);
        reasoning = combineChunkReasonings(chunkAnalyses, null);
        if (!reasoning.summary) {
          reasoning = buildFallbackReasoning(frameObservations, domAnalysis, retryErr.message);
        }
        reasoningStatus = {
          status: reasoningStatus.status === 'ok' ? 'failed' : reasoningStatus.status,
          reason: retryErr.message
        };
      }
    }

    const finalResult = mergeV2Results(
      { ...domAnalysis, pageMeta },
      frames,
      frameObservations,
      reasoning
    );

    finalResult.reasoning_status = reasoningStatus.status;
    finalResult.reasoning_reason = reasoningStatus.reason;
    finalResult.frame_observation_errors = frameObservations
      .filter(item => item.error)
      .map(item => ({
        frame_index: item.frame_index,
        error: item.error
      }));

    await writeV2Result(finalResult);
    await saveV2History(finalResult, url);
    console.log('V2 analysis completed successfully.');
    console.log(JSON.stringify(finalResult, null, 2));
  } finally {
    await closeCrawler(session);
  }
}

run().catch(err => {
  console.error(`V2 run failed: ${err.message}`);
  process.exitCode = 1;
});
