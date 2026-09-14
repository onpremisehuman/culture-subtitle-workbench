const form = document.querySelector("#request-form");
const jobList = document.querySelector("#job-list");
const message = document.querySelector("#form-message");
const connection = document.querySelector("#connection");
const pairDialog = document.querySelector("#pair-dialog");
const videoUrl = document.querySelector("#video-url");
const videoFile = document.querySelector("#video-file");
const deleteDialog = document.querySelector("#delete-dialog");
const deleteForm = document.querySelector("#delete-form");
const playlistDialog = document.querySelector("#playlist-dialog");
const playlistForm = document.querySelector("#playlist-form");
const libraryTabs = document.querySelector("#library-tabs");
let knownStatuses = new Map();
let allJobs = [];
let activeLibrary = "visible";
let currentSource = "youtube";
let activePlayer = null;
let pendingDeleteJob = null;
let pendingPlaylistJob = null;

document.querySelectorAll(".level-option input").forEach(input => {
  input.addEventListener("change", () => {
    document.querySelectorAll(".level-option").forEach(label => label.classList.toggle("selected", label.contains(input)));
  });
});

function setSource(source) {
  currentSource = source === "local" ? "local" : "youtube";
  document.querySelectorAll(".source-tab").forEach(button => {
    const active = button.dataset.source === currentSource;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelector("#youtube-source").hidden = currentSource !== "youtube";
  document.querySelector("#local-source").hidden = currentSource !== "local";
  videoUrl.required = currentSource === "youtube";
}

document.querySelectorAll(".source-tab").forEach(button => button.addEventListener("click", () => setSource(button.dataset.source)));
videoFile.addEventListener("change", () => {
  document.querySelector("#file-name").textContent = videoFile.files[0]?.name || "MP4·MOV·WebM·MKV·AVI";
});

async function ensureConnection() {
  try {
    await CultureAPI.bootstrap();
    connection.classList.add("online");
    connection.lastChild.textContent = " 연결됨";
    return true;
  } catch (error) {
    connection.classList.remove("online");
    connection.lastChild.textContent = " 페어링 필요";
    pairDialog.showModal();
    return false;
  }
}

document.querySelector("#pair-form").addEventListener("submit", event => {
  event.preventDefault();
  const token = document.querySelector("#pair-token").value.trim();
  if (!token) return;
  CultureAPI.setToken(token);
  pairDialog.close();
  loadJobs();
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  const button = form.querySelector(`#${currentSource}-source button[type=submit]`);
  button.disabled = true;
  message.textContent = currentSource === "local" ? "영상 파일을 작업실로 올리는 중…" : "작업함에 넣는 중…";
  try {
    const level = form.querySelector("input[name=level]:checked").value;
    const language = form.querySelector("#source-language").value;
    let result;
    if (currentSource === "local") {
      const file = videoFile.files[0];
      if (!file) throw new Error("먼저 영상 파일을 선택하세요.");
      const query = new URLSearchParams({filename: file.name, level, language});
      result = await CultureAPI.request(`/api/local-jobs?${query}`, {
        method: "POST",
        body: file,
        headers: {"Content-Type": "application/octet-stream"}
      });
      message.textContent = `‘${result.job.title}’ 업로드 완료. 문화자막 작업을 시작합니다.`;
      videoFile.value = "";
      document.querySelector("#file-name").textContent = "MP4·MOV·WebM·MKV·AVI";
    } else {
      result = await CultureAPI.request("/api/jobs", {
        method: "POST",
        body: JSON.stringify({url: videoUrl.value, level, language})
      });
      message.textContent = `‘${result.job.title || result.job.video_id}’ 작업을 맡겼습니다.`;
      videoUrl.value = "";
    }
    form.querySelector("input[value=culture]").checked = true;
    document.querySelectorAll(".level-option").forEach(label => label.classList.toggle("selected", label.querySelector("input").checked));
    await loadJobs();
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#refresh-button").addEventListener("click", loadJobs);

document.querySelector("#notify-button").addEventListener("click", async event => {
  if (!("Notification" in window)) {
    event.currentTarget.textContent = "이 환경에서는 알림 불가";
    return;
  }
  const permission = await Notification.requestPermission();
  event.currentTarget.textContent = permission === "granted" ? "완료 알림 켜짐" : "알림 허용 필요";
});

function levelLabel(level) {
  return {economy: "경제형", culture: "문화역주", curator: "고인물판"}[level] || level;
}

function statusLabel(status) {
  return {uploading: "업로드 중", queued: "대기", downloading: "수집 중", translating: "번역 중", completed: "완료", failed: "실패"}[status] || status;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>'"]/g, char => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;"}[char]));
}

function playlistNames(jobs = allJobs) {
  return [...new Set(jobs.map(job => job.playlist || "기본 재생목록"))].sort((a, b) => a.localeCompare(b, "ko"));
}

function renderLibrary() {
  const names = playlistNames();
  const visibleCount = allJobs.filter(job => !job.hidden).length;
  const hiddenCount = allJobs.filter(job => job.hidden).length;
  const tabs = [
    {key: "visible", label: `전체 ${visibleCount}`},
    ...names.map(name => ({key: `playlist:${name}`, label: name})),
    {key: "hidden", label: `숨긴 항목 ${hiddenCount}`}
  ];
  libraryTabs.innerHTML = tabs.map(tab => `<button class="library-tab${tab.key === activeLibrary ? " active" : ""}" type="button" role="tab" aria-selected="${tab.key === activeLibrary}" data-library="${escapeHtml(tab.key)}">${escapeHtml(tab.label)}</button>`).join("");
  libraryTabs.querySelectorAll("button").forEach(button => button.addEventListener("click", () => {
    activeLibrary = button.dataset.library;
    renderLibrary();
  }));
  const jobs = activeLibrary === "hidden"
    ? allJobs.filter(job => job.hidden)
    : activeLibrary.startsWith("playlist:")
      ? allJobs.filter(job => !job.hidden && job.playlist === activeLibrary.slice(9))
      : allJobs.filter(job => !job.hidden);
  renderJobs(jobs);
}

function renderJobs(jobs) {
  if (!jobs.length) {
    jobList.innerHTML = '<div class="empty">아직 맡겨둔 영상이 없습니다.</div>';
    return;
  }
  jobList.innerHTML = jobs.map(job => {
    const done = job.status === "completed";
    const failed = job.status === "failed";
    const local = job.source_type === "local";
    const language = job.detected_language_label || (job.requested_language !== "auto" ? job.requested_language_label : "자동 감지");
    const thumbnail = local
      ? '<div class="local-thumb" aria-label="로컬 영상"><span>※</span></div>'
      : `<img class="thumb" src="https://i.ytimg.com/vi/${escapeHtml(job.video_id)}/mqdefault.jpg" alt="" loading="lazy">`;
    return `
      <article class="job-card" data-job-id="${escapeHtml(job.id)}">
        ${thumbnail}
        <div class="job-main">
          <h3 class="job-title">${escapeHtml(job.title || "영상 정보를 확인하는 중")}</h3>
          <div class="job-meta"><span>${local ? "내 컴퓨터" : "YouTube"}</span><span>${escapeHtml(language)}</span><span>${levelLabel(job.level)}</span><span>${statusLabel(job.status)}</span><span class="playlist-badge">${escapeHtml(job.playlist || "기본 재생목록")}</span></div>
          <div class="status-line"><div class="progress"><i style="width:${Number(job.progress)}%"></i></div><span class="status-text">${escapeHtml(job.stage)}</span></div>
          ${failed ? `<div class="error-box">${escapeHtml(job.error)}</div>` : ""}
          <p class="export-status" role="status"></p>
        </div>
        <div class="job-actions">
          ${done && local ? `<button class="watch-button inline-watch" data-id="${escapeHtml(job.id)}">작업실에서 보기</button>` : ""}
          ${done && !local ? `<a class="watch-button" href="/app/watch.html?v=${escapeHtml(job.video_id)}">문화자막으로 보기</a>` : ""}
          ${done ? `<button class="export-button" data-export="srt">SRT</button><button class="export-button" data-export="mp4">MP4</button><button class="export-button" data-export="mp4_srt">MP4+SRT</button>` : ""}
          ${failed ? `<button class="quiet retry-button" data-id="${escapeHtml(job.id)}">다시 시도</button>` : ""}
          ${!local ? `<a class="youtube-button" href="${escapeHtml(job.youtube_url)}" target="_blank" rel="noreferrer">YouTube</a>` : ""}
          <button class="organize-button" data-playlist-id="${escapeHtml(job.id)}" data-playlist-title="${escapeHtml(job.title || job.video_id)}" data-playlist-name="${escapeHtml(job.playlist || "기본 재생목록")}">재생목록</button>
          <button class="hide-button" data-hide-id="${escapeHtml(job.id)}" data-hidden="${job.hidden}">${job.hidden ? "목록에 복구" : "목록에서 숨기기"}</button>
          ${["queued", "completed", "failed"].includes(job.status) ? `<button class="delete-button" data-delete-id="${escapeHtml(job.id)}" data-delete-title="${escapeHtml(job.title || job.video_id)}">삭제</button>` : ""}
        </div>
        <div class="inline-player-host" hidden></div>
      </article>`;
  }).join("");
  document.querySelectorAll(".retry-button").forEach(button => button.addEventListener("click", () => retryJob(button.dataset.id)));
  document.querySelectorAll(".inline-watch").forEach(button => button.addEventListener("click", () => openInlinePlayer(button.dataset.id)));
  document.querySelectorAll("[data-export]").forEach(button => button.addEventListener("click", () => handleExport(button)));
  document.querySelectorAll("[data-delete-id]").forEach(button => button.addEventListener("click", () => openDeleteDialog(button)));
  document.querySelectorAll("[data-playlist-id]").forEach(button => button.addEventListener("click", () => openPlaylistDialog(button)));
  document.querySelectorAll("[data-hide-id]").forEach(button => button.addEventListener("click", () => toggleHidden(button)));
}

async function toggleHidden(button) {
  button.disabled = true;
  try {
    await CultureAPI.request(`/api/jobs/${button.dataset.hideId}`, {
      method: "PATCH", body: JSON.stringify({hidden: button.dataset.hidden !== "true"})
    });
    await loadJobs();
  } catch (error) {
    button.disabled = false;
    button.closest(".job-card").querySelector(".export-status").textContent = error.message;
  }
}

function openPlaylistDialog(button) {
  pendingPlaylistJob = {id: button.dataset.playlistId, title: button.dataset.playlistTitle};
  document.querySelector("#playlist-job-title").textContent = pendingPlaylistJob.title;
  const input = document.querySelector("#playlist-name");
  input.value = button.dataset.playlistName || "기본 재생목록";
  document.querySelector("#playlist-names").innerHTML = playlistNames().map(name => `<option value="${escapeHtml(name)}"></option>`).join("");
  document.querySelector("#playlist-dialog-message").textContent = "";
  document.querySelector("#playlist-confirm").disabled = false;
  playlistDialog.showModal();
  input.select();
}

document.querySelector("#playlist-cancel").addEventListener("click", () => {
  pendingPlaylistJob = null;
  playlistDialog.close("cancel");
});
playlistDialog.addEventListener("cancel", () => { pendingPlaylistJob = null; });
playlistForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!pendingPlaylistJob) return;
  const confirm = document.querySelector("#playlist-confirm");
  const dialogMessage = document.querySelector("#playlist-dialog-message");
  confirm.disabled = true;
  try {
    const playlist = document.querySelector("#playlist-name").value.trim();
    await CultureAPI.request(`/api/jobs/${pendingPlaylistJob.id}`, {
      method: "PATCH", body: JSON.stringify({playlist})
    });
    activeLibrary = `playlist:${playlist.replace(/\s+/g, " ")}`;
    pendingPlaylistJob = null;
    playlistDialog.close("saved");
    await loadJobs();
  } catch (error) {
    dialogMessage.textContent = error.message;
    confirm.disabled = false;
  }
});

function openDeleteDialog(button) {
  pendingDeleteJob = {id: button.dataset.deleteId, title: button.dataset.deleteTitle};
  document.querySelector("#delete-job-title").textContent = pendingDeleteJob.title;
  document.querySelector("#delete-dialog-message").textContent = "";
  document.querySelector("#delete-confirm").disabled = false;
  deleteDialog.showModal();
}

document.querySelector("#delete-cancel").addEventListener("click", () => {
  pendingDeleteJob = null;
  deleteDialog.close("cancel");
});

deleteDialog.addEventListener("cancel", () => { pendingDeleteJob = null; });

deleteForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!pendingDeleteJob) return;
  const {id} = pendingDeleteJob;
  const confirmButton = document.querySelector("#delete-confirm");
  const dialogMessage = document.querySelector("#delete-dialog-message");
  confirmButton.disabled = true;
  dialogMessage.textContent = "삭제하는 중…";
  try {
    if (activePlayer?.host.closest(".job-card")?.dataset.jobId === id) closeActivePlayer();
    await CultureAPI.request(`/api/jobs/${id}`, {method: "DELETE"});
    knownStatuses.delete(id);
    pendingDeleteJob = null;
    deleteDialog.close("deleted");
    await loadJobs();
  } catch (error) {
    dialogMessage.textContent = error.message;
    confirmButton.disabled = false;
  }
});

