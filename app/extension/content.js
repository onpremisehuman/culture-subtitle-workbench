let currentVideoId = "";
let cues = [];
let enabled = true;
let overlay;
let dialogue;
let note;
let badge;
let lastCueKey = "";
let userScale = 1;
let userFont = "gothic";
let overlayResizeObserver;
const FONT_KEYS = new Set(["gothic", "a2z", "serif", "mono"]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function updateSubtitleSizes() {
  if (!overlay) return;
  const {width, height} = overlay.getBoundingClientRect();
  if (!width || !height) return;
  const dialogueSize = clamp(Math.min(width * .041, height * .072), 12, 42) * userScale;
  const noteSize = clamp(Math.min(width * .03, height * .053), 10, 31) * userScale;
  overlay.style.setProperty("--culture-dialogue-size", `${dialogueSize.toFixed(2)}px`);
  overlay.style.setProperty("--culture-note-size", `${noteSize.toFixed(2)}px`);
}

function applyUserScale(value) {
  userScale = clamp(Number(value) || 1, .7, 1.5);
  updateSubtitleSizes();
}

function applyUserFont(value) {
  userFont = FONT_KEYS.has(value) ? value : "gothic";
  if (overlay) overlay.dataset.font = userFont;
}

function extractVideoId() {
  const url = new URL(location.href);
  if (url.pathname === "/watch") return url.searchParams.get("v") || "";
  const match = url.pathname.match(/^\/(?:shorts|live)\/([A-Za-z0-9_-]{11})/);
  return match?.[1] || "";
}

function ensureOverlay() {
  const player = document.querySelector(".html5-video-player");
  if (!player) return false;
  if (overlay?.isConnected && overlay.parentElement === player) return true;
  overlay = document.createElement("div");
  overlay.className = "culture-subtitle-overlay";
  overlay.dataset.font = userFont;
  overlay.innerHTML = `
    <div class="culture-note"></div>
    <div class="culture-dialogue"></div>
    <button class="culture-badge" type="button" title="문화자막 켜기/끄기">문화자막</button>`;
  note = overlay.querySelector(".culture-note");
  dialogue = overlay.querySelector(".culture-dialogue");
  badge = overlay.querySelector(".culture-badge");
  badge.addEventListener("click", event => {
    event.stopPropagation();
    enabled = !enabled;
    badge.classList.toggle("off", !enabled);
    badge.textContent = enabled ? "문화자막" : "자막 꺼짐";
    if (!enabled) setText(dialogue, ""), setText(note, "");
  });
  player.appendChild(overlay);
  overlayResizeObserver?.disconnect();
  overlayResizeObserver = new ResizeObserver(updateSubtitleSizes);
  overlayResizeObserver.observe(overlay);
  updateSubtitleSizes();
  return true;
}

function sendApi(path, options) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({type: "api", path, options}, response => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else if (!response?.ok) reject(new Error(response?.error || "서버 연결 실패"));
      else resolve(response.data);
    });
  });
}

function parseSrt(text) {
  return text.replace(/\r/g, "").trim().split(/\n{2,}/).map(block => {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex(line => line.includes("-->"));
    if (timingIndex < 0) return null;
    const [start, end] = lines[timingIndex].split("-->").map(value => value.trim());
    const seconds = value => {
      const [h, m, rest] = value.replace(",", ".").split(":");
      return Number(h) * 3600 + Number(m) * 60 + Number(rest);
    };
    const cueText = lines.slice(timingIndex + 1).join("\n").replace(/<[^>]+>/g, "").trim();
    const marker = "※ 역주:";
    const markerIndex = cueText.indexOf(marker);
    const text = markerIndex < 0 ? cueText : cueText.slice(0, markerIndex).trim();
    const noteText = markerIndex < 0 ? "" : cueText.slice(markerIndex).trim();
    return {start: seconds(start), end: seconds(end), text, noteText};
  }).filter(Boolean);
}

async function loadForVideo(videoId) {
  cues = [];
  if (!ensureOverlay()) return;
  badge.textContent = "확인 중";
  badge.classList.remove("ready", "off");
  try {
    const {job} = await sendApi(`/api/jobs/by-video/${videoId}`);
    if (!job) {
      badge.textContent = "자막 없음";
      return;
    }
    if (job.status !== "completed") {
      badge.textContent = job.stage || "작업 중";
      return;
    }
    const srt = await sendApi(`/api/jobs/${job.id}/subtitle.srt`);
    cues = parseSrt(srt);
    badge.textContent = "문화자막";
    badge.classList.add("ready");
  } catch (_) {
    badge.textContent = "서버 꺼짐";
  }
}

function setText(element, text) {
  if (!element) return;
  const readable = String(text || "").replace(/\s+/g, " ").trim();
  if (element.textContent !== readable) element.textContent = readable;
  element.classList.toggle("visible", Boolean(readable));
}

function render() {
  ensureOverlay();
  const video = document.querySelector("video");
  if (video && enabled && cues.length) {
    const time = video.currentTime;
    const active = cues.filter(cue => time >= cue.start && time < cue.end);
    const normalCue = active.find(cue => cue.text);
    const noteCue = active.find(cue => cue.noteText);
    const key = `${normalCue?.text || ""}|${noteCue?.noteText || ""}`;
    if (key !== lastCueKey) {
      setText(dialogue, normalCue?.text || "");
      setText(note, noteCue?.noteText || "");
      lastCueKey = key;
    }
  }
  requestAnimationFrame(render);
}

async function watchNavigation() {
  const nextId = extractVideoId();
  if (nextId && nextId !== currentVideoId) {
    currentVideoId = nextId;
    await loadForVideo(nextId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "getVideoInfo") {
    sendResponse({videoId: extractVideoId(), title: document.title.replace(/\s*-\s*YouTube$/, "")});
  } else if (message.type === "reloadSubtitle") {
    loadForVideo(extractVideoId()).then(() => sendResponse({ok: true}));
    return true;
  }
});

chrome.storage.local.get({subtitleScale: 1, subtitleFont: "gothic"}).then(saved => {
  applyUserScale(saved.subtitleScale);
  applyUserFont(saved.subtitleFont);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.subtitleScale) applyUserScale(changes.subtitleScale.newValue);
  if (area === "local" && changes.subtitleFont) applyUserFont(changes.subtitleFont.newValue);
});

document.addEventListener("yt-navigate-finish", watchNavigation);
setInterval(watchNavigation, 1500);
requestAnimationFrame(render);
watchNavigation();
