require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const { analyzeDom } = require('../v1/domAnalysis');
const { createCrawler, closeCrawler } = require('../v2/crawler');
const { collectFrames } = require('../v2/frameCollector');
const { mergeV2Results } = require('../v2/merger');
const {
  buildCompactSynthesisPayload,
  getConfiguredApiKeys,
  getConfiguredModels,
  getModelDebugSnapshot,
  getRequestDebugStats,
  resetRequestDebugStats,
  runGemmaSynthesisReasoning,
  runGemmaVisionReasoning,
  truncateText
} = require('./gemmaClient');

const historyDir = path.join(process.cwd(), 'history', 'v3');
const historyIndexPath = path.join(historyDir, 'index.json');

function pickImportantTexts(items, limit = 10) {
  return (items || [])
    .slice()
    .sort((a, b) => (b.fontSize || 0) - (a.fontSize || 0))
    .slice(0, limit)
    .map(item => ({
      text: truncateText(item.text, 160),
      fontSize: item.fontSize
    }));
}

function chunkItems(items, maxPerChunk) {
  const chunks = [];
  for (let index = 0; index < items.length; index += maxPerChunk) {
    chunks.push(items.slice(index, index + maxPerChunk));
  }
  return chunks;
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

function dedupeFrameObservations(items) {
  const byFrame = new Map();
  for (const item of items || []) {
    if (!Number.isInteger(item?.frame_index)) continue;
    if (!byFrame.has(item.frame_index)) {
      byFrame.set(item.frame_index, item);
    }
  }
  return Array.from(byFrame.values()).sort((a, b) => a.frame_index - b.frame_index);
}

function buildChunkReasoningPayload(basePayload, framesInChunk) {
  const frameIndexes = new Set(framesInChunk.map(item => item.index));
  return {
    dom_analysis: basePayload.dom_analysis,
    chunk_meta: {
      start_frame_index: framesInChunk[0]?.index ?? 0,
      end_frame_index: framesInChunk[framesInChunk.length - 1]?.index ?? 0,
      chunk_size: framesInChunk.length
    },
    frame_inputs: framesInChunk.map(frame => ({
      frame_index: frame.index,
      scrollY: frame.scrollY,
      scrollPercent: frame.scrollPercent,
      image: frame.image
    })),
    timeline: (basePayload.timeline || []).filter(item => frameIndexes.has(item.frame_index))
  };
}

function buildSynthesisPayload(basePayload, chunkAnalyses) {
  return {
    dom_analysis: basePayload.dom_analysis,
    timeline: basePayload.timeline,
    chunk_analyses: chunkAnalyses.map((chunk, index) => ({
      chunk_index: index,
      frame_range: chunk.frame_range,
      summary: truncateText(chunk.summary, 180),
      issue_count: Array.isArray(chunk.enhanced_issues) ? chunk.enhanced_issues.length : 0,
      issues: (chunk.enhanced_issues || []).slice(0, 4).map(issue => ({
        title: truncateText(issue.title, 64),
        description: truncateText(issue.description, 140),
        severity: issue.severity,
        frame_index: issue.frame_index
      })),
      timeline_analysis: (chunk.timeline_analysis || []).map(item => ({
        frame_index: item.frame_index,
        summary: truncateText(item.summary, 100),
        risk: truncateText(item.risk, 100)
      })),
      frame_observations: (chunk.frame_observations || []).map(item => ({
        frame_index: item.frame_index,
        observation: truncateText(item.observation, 120)
      })),
      flow_signal: truncateText(chunk.flow_analysis, 140),
      cta_signal: truncateText(chunk.cta_analysis, 140),
      spatial_signal: truncateText(chunk.spatial_analysis, 140)
    }))
  };
}

function buildFallbackChunkReasoning(framesInChunk, errorMessage) {
  return {
    summary: `프레임 ${framesInChunk[0]?.index + 1 || 1}부터 ${framesInChunk[framesInChunk.length - 1]?.index + 1 || 1}까지의 멀티모달 분석이 실패했습니다.`,
    frame_observations: framesInChunk.map(frame => ({
      frame_index: frame.index,
      observation: `멀티모달 분석 실패: ${errorMessage}`
    })),
    enhanced_issues: [],
    timeline_analysis: framesInChunk.map(frame => ({
      frame_index: frame.index,
      summary: `프레임 ${frame.index + 1} 분석 실패`,
      risk: errorMessage
    })),
    flow_analysis: `청크 분석 실패: ${errorMessage}`,
    cta_analysis: '멀티모달 청크 분석 실패로 CTA 종합 판단을 생성하지 못했습니다.',
    spatial_analysis: '멀티모달 청크 분석 실패로 공간 구조 종합 판단을 생성하지 못했습니다.'
  };
}

function combineChunkReasonings(chunkAnalyses, synthesisReasoning) {
  const chunkIssues = dedupeIssues(
    chunkAnalyses.flatMap(chunk => (Array.isArray(chunk.enhanced_issues) ? chunk.enhanced_issues : []))
  );
  const chunkTimeline = chunkAnalyses
    .flatMap(chunk => (Array.isArray(chunk.timeline_analysis) ? chunk.timeline_analysis : []))
    .sort((a, b) => (a.frame_index || 0) - (b.frame_index || 0));
  const chunkObservations = dedupeFrameObservations(
    chunkAnalyses.flatMap(chunk => (Array.isArray(chunk.frame_observations) ? chunk.frame_observations : []))
  );

  if (!synthesisReasoning) {
    return {
      summary: chunkAnalyses.map(item => item.summary).filter(Boolean).join(' '),
      frame_observations: chunkObservations,
      enhanced_issues: chunkIssues,
      new_issues: [],
      validated_issues: [],
      timeline_analysis: chunkTimeline,
      flow_analysis: chunkAnalyses.map(item => item.flow_analysis).filter(Boolean).join(' '),
      cta_analysis: chunkAnalyses.map(item => item.cta_analysis).filter(Boolean).join(' '),
      spatial_analysis: chunkAnalyses.map(item => item.spatial_analysis).filter(Boolean).join(' ')
    };
  }

  return {
    summary: synthesisReasoning.summary || chunkAnalyses.map(item => item.summary).filter(Boolean).join(' '),
    frame_observations: chunkObservations,
    enhanced_issues: dedupeIssues([
      ...chunkIssues,
      ...(Array.isArray(synthesisReasoning.enhanced_issues) ? synthesisReasoning.enhanced_issues : [])
    ]),
    new_issues: Array.isArray(synthesisReasoning.new_issues) ? synthesisReasoning.new_issues : [],
    validated_issues: Array.isArray(synthesisReasoning.validated_issues) ? synthesisReasoning.validated_issues : [],
    timeline_analysis: Array.isArray(synthesisReasoning.timeline_analysis) && synthesisReasoning.timeline_analysis.length
      ? synthesisReasoning.timeline_analysis
      : chunkTimeline,
    flow_analysis: synthesisReasoning.flow_analysis || chunkAnalyses.map(item => item.flow_analysis).filter(Boolean).join(' '),
    cta_analysis: synthesisReasoning.cta_analysis || chunkAnalyses.map(item => item.cta_analysis).filter(Boolean).join(' '),
    spatial_analysis: synthesisReasoning.spatial_analysis || chunkAnalyses.map(item => item.spatial_analysis).filter(Boolean).join(' ')
  };
}

async function writeV3Result(result) {
  await fs.writeFile(path.join(process.cwd(), 'v3_result.json'), JSON.stringify(result, null, 2), 'utf8');
}

async function saveV3History(result, url) {
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
  if (!url) throw new Error('URL is required for V3 analysis.');
  resetRequestDebugStats();

  const configuredKeys = getConfiguredApiKeys();
  const configuredModels = getConfiguredModels();
  console.log(`V3 OpenRouter API 키 수: ${configuredKeys.length}`);
  console.log(`V3 설정 모델: ${configuredModels.join(', ')}`);

  const viewport = {
    width: Number(process.env.V3_VIEWPORT_WIDTH || process.env.V2_VIEWPORT_WIDTH || 1280),
    height: Number(process.env.V3_VIEWPORT_HEIGHT || process.env.V2_VIEWPORT_HEIGHT || 880)
  };

  const domAnalysis = await analyzeDom(url, { viewport });
  console.log(`V3 DOM 분석 완료. 클릭 요소 ${domAnalysis.clickable.length}개, 카드 ${domAnalysis.cards.length}개`);

  const session = await createCrawler(url, { viewport });
  try {
    const framesDir = path.join(process.cwd(), 'public', 'v3', 'frames');
    const { frames, pageMeta } = await collectFrames(session.page, {
      outDir: framesDir,
      viewport,
      step: Number(process.env.V3_FRAME_STEP || process.env.V2_FRAME_STEP || 560),
      maxFrames: Number(process.env.V3_MAX_FRAMES || process.env.V2_MAX_FRAMES || 10),
      delayMs: 260
    });
    console.log(`V3 프레임 수집 완료. 프레임 ${frames.length}개`);

    const enrichedFrames = frames.map(frame => ({
      ...frame,
      imagePath: path.join(process.cwd(), 'public', frame.image.replace(/^\//, '').replace(/\//g, path.sep))
    }));

    const reasoningBasePayload = {
      dom_analysis: {
        page_type: domAnalysis.pageType,
        text_length: domAnalysis.textLength,
        image_count: domAnalysis.imageCount,
        important_texts: pickImportantTexts(domAnalysis.importantTexts, 10),
        clickable_count: domAnalysis.clickable.length,
        card_count: domAnalysis.cards.length,
        overflow_count: domAnalysis.overflow.length
      },
      timeline: frames.map(frame => ({
        frame_index: frame.index,
        scrollY: frame.scrollY,
        scrollPercent: frame.scrollPercent
      }))
    };

    const batchSize = Number(process.env.V3_MULTIMODAL_BATCH_SIZE || 12);
    const frameChunks = chunkItems(enrichedFrames, Math.max(1, batchSize));
    const chunkAnalyses = [];
    let reasoningStatus = { status: 'ok', reason: '' };
    const synthesisMeta = {
      attempted: false,
      completed: false,
      skipped: false,
      skipReason: '',
      compactRetryAttempted: false,
      compactRetryCompleted: false,
      compactRetrySkipped: false,
      compactRetrySkipReason: ''
    };
    console.log(`V3 멀티모달 청크 계획. 청크 ${frameChunks.length}개, 청크 크기 ${batchSize}`);

    for (let chunkIndex = 0; chunkIndex < frameChunks.length; chunkIndex += 1) {
      const framesInChunk = frameChunks[chunkIndex];
      const chunkPayload = buildChunkReasoningPayload(reasoningBasePayload, framesInChunk);
      try {
        console.log(`V3 멀티모달 청크 시작 ${chunkIndex + 1}/${frameChunks.length}`);
        const chunkReasoning = await runGemmaVisionReasoning(chunkPayload, framesInChunk);
        if (chunkReasoning.__meta) {
          console.log(`V3 멀티모달 청크 성공 ${chunkIndex + 1}/${frameChunks.length}: 키 슬롯 ${chunkReasoning.__meta.keySlot}, 모델 ${chunkReasoning.__meta.model}`);
        }
        chunkAnalyses.push({
          ...chunkReasoning,
          frame_range: {
            start: chunkPayload.chunk_meta.start_frame_index,
            end: chunkPayload.chunk_meta.end_frame_index
          }
        });
        console.log(`V3 멀티모달 청크 완료 ${chunkIndex + 1}/${frameChunks.length}`);
      } catch (err) {
        reasoningStatus = { status: 'partial', reason: `chunk ${chunkIndex + 1} fallback: ${err.message}` };
        chunkAnalyses.push({
          ...buildFallbackChunkReasoning(framesInChunk, err.message),
          frame_range: {
            start: chunkPayload.chunk_meta.start_frame_index,
            end: chunkPayload.chunk_meta.end_frame_index
          }
        });
        console.error(`V3 멀티모달 청크 실패 ${chunkIndex + 1}/${frameChunks.length}: 키 슬롯 ${err.keySlot || '?/?'}, 모델 ${err.model || 'unknown'}, ${err.message}`);
        console.log(`V3 실패 후 모델 상태: ${JSON.stringify(getModelDebugSnapshot(configuredModels))}`);
      }
    }

    let reasoning;
    if (chunkAnalyses.length === 1) {
      synthesisMeta.skipped = true;
      synthesisMeta.skipReason = 'single_chunk';
      console.log('V3 통합 추론 생략: 단일 청크 결과로 충분합니다.');
      reasoning = {
        ...chunkAnalyses[0],
        new_issues: [],
        validated_issues: []
      };
    } else {
      try {
        synthesisMeta.attempted = true;
        console.log('V3 통합 추론 시작');
        const synthesisPayload = buildSynthesisPayload(reasoningBasePayload, chunkAnalyses);
        const synthesisReasoning = await runGemmaSynthesisReasoning(synthesisPayload);
        if (synthesisReasoning.__meta) {
          console.log(`V3 통합 추론 성공: 키 슬롯 ${synthesisReasoning.__meta.keySlot}, 모델 ${synthesisReasoning.__meta.model}`);
        }
        synthesisMeta.completed = true;
        reasoning = combineChunkReasonings(chunkAnalyses, synthesisReasoning);
        console.log('V3 통합 추론 완료');
      } catch (err) {
        console.error(`V3 통합 추론 실패: 키 슬롯 ${err.keySlot || '?/?'}, 모델 ${err.model || 'unknown'}, ${err.message}`);
        if (err.status === 429) {
          synthesisMeta.compactRetrySkipped = true;
          synthesisMeta.compactRetrySkipReason = 'rate_limited';
          console.log('V3 축약 재시도 생략: 직전 통합 추론이 429로 실패했습니다.');
          reasoning = combineChunkReasonings(chunkAnalyses, null);
          reasoningStatus = {
            status: reasoningStatus.status === 'ok' ? 'failed' : reasoningStatus.status,
            reason: err.message
          };
        } else try {
          synthesisMeta.compactRetryAttempted = true;
          console.log('V3 축약 재시도 시작');
          const compactPayload = buildCompactSynthesisPayload(buildSynthesisPayload(reasoningBasePayload, chunkAnalyses));
          const synthesisReasoning = await runGemmaSynthesisReasoning(compactPayload);
          if (synthesisReasoning.__meta) {
            console.log(`V3 축약 재시도 성공: 키 슬롯 ${synthesisReasoning.__meta.keySlot}, 모델 ${synthesisReasoning.__meta.model}`);
          }
          synthesisMeta.compactRetryCompleted = true;
          reasoning = combineChunkReasonings(chunkAnalyses, synthesisReasoning);
          reasoningStatus = {
            status: reasoningStatus.status === 'ok' ? 'recovered' : reasoningStatus.status,
            reason: `compact synthesis retry after: ${err.message}`
          };
          console.log('V3 축약 페이로드로 통합 추론을 복구했습니다.');
        } catch (retryErr) {
          console.error(`V3 축약 재시도 실패: 키 슬롯 ${retryErr.keySlot || '?/?'}, 모델 ${retryErr.model || 'unknown'}, ${retryErr.message}`);
          reasoning = combineChunkReasonings(chunkAnalyses, null);
          reasoningStatus = {
            status: reasoningStatus.status === 'ok' ? 'failed' : reasoningStatus.status,
            reason: retryErr.message
          };
        }
      }
    }

    const frameObservations = dedupeFrameObservations(
      Array.isArray(reasoning.frame_observations) ? reasoning.frame_observations : []
    ).map(item => ({
      frame_index: item.frame_index,
      scrollY: frames[item.frame_index]?.scrollY ?? 0,
      observation: item.observation || ''
    }));

    const finalResult = mergeV2Results(
      { ...domAnalysis, pageMeta },
      frames,
      frameObservations,
      reasoning,
      {
        analysis_version: 'v3',
        mode: 'v3',
        summary: 'OpenRouter Gemma 멀티모달 기반 V3 분석이 완료되었습니다.'
      }
    );

    finalResult.reasoning_status = reasoningStatus.status;
    finalResult.reasoning_reason = reasoningStatus.reason;
    finalResult.analysis_meta = {
      request_strategy: 'minimize_requests',
      openrouter_requests: getRequestDebugStats(),
      multimodal: {
        frame_count: frames.length,
        chunk_count: frameChunks.length,
        batch_size: batchSize
      },
      synthesis: synthesisMeta
    };

    console.log(`V3 요청 요약: ${JSON.stringify(finalResult.analysis_meta.openrouter_requests)}`);

    await writeV3Result(finalResult);
    await saveV3History(finalResult, url);
    console.log('V3 분석이 완료되었습니다.');
    console.log(JSON.stringify(finalResult, null, 2));
  } finally {
    await closeCrawler(session);
  }
}

run().catch(err => {
  console.error(`V3 실행 실패: ${err.message}`);
  process.exitCode = 1;
});
