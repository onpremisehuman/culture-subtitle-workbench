const SERVERS = {
  local: {key: "local", label: "이 PC", base: "http://127.0.0.1:8876", control: "http://127.0.0.1:8875"}
};
const starts = new Map();
async function getServer() {
  const saved = await chrome.storage.local.get("cultureServerTarget");
  return Object.hasOwn(SERVERS, saved.cultureServerTarget) ? SERVERS[saved.cultureServerTarget] : SERVERS.local;
}
async function serverReady(target) {
  try {
    const response = await fetch(`${target.base}/api/health`, {cache: "no-store", signal: AbortSignal.timeout(1200)});
    const data = await response.json();
    return response.ok && data.ok === true && data.service === "문화자막 큐";
  } catch (_) { return false; }
}
function ensureServer(target) {
  if (!starts.has(target.key)) starts.set(target.key, (async () => {
    if (await serverReady(target)) return;
    try {
      const deadline = Date.now() + 25000;
      const response = await fetch(`${target.control}/api/ensure`, {
        method: "POST", headers: {"X-Culture-Start": "1"}, signal: AbortSignal.timeout(23000)
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error("실행 도우미 응답 오류");
      do {
        if (await serverReady(target)) return;
        await new Promise(resolve => setTimeout(resolve, 500));
      } while (Date.now() < deadline);
      throw new Error("시작 시간 초과");
    } catch (_) {
      throw new Error("이 PC의 실행 도우미에 연결하지 못했습니다. scripts/install.ps1 -RegisterAutostart로 시작 기능을 설치하거나 서버를 직접 켜주세요.");
    }
  })().finally(() => starts.delete(target.key)));
  return starts.get(target.key);
}
async function getToken(target) {
  const key = `apiToken:${target.base}`;
  const saved = await chrome.storage.local.get(key);
  if (saved[key]) return saved[key];
  const response = await fetch(`${target.base}/api/bootstrap`, {signal: AbortSignal.timeout(5000)});
  if (!response.ok) throw new Error("자동 연결에 실패했습니다. 이 PC의 서버 상태를 확인해주세요.");
  const data = await response.json();
  await chrome.storage.local.set({[key]: data.token});
  return data.token;
}
async function api(path, options = {}, target) {
  target ||= await getServer();
  if (typeof path !== "string" || !path.startsWith("/api/") || path.includes("..")) throw new Error("잘못된 API 경로입니다.");
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${await getToken(target)}`);
  if (options.body) headers.set("Content-Type", "application/json");
  let response = await fetch(`${target.base}${path}`, {...options, headers});
  if (response.status === 401) {
    await chrome.storage.local.remove(`apiToken:${target.base}`);
    headers.set("Authorization", `Bearer ${await getToken(target)}`);
    response = await fetch(`${target.base}${path}`, {...options, headers});
  }
  const data = (response.headers.get("content-type") || "").includes("json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(data.error || `서버 오류 (${response.status})`);
  return data;
}
chrome.runtime.onInstalled.addListener(() => chrome.alarms.create("poll-jobs", {periodInMinutes: 1}));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create("poll-jobs", {periodInMinutes: 1}));
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const target = await getServer(); // Freeze destination throughout this request.
    if (message.type === "getServer") sendResponse({ok: true, data: target});
    else if (message.type === "setServer") {
      if (sender.url !== chrome.runtime.getURL("popup.html") || !Object.hasOwn(SERVERS, message.target)) throw new Error("설정 화면에서 서버를 선택해주세요.");
      await chrome.storage.local.set({cultureServerTarget: message.target});
      sendResponse({ok: true, data: SERVERS[message.target]});
    } else if (message.type === "api") {
      if (message.path === "/api/jobs" && message.options?.method?.toUpperCase() === "POST") await ensureServer(target);
      sendResponse({ok: true, data: await api(message.path, message.options, target)});
    } else if (message.type === "openQueue" || message.type === "openLocalQueue") {
      await ensureServer(target);
      await chrome.tabs.create({url: `${target.base}/app/${message.type === "openLocalQueue" ? "?source=local" : ""}`});
      sendResponse({ok: true});
    } else if (message.type === "downloadUrl") {
      if (!/^\/api\/download\/[A-Za-z0-9_-]+$/.test(message.path)) throw new Error("잘못된 다운로드 경로입니다.");
      await chrome.downloads.download({url: `${target.base}${message.path}`, saveAs: true});
      sendResponse({ok: true});
    } else throw new Error("지원하지 않는 요청입니다.");
  })().catch(error => sendResponse({ok: false, error: error.message}));
  return true;
});
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== "poll-jobs") return;
  try {
    const target = await getServer();
    const {jobs} = await api("/api/jobs", {}, target);
    const key = `notifiedJobs:${target.key}`;
    const storage = await chrome.storage.local.get([key, "notifiedJobs"]);
    const notified = new Set(storage[key] || (target.key === "local" ? storage.notifiedJobs : []) || []);
    for (const job of jobs.filter(job => job.status === "completed" && !job.hidden && !notified.has(job.id))) {
      await chrome.notifications.create(`culture:${target.key}:${job.id}`, {
        type: "basic", iconUrl: "icon.png", title: "문화자막이 완성됐습니다", message: job.title || job.video_id, priority: 1
      });
      notified.add(job.id);
    }
    await chrome.storage.local.set({[key]: [...notified].slice(-300)});
  } catch (_) {}
});
chrome.notifications.onClicked.addListener(async notificationId => {
  try {
    const parts = notificationId.split(":");
    const target = parts[0] === "culture" ? SERVERS[parts[1]] : SERVERS.local;
    const id = parts[0] === "culture" ? parts[2] : notificationId.replace(/^culture-/, "");
    if (!target || !/^[A-Za-z0-9-]+$/.test(id)) return;
    const {job} = await api(`/api/jobs/${id}`, {}, target);
    await chrome.tabs.create({url: job.source_type === "local" ? `${target.base}${job.watch_url}` : job.youtube_url});
  } catch (_) {}
});
