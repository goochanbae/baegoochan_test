const { chromium } = require('playwright');
const { navigateWithFallback } = require('../v1/domAnalysis');

async function createCrawler(url, options = {}) {
  const viewport = options.viewport || { width: 1440, height: 900 };
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize(viewport);

  await page.addInitScript(() => {
    window.IntersectionObserver = class {
      constructor(callback) {
        this.callback = callback;
      }
      observe(target) {
        if (typeof this.callback === 'function') {
          const rect = target.getBoundingClientRect();
          this.callback([
            {
              isIntersecting: true,
              intersectionRatio: 1,
              target,
              boundingClientRect: rect,
              intersectionRect: rect,
              rootBounds: null,
              time: performance.now()
            }
          ], this);
        }
      }
      unobserve() {}
      disconnect() {}
    };
  });

  await navigateWithFallback(page, url);
  await stabilizePage(page);

  return { browser, page, viewport, url };
}

async function stabilizePage(page) {
  await page.addStyleTag({
    content: `
      body { overflow-x: hidden !important; }
      * {
        animation: none !important;
        transition: none !important;
        scroll-behavior: auto !important;
      }
      html, body { scroll-snap-type: none !important; }
      [class*="parallax" i],
      [data-parallax],
      [data-scroll],
      [data-speed] {
        transform: none !important;
        background-attachment: scroll !important;
        will-change: auto !important;
      }
    `
  });

  await page.evaluate(() => {
    document.querySelectorAll('img, iframe, video, source').forEach(el => {
      if (el.hasAttribute('loading')) el.setAttribute('loading', 'eager');
      const dataSrc = el.getAttribute('data-src') || el.getAttribute('data-lazy-src');
      const dataSrcset = el.getAttribute('data-srcset') || el.getAttribute('data-lazy-srcset');
      if (dataSrc && !el.getAttribute('src')) el.setAttribute('src', dataSrc);
      if (dataSrcset && !el.getAttribute('srcset')) el.setAttribute('srcset', dataSrcset);
    });
    window.scrollTo(0, document.body.scrollHeight);
  });
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
}

async function closeCrawler(session) {
  if (session?.browser) {
    await session.browser.close();
  }
}

module.exports = {
  createCrawler,
  closeCrawler,
  stabilizePage
};
