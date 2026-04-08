function buildDefaultCtaAnalysis(domAnalysis) {
  const clickables = domAnalysis.clickable || [];
  if (clickables.length === 0) {
    return '\uba85\ud655\ud55c CTA \uc694\uc18c\uac00 \uac70\uc758 \uac10\uc9c0\ub418\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4. \uc8fc\uc694 \ud589\ub3d9 \uc720\ub3c4 \uc694\uc18c\uc758 \uc704\uce58\uc640 \ubb38\uad6c\ub97c \ub2e4\uc2dc \uc810\uac80\ud560 \ud544\uc694\uac00 \uc788\uc2b5\ub2c8\ub2e4.';
  }

  const topAreaCount = clickables.filter(item => (item.y || 0) < 900).length;
  const primaryLabels = clickables
    .map(item => String(item.text || '').trim())
    .filter(Boolean)
    .slice(0, 5);

  return [
    `DOM \uae30\uc900 CTA \uc694\uc18c\ub294 \ucd1d ${clickables.length}\uac1c \uac10\uc9c0\ub418\uc5c8\uc2b5\ub2c8\ub2e4.`,
    `\uc774 \uc911 \uc0c1\ub2e8 \uc601\uc5ed\uc5d0 \ubc30\uce58\ub41c CTA\ub294 ${topAreaCount}\uac1c\ub85c, \ucd08\uae30 \uc9c4\uc785 \uc2dc \ud589\ub3d9 \uc720\ub3c4 \uac00\uc2dc\uc131\uc740 ${topAreaCount > 0 ? '\ud655\ubcf4\ub41c \ud3b8' : '\uc57d\ud55c \ud3b8'}\uc785\ub2c8\ub2e4.`,
    primaryLabels.length ? `\ub300\ud45c CTA \ubb38\uad6c \uc608\uc2dc\ub294 ${primaryLabels.join(', ')} \uc785\ub2c8\ub2e4.` : 'CTA \ubb38\uad6c\ub294 \ud14d\uc2a4\ud2b8 \uae30\uc900\uc73c\ub85c \ucda9\ubd84\ud788 \uc2dd\ubcc4\ub418\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4.'
  ].join(' ');
}

function buildDefaultSpatialAnalysis(domAnalysis, frames) {
  const cards = domAnalysis.cards || [];
  const overflow = domAnalysis.overflow || [];
  const frameCount = frames.length;

  return [
    `DOM \uae30\uc900 \uce74\ub4dc\ud615 \ube14\ub85d\uc740 ${cards.length}\uac1c, \uac00\ub85c \uc624\ubc84\ud50c\ub85c\uc6b0 \uad6c\uac04\uc740 ${overflow.length}\uac1c \uac10\uc9c0\ub418\uc5c8\uc2b5\ub2c8\ub2e4.`,
    `\ud0c0\uc784\ub77c\uc778 \ud504\ub808\uc784\uc740 \ucd1d ${frameCount}\uac1c \uc218\uc9d1\ub418\uc5c8\uc73c\uba70, \ud398\uc774\uc9c0\uc758 \uc8fc\uc694 \uad6c\uac04\uc744 \uc21c\ucc28\uc801\uc73c\ub85c \ud655\uc778\ud560 \uc218 \uc788\ub294 \uc218\uc900\uc73c\ub85c \uad6c\uc131\ub418\uc5c8\uc2b5\ub2c8\ub2e4.`,
    overflow.length > 0
      ? '\uc77c\ubd80 \uad6c\uac04\uc740 \uac00\ub85c \uc2a4\ud06c\ub864 \ub610\ub294 \uc228\uaca8\uc9c4 \ucf58\ud150\uce20 \uac00\ub2a5\uc131\uc774 \uc788\uc5b4 \uc0ac\uc6a9\uc790\uac00 \ub0b4\uc6a9\uc744 \ub193\uce60 \uc704\ud5d8\uc774 \uc788\uc2b5\ub2c8\ub2e4.'
      : '\uac00\ub85c \uc624\ubc84\ud50c\ub85c\uc6b0 \uc9d5\ud6c4\ub294 \ud06c\uc9c0 \uc54a\uc544 \uae30\ubcf8\uc801\uc778 \uacf5\uac04 \ud750\ub984\uc740 \ube44\uad50\uc801 \uc548\uc815\uc801\uc73c\ub85c \ubcf4\uc785\ub2c8\ub2e4.'
  ].join(' ');
}

