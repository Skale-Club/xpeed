// "A screen never slides sideways" (owner rule, 2026-11-21; AGENTS.md).
//
// Opens every screen of the screen-test copy of the app (vite.harness.config.ts: sample data, no production) in a real browser, at phone
// widths (and a tablet and a desktop one) and in the three languages, and fails when
//   - the page can be moved sideways, or
//   - anything sticks out of the screen's left or right edge, unless it sits inside a box that scrolls or cuts sideways by itself
//     (a table or chart in `overflow-x-auto`, a `truncate` line). The app cuts what sticks out (src/index.css), so without this check a
//     too-wide thing would lose its end without anybody noticing.
//
// Run:  npm run check:phone                     every screen
//       npm run check:phone -- /virtual/sessions /virtual/cars     only these
// It starts the test app by itself when none is running on PHONE_CHECK_URL (default http://127.0.0.1:5010).
// Needs Playwright with Chromium (not a dependency of the project): `npm i --no-save playwright && npx playwright install chromium`,
// or a global one. PHONE_CHECK_WIDTHS and PHONE_CHECK_LANGS narrow the run; PHONE_CHECK_SHOTS=<folder> saves a picture of each failure.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const BASE = process.env.PHONE_CHECK_URL ?? 'http://127.0.0.1:5010';
const WIDTHS = (process.env.PHONE_CHECK_WIDTHS ?? '320,360,412,768,1280').split(',').map(Number);
const LANGS = (process.env.PHONE_CHECK_LANGS ?? 'en,pt-BR,es-ES').split(',');
const SHOTS = process.env.PHONE_CHECK_SHOTS;

// The ids are the ones of the sample data (src/harness/sim-v1.ts, src/harness/seed.ts, src/harness/sim-social.ts). The first Virtual
// session, track 7 and car 6 carry long names on purpose.
const id = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ROUTES = [
  '/', '/live', '/trends', '/issues', '/codes', '/history', '/fuel', '/maintenance', '/cars', '/scanner', '/settings', '/session/s-3', '/session/s-1',
  '/onboarding', '/admin', '/admin/design',
  '/virtual', '/virtual/sessions', `/virtual/sessions/${id('00000003', 1)}`, `/virtual/sessions/${id('00000003', 2)}`, '/virtual/compare', `/virtual/compare?a=${id('00000004', 3)}`,
  '/virtual/tracks', `/virtual/tracks/${id('00000001', 7)}`, `/virtual/tracks/${id('00000001', 1)}`,
  '/virtual/cars', `/virtual/cars/${id('00000002', 6)}`, `/virtual/cars/${id('00000002', 1)}`,
  '/virtual/leaderboards', '/virtual/friends', '/virtual/drivers/apex_anna', '/virtual/profile', '/virtual/privacy', '/virtual/companion', '/virtual/live',
  '/companion', '/privacy', '/terms', '/not-a-page',
];

function loadPlaywright() {
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  try {
    return require('playwright');
  } catch {
    console.error('Playwright is not installed. Run: npm i --no-save playwright && npx playwright install chromium');
    process.exit(2);
  }
}

const reachable = async () => {
  try {
    return (await fetch(BASE, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
};

/** The test app: the one already running, or one started here (and stopped at the end). */
async function testApp() {
  if (await reachable()) return () => {};
  const url = new URL(BASE);
  // On Windows npx is npx.cmd, which only a shell runs (a plain spawn of 'npx' fails with ENOENT).
  const child = spawn('npx', ['vite', '--config', 'vite.harness.config.ts', '--host', url.hostname, '--port', url.port || '5010', '--strictPort'], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
  const stop = () => { try { process.kill(-child.pid); } catch { /* already gone */ } };
  for (let i = 0; i < 60; i++) {
    if (await reachable()) return stop;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  stop();
  console.error(`The test app did not start on ${BASE}.`);
  process.exit(2);
}

/** Waits until the page stops changing (data arrived, lazy parts drawn), at most `limit` ms. */
const settle = (page, limit = 6000) => page.evaluate((max) => new Promise((resolve) => {
  let timer = setTimeout(done, 500);
  const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, 500); });
  const cap = setTimeout(done, max);
  function done() { observer.disconnect(); clearTimeout(timer); clearTimeout(cap); resolve(); }
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
}), limit);

/** Runs in the page: what is wider than the screen. */
function measure() {
  const screenWidth = document.documentElement.clientWidth;
  const fits = (rect) => rect.right <= screenWidth + 0.5 && rect.left >= -0.5;
  const cutsSideways = (element) => /(auto|scroll|hidden|clip)/.test(getComputedStyle(element).overflowX);
  const wide = [];
  for (const element of document.querySelectorAll('#root *, body > :not(#root):not(script):not(style), body > :not(#root) *')) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || fits(rect)) continue;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none' || element.closest('.sr-only, [data-sideways-ok]')) continue;
    // Inside a box that scrolls or cuts sideways, and the box itself fits: that box's business.
    let box = element.parentElement;
    let held = false;
    for (; box && box !== document.body; box = box.parentElement) {
      if (box.id !== 'root' && cutsSideways(box) && fits(box.getBoundingClientRect())) { held = true; break; }
    }
    if (held) continue;
    element.setAttribute('data-too-wide', '');
    wide.push(element);
  }
  // The innermost ones say where the problem is.
  const culprits = wide.filter((element) => !element.querySelector('[data-too-wide]')).slice(0, 4).map((element) => {
    const rect = element.getBoundingClientRect();
    const name = element.getAttribute('data-testid') ? `[data-testid=${element.getAttribute('data-testid')}]` : `.${(element.getAttribute('class') ?? '').split(/\s+/).slice(0, 6).join('.')}`;
    return `<${element.tagName.toLowerCase()}>${name} "${(element.textContent ?? '').trim().slice(0, 40)}" spans ${Math.round(rect.left)}..${Math.round(rect.right)}`;
  });
  for (const element of wide) element.removeAttribute('data-too-wide');
  window.scrollTo(200, window.scrollY);
  const slid = window.scrollX;
  window.scrollTo(0, window.scrollY);
  return { screenWidth, pageWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), slid, culprits };
}

