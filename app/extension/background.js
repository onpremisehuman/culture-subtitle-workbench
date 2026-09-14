const API_BASE = "http://127.0.0.1:8876";

async function getToken() {
  const saved = await chrome.storage.local.get("apiToken");
  if (saved.apiToken) return saved.apiToken;
  const response = await fetch(`${API_BASE}/api/bootstrap`);
  if (!response.ok) throw new Error("문화자막 서버를 먼저 실행하세요.");
  const data = await response.json();
  await chrome.storage.local.set({apiToken: data.token});
  return data.token;
}

async function api(path, options = {}) {
  const token = await getToken();
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  if (options.body) headers.set("Content-Type", "application/json");
  let response = await fetch(`${API_BASE}${path}`, {...options, headers});
  if (response.status === 401) {
    await chrome.storage.local.remove("apiToken");
    headers.set("Authorization", `Bearer ${await getToken()}`);
    response = await fetch(`${API_BASE}${path}`, {...options, headers});
  }
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(data.error || `서버 오류 (${response.status})`);
  return data;
}

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create("poll-jobs", {periodInMinutes: 1}));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create("poll-jobs", {periodInMinutes: 1}));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === "api") {
      sendResponse({ok: true, data: await api(message.path, message.options)});
    } else if (message.type === "openQueue") {
      await chrome.tabs.create({url: `${API_BASE}/app/`});
      sendResponse({ok: true});
    } else if (message.type === "openLocalQueue") {
      await chrome.tabs.create({url: `${API_BASE}/app/?source=local`});
      sendResponse({ok: true});
    } else if (message.type === "downloadUrl") {
      await chrome.downloads.download({url: `${API_BASE}${message.path}`, saveAs: true});
      sendResponse({ok: true});
    }
  })().catch(error => sendResponse({ok: false, error: error.message}));
  return true;
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== "poll-jobs") return;
  try {
    const {jobs} = await api("/api/jobs");
    const storage = await chrome.storage.local.get("notifiedJobs");
    const notified = new Set(storage.notifiedJobs || []);
    const newlyCompleted = jobs.filter(job => job.status === "completed" && !job.hidden && !notified.has(job.id));
    for (const job of newlyCompleted) {
      await chrome.notifications.create(`culture-${job.id}`, {
        type: "basic",
        iconUrl: "icon.png",
        title: "문화자막이 완성됐습니다",
        message: job.title || job.video_id,
        priority: 1
      });
      notified.add(job.id);
    }
    await chrome.storage.local.set({notifiedJobs: [...notified].slice(-300)});
  } catch (_) {}
});

chrome.notifications.onClicked.addListener(async notificationId => {
  const id = notificationId.replace(/^culture-/, "");
  try {
    const {job} = await api(`/api/jobs/${id}`);
    await chrome.tabs.create({url: job.source_type === "local" ? `${API_BASE}${job.watch_url}` : job.youtube_url});
  } catch (_) {}
});
