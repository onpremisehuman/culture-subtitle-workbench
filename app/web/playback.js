/* Server-backed progress for the private workbench, shared by all paired devices. */
const CulturePlayback = (() => {
  function time(value) {
    const seconds = Math.max(0, Math.floor(Number(value) || 0));
    return seconds >= 3600
      ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
      : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function attach({jobId, host, read, seek, pause, play}) {
    const path = `/api/jobs/${encodeURIComponent(jobId)}/playback`;
    let state, armed = false, disposed = false, busy = false, pending = false;
    let lastSaved = '', lastWrite = 0, wasPlaying = false, seenPlayback = false;
    let waitingSeek = null, seekingSince = 0;
    const box = document.createElement('div');
    box.className = 'resume-panel';
    box.setAttribute('role', 'status');
    host.appendChild(box);

    function message(text, retry) {
      box.replaceChildren();
      box.hidden = !text && !retry;
      if (!text) return;
      const label = document.createElement('span'); label.textContent = text; box.appendChild(label);
      if (retry) button('다시 연결', reload);
    }
    function button(label, fn) {
      const el = document.createElement('button'); el.type = 'button'; el.textContent = label;
      el.addEventListener('click', fn); box.appendChild(el);
    }
    function offer(prefix = '') {
      armed = false;
      pause();
      message(prefix || (state.completed ? '다 본 영상입니다.' : `${time(state.position)}까지 봤어요.`));
      if (!state.completed && state.position >= 1) button(`${time(state.position)}부터 이어보기`, () => choose(false));
      button('처음부터', () => choose(true));
    }
    async function reload() {
      armed = false;
      try {
        const result = await CultureAPI.request(path);
        if (disposed) return;
        state = result.playback;
        if (state.position >= 1 || state.completed) offer();
        else { armed = true; message(''); }
      } catch (_) { if (!disposed) message('시청 위치를 불러오지 못했습니다. 저장은 연결 후 시작합니다.', true); }
    }
    async function choose(fromStart) {
      if (busy || disposed) return;
      busy = true;
      armed = false;
      try {
        // Explicit choice claims the freshest revision, never a stale open-tab snapshot.
        state = (await CultureAPI.request(path)).playback;
        if (disposed) return;
        const target = fromStart || state.completed ? 0 : state.position;
        const duration = read().duration;
        if (!(duration > 0 && Number.isFinite(duration))) throw new Error('not-ready');
        state = (await CultureAPI.request(path, {method: 'PATCH', body: JSON.stringify({
          position: Math.min(target, duration), duration, completed: false, revision: state.revision
        })})).playback;
        if (disposed) return;
        waitingSeek = Math.min(target, duration); seekingSince = Date.now();
        seek(waitingSeek);
        if (Math.abs(read().position - waitingSeek) <= 2) waitingSeek = null;
        seenPlayback = false; lastSaved = ''; lastWrite = Date.now(); armed = true;
        message('');
        Promise.resolve(play()).catch(() => message('재생 버튼을 눌러 이어보세요.'));
      } catch (_) { if (!disposed) message('이어보기를 준비하지 못했습니다. 플레이어가 준비된 뒤 다시 연결하세요.', true); }
      finally { busy = false; }
    }
    async function save(force = false, snapshot = null, closing = false) {
      if (!armed || (disposed && !closing) || !state) return;
      const sample = snapshot || read();
      if (waitingSeek !== null) {
        if (Math.abs(sample.position - waitingSeek) > 2) {
          if (Date.now() - seekingSince > 15000) { armed = false; message('위치 이동을 확인하지 못했습니다. 다시 연결하세요.', true); }
          return;
        }
        waitingSeek = null;
      }
      if (sample.playing) seenPlayback = true;
      if (!seenPlayback || !Number.isFinite(sample.position) || !Number.isFinite(sample.duration) || sample.duration <= 0) return;
      const signature = `${Math.floor(sample.position)}:${!!sample.ended}`;
      if (signature === lastSaved || (!force && Date.now() - lastWrite < 5000)) return;
      if (busy) { if (force) pending = {sample, closing}; return; }
      busy = true;
      lastWrite = Date.now();
      try {
        const result = await CultureAPI.request(path, {method: 'PATCH', keepalive: true, body: JSON.stringify({
          position: sample.position, duration: sample.duration, completed: !!sample.ended, revision: state.revision
        })});
        state = result.playback; lastSaved = signature;
        if (!disposed) message('');
      } catch (error) {
        if (disposed) return;
        if (error.status === 409) {
          armed = false; pause();
          message('다른 기기에서 시청 위치가 바뀌었습니다. 다시 연결해 이어볼 위치를 선택하세요.', true);
        } else message('서버 연결이 끊겨 시청 위치를 저장하지 못했습니다. 연결되면 자동 재시도합니다.');
      } finally {
        busy = false;
        if (pending) { const next = pending; pending = false; void save(true, next.sample, next.closing); }
      }
    }
    function tick() {
      if (disposed || document.hidden) return;
      const sample = read();
      if (sample.playing) seenPlayback = true;
      void save((wasPlaying && !sample.playing) || sample.ended);
      wasPlaying = sample.playing;
    }
    function hidden() { if (document.hidden) void save(true); }
    function leaving() { void save(true); }
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', leaving);
    const timer = setInterval(tick, 1000);
    message('보던 위치를 확인하고 있습니다.');
    const ready = reload();
    return {ready, flush: () => save(true), dispose() {
      // Initiate the final keepalive write before marking this player disposed.
      void save(true, read(), true); disposed = true; clearInterval(timer);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', leaving);
      box.remove();
    }};
  }
  return {attach, time};
})();