async function retryJob(id) {
  await CultureAPI.request(`/api/jobs/${id}/retry`, {method: "POST"});
  loadJobs();
}

async function downloadKind(jobId, kind) {
  const {url} = await CultureAPI.request(`/api/jobs/${jobId}/download-ticket`, {
    method: "POST", body: JSON.stringify({kind})
  });
  location.href = url;
}

async function handleExport(button) {
  const card = button.closest(".job-card");
  const jobId = card.dataset.jobId;
  const kind = button.dataset.export;
  const status = card.querySelector(".export-status");
  button.disabled = true;
  try {
    if (kind === "srt") {
      await downloadKind(jobId, kind);
      status.textContent = "SRT 다운로드를 시작했습니다.";
    } else {
      const {export: exportJob} = await CultureAPI.request(`/api/jobs/${jobId}/exports`, {
        method: "POST", body: JSON.stringify({mode: kind})
      });
      if (exportJob.status === "ready") await downloadKind(jobId, kind);
      else {
        status.textContent = exportJob.stage || "내보내기를 준비합니다.";
        pollExport(jobId, kind, button, status);
        return;
      }
    }
  } catch (error) {
    status.textContent = error.message;
  }
  button.disabled = false;
}

async function pollExport(jobId, kind, button, status) {
  try {
    const {exports} = await CultureAPI.request(`/api/jobs/${jobId}/exports`);
    const state = exports?.[kind];
    status.textContent = state?.stage || "내보내기 준비 중…";
    if (state?.status === "ready") {
      await downloadKind(jobId, kind);
      button.disabled = false;
      return;
    }
    if (state?.status === "failed") {
      status.textContent = state.error || "내보내기에 실패했습니다.";
      button.disabled = false;
      return;
    }
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
    return;
  }
  setTimeout(() => pollExport(jobId, kind, button, status), 3000);
}

