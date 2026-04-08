window.V3AnalysisPanel = function V3AnalysisPanel({
  result,
  selectedIssueId,
  onSelectIssue,
  selectedFrameIndex
}) {
  const T = {
    none: '\ud574\ub2f9 \uc774\uc288\uac00 \uc5c6\uc2b5\ub2c8\ub2e4.',
    runMeta: '\uc2e4\ud589 \uba54\ud0c0',
    strategy: '\uc694\uccad \uc804\ub7b5',
    logicalRequests: '\ub17c\ub9ac \uc694\uccad',
    httpAttempts: '\uc2e4\uc81c HTTP \uc2dc\ub3c4',
    requestSuccesses: '\uc131\uacf5',
    rateLimits: '429 \uc751\ub2f5',
    totalWait: '\ub300\uae30 \uc2dc\uac04',
    chunks: '\uba40\ud2f0\ubaa8\ub2ec \uccad\ud06c',
    synthesis: '\ud1b5\ud569 \ucd94\ub860',
    synthesisSkipped: '\uc0dd\ub7b5\ub428',
    synthesisDone: '\uc218\ud589\ub428',
    synthesisRetry: '\ucd95\uc57d \uc7ac\uc2dc\ub3c4',
    yes: '\uc608',
    no: '\uc544\ub2c8\uc624',
    frame: '\ud504\ub808\uc784',
    summary: '\uc694\uc57d',
    summaryEmpty: '\uc694\uc57d\uc774 \uc544\uc9c1 \uc5c6\uc2b5\ub2c8\ub2e4.',
    currentFrame: '\ud604\uc7ac \ud504\ub808\uc784',
    timeline: '\ud0c0\uc784\ub77c\uc778 \ubd84\uc11d',
    critical: '\uce58\uba85\uc801 \ubb38\uc81c',
    major: '\uc8fc\uc694 \ubb38\uc81c',
    minor: '\uacbd\ubbf8\ud55c \ubb38\uc81c',
    flow: '\ud50c\ub85c\uc6b0 \ubd84\uc11d',
    flowEmpty: '\ud50c\ub85c\uc6b0 \ubd84\uc11d \uacb0\uacfc\uac00 \uc5c6\uc2b5\ub2c8\ub2e4.',
    cta: 'CTA \ubd84\uc11d',
    ctaEmpty: 'CTA \ubd84\uc11d \uacb0\uacfc\uac00 \uc5c6\uc2b5\ub2c8\ub2e4.',
    spatial: '\uacf5\uac04 \ubd84\uc11d',
    spatialEmpty: '\uacf5\uac04 \ubd84\uc11d \uacb0\uacfc\uac00 \uc5c6\uc2b5\ub2c8\ub2e4.'
  };

  const issues = result?.enhanced_issues || [];
  const analysisMeta = result?.analysis_meta || null;
  const requestMeta = analysisMeta?.openrouter_requests || null;
  const synthesisMeta = analysisMeta?.synthesis || null;
  const grouped = {
    critical: issues.filter(item => item.severity === 'critical'),
    major: issues.filter(item => item.severity === 'major'),
    minor: issues.filter(item => item.severity === 'minor')
  };

  const IssueGroup = ({ label, items }) => (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 font-semibold text-slate-900">{label} ({items.length})</div>
      <div className="space-y-3">
        {items.length === 0 ? <div className="text-sm text-slate-500">{T.none}</div> : null}
        {items.map(issue => (
          <button
            key={issue.id}
            type="button"
            onClick={() => onSelectIssue(issue)}
            className={[
              'w-full rounded-2xl border p-4 text-left transition',
              selectedIssueId === issue.id ? 'border-sky-300 bg-sky-50' : 'border-slate-200 bg-white hover:border-slate-300'
            ].join(' ')}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="font-semibold text-slate-900">{issue.title}</div>
              <div className="text-xs text-slate-400">{`${T.frame} ${Number.isInteger(issue.frame_index) ? issue.frame_index + 1 : '-'}`}</div>
            </div>
            <div className="mt-2 text-sm leading-6 text-slate-600">{issue.description}</div>
          </button>
        ))}
      </div>
    </section>
  );

  return (
    <div className="min-w-0 space-y-4">
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="text-xs uppercase tracking-[0.2em] text-slate-400">{T.summary}</div>
        <div className="mt-2 text-base leading-7 text-slate-900">{result?.summary || T.summaryEmpty}</div>
        <div className="mt-3 text-sm text-slate-500">{`${T.currentFrame} ${selectedFrameIndex + 1}`}</div>
      </section>

      {analysisMeta ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 font-semibold text-slate-900">{T.runMeta}</div>
          <div className="grid grid-cols-2 gap-3 text-sm text-slate-300">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs text-slate-500">{T.strategy}</div>
              <div className="mt-1 font-semibold text-slate-900">{analysisMeta.request_strategy || '-'}</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs text-slate-500">{T.chunks}</div>
              <div className="mt-1 font-semibold text-slate-900">
                {`${analysisMeta?.multimodal?.chunk_count ?? '-'} / batch ${analysisMeta?.multimodal?.batch_size ?? '-'}`}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs text-slate-500">{T.logicalRequests}</div>
              <div className="mt-1 font-semibold text-slate-900">{requestMeta?.logicalCalls ?? '-'}</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs text-slate-500">{T.httpAttempts}</div>
              <div className="mt-1 font-semibold text-slate-900">{requestMeta?.httpAttempts ?? '-'}</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs text-slate-500">{T.requestSuccesses}</div>
              <div className="mt-1 font-semibold text-slate-900">{requestMeta?.successes ?? '-'}</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs text-slate-500">{T.rateLimits}</div>
              <div className="mt-1 font-semibold text-slate-900">{requestMeta?.rateLimitErrors ?? '-'}</div>
            </div>
          </div>
          <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
            <div><span className="text-slate-500">{T.totalWait}:</span> {requestMeta ? `${(Number(requestMeta.waitedMs || 0) / 1000).toFixed(1)}s` : '-'}</div>
            <div className="mt-1"><span className="text-slate-500">{T.synthesis}:</span> {synthesisMeta?.skipped ? `${T.synthesisSkipped} (${synthesisMeta.skipReason || '-'})` : synthesisMeta?.completed ? T.synthesisDone : '-'}</div>
            <div className="mt-1"><span className="text-slate-500">{T.synthesisRetry}:</span> {synthesisMeta ? (synthesisMeta.compactRetryAttempted ? T.yes : synthesisMeta.compactRetrySkipped ? `${T.synthesisSkipped} (${synthesisMeta.compactRetrySkipReason || '-'})` : T.no) : '-'}</div>
          </div>
        </section>
      ) : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 font-semibold text-slate-900">{T.timeline}</div>
        <div className="space-y-3">
          {(result?.timeline_analysis || []).map(item => (
            <div key={`timeline-${item.frame_index}`} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="text-sm font-semibold text-slate-900">{`${T.frame} ${item.frame_index + 1}`}</div>
              <div className="mt-1 text-sm text-slate-600">{item.summary}</div>
              <div className="mt-2 text-xs text-slate-500">{item.risk}</div>
            </div>
          ))}
        </div>
      </section>

      <IssueGroup label={T.critical} items={grouped.critical} />
      <IssueGroup label={T.major} items={grouped.major} />
      <IssueGroup label={T.minor} items={grouped.minor} />

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 font-semibold text-slate-900">{T.flow}</div>
        <div className="text-sm leading-6 text-slate-600">{result?.flow_analysis || T.flowEmpty}</div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 font-semibold text-slate-900">{T.cta}</div>
        <div className="whitespace-pre-wrap text-sm leading-6 text-slate-600">{result?.cta_analysis || T.ctaEmpty}</div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 font-semibold text-slate-900">{T.spatial}</div>
        <div className="whitespace-pre-wrap text-sm leading-6 text-slate-600">{result?.spatial_analysis || T.spatialEmpty}</div>
      </section>
    </div>
  );
};
