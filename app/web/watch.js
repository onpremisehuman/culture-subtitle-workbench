const params = new URLSearchParams(location.search);
const videoId = params.get("v") || "";
const dialogueEl = document.querySelector("#dialogue-subtitle");
const noteEl = document.querySelector("#note-subtitle");
const playerWrap = document.querySelector("#player-wrap");
const playerCard = document.querySelector("#watch-player-card");
const fullscreenButton = document.querySelector("#fullscreen");
const orientationHint = document.querySelector("#orientation-hint");
let orientationRequested = false;
let orientationAttempt = 0;
const statusEl = document.querySelector("#watch-status");
const titleEl = document.querySelector("#video-title");
const toggleButton = document.querySelector("#toggle-subtitles");
let player;
let playerReady = false;
let playbackJobId = '';
let playbackSession;
function connectPlayback() {
  if (!playerReady || !playbackJobId || playbackSession) return;
  playbackSession = CulturePlayback.attach({
    jobId: playbackJobId, host: document.querySelector('#playback-status'),
    read: () => ({position: player.getCurrentTime(), duration: player.getDuration(),
      playing: player.getPlayerState() === 1, ended: player.getPlayerState() === 0}),
    seek: value => player.seekTo(value, true), pause: () => player.pauseVideo(), play: () => player.playVideo()
  });
}
let cues = [];
let subtitlesEnabled = true;
let scale = 1;
const subtitleFont = document.querySelector("#subtitle-font");
const FONT_KEYS = new Set(["gothic", "a2z", "serif", "mono"]);

function applySubtitleFont(value) {
  const font = FONT_KEYS.has(value) ? value : "gothic";
  subtitleFont.value = font;
  playerWrap.querySelector(".subtitle-layer").dataset.font = font;
  localStorage.setItem("cultureSubtitleFont", font);
}

document.querySelector("#youtube-link").href = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player("youtube-player", {
    videoId,
    // Fullscreen must include our sibling subtitle layer, not only YouTube's iframe.
    playerVars: {playsinline: 1, rel: 0, fs: 0},
    events: {
      onReady: () => { playerReady = true; connectPlayback(); requestAnimationFrame(renderSubtitle); },
      onStateChange: event => { if (event.data === 0 || event.data === 2) playbackSession?.flush(); }
    }
  });
};

async function loadSubtitle() {
  try {
    const {job} = await CultureAPI.request(`/api/jobs/by-video/${encodeURIComponent(videoId)}`);
    if (!job) throw new Error("이 영상의 작업을 찾을 수 없습니다.");
    titleEl.textContent = job.title || videoId;
    if (job.status !== "completed") throw new Error(`아직 ${job.stage}입니다.`);
    const srt = await CultureAPI.request(`/api/jobs/${job.id}/subtitle.srt`);
    cues = CultureAPI.parseSrt(srt);
    playbackJobId = job.id;
    connectPlayback();
    statusEl.textContent = `자막 ${cues.length}개 · ${job.level === "curator" ? "고인물판" : job.level === "economy" ? "경제형" : "문화역주"}`;
  } catch (error) {
    statusEl.textContent = error.message;
  }
}

function renderSubtitle() {
  if (player && typeof player.getCurrentTime === "function") {
    const time = player.getCurrentTime();
    const active = subtitlesEnabled ? cues.filter(cue => time >= cue.start && time < cue.end) : [];
    const dialogue = active.find(cue => cue.text);
    const note = active.find(cue => cue.noteText);
    setCue(dialogueEl, dialogue?.text || "");
    setCue(noteEl, note?.noteText || "");
  }
  requestAnimationFrame(renderSubtitle);
}

function setCue(element, text) {
  const readable = String(text || "").replace(/\s+/g, " ").trim();
  if (element.textContent !== readable) element.textContent = readable;
  element.classList.toggle("visible", Boolean(readable));
}

toggleButton.addEventListener("click", () => {
  subtitlesEnabled = !subtitlesEnabled;
  toggleButton.classList.toggle("active", subtitlesEnabled);
  toggleButton.textContent = subtitlesEnabled ? "문화자막 켜짐" : "문화자막 꺼짐";
});

document.querySelector("#font-down").addEventListener("click", () => setScale(scale - .1));
document.querySelector("#font-up").addEventListener("click", () => setScale(scale + .1));
subtitleFont.addEventListener("change", () => applySubtitleFont(subtitleFont.value));
function setScale(value) {
  scale = Math.min(1.5, Math.max(.7, value));
  playerWrap.style.setProperty("--subtitle-scale", scale);
  // Scale glyphs, not the entire layer (which could move cues outside fullscreen).
}

function isExpanded() {
  return document.fullscreenElement === playerCard || playerCard.classList.contains("is-expanded");
}

function releaseOrientation() {
  orientationAttempt++;
  if (orientationRequested) {
    try { window.screen?.orientation?.unlock?.(); } catch (_) {}
    orientationRequested = false;
  }
  orientationHint.hidden = true;
}

async function requestLandscape() {
  const attempt = ++orientationAttempt;
  try {
    if (!window.screen?.orientation?.lock) throw new Error("orientation-unavailable");
    orientationRequested = true;
    await window.screen.orientation.lock("landscape");
    // A user can leave fullscreen while the browser is still rotating.
    if (attempt !== orientationAttempt && !isExpanded()) {
      try { window.screen.orientation.unlock?.(); } catch (_) {}
    }
  } catch (_) {
    if (attempt === orientationAttempt && isExpanded()) {
      orientationHint.textContent = "자동 가로 전환이 제한된 브라우저입니다. 폰의 자동 회전을 켜고 가로로 돌려주세요.";
      orientationHint.hidden = false;
    }
  }
}

function syncFullscreen() {
  const expanded = isExpanded();
  fullscreenButton.textContent = expanded ? "전체화면 닫기" : "전체화면";
  fullscreenButton.setAttribute("aria-pressed", String(expanded));
  document.body.classList.toggle("watch-expanded", expanded);
  if (!expanded) releaseOrientation();
}

fullscreenButton.addEventListener("click", async () => {
  try {
    if (document.fullscreenElement === playerCard) {
      await document.exitFullscreen();
    } else if (playerCard.classList.contains("is-expanded")) {
      playerCard.classList.remove("is-expanded");
    } else {
      try {
        if (!playerCard.requestFullscreen) throw new Error("fullscreen-unavailable");
        await playerCard.requestFullscreen();
      } catch (_) {
        // Some mobile browsers disallow native fullscreen: keep subtitles in a viewport-sized view.
        playerCard.classList.add("is-expanded");
      }
      syncFullscreen();
      await requestLandscape();
    }
  } catch (_) {
    statusEl.textContent = "전체화면을 닫지 못했습니다. 휴대폰 뒤로가기나 Esc를 눌러주세요.";
  }
  syncFullscreen();
});
document.addEventListener("fullscreenchange", syncFullscreen);
window.addEventListener("pagehide", releaseOrientation);
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && playerCard.classList.contains("is-expanded")) {
    playerCard.classList.remove("is-expanded");
    syncFullscreen();
  }
});

applySubtitleFont(localStorage.getItem("cultureSubtitleFont") || "gothic");
loadSubtitle();