function setCue(element, text) {
  const readable = String(text || "").replace(/\s+/g, " ").trim();
  if (element.textContent !== readable) element.textContent = readable;
  element.classList.toggle("visible", Boolean(readable));
}

function toVttTime(seconds) {
  const millis = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(millis / 3600000);
  const minutes = Math.floor((millis % 3600000) / 60000);
  const secs = Math.floor((millis % 60000) / 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis % 1000).padStart(3, "0")}`;
}

function cuesToVtt(cues) {
  const blocks = cues.map((cue, index) => {
    const lines = [cue.text, cue.noteText].filter(Boolean).join("\n");
    return `${index + 1}\n${toVttTime(cue.start)} --> ${toVttTime(cue.end)}\n${lines}`;
  });
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

function closeActivePlayer() {
  if (!activePlayer) return;
  if (activePlayer.pipWindow && !activePlayer.pipWindow.closed) activePlayer.pipWindow.close();
  cancelAnimationFrame(activePlayer.frame);
  activePlayer.video.pause();
  activePlayer.video.removeAttribute("src");
  if (activePlayer.trackUrl) URL.revokeObjectURL(activePlayer.trackUrl);
  activePlayer.host.hidden = true;
  activePlayer.host.replaceChildren();
  activePlayer = null;
}

async function openInlinePlayer(jobId) {
  const card = document.querySelector(`.job-card[data-job-id="${CSS.escape(jobId)}"]`);
  if (!card) return;
  const host = card.querySelector(".inline-player-host");
  if (activePlayer?.host === host) {
    closeActivePlayer();
    return;
  }
  closeActivePlayer();
  host.hidden = false;
  host.innerHTML = '<div class="empty">작업실 플레이어를 여는 중…</div>';
  try {
    const [srt, media] = await Promise.all([
      CultureAPI.request(`/api/jobs/${jobId}/subtitle.srt`),
      CultureAPI.request(`/api/jobs/${jobId}/media-ticket`)
    ]);
    const cues = CultureAPI.parseSrt(srt);
    host.innerHTML = `
      <section class="inline-player-shell">
        <div class="inline-video-wrap">
          <video controls playsinline preload="metadata"></video>
          <div class="subtitle-layer" aria-live="off">
            <div class="note-subtitle"></div>
            <div class="dialogue-subtitle"></div>
          </div>
        </div>
        <div class="inline-player-controls">
          <button class="active" data-player-action="subtitle" type="button">문화자막 켜짐</button>
          <label class="inline-font-control">폰트
            <select data-player-action="font">
              <option value="gothic">선명 고딕</option>
              <option value="a2z">A2Z</option>
              <option value="serif">명조</option>
              <option value="mono">고정폭</option>
            </select>
          </label>
          <button data-player-action="pip" type="button">항상 위에 보기</button>
          <button data-player-action="close" type="button">닫기</button>
          <p class="inline-player-message">자막 ${cues.length}개</p>
        </div>
      </section>`;
    const shell = host.querySelector(".inline-player-shell");
    const video = host.querySelector("video");
    const dialogue = host.querySelector(".dialogue-subtitle");
    const note = host.querySelector(".note-subtitle");
    const subtitleLayer = host.querySelector(".subtitle-layer");
    const subtitleButton = host.querySelector('[data-player-action="subtitle"]');
    const fontSelect = host.querySelector('[data-player-action="font"]');
    const savedFont = ["gothic", "a2z", "serif", "mono"].includes(localStorage.getItem("cultureSubtitleFont")) ? localStorage.getItem("cultureSubtitleFont") : "gothic";
    fontSelect.value = savedFont;
    subtitleLayer.dataset.font = savedFont;
    let enabled = true;
    video.src = media.url;
    const trackUrl = URL.createObjectURL(new Blob([cuesToVtt(cues)], {type: "text/vtt"}));
    const track = document.createElement("track");
    track.kind = "captions";
    track.label = "문화자막";
    track.srclang = "ko";
    track.src = trackUrl;
    video.append(track);
    const state = {host, shell, video, track, trackUrl, frame: 0};
    activePlayer = state;
    const draw = () => {
      if (activePlayer !== state) return;
      const active = enabled ? cues.filter(cue => video.currentTime >= cue.start && video.currentTime < cue.end) : [];
      setCue(dialogue, active.find(cue => cue.text)?.text || "");
      setCue(note, active.find(cue => cue.noteText)?.noteText || "");
      state.frame = requestAnimationFrame(draw);
    };
    draw();
    subtitleButton.addEventListener("click", () => {
      enabled = !enabled;
      subtitleButton.classList.toggle("active", enabled);
      subtitleButton.textContent = enabled ? "문화자막 켜짐" : "문화자막 꺼짐";
    });
    fontSelect.addEventListener("change", () => {
      subtitleLayer.dataset.font = fontSelect.value;
      localStorage.setItem("cultureSubtitleFont", fontSelect.value);
    });
    host.querySelector('[data-player-action="close"]').addEventListener("click", closeActivePlayer);
    host.querySelector('[data-player-action="pip"]').addEventListener("click", event => openAlwaysOnTop(state, event.currentTarget));
    video.play().catch(() => {});
  } catch (error) {
    host.innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`;
  }
}

