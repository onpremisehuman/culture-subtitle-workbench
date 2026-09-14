const params = new URLSearchParams(location.search);
const videoId = params.get("v") || "";
const dialogueEl = document.querySelector("#dialogue-subtitle");
const noteEl = document.querySelector("#note-subtitle");
const playerWrap = document.querySelector("#player-wrap");
const statusEl = document.querySelector("#watch-status");
const titleEl = document.querySelector("#video-title");
const toggleButton = document.querySelector("#toggle-subtitles");
let player;
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
    playerVars: {playsinline: 1, rel: 0, modestbranding: 1},
    events: {onReady: () => requestAnimationFrame(renderSubtitle)}
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
  playerWrap.querySelector(".subtitle-layer").style.transform = `scale(${scale})`;
  playerWrap.querySelector(".subtitle-layer").style.transformOrigin = "center center";
}

document.querySelector("#fullscreen").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else playerWrap.requestFullscreen?.();
});

applySubtitleFont(localStorage.getItem("cultureSubtitleFont") || "gothic");
loadSubtitle();
