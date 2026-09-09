// Minimal service worker — its only job is to satisfy PWA installability
// criteria (a registered SW with a fetch handler). Deliberately NOT caching
// API responses or pages: this app's data changes on every action (sync,
// analysis, chat), so a caching SW would risk serving stale financial data.
// A real offline mode is a deliberate later feature, not an accident of
// caching everything by default.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