async function openAlwaysOnTop(state, button) {
  try {
    if (state.pipWindow && !state.pipWindow.closed) {
      state.pipWindow.close();
      return;
    }
    if (window.documentPictureInPicture?.requestWindow) {
      const pipWindow = await window.documentPictureInPicture.requestWindow({width: 640, height: 420});
      state.pipWindow = pipWindow;
      const stylesheet = pipWindow.document.createElement("link");
      stylesheet.rel = "stylesheet";
      stylesheet.href = "/app/styles.css";
      pipWindow.document.head.append(stylesheet);
      pipWindow.document.body.className = "pip-body";
      pipWindow.document.body.append(state.shell);
      button.textContent = "작업실로 돌려놓기";
      pipWindow.addEventListener("pagehide", () => {
        state.pipWindow = null;
        if (activePlayer === state) {
          state.host.append(state.shell);
          button.textContent = "항상 위에 보기";
        }
      }, {once: true});
    } else if (state.video.requestPictureInPicture) {
      if (state.video.paused) await state.video.play();
      state.track.track.mode = "showing";
      await state.video.requestPictureInPicture();
      state.video.addEventListener("leavepictureinpicture", () => { state.track.track.mode = "hidden"; }, {once: true});
    } else {
      throw new Error("이 브라우저는 항상 위에 보기를 지원하지 않습니다.");
    }
  } catch (error) {
    state.host.querySelector(".inline-player-message").textContent = error.message;
  }
}

async function loadJobs() {
  try {
    const {jobs} = await CultureAPI.request("/api/jobs");
    const justCompleted = jobs.filter(job => knownStatuses.has(job.id) && knownStatuses.get(job.id) !== "completed" && job.status === "completed");
    jobs.forEach(job => knownStatuses.set(job.id, job.status));
    allJobs = jobs;
    const playingId = activePlayer?.host.closest(".job-card")?.dataset.jobId;
    if (!playingId) renderLibrary();
    if (justCompleted.length && "Notification" in window && Notification.permission === "granted") {
      new Notification("문화자막이 완성됐습니다", {body: justCompleted[0].title, icon: "/app/icon-192.png"});
    }
    const focusId = new URLSearchParams(location.search).get("focus");
    if (focusId && !activePlayer && jobs.some(job => job.id === focusId && job.status === "completed")) {
      history.replaceState({}, "", "/app/");
      openInlinePlayer(focusId);
    }
  } catch (error) {
    if (error.message === "pairing-required") pairDialog.showModal();
    else jobList.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

setSource(new URLSearchParams(location.search).get("source") === "local" ? "local" : "youtube");
ensureConnection().then(ok => { if (ok) loadJobs(); });
setInterval(loadJobs, 7000);
