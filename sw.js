// sw.js — placeholder for Phase 1.
// Full offline caching strategy (app shell + OpenCV.js wasm + IndexedDB
// coordination) is implemented in Phase 13. For now this only exists so
// registration in app.js doesn't fail, and installs with no caching.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
});
