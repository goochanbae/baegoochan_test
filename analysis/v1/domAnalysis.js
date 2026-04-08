const { chromium } = require('playwright');

async function navigateWithFallback(page, url) {
  const attempts = [
    { waitUntil: 'domcontentloaded', timeout: 45000 },
    { waitUntil: 'load', timeout: 60000 }
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      await page.goto(url, attempt);
      try {
        await page.waitForLoadState('networkidle', { timeout: 10000 });
      } catch {
        // Long-lived requests are common on marketing sites.
      }
      return;
    } catch (err) {
      lastError = err;
      console.log(`V1 DOM navigate fallback (${attempt.waitUntil}): ${err.message}`);
    }
  }
  throw lastError;
}

async function extractImportantTexts(page) {
  const candidates = await page.evaluate(() => {
    const tags = 'h1,h2,h3,h4,h5,h6,p,a,button,li,span,strong,em,label,div';
    const elements = Array.from(document.querySelectorAll(tags));
    const seen = new Set();
    const items = [];

    for (const el of elements) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length >= 100) continue;

      const fontSize = Number.parseFloat(window.getComputedStyle(el).fontSize || '0');
      if (Number.isNaN(fontSize) || fontSize < 18) continue;

      const key = `${text}::${fontSize}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ text, fontSize: Number(fontSize.toFixed(2)) });
    }
    return items;
  });

  return candidates.sort((a, b) => b.fontSize - a.fontSize).slice(0, 10);
}

async function extractSpatialData(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const pageMeta = {
      width: Math.ceil(Math.max(doc.scrollWidth, doc.clientWidth, window.innerWidth)),
      height: Math.ceil(Math.max(doc.scrollHeight, doc.clientHeight, window.innerHeight))
    };

    const toBox = (el, extra = {}) => {
      const rect = el.getBoundingClientRect();
      return {
        text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
        ...extra,
        x: Number(rect.x.toFixed(2)),
        y: Number((rect.y + window.scrollY).toFixed(2)),
        width: Number(rect.width.toFixed(2)),
        height: Number(rect.height.toFixed(2))
      };
    };

    const clickable = Array.from(document.querySelectorAll('a, button, [role="button"], input[type="button"], input[type="submit"]'))
      .map((el, idx) => {
        const style = window.getComputedStyle(el);
        const box = toBox(el, {
          id: `cta-${idx + 1}`,
          type: 'cta',
          tag: el.tagName,
          href: typeof el.href === 'string' ? el.href : null
        });
        return { box, style };
      })
      .filter(({ box, style }) => {
        if (!box.text || box.text.length < 2) return false;
        if (box.width < 40 || box.height < 20) return false;
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (Number(style.opacity || '1') <= 0.02) return false;
        return true;
      })
      .map(({ box }) => box)
      .slice(0, 180);

    const cards = Array.from(document.querySelectorAll('section, article, [class*="card" i], [class*="item" i], [data-card], [role="article"]'))
      .map((el, idx) => toBox(el, { id: `card-${idx + 1}`, type: 'card', tag: el.tagName }))
      .filter(item => item.width > 120 && item.height > 80)
      .slice(0, 240);

    const overflow = Array.from(document.querySelectorAll('section, article, main, div, ul, ol'))
      .filter(el => el.scrollWidth > el.clientWidth + 20)
      .map((el, idx) => toBox(el, { id: `overflow-${idx + 1}`, type: 'overflow', tag: el.tagName }))
      .filter(item => item.width > 120 && item.height > 60)
      .slice(0, 60);

    return { clickable, cards, overflow, pageMeta };
  });
}

function analyzePageType(textLength, imageCount) {
  if (textLength < 300 && imageCount > 5) return 'image-heavy';
  if (textLength > 1000) return 'text-heavy';
  return 'mixed';
}

async function analyzeDom(url, options = {}) {
  const viewport = options.viewport || { width: 1440, height: 900 };
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize(viewport);

  try {
    await navigateWithFallback(page, url);
    await page.addStyleTag({
      content: `
        body { overflow-x: hidden !important; }
        * { animation: none !important; transition: none !important; }
      `
    });

    const text = await page.innerText('body');
    const imageCount = await page.$$eval('img', imgs => imgs.length);
    const importantTexts = await extractImportantTexts(page);
    const spatial = await extractSpatialData(page);

    return {
      url,
      viewport,
      text,
      textLength: text.length,
      imageCount,
      pageType: analyzePageType(text.length, imageCount),
      importantTexts,
      ...spatial
    };
  } finally {
    await browser.close();
  }
}

module.exports = {
  analyzeDom,
  navigateWithFallback
};
