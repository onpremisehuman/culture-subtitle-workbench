const API_BASE = "http://127.0.0.1:8876";
let activeTab;
let videoInfo;
const queueButton = document.querySelector("#queue");
const statusEl = document.querySelector("#status");
const playlistItems = document.querySelector("#playlist-items");
const sizeValue = document.querySelector("#size-value");
const playlistFilter = document.querySelector("#playlist-filter");
let subtitleScale = 1;
const subtitleFont = document.querySelector("#subtitle-font");
const FONT_KEYS = new Set(["gothic", "a2z", "serif", "mono"]);

function clampScale(value) {
  return Math.min(1.5, Math.max(.7, Math.round(value * 10) / 10));
}

function renderScale() {
  sizeValue.textContent = `${Math.round(subtitleScale * 100)}%`;
  document.querySelector("#size-down").disabled = subtitleScale <= .7;
  document.querySelector("#size-up").disabled = subtitleScale >= 1.5;
}

async function setSubtitleScale(value) {
  subtitleScale = clampScale(value);
  renderScale();
  await chrome.storage.local.set({subtitleScale});
}

chrome.storage.local.get({subtitleScale: 1, subtitleFont: "gothic"}).then(saved => {
  subtitleScale = clampScale(Number(saved.subtitleScale) || 1);
  subtitleFont.value = FONT_KEYS.has(saved.subtitleFont) ? saved.subtitleFont : "gothic";
  renderScale();
});

document.querySelector("#size-down").addEventListener("click", () => setSubtitleScale(subtitleScale - .1));
document.querySelector("#size-reset").addEventListener("click", () => setSubtitleScale(1));
document.querySelector("#size-up").addEventListener("click", () => setSubtitleScale(subtitleScale + .1));
subtitleFont.addEventListener("change", () => chrome.storage.local.set({subtitleFont: subtitleFont.value}));

function send(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, response => {
    if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
    else if (!response?.ok) reject(new Error(response?.error || "연결 실패"));
    else resolve(response.data);
  }));
}

async function sendToYouTube(message) {
  try {
    return await chrome.tabs.sendMessage(activeTab.id, message);
  } catch (error) {
    if (!String(error?.message || error).includes("Receiving end does not exist")) throw error;
    await chrome.scripting.insertCSS({target: {tabId: activeTab.id}, files: ["overlay.css"]});
    await chrome.scripting.executeScript({target: {tabId: activeTab.id}, files: ["content.js"]});
    return chrome.tabs.sendMessage(activeTab.id, message);
  }
}

async function init() {
  [activeTab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!activeTab?.url?.includes("youtube.com")) return;
  try {
    videoInfo = await sendToYouTube({type: "getVideoInfo"});
    if (!videoInfo?.videoId) return;
    document.querySelector("#title").textContent = videoInfo.title || videoInfo.videoId;
    queueButton.disabled = false;
    const {job} = await send({type: "api", path: `/api/jobs/by-video/${videoInfo.videoId}`});
    if (job?.status === "completed") {
      queueButton.textContent = "문화자막 준비됨";
      statusEl.textContent = "영상 화면에서 자막이 자동으로 켜집니다.";
    } else if (job) {
      queueButton.textContent = job.stage;
      statusEl.textContent = `${job.progress}% 진행 중`;
    }
  } catch (error) {
    statusEl.textContent = error.message;
  }
}

queueButton.addEventListener("click", async () => {
  if (!videoInfo?.videoId) return;
  queueButton.disabled = true;
  statusEl.textContent = "작업함에 넣는 중…";
  try {
    const level = document.querySelector("input[name=level]:checked").value;
    const language = document.querySelector("#source-language").value;
    const data = await send({
      type: "api",
      path: "/api/jobs",
      options: {method: "POST", body: JSON.stringify({url: `https://www.youtube.com/watch?v=${videoInfo.videoId}`, level, language})}
    });
    queueButton.textContent = data.job.status === "completed" ? "문화자막 준비됨" : data.job.stage;
    statusEl.textContent = data.job.status === "completed" ? "영상 화면에서 자막이 자동으로 켜집니다." : "브라우저를 닫아도 PC가 계속 작업합니다.";
    await sendToYouTube({type: "reloadSubtitle"});
  } catch (error) {
    statusEl.textContent = error.message;
    queueButton.disabled = false;
  }
});

document.querySelector("#open-queue").addEventListener("click", () => chrome.runtime.sendMessage({type: "openQueue"}));
document.querySelector("#open-local").addEventListener("click", () => chrome.runtime.sendMessage({type: "openLocalQueue"}));

