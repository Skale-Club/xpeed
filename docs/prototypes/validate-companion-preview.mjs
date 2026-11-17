import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const path = fileURLToPath(new URL('./companion-live-preview.fragment.html', import.meta.url));
const html = fs.readFileSync(path, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const markup = html.slice(0, html.indexOf('<script>'));
assert.ok(Buffer.byteLength(html) < 1_000_000);
assert.ok(!/<!doctype|<html\b|<body\b|fetch\s*\(|XMLHttpRequest|WebSocket/.test(html));
for (const [, selector] of script.matchAll(/\$\('([^']+)'\)/g)) {
  const word = selector.slice(1);
  assert.ok(selector[0] === '#' ? markup.includes(`id="${word}"`) : new RegExp(`class="[^"]*\\b${word}\\b`).test(markup), `Missing element ${selector}`);
}
function boot(width, reduced = false) {
  const elements = new Map(), listeners = new Map(), frames = new Map(), saved = [];
  let next = 0;
  class Element {
    constructor(selector) { this.selector = selector; this.style = {}; this.attrs = {}; this.events = {}; this.textContent = ''; this.innerHTML = ''; this.value = ''; this.clientWidth = width; this.clientHeight = 342; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return this.attrs[name] ?? null; }
    addEventListener(name, handler) { this.events[name] = handler; }
    getBoundingClientRect() { return { width, height: 342 }; }
    get outerHTML() { return JSON.stringify({ attrs: this.attrs, body: this.innerHTML }); }
    fire(name, value = this.value) { this.value = value; this.events[name]?.({ target: this }); }
  }
  const root = new Element('root');
  root.querySelector = selector => {
    if (!elements.has(selector)) elements.set(selector, new Element(selector));
    return elements.get(selector);
  };
  const context = {
    document: { getElementById: id => id === 'companion-live-preview' ? root : null },
    matchMedia: () => ({ matches: reduced }),
    requestAnimationFrame: cb => { frames.set(++next, cb); return next; },
    cancelAnimationFrame: id => frames.delete(id),
    ResizeObserver: class { observe() {} disconnect() {} },
    addEventListener: (name, cb) => listeners.set(name, cb),
    openai: { widgetState: null, setWidgetState: value => { saved.push(value); return Promise.resolve(); } },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(script, context, { timeout: 1500 });
  const tick = time => { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(time); };
  return { hook: context.__companionLivePreviewTest, elements, tick, saved, globals: value => listeners.get('openai:set_globals')({ detail: { globals: { widgetState: value } } }) };
}
const app = boot(736);
assert.equal(app.hook.snapshot().playing, true, 'starts moving');
assert.equal(app.saved.length, 0, 'no saved state on load');
const initial = app.hook.snapshot();
assert.ok(initial.roadPolygonCount > 20, 'asphalt is independent projected surface geometry');
assert.ok(initial.roadEdgeCount > 20, 'two surveyed/interpolated road boundaries');
app.tick(0); app.tick(1000);
assert.ok(Math.abs(app.hook.snapshot().t - initial.t - 1) < .001, 'actual one-second playback');
assert.notDeepEqual(app.hook.snapshot().carWorld, initial.carWorld);
app.elements.get('.cp-play').fire('click');
assert.equal(app.hook.snapshot().playing, false);
const oldPauseEcho = app.saved.at(-1);
app.elements.get('.cp-play').fire('click');
app.globals(oldPauseEcho);
assert.equal(app.hook.snapshot().playing, true, 'host echo does not disable resumed playback');
const resumedAt = app.hook.snapshot().t;
app.tick(2000); app.tick(2500);
assert.ok(app.hook.snapshot().t > resumedAt);
app.elements.get('.cp-rate').fire('change', '4');
const fourAt = app.hook.snapshot().t;
app.tick(3000); app.tick(3250);
assert.ok(Math.abs(app.hook.snapshot().t - fourAt - 1) < .001, '4x speed');
app.elements.get('.cp-scrub').fire('input', '500');
app.elements.get('.cp-scrub').fire('change', '500');
assert.equal(app.hook.snapshot().playing, false);
assert.ok(app.hook.snapshot().t > 51 && app.hook.snapshot().t < 52, 'seek changes recorded time');
app.hook.setTime(102.5);
app.elements.get('.cp-play').fire('click');
app.tick(4000); app.tick(5000);
assert.equal(app.hook.snapshot().playing, false, 'finite finish');
assert.ok(app.hook.snapshot().t < 103);
assert.equal(app.elements.get('.cp-play').textContent, 'Repetir');
app.elements.get('.cp-play').fire('click');
assert.ok(app.hook.snapshot().t < 1, 'replay from start');
assert.equal(app.hook.snapshot().playing, true);
app.hook.stop();
let projections = 0;
for (const width of [320, 736, 1024]) {
  const sample = boot(width);
  for (const t of [1, 25.953, 55, 90, 102.5]) {
    sample.hook.setTime(t);
    const result = sample.hook.snapshot();
    assert.ok(result.carWorld.every(Number.isFinite));
    assert.ok(result.heading.every(Number.isFinite));
    assert.equal(result.screenAnchor[0], width / 2);
    assert.ok(result.centerCount > 0);
    assert.ok(result.roadPolygonCount > 20, 'asphalt remains visible through the lap');
    assert.ok(result.roadEdgeCount > 20, 'both edges follow the camera');
    assert.ok(!/NaN|Infinity/.test(sample.elements.get('.cp-ground').innerHTML));
    projections++;
  }
  sample.hook.stop();
}
assert.equal(boot(320, true).hook.snapshot().playing, false, 'respects reduced motion');
const inspection = boot(240, true);
inspection.hook.setTime(25.953);
assert.ok(inspection.hook.snapshot().roadPolygons.every(polygon => polygon.every(point => point.every(Number.isFinite))), 'all asphalt vertices finite');
console.log(JSON.stringify({ controls: 'passed', hostEcho: 'passed', finitePlayback: 'passed', reducedMotion: 'passed', projections, bytes: Buffer.byteLength(html) }));
