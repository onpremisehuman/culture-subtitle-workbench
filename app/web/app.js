const form = document.querySelector("#request-form");
const jobList = document.querySelector("#job-list");
const message = document.querySelector("#form-message");
const connection = document.querySelector("#connection");
const pairDialog = document.querySelector("#pair-dialog");
const serverDialog = document.querySelector("#server-dialog");
const serverDialogTitle = document.querySelector("#server-dialog-title");
const serverDialogMessage = document.querySelector("#server-dialog-message");
const serverDialogDetail = document.querySelector("#server-dialog-message-detail");
const serverAddress = document.querySelector("#server-address");
const serverTools = document.querySelector("#server-tools");
const videoUrl = document.querySelector("#video-url");
const videoFile = document.querySelector("#video-file");
const deleteDialog = document.querySelector("#delete-dialog");
const deleteForm = document.querySelector("#delete-form");
const playlistDialog = document.querySelector("#playlist-dialog");
const playlistForm = document.querySelector("#playlist-form");
const createPlaylistDialog = document.querySelector("#create-playlist-dialog");
const createPlaylistForm = document.querySelector("#create-playlist-form");
const libraryTabs = document.querySelector("#library-tabs");
const selectVisible = document.querySelector("#select-visible");
const selectionCount = document.querySelector("#selection-count");
const bulkPlaylistButton = document.querySelector("#bulk-playlist-button");
const clearSelectionButton = document.querySelector("#clear-selection-button");
let knownStatuses = new Map();
let allJobs = [];
let playlistCatalog = ["기본 재생목록"];
let renderedJobIds = [];
const selectedJobIds = new Set();
let lastSelectionIndex = null;
let activeLibrary = "playlist:기본 재생목록";
let currentSource = "youtube";
let activePlayer = null;
let pendingDeleteJob = null;
let pendingPlaylistJob = null;
let serverConnected = false;

const aiDialog = document.querySelector("#ai-settings-dialog");
const aiSelect = document.querySelector("#ai-backend");
const aiStatus = document.querySelector("#ai-settings-status");
const aiSave = document.querySelector("#ai-settings-save");
function renderAiSettings(info) {
  aiSelect.replaceChildren(new Option("자동 (설치된 AI 우선)", "auto"));
  for (const item of info.backends) {
    aiSelect.add(new Option(`${item.label}${item.installed ? " · 설치됨" : " · 미설치"}`, item.id));
  }
  aiSelect.value = info.selected;
  aiSelect.disabled = info.forced_by_env;
  aiSave.disabled = info.forced_by_env;
  const effective = info.backends.find(item => item.id === info.effective)?.label;
  aiStatus.textContent = info.error || `${info.forced_by_env ? "서버 환경변수로 고정됨 · " : ""}현재 선택: ${effective}. 다음 번역부터 적용되며 진행 중인 번역은 유지됩니다.`;
}
document.querySelector("#ai-settings-button").addEventListener("click", async () => {
  aiDialog.showModal();
  aiStatus.textContent = "서버의 AI 설정을 확인하는 중…";
  aiSave.disabled = true;
  try { renderAiSettings(await CultureAPI.request("/api/ai-settings")); }
  catch (error) { aiStatus.textContent = error.message; }
});
document.querySelector("#ai-settings-close").addEventListener("click", () => aiDialog.close());
aiSave.addEventListener("click", async () => {
  aiSave.disabled = true;
  try {
    renderAiSettings(await CultureAPI.request("/api/ai-settings", {method: "POST", body: JSON.stringify({backend: aiSelect.value})}));
  } catch (error) { aiStatus.textContent = error.message; aiSave.disabled = false; }
});

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