function escapeHtml(value) {
  return String(value || "").replace(/[&<>'"]/g, char => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;"}[char]));
}

async function downloadKind(jobId, kind) {
  const {url} = await send({
    type: "api",
    path: `/api/jobs/${jobId}/download-ticket`,
    options: {method: "POST", body: JSON.stringify({kind})}
  });
  await send({type: "downloadUrl", path: url});
}

async function requestExport(jobId, mode, button) {
  button.disabled = true;
  const status = button.closest(".playlist-item").querySelector(".export-status");
  status.textContent = mode === "mp4" ? "자막 MP4를 만드는 중…" : "MP4와 SRT를 묶는 중…";
  try {
    const {export: exportJob} = await send({
      type: "api",
      path: `/api/jobs/${jobId}/exports`,
      options: {method: "POST", body: JSON.stringify({mode})}
    });
    if (exportJob.status === "ready") await downloadKind(jobId, mode);
    else status.textContent = "백그라운드에서 준비합니다. 완성되면 버튼이 다운로드로 바뀝니다.";
  } catch (error) {
    status.textContent = error.message;
  }
  await loadPlaylist();
}

async function loadPlaylist() {
  try {
    const {jobs} = await send({type: "api", path: "/api/jobs"});
    const completedAll = jobs.filter(job => job.status === "completed" && !job.hidden);
    const names = [...new Set(completedAll.map(job => job.playlist || "기본 재생목록"))].sort((a, b) => a.localeCompare(b, "ko"));
    const previous = playlistFilter.value;
    playlistFilter.innerHTML = '<option value="all">전체</option>' + names.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
    playlistFilter.value = names.includes(previous) ? previous : "all";
    const completed = playlistFilter.value === "all" ? completedAll : completedAll.filter(job => job.playlist === playlistFilter.value);
    const exportsById = await Promise.all(completed.map(async job => {
      const {exports} = await send({type: "api", path: `/api/jobs/${job.id}/exports`});
      return [job.id, exports || {}];
    }));
    const exportMap = new Map(exportsById);
    playlistItems.innerHTML = completed.length ? completed.map(job => {
      const states = exportMap.get(job.id) || {};
      const mp4Ready = states.mp4?.status === "ready";
      const zipReady = states.mp4_srt?.status === "ready";
      const working = states.mp4?.status === "working" || states.mp4_srt?.status === "working";
      return `<article class="playlist-item" data-id="${escapeHtml(job.id)}">
        <h3 title="${escapeHtml(job.title)}">${escapeHtml(job.title || job.video_id)}</h3>
        <p class="playlist-meta">${escapeHtml(job.playlist || "기본 재생목록")} · ${escapeHtml(job.detected_language_label || job.requested_language_label || "자동 감지")}</p>
        <div class="playlist-actions">
          <button class="watch" data-action="watch" data-url="${escapeHtml(job.source_type === "local" ? API_BASE + job.watch_url : job.youtube_url)}">${job.source_type === "local" ? "작업실에서 보기" : "YouTube에서 보기"}</button>
          <button data-action="srt">SRT</button>
          <button data-action="mp4">${mp4Ready ? "MP4 받기" : "MP4 만들기"}</button>
        </div>
        <div class="playlist-actions secondary-row">
          <span></span><span></span><button data-action="mp4_srt">${zipReady ? "MP4+SRT 받기" : "MP4+SRT"}</button>
        </div>
        <p class="export-status">${working ? "내보내기 준비 중…" : ""}</p>
      </article>`;
    }).join("") : '<p class="empty">완성된 영상이 없습니다.</p>';
    playlistItems.querySelectorAll("button").forEach(button => button.addEventListener("click", async () => {
      const card = button.closest(".playlist-item");
      const jobId = card.dataset.id;
      const action = button.dataset.action;
      if (action === "watch") await chrome.tabs.create({url: button.dataset.url});
      else if (action === "srt") await downloadKind(jobId, "srt");
      else {
        const state = exportMap.get(jobId)?.[action];
        if (state?.status === "ready") await downloadKind(jobId, action);
        else await requestExport(jobId, action, button);
      }
    }));
  } catch (error) {
    playlistItems.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  }
}

document.querySelector("#refresh-playlist").addEventListener("click", loadPlaylist);
playlistFilter.addEventListener("change", loadPlaylist);
init();
loadPlaylist();
setInterval(loadPlaylist, 5000);