const only = process.argv.slice(2).filter((arg) => arg.startsWith('/'));
const routes = only.length ? only : ROUTES;
const { chromium } = loadPlaywright();
const stopApp = await testApp();
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
const failures = [];
let checked = 0;
try {
  for (const lang of LANGS) {
    const context = await browser.newContext({ viewport: { width: WIDTHS[0], height: 800 }, hasTouch: true });
    await context.addInitScript((code) => { try { localStorage.setItem('app_language', code); } catch { /* no storage */ } }, lang);
    // Nothing outside the test app (fonts, logos): the check must not depend on the network.
    await context.route((url) => !url.href.startsWith(BASE), (route) => route.abort());
    const page = await context.newPage();
    // Racing games on (the Virtual side is opt-in): answer the gate once, the choice is kept for the run.
    await page.goto(`${BASE}/virtual`, { waitUntil: 'load' });
    await settle(page);
    const gate = page.locator('[data-testid="mode-offer"] button').first();
    if (await gate.count()) { await gate.click(); await settle(page); }
    /** Measures the page as it is now at every width; `label` names it in the report. */
    const check = async (label) => {
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        await page.waitForTimeout(120);
        const result = await page.evaluate(measure);
        checked++;
        if (result.pageWidth <= result.screenWidth && result.slid === 0 && result.culprits.length === 0) continue;
        const what = `${label}  ${width}px  ${lang}`;
        failures.push(what);
        console.log(`\nTOO WIDE  ${what}  (page ${result.pageWidth}px on a ${result.screenWidth}px screen${result.slid ? ', slides sideways' : ''})`);
        for (const culprit of result.culprits) console.log(`    ${culprit}`);
        if (SHOTS) {
          mkdirSync(SHOTS, { recursive: true });
          await page.screenshot({ path: path.join(SHOTS, `${label.replace(/\W+/g, '_') || 'home'}-${width}-${lang}.png`) });
        }
      }
    };
    const open = async (route) => {
      await page.setViewportSize({ width: WIDTHS[0], height: 800 });
      await page.goto(BASE + route, { waitUntil: 'load' });
      await settle(page);
    };
    for (const route of routes) {
      await open(route);
      // Scroll through, so the rows that load when seen are there.
      await page.evaluate(async () => {
        for (let y = 0; y < document.documentElement.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((resolve) => setTimeout(resolve, 50)); }
        window.scrollTo(0, 0);
      });
      await settle(page, 4000);
      await check(route);
    }
    // What opens over a page on a phone: the "More" menu of the tab bar and the assistant's chat, on both sides of the app.
    if (!only.length && WIDTHS[0] < 768) {
      for (const route of ['/', '/virtual']) {
        for (const [name, trigger] of [['More menu', '[data-testid="mobile-tab-bar"] button'], ['assistant chat', 'button.fixed.rounded-full']]) {
          await open(route);
          const button = page.locator(trigger).first();
          if (!(await button.count())) continue;
          await button.click();
          await page.waitForTimeout(600);
          await settle(page, 3000);
          await check(`${route} + ${name}`);
        }
      }
    }
    await context.close();
  }
} finally {
  await browser.close();
  stopApp();
}
console.log(`\n${checked} checks (${routes.length} screens, widths ${WIDTHS.join(', ')}, languages ${LANGS.join(', ')}): ${failures.length === 0 ? 'no screen is wider than its screen.' : `${failures.length} too wide.`}`);
process.exit(failures.length === 0 ? 0 : 1);
