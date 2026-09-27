const CACHE = "culture-subtitle-shell-v24";
const SHELL = ["/app/", "/app/styles.css", "/app/common.js", "/app/app.js", "/app/watch.html", "/app/watch.js", "/app/icon-192.png", "/app/icon-512.png", "/app/fonts/A2Z-Regular.ttf", "/app/fonts/A2Z-Medium.ttf", "/app/fonts/A2Z-Bold.ttf"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))));
self.addEventListener("activate", event => event.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim())
));
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
