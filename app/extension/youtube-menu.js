(() => {
  // Separate from the player overlay: home/search cards have no current video.
  if (globalThis.__cultureMenuInstalled) return;
  globalThis.__cultureMenuInstalled = true;
  const CARDS = 'yt-lockup-view-model,ytd-rich-grid-media,ytd-video-renderer,ytd-compact-video-renderer,ytd-playlist-video-renderer,ytd-grid-video-renderer,ytm-shorts-lockup-view-model';
  const TRIGGERS = '.ytLockupMetadataViewModelMenuButton,ytd-menu-renderer,button[aria-label="추가 작업"],button[aria-label="More actions"]';
  const MENUS = 'yt-list-view-model[role="menu"],ytd-menu-popup-renderer';
  const LANGUAGES = [['auto','자동 감지'],['tr','튀르키예어'],['fa','페르시아어'],['pt','포르투갈어(브라질 포함)'],['es','스페인어'],['ar','아랍어'],['ja','일본어'],['zh','중국어'],['ru','러시아어'],['pl','폴란드어'],['en','영어']];
  let pending = null;
  let frame = 0;

  function videoFromCard(card) {
    // Only visible links, never YouTube private player state or the current URL.
    const links = [...card.querySelectorAll('h3 a[href],a#video-title[href],a[href]')];
    for (const link of links) {
      let url;
      try { url = new URL(link.getAttribute('href'), 'https://www.youtube.com'); } catch (_) { continue; }
      if (!['www.youtube.com', 'youtube.com'].includes(url.hostname) || url.protocol !== 'https:') continue;
      const id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|live)\/([^/]+)\/?$/)?.[1];
      if (!/^[\w-]{11}$/.test(id || '')) continue;
      return {url: `https://www.youtube.com/watch?v=${id}`, title: (link.textContent || link.getAttribute('aria-label') || id).trim()};
    }
    return null;
  }

  function clearItems() {
    document.querySelectorAll('.culture-menu-action').forEach(el => el.remove());
  }

  function capture(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest('.culture-menu-action,#culture-queue-dialog')) return;
    if (event.type === 'keydown' && event.key === 'Escape') {
      pending = null;
      clearItems();
      return;
    }
    if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
    if (target.closest(MENUS)) {
      pending = null;
      clearItems();
      return;
    }
    pending = null;
    clearItems();
    const trigger = target.closest(TRIGGERS);
    const card = trigger?.closest(CARDS);
    const video = card && videoFromCard(card);
    if (video) {
      pending = {video, trigger: target.closest('button,[role="button"]') || trigger, page: location.href};
      schedule();
    }
  }

  function visible(el) {
    return el.getClientRects().length > 0 && !el.closest('[hidden],[aria-hidden="true"]') && getComputedStyle(el).visibility !== 'hidden';
  }

  function installItems() {
    frame = 0;
    if (!pending || pending.page !== location.href || !pending.trigger.isConnected) return;
    for (const menu of document.querySelectorAll(MENUS)) {
      if (!visible(menu) || menu.querySelector('.culture-menu-action')) continue;
      const context = pending;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'culture-menu-action';
      button.setAttribute('role', 'menuitem');
      const icon = document.createElement('span');
      icon.textContent = '※';
      icon.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = '문화자막 만들기';
      button.append(icon, label);
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (context !== pending || context.page !== location.href) return;
        // Clicking the originating toggle lets YouTube close its own popup.
        context.trigger.click();
        pending = null;
        clearItems();
        openDialog(context.video, context.trigger);
      });
      menu.prepend(button);
    }
  }

  function schedule() {
    if (!frame && pending) {
      frame = 1;
      queueMicrotask(installItems);
    }
  }

  function send(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, response => {
          if (chrome.runtime.lastError) reject(new Error('확장 프로그램을 새로고침했다면 YouTube 페이지도 새로고침해주세요.'));
          else if (!response?.ok) reject(new Error(response?.error || '서버 연결 실패'));
          else resolve(response.data);
        });
      } catch (_) { reject(new Error('확장 프로그램과 YouTube 페이지를 새로고침해주세요.')); }
    });
  }

  function openDialog(video, trigger) {
    document.querySelector('#culture-queue-dialog')?.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'culture-queue-dialog';
    dialog.setAttribute('aria-labelledby', 'culture-queue-heading');
    // Only static markup; video titles and server messages use textContent.
    dialog.innerHTML = `<form>
      <h2 id="culture-queue-heading">문화자막 만들기</h2>
      <p class="culture-video-title"></p>
      <label>원문 언어<select name="language"></select></label>
      <label>자막 농도<select name="level"><option value="economy">경제형</option><option value="culture" selected>문화역주</option><option value="curator">고인물판</option></select></label>
      <p class="culture-queue-status" role="status" aria-live="polite">완성되면 알림을 보내드립니다. PC는 켜두세요.</p>
      <div class="culture-queue-buttons"><button type="button" data-action="close">취소</button><button type="button" data-action="workbench">내 작업함</button><button type="submit">큐에 넣기</button></div>
    </form>`;
    dialog.querySelector('.culture-video-title').textContent = video.title;
    const language = dialog.querySelector('[name="language"]');
    const level = dialog.querySelector('[name="level"]');
    for (const [value, label] of LANGUAGES) language.add(new Option(label, value));
    const status = dialog.querySelector('.culture-queue-status');
    const submit = dialog.querySelector('[type="submit"]');
    let dirty = false;
    let busy = false;
    dialog.addEventListener('change', () => { dirty = true; });
    chrome.storage.local.get({cultureQueueLanguage: 'auto', cultureQueueLevel: 'culture'}).then(saved => {
      if (dirty || busy || !dialog.isConnected) return;
      if (LANGUAGES.some(([key]) => key === saved.cultureQueueLanguage)) language.value = saved.cultureQueueLanguage;
      if (['economy', 'culture', 'curator'].includes(saved.cultureQueueLevel)) level.value = saved.cultureQueueLevel;
    }).catch(() => {});
    dialog.querySelector('[data-action="close"]').onclick = () => dialog.close();
    dialog.querySelector('[data-action="workbench"]').onclick = () => {
      send({type: 'openQueue'}).catch(error => { status.textContent = error.message; });
    };
    dialog.addEventListener('close', () => { dialog.remove(); if (trigger.isConnected) trigger.focus(); });
    dialog.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault();
      if (busy) return;
      busy = true;
      submit.disabled = true;
      language.disabled = level.disabled = true;
      status.textContent = '서버 확인 중… 꺼져 있으면 자동으로 켠 뒤 등록합니다.';
      status.removeAttribute('data-error');
      const options = {language: language.value, level: level.value};
      try {
        const data = await send({type: 'api', path: '/api/jobs', options: {method: 'POST', body: JSON.stringify({url: video.url, ...options})}});
        if (!data?.job) throw new Error('서버 응답을 확인할 수 없습니다. 작업함에서 등록 여부를 확인해주세요.');
        chrome.storage.local.set({cultureQueueLanguage: options.language, cultureQueueLevel: options.level}).catch(() => {});
        const job = data.job;
        submit.textContent = job.status === 'completed' ? '문화자막 준비됨' : '큐 등록 완료';
        status.textContent = job.status === 'completed' ? '이미 완성된 문화자막이 있습니다. 내 작업함에서 확인하세요.' : job.status === 'failed' ? '기존 작업이 실패 상태입니다. 내 작업함에서 다시 시도해주세요.' : '작업함에 등록됐습니다. 완성되면 알림을 보내드립니다.';
        dialog.querySelector('[data-action="close"]').textContent = '닫기';
      } catch (error) {
        status.textContent = `등록하지 못했습니다. 서버 연결을 확인한 뒤 다시 시도해주세요. ${error.message}`;
        status.dataset.error = 'true';
        submit.disabled = false;
        language.disabled = level.disabled = false;
        busy = false;
      }
    });
    document.body.append(dialog);
    dialog.showModal();
  }

  document.addEventListener('click', capture, true);
  document.addEventListener('keydown', capture, true);
  document.addEventListener('yt-navigate-start', () => { pending = null; clearItems(); });
  new MutationObserver(schedule).observe(document.documentElement, {childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'style']});
})();
