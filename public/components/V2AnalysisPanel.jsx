window.V2AnalysisPanel = function V2AnalysisPanel({
  result,
  selectedIssueId,
  onSelectIssue,
  selectedFrameIndex
}) {
  const T = {
    none: '\ud574\ub2f9 \uc774\uc288\uac00 \uc5c6\uc2b5\ub2c8\ub2e4.',
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
  const grouped = {
    critical: issues.filter(item => item.severity === 'critical'),
    major: issues.filter(item => item.severity === 'major'),
    minor: issues.filter(item => item.severity === 'minor')
  };

  const IssueGroup = ({ label, items }) => (
    <section className="rounded-2xl border border-white/10 bg-[#101929] p-4">
      <div className="mb-3 font-semibold text-slate-100">{label} ({items.length})</div>
      <div className="space-y-3">
        {items.length === 0 ? <div className="text-sm text-slate-500">{T.none}</div> : null}
        {items.map(issue => (
          <button
            key={issue.id}
            type="button"
            onClick={() => onSelectIssue(issue)}
            className={[
              'w-full rounded-2xl border p-4 text-left transition',
              selectedIssueId === issue.id ? 'border-cyan-300 bg-cyan-300/10' : 'border-white/10 bg-[#0B1320] hover:border-white/20'
            ].join(' ')}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="font-semibold text-slate-100">{issue.title}</div>
              <div className="text-xs text-slate-400">{`${T.frame} ${Number.isInteger(issue.frame_index) ? issue.frame_index + 1 : '-'}`}</div>
            </div>
            <div className="mt-2 text-sm leading-6 text-slate-300">{issue.description}</div>
          </button>
        ))}
      </div>
    </section>
  );

  return (
    <div className="min-w-0 space-y-4">
      <section className="rounded-2xl border border-white/10 bg-[#101929] p-4">
        <div className="text-xs uppercase tracking-[0.2em] text-slate-500">{T.summary}</div>
        <div className="mt-2 text-base leading-7 text-slate-100">{result?.summary || T.summaryEmpty}</div>
        <div className="mt-3 text-sm text-slate-400">{`${T.currentFrame} ${selectedFrameIndex + 1}`}</div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-[#101929] p-4">
        <div className="mb-3 font-semibold text-slate-100">{T.timeline}</div>
        <div className="space-y-3">
          {(result?.timeline_analysis || []).map(item => (
            <div key={`timeline-${item.frame_index}`} className="rounded-xl border border-white/10 bg-[#0B1320] p-3">
              <div className="text-sm font-semibold text-slate-100">{`${T.frame} ${item.frame_index + 1}`}</div>
              <div className="mt-1 text-sm text-slate-300">{item.summary}</div>
              <div className="mt-2 text-xs text-slate-500">{item.risk}</div>
            </div>
          ))}
        </div>
      </section>

      <IssueGroup label={T.critical} items={grouped.critical} />
      <IssueGroup label={T.major} items={grouped.major} />
      <IssueGroup label={T.minor} items={grouped.minor} />

      <section className="rounded-2xl border border-white/10 bg-[#101929] p-4">
        <div className="mb-3 font-semibold text-slate-100">{T.flow}</div>
        <div className="text-sm leading-6 text-slate-300">{result?.flow_analysis || T.flowEmpty}</div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-[#101929] p-4">
        <div className="mb-3 font-semibold text-slate-100">{T.cta}</div>
        <div className="whitespace-pre-wrap text-sm leading-6 text-slate-300">{result?.cta_analysis || T.ctaEmpty}</div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-[#101929] p-4">
        <div className="mb-3 font-semibold text-slate-100">{T.spatial}</div>
        <div className="whitespace-pre-wrap text-sm leading-6 text-slate-300">{result?.spatial_analysis || T.spatialEmpty}</div>
      </section>
    </div>
  );
};