function normalizeIssue(issue, idx, domAnalysis) {
  const clickableIds = (domAnalysis.clickable || []).slice(0, 3).map(item => item.id);
  const related = Array.isArray(issue.related_elements) && issue.related_elements.length
    ? issue.related_elements.map((id, relIdx) => ({
        id,
        role: relIdx === 0 ? 'primary' : 'secondary',
        reason: relIdx === 0
          ? '\uc8fc\uc694 \uc2dc\uac01 \uc99d\uac70\ub85c \uc5f0\uacb0\ub41c \uc694\uc18c\uc785\ub2c8\ub2e4.'
          : '\ubcf4\uc870 \uadfc\uac70 \uc694\uc18c\uc785\ub2c8\ub2e4.'
      }))
    : clickableIds.map((id, relIdx) => ({
        id,
        role: relIdx === 0 ? 'primary' : 'secondary',
        reason: '\ub3d9\uc801 CTA \ud6c4\ubcf4\uc640 \uc5f0\uacb0\ub41c \uae30\ubcf8 \uc99d\uac70\uc785\ub2c8\ub2e4.'
      }));

  return {
    id: issue.id || `v2-issue-${idx + 1}`,
    title: issue.title || `\uc774\uc288 ${idx + 1}`,
    description: issue.description || issue.title || '\uc124\uba85\uc774 \uc0dd\uc131\ub418\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4.',
    severity: ['critical', 'major', 'minor'].includes(issue.severity) ? issue.severity : 'major',
    frame_index: Number.isInteger(issue.frame_index) ? issue.frame_index : 0,
    related_elements: related
  };
}

function mergeV2Results(domAnalysis, frames, frameObservations, reasoning, options = {}) {
  const enhanced = Array.isArray(reasoning.enhanced_issues) ? reasoning.enhanced_issues : [];
  const timelineAnalysis = Array.isArray(reasoning.timeline_analysis) ? reasoning.timeline_analysis : [];

  return {
    analysis_version: options.analysis_version || 'v2',
    mode: options.mode || 'v2',
    summary: reasoning.summary || options.summary || '\ub85c\uceec Ollama \uae30\ubc18 V2 \ubd84\uc11d\uc774 \uc644\ub8cc\ub418\uc5c8\uc2b5\ub2c8\ub2e4.',
    enhanced_issues: enhanced.map((issue, idx) => normalizeIssue(issue, idx, domAnalysis)),
    new_issues: Array.isArray(reasoning.new_issues) ? reasoning.new_issues : [],
    validated_issues: Array.isArray(reasoning.validated_issues) ? reasoning.validated_issues : [],
    timeline_analysis: timelineAnalysis,
    flow_analysis: reasoning.flow_analysis || '\ud50c\ub85c\uc6b0 \ubd84\uc11d \uacb0\uacfc\uac00 \uc544\uc9c1 \uc0dd\uc131\ub418\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4.',
    cta_analysis: reasoning.cta_analysis || buildDefaultCtaAnalysis(domAnalysis),
    spatial_analysis: reasoning.spatial_analysis || buildDefaultSpatialAnalysis(domAnalysis, frames),
    dom_analysis: {
      page_type: domAnalysis.pageType,
      text_length: domAnalysis.textLength,
      image_count: domAnalysis.imageCount,
      important_texts: domAnalysis.importantTexts,
      clickable: domAnalysis.clickable,
      cards: domAnalysis.cards,
      overflow: domAnalysis.overflow,
      page: domAnalysis.pageMeta
    },
    timeline: frames,
    frame_observations: frameObservations
  };
}

module.exports = {
  mergeV2Results
};
