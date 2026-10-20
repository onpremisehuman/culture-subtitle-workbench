const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../web/watch.js'), 'utf8');

function setup(mode = 'native') {
  const elements = new Map();
  function element(key) {
    if (!elements.has(key)) {
      const classes = new Set();
      const el = {
        textContent: '', dataset: {}, events: {}, attrs: {},
        classList: {
          contains: x => classes.has(x), add: x => classes.add(x),
          remove: x => classes.delete(x),
          toggle(x, on) { on ? classes.add(x) : classes.delete(x); }
        },
        style: {setProperty(k, v) { this[k] = v; }},
        setAttribute(k, v) { this.attrs[k] = v; },
        addEventListener(k, fn) { this.events[k] = fn; },
        querySelector: element
      };
      elements.set(key, el);
    }
    return elements.get(key);
  }
  const document = {
    querySelector: element, body: element('body'), events: {},
    fullscreenElement: null,
    addEventListener(k, fn) { this.events[k] = fn; },
    async exitFullscreen() { this.fullscreenElement = null; }
  };
  const card = element('#watch-player-card');
  if (mode !== 'missing') card.requestFullscreen = async () => {
    if (mode === 'rejected') throw new Error('NotAllowedError');
    document.fullscreenElement = card;
  };
  const context = {
    document, window: {addEventListener() {}}, location: {search: '?v=test'}, URLSearchParams,
    localStorage: {getItem() {}, setItem() {}}, requestAnimationFrame() {},
    CultureAPI: {request: async () => ({job: null})}
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return {context, document, element, card, button: element('#fullscreen')};
}

test('native fullscreen includes the player card and supports exit', async () => {
  const {button, document, card} = setup();
  await button.events.click();
  assert.equal(document.fullscreenElement, card);
  assert.equal(button.attrs['aria-pressed'], 'true');
  assert.equal(button.textContent, '전체화면 닫기');
  await button.events.click();
  assert.equal(document.fullscreenElement, null);
  assert.equal(button.attrs['aria-pressed'], 'false');
  assert.equal(button.textContent, '전체화면');
});

for (const mode of ['missing', 'rejected']) {
  test(`${mode} fullscreen falls back to a subtitle-inclusive view`, async () => {
    const {button, card, document} = setup(mode);
    await button.events.click();
    assert.equal(card.classList.contains('is-expanded'), true);
    assert.equal(document.body.classList.contains('watch-expanded'), true);
    await button.events.click();
    assert.equal(card.classList.contains('is-expanded'), false);
    await button.events.click();
    document.events.keydown({key: 'Escape'});
    assert.equal(card.classList.contains('is-expanded'), false);
    assert.equal(button.attrs['aria-pressed'], 'false');
  });
}

test('external fullscreen exit updates controls', async () => {
  const {button, document} = setup();
  await button.events.click();
  document.fullscreenElement = null;
  document.events.fullscreenchange();
  assert.equal(button.attrs['aria-pressed'], 'false');
  assert.equal(document.body.classList.contains('watch-expanded'), false);
});

test('YouTube iframe-only fullscreen is disabled', () => {
  const {context} = setup();
  let options;
  context.YT = {Player: function(id, config) { options = config; }};
  context.window.onYouTubeIframeAPIReady();
  assert.equal(options.playerVars.fs, 0);
  assert.equal(options.playerVars.playsinline, 1);
});

test('subtitle enlargement scales glyphs without moving the overlay', () => {
  const {context, element} = setup();
  vm.runInContext('setScale(1.5)', context);
  assert.equal(element('#player-wrap').style['--subtitle-scale'], 1.5);
  assert.equal(element('.subtitle-layer').style.transform, undefined);
});

test('landscape is requested after fullscreen, then unlocked on exit', async () => {
  const {context, button, document, card} = setup();
  const calls = [];
  context.window.screen = {orientation: {
    async lock(value) { assert.equal(document.fullscreenElement, card); calls.push(value); },
    unlock() { calls.push('unlock'); }
  }};
  await button.events.click();
  await button.events.click();
  assert.deepEqual(calls, ['landscape', 'unlock']);
});

test('rejected rotation preserves fullscreen and shows guidance', async () => {
  const {context, button, document, card, element} = setup();
  context.window.screen = {orientation: {async lock() { throw new Error('unsupported'); }, unlock() {}}};
  await button.events.click();
  assert.equal(document.fullscreenElement, card);
  assert.equal(element('#orientation-hint').hidden, false);
  await button.events.click();
  assert.equal(element('#orientation-hint').hidden, true);
});

test('late orientation completion after fullscreen exit releases the lock', async () => {
  const {context, button, document} = setup();
  let resolveLock;
  let unlocks = 0;
  let started;
  const lockStarted = new Promise(resolve => { started = resolve; });
  context.window.screen = {orientation: {
    lock() { return new Promise(resolve => { resolveLock = resolve; started(); }); },
    unlock() { unlocks++; }
  }};
  const enter = button.events.click();
  await lockStarted;
  document.fullscreenElement = null;
  document.events.fullscreenchange();
  resolveLock();
  await enter;
  assert.ok(unlocks >= 2);
  assert.equal(button.attrs['aria-pressed'], 'false');
});
