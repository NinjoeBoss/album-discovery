/* Club Music service worker: makes the app open fast and work offline.
 * Bump VERSION whenever index.html changes so phones pick up the new copy. */
var VERSION = 'ad-v100';
var SHELL = ['./', 'index.html', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION && k !== 'ad-art'; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return; // sheet requests are POSTs: always live
  var url = new URL(req.url);

  // Album art from Apple: keep a copy so covers show instantly and offline.
  if (/mzstatic\.com$/.test(url.hostname)) {
    e.respondWith(caches.open('ad-art').then(function (c) {
      return c.match(req).then(function (hit) {
        return hit || fetch(req).then(function (res) { c.put(req, res.clone()); return res; });
      });
    }));
    return;
  }
  if (url.origin !== location.origin) return;

  // The app itself: try the network first so updates arrive, fall back to the saved copy.
  // cache: 'no-cache' makes the browser check with GitHub every time instead of reusing
  // its own 10 minute copy, so a new version shows on the next open.
  // If this address stops serving the app (moved to a new domain: a 404 or a redirect), open the
  // saved copy instead, so its hand over code can carry your sign in to the new address.
  // (A redirect can't be handed straight to a page load; the browser shows an error.)
  // Page loads are saved under one name, so a link with ?k=… (home screen sign in) doesn't pile up copies.
  var nav = req.mode === 'navigate';
  e.respondWith(fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(function (res) {
    if (res.ok && !res.redirected) { var copy = res.clone(); caches.open(VERSION).then(function (c) { c.put(nav ? './' : req, copy); }); return res; }
    return caches.match(nav ? './' : req).then(function (hit) {
      if (!hit && req.mode === 'navigate') return caches.match('index.html').then(function (i) { return i || caches.match('./'); });
      return hit;
    }).then(function (hit) {
      if (hit) return hit;
      return res.redirected && req.mode === 'navigate' ? Response.redirect(res.url, 302) : res;
    });
  }).catch(function () {
    return caches.match(nav ? './' : req).then(function (hit) { return hit || caches.match('index.html'); });
  }));
});

/* Phone notifications. The api function sends { title, body, tag, url }, encrypted for this phone. */
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  // iPhone needs every push to show something, or it stops delivering them.
  // A chat note means the open app (if any) should fetch right away, not wait for its next check.
  var tell = d.tag === 'chat' ? self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    list.forEach(function (c) { c.postMessage({ type: 'chat' }); });
  }) : Promise.resolve();
  e.waitUntil(tell.then(function () { return self.registration.showNotification(d.title || 'Club Music', {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    data: { url: d.url || './' }
  }); }));
});

/* Tapping a notification: bring the open app forward and go there, or open the app at that spot. */
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.url.indexOf(self.registration.scope) === 0 && 'focus' in c) {
        c.postMessage({ type: 'go', url: url });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
