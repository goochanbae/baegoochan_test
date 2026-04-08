const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

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

async function collectFrames(page, options = {}) {
  const outDir = options.outDir;
  const step = options.step || 420;
  const maxFrames = options.maxFrames || 18;
  const delayMs = options.delayMs || 280;
  const viewport = options.viewport || { width: 1440, height: 900 };
  const imageBasePath = String(options.imageBasePath || '/v2/frames').replace(/\/$/, '');

  if (!outDir) {
    throw new Error('collectFrames requires outDir.');
  }

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const pageMeta = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      width: Math.ceil(Math.max(doc.scrollWidth, doc.clientWidth, window.innerWidth)),
      height: Math.ceil(Math.max(doc.scrollHeight, doc.clientHeight, window.innerHeight))
    };
  });

  const positions = [];
  for (let y = 0; y < pageMeta.height; y += step) {
    positions.push(y);
    if (positions.length >= maxFrames) break;
  }
  const lastStart = Math.max(0, pageMeta.height - viewport.height);
  if (!positions.includes(lastStart)) {
    positions.push(lastStart);
  }

  const frames = [];
  for (let i = 0; i < positions.length; i += 1) {
    const y = positions[i];
    const framePath = path.join(outDir, `frame_${String(i + 1).padStart(3, '0')}.png`);

    for (const pause of [delayMs, delayMs + 260, delayMs + 620]) {
      await settleAfterScroll(page, y, viewport.height);
      await page.waitForTimeout(pause);
      await page.screenshot({ path: framePath, fullPage: false });
      const blank = await isLikelyBlankTile(framePath);
      if (!blank || pause === delayMs + 620) break;
    }

    frames.push({
      id: `frame-${i + 1}`,
      index: i,
      scrollY: y,
      scrollPercent: Math.round((y / Math.max(1, pageMeta.height - viewport.height)) * 100),
      image: `${imageBasePath}/${path.basename(framePath)}`
    });
  }

  return {
    frames,
    pageMeta
  };
}

module.exports = {
  collectFrames
};
