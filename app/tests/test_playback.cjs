const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../web/playback.js'), 'utf8');

function setup(saved = {position: 60, duration: 300, completed: false, revision: 1}, initiallyOffline = false) {
  let state = {...saved}, now = 10000, tick, fail = initiallyOffline;
  const writes = [], seeks = [], sample = {position: 0, duration: 300, playing: false, ended: false};
  const el = () => ({children: [], events: {}, textContent: '', setAttribute() {},
    appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; },
    addEventListener(name, cb) { this.events[name] = cb; }, remove() {}});
  const host = el();
  const context = {console, Date: {now: () => now}, setInterval(fn) {tick = fn; return 1;}, clearInterval() {},
    document: {hidden: false, createElement: el, addEventListener() {}, removeEventListener() {}},
    window: {addEventListener() {}, removeEventListener() {}},
    CultureAPI: {async request(path, options) {
      if (fail) throw new Error('offline');
      if (!options) return {playback: {...state}};
      const payload = JSON.parse(options.body);
      if (payload.revision !== state.revision) { const e = new Error('conflict'); e.status = 409; throw e; }
      state = {...payload, revision: state.revision + 1}; writes.push(payload);
      return {playback: {...state}};
    }}
  };
  vm.createContext(context); vm.runInContext(source, context);
  const api = vm.runInContext('CulturePlayback', context);
  const session = api.attach({jobId: 'job', host, read: () => ({...sample}),
    pause: () => {sample.playing = false;}, play: () => {sample.playing = true;},
    seek: value => {seeks.push(value); sample.position = value;}});
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {session, host, sample, writes, seeks, api, settle,
    async tick(ms = 6000) {now += ms; tick(); await settle();},
    async click(label) {const b = host.children[0].children.find(x => x.textContent.includes(label) && x.events.click); assert.ok(b); await b.events.click(); await settle();},
    change(value) {state = {...state, ...value};}, offline(value) {fail = value;},
    text: () => host.children[0].children.map(x => x.textContent).join(' '),
    state: () => state};
}

test('opening or waiting never overwrites saved position; explicit resume seeks', async () => {
  const s = setup(); await s.session.ready; await s.tick();
  assert.equal(s.writes.length, 0); assert.match(s.text(), /1:00부터 이어보기/);
  await s.click('이어보기'); assert.deepEqual(s.seeks, [60]);
  s.sample.position = 76; await s.tick(); assert.equal(s.state().position, 76);
});
test('successful playback saves silently and hides the status panel', async () => {
  const s = setup({position: 0, duration: 300, completed: false, revision: 0});
  await s.session.ready;
  assert.equal(s.text(), '');
  assert.equal(s.host.children[0].hidden, true);
  s.sample.playing = true;
  s.sample.position = 10;
  await s.tick();
  assert.equal(s.writes.length, 1);
  assert.equal(s.text(), '');
  assert.equal(s.host.children[0].hidden, true);
});
test('start from beginning is intentional and clears completion', async () => {
  const s = setup({position: 300, duration: 300, completed: true, revision: 4}); await s.session.ready;
  assert.match(s.text(), /다 본 영상/); await s.click('처음부터');
  assert.equal(s.state().position, 0); assert.equal(s.state().completed, false);
});
test('pause flushes immediately, then idle tab does not rewrite', async () => {
  const s = setup(); await s.session.ready; await s.click('이어보기'); await s.tick();
  s.sample.position = 64; s.sample.playing = false; await s.tick(1000);
  assert.equal(s.state().position, 64); const n = s.writes.length;
  await s.tick(); assert.equal(s.writes.length, n);
});
test('stale device cannot overwrite new device; explicit reconnect uses latest position', async () => {
  const s = setup(); await s.session.ready; await s.click('이어보기'); await s.tick();
  s.change({position: 170, revision: 20}); s.sample.position = 80; await s.tick();
  assert.equal(s.state().position, 170); assert.match(s.text(), /다른 기기/);
  await s.click('다시 연결'); await s.click('이어보기'); assert.equal(s.seeks.at(-1), 170);
});
test('failure on initial GET prevents zero overwrite and offers retry', async () => {
  const s = setup(undefined, true); await s.session.ready; await s.tick();
  assert.equal(s.writes.length, 0);
  assert.match(s.text(), /불러오지 못/);
  s.offline(false); await s.click('다시 연결'); await s.click('이어보기');
  s.offline(true); s.sample.position = 90; await s.tick(); assert.match(s.text(), /저장하지 못/);
  s.offline(false); await s.tick(); assert.equal(s.state().position, 90);
});
test('ended records watched, disposal flushes and invalid duration is ignored', async () => {
  const s = setup(); await s.session.ready; await s.click('이어보기'); await s.tick();
  s.sample.duration = NaN; s.sample.position = 80; await s.tick(); assert.equal(s.state().position, 60);
  s.sample.duration = 300; s.sample.position = 300; s.sample.ended = true; s.sample.playing = false;
  await s.session.flush(); assert.equal(s.state().completed, true);
  s.session.dispose(); await s.settle(); assert.equal(s.state().position, 300);
});
test('formatting supports hours', () => {assert.equal(setup().api.time(3725), '1:02:05');});