function showServerDialog(mode = "offline") {
  const online = mode === "online";
  serverDialogTitle.textContent = online ? "문화자막 서버가 정상 작동 중입니다." : "문화자막 서버에 연결되지 않습니다.";
  serverDialogMessage.textContent = online
    ? "작업 대기열과 자막 파일은 이 PC의 서버에서 처리됩니다."
    : "PC가 켜져 있고 Tailscale이 연결되어 있는지 확인하세요. PC에 로그인하면 서버는 창 없이 자동으로 시작됩니다.";
  serverAddress.textContent = location.origin;
  serverTools.hidden = !online;
  serverDialogDetail.textContent = "";
  if (!serverDialog.open) serverDialog.showModal();
}

function setConnectionState(online, label) {
  serverConnected = online;
  connection.classList.toggle("online", online);
  connection.lastChild.textContent = ` ${label}`;
}

async function ensureConnection(showFailure = true) {
  try {
    await CultureAPI.request("/api/jobs");
    setConnectionState(true, "연결됨");
    return true;
  } catch (error) {
    if (error.message === "pairing-required") {
      setConnectionState(false, "페어링 필요");
      if (showFailure && !pairDialog.open) pairDialog.showModal();
    } else {
      setConnectionState(false, "서버 꺼짐");
      if (showFailure) showServerDialog("offline");
    }
    return false;
  }
}

connection.addEventListener("click", () => showServerDialog(serverConnected ? "online" : "offline"));
document.querySelector("#server-close").addEventListener("click", () => serverDialog.close());
document.querySelector("#server-retry").addEventListener("click", async () => {
  const button = document.querySelector("#server-retry");
  button.disabled = true;
  serverDialogDetail.textContent = "서버를 다시 확인하는 중…";
  const ok = await ensureConnection(false);
  if (ok) {
    serverDialog.close();
    await loadJobs();
  } else {
    serverDialogDetail.textContent = "아직 연결되지 않습니다. PC 로그인과 Tailscale 연결 상태를 확인하세요.";
  }
  button.disabled = false;
});
document.querySelector("#copy-server-address").addEventListener("click", async () => {
  await navigator.clipboard.writeText(location.origin);
  serverDialogDetail.textContent = "서버 주소를 복사했습니다.";
});
document.querySelector("#copy-pair-token").addEventListener("click", async () => {
  const token = CultureAPI.getToken();
  if (!token) {
    serverDialogDetail.textContent = "먼저 서버에 연결해야 토큰을 복사할 수 있습니다.";
    return;
  }
  await navigator.clipboard.writeText(token);
  serverDialogDetail.textContent = "페어링 토큰을 복사했습니다. 본인 기기에만 입력하세요.";
});

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
  return [...new Set([
    ...playlistCatalog,
    ...jobs.map(job => job.playlist || "기본 재생목록")
  ])].sort((a, b) => {
    if (a === "기본 재생목록") return -1;
    if (b === "기본 재생목록") return 1;
    return a.localeCompare(b, "ko");
  });
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
    clearSelection();
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
  renderedJobIds = jobs.map(job => job.id);
  if (!jobs.length) {
    jobList.innerHTML = '<div class="empty">아직 맡겨둔 영상이 없습니다.</div>';
    updateSelectionUi();
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
      <article class="job-card${selectedJobIds.has(job.id) ? " selected" : ""}" data-job-id="${escapeHtml(job.id)}">
        <label class="job-select" title="선택">
          <input type="checkbox" data-select-id="${escapeHtml(job.id)}" aria-label="${escapeHtml(job.title || job.video_id)} 선택" ${selectedJobIds.has(job.id) ? "checked" : ""}>
        </label>
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
  document.querySelectorAll("[data-select-id]").forEach(input => input.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    const index = renderedJobIds.indexOf(input.dataset.selectId);
    toggleJobSelection(index, event.shiftKey);
  }));
  document.querySelectorAll(".job-card").forEach(card => card.addEventListener("click", event => {
    if (event.target.closest("button, a, input, label, select, video")) return;
    const index = renderedJobIds.indexOf(card.dataset.jobId);
    selectJobFromCard(index, event);
  }));
  updateSelectionUi();
}

