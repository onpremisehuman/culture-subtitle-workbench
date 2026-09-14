const CultureAPI = (() => {
  const TOKEN_KEY = "cultureSubtitleToken";

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || "";
  }

  function setToken(token) {
    localStorage.setItem(TOKEN_KEY, token.trim());
  }

  async function bootstrap() {
    if (getToken()) return getToken();
    const response = await fetch("/api/bootstrap");
    if (!response.ok) throw new Error("pairing-required");
    const data = await response.json();
    setToken(data.token);
    return data.token;
  }

  async function request(path, options = {}) {
    const token = getToken() || await bootstrap();
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${token}`);
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await fetch(path, {...options, headers});
    let data;
    if ((response.headers.get("content-type") || "").includes("json")) data = await response.json();
    else data = await response.text();
    if (!response.ok) throw new Error(data.error || `요청 실패 (${response.status})`);
    return data;
  }

  function parseSrt(text) {
    return text.replace(/\r/g, "").trim().split(/\n{2,}/).map(block => {
      const lines = block.split("\n");
      const timingIndex = lines.findIndex(line => line.includes("-->"));
      if (timingIndex < 0) return null;
      const [start, end] = lines[timingIndex].split("-->").map(value => value.trim());
      const toSeconds = value => {
        const [h, m, rest] = value.replace(",", ".").split(":");
        return Number(h) * 3600 + Number(m) * 60 + Number(rest);
      };
      const cueText = lines.slice(timingIndex + 1).join("\n").replace(/<[^>]+>/g, "").trim();
      const marker = "※ 역주:";
      const markerIndex = cueText.indexOf(marker);
      const text = markerIndex < 0 ? cueText : cueText.slice(0, markerIndex).trim();
      const noteText = markerIndex < 0 ? "" : cueText.slice(markerIndex).trim();
      return {start: toSeconds(start), end: toSeconds(end), text, noteText};
    }).filter(Boolean);
  }

  return {getToken, setToken, bootstrap, request, parseSrt};
})();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/app/sw.js").catch(() => {});
