// Minimal service worker: lets Android Chrome install the phone page as a full-screen app.
// It does not cache anything — the page always needs the live server.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