function setSelectedRange(fromIndex, toIndex, selected = true) {
  const start = Math.max(0, Math.min(fromIndex, toIndex));
  const end = Math.min(renderedJobIds.length - 1, Math.max(fromIndex, toIndex));
  for (let index = start; index <= end; index += 1) {
    if (selected) selectedJobIds.add(renderedJobIds[index]);
    else selectedJobIds.delete(renderedJobIds[index]);
  }
}

function toggleJobSelection(index, shiftKey = false) {
  if (index < 0) return;
  const id = renderedJobIds[index];
  const shouldSelect = !selectedJobIds.has(id);
  if (shiftKey && lastSelectionIndex !== null) setSelectedRange(lastSelectionIndex, index, shouldSelect);
  else if (shouldSelect) selectedJobIds.add(id);
  else selectedJobIds.delete(id);
  lastSelectionIndex = index;
  updateSelectionUi();
}

function selectJobFromCard(index, event) {
  if (index < 0) return;
  const id = renderedJobIds[index];
  if (event.shiftKey && lastSelectionIndex !== null) {
    setSelectedRange(lastSelectionIndex, index, true);
  } else if (event.ctrlKey || event.metaKey) {
    if (selectedJobIds.has(id)) selectedJobIds.delete(id);
    else selectedJobIds.add(id);
    lastSelectionIndex = index;
  } else {
    selectedJobIds.clear();
    selectedJobIds.add(id);
    lastSelectionIndex = index;
  }
  updateSelectionUi();
}

function updateSelectionUi() {
  document.querySelectorAll(".job-card").forEach(card => {
    const selected = selectedJobIds.has(card.dataset.jobId);
    card.classList.toggle("selected", selected);
    const input = card.querySelector("[data-select-id]");
    if (input) input.checked = selected;
  });
  const selectedVisible = renderedJobIds.filter(id => selectedJobIds.has(id)).length;
  selectVisible.checked = Boolean(renderedJobIds.length) && selectedVisible === renderedJobIds.length;
  selectVisible.indeterminate = selectedVisible > 0 && selectedVisible < renderedJobIds.length;
  selectVisible.disabled = !renderedJobIds.length;
  selectionCount.textContent = `선택 ${selectedJobIds.size}개`;
  bulkPlaylistButton.disabled = selectedJobIds.size === 0;
  clearSelectionButton.disabled = selectedJobIds.size === 0;
}

function clearSelection() {
  selectedJobIds.clear();
  lastSelectionIndex = null;
  updateSelectionUi();
}

selectVisible.addEventListener("change", () => {
  renderedJobIds.forEach(id => {
    if (selectVisible.checked) selectedJobIds.add(id);
    else selectedJobIds.delete(id);
  });
  lastSelectionIndex = null;
  updateSelectionUi();
});

clearSelectionButton.addEventListener("click", clearSelection);
bulkPlaylistButton.addEventListener("click", () => {
  const jobs = allJobs.filter(job => selectedJobIds.has(job.id));
  if (jobs.length) openPlaylistDialogForJobs(jobs);
});

document.querySelector("#create-playlist-button").addEventListener("click", () => {
  const input = document.querySelector("#new-playlist-name");
  input.value = "";
  document.querySelector("#create-playlist-dialog-message").textContent = "";
  document.querySelector("#create-playlist-confirm").disabled = false;
  createPlaylistDialog.showModal();
  input.focus();
});

document.querySelector("#create-playlist-cancel").addEventListener("click", () => {
  createPlaylistDialog.close("cancel");
});

createPlaylistForm.addEventListener("submit", async event => {
  event.preventDefault();
  const input = document.querySelector("#new-playlist-name");
  const confirm = document.querySelector("#create-playlist-confirm");
  const dialogMessage = document.querySelector("#create-playlist-dialog-message");
  confirm.disabled = true;
  try {
    const {playlist} = await CultureAPI.request("/api/playlists", {
      method: "POST", body: JSON.stringify({name: input.value.trim()})
    });
    activeLibrary = `playlist:${playlist}`;
    createPlaylistDialog.close("created");
    await loadJobs();
  } catch (error) {
    dialogMessage.textContent = error.message;
    confirm.disabled = false;
  }
});

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
  openPlaylistDialogForJobs([{
    id: button.dataset.playlistId,
    title: button.dataset.playlistTitle,
    playlist: button.dataset.playlistName || "기본 재생목록"
  }]);
}

function openPlaylistDialogForJobs(jobs) {
  const currentPlaylists = [...new Set(jobs.map(job => job.playlist || "기본 재생목록"))];
  pendingPlaylistJob = {
    ids: jobs.map(job => job.id),
    title: jobs.length === 1 ? jobs[0].title : `${jobs.length}개 영상을 한꺼번에 이동`,
    playlist: currentPlaylists.length === 1 ? currentPlaylists[0] : ""
  };
  document.querySelector("#playlist-job-title").textContent = pendingPlaylistJob.title;
  const input = document.querySelector("#playlist-name");
  input.value = pendingPlaylistJob.playlist;
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
    if (pendingPlaylistJob.ids.length === 1) {
      await CultureAPI.request(`/api/jobs/${pendingPlaylistJob.ids[0]}`, {
        method: "PATCH", body: JSON.stringify({playlist})
      });
    } else {
      await CultureAPI.request("/api/jobs/bulk", {
        method: "PATCH", body: JSON.stringify({ids: pendingPlaylistJob.ids, playlist})
      });
    }
    activeLibrary = `playlist:${playlist.replace(/\s+/g, " ")}`;
    pendingPlaylistJob = null;
    clearSelection();
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
    const [{jobs}, {playlists}] = await Promise.all([
      CultureAPI.request("/api/jobs"),
      CultureAPI.request("/api/playlists")
    ]);
    const justCompleted = jobs.filter(job => knownStatuses.has(job.id) && knownStatuses.get(job.id) !== "completed" && job.status === "completed");
    jobs.forEach(job => knownStatuses.set(job.id, job.status));
    allJobs = jobs;
    playlistCatalog = playlists;
    const existingIds = new Set(jobs.map(job => job.id));
    [...selectedJobIds].forEach(id => { if (!existingIds.has(id)) selectedJobIds.delete(id); });
    const focusId = new URLSearchParams(location.search).get("focus");
    const focusJob = jobs.find(job => job.id === focusId && job.status === "completed");
    if (focusJob && !activePlayer) {
      activeLibrary = focusJob.hidden ? "hidden" : `playlist:${focusJob.playlist || "기본 재생목록"}`;
    }
    const playingId = activePlayer?.host.closest(".job-card")?.dataset.jobId;
    if (!playingId) renderLibrary();
    if (justCompleted.length && "Notification" in window && Notification.permission === "granted") {
      new Notification("문화자막이 완성됐습니다", {body: justCompleted[0].title, icon: "/app/icon-192.png"});
    }
    if (focusJob && !activePlayer) {
      history.replaceState({}, "", "/app/");
      openInlinePlayer(focusId);
    }
  } catch (error) {
    if (error.message === "pairing-required") {
      setConnectionState(false, "페어링 필요");
      if (!pairDialog.open) pairDialog.showModal();
    } else if (error.message === "server-unreachable") {
      setConnectionState(false, "서버 꺼짐");
      jobList.innerHTML = '<div class="empty">문화자막 서버가 꺼져 있습니다. 위의 ‘서버 꺼짐’을 눌러 다시 확인하세요.</div>';
    } else {
      jobList.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    }
  }
}

setSource(new URLSearchParams(location.search).get("source") === "local" ? "local" : "youtube");
ensureConnection().then(ok => { if (ok) loadJobs(); });
setInterval(loadJobs, 7000);
