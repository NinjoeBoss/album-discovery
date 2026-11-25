/* Club Music service worker: makes the app open fast and work offline.
 * Bump VERSION whenever index.html changes so phones pick up the new copy. */
var VERSION = 'ad-v111';
var SHELL = ['./', 'index.html', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  // cache: 'reload' skips the browser's own 10 minute copy, so a new version never saves a stale page.
  e.waitUntil(caches.open(VERSION).then(function (c) {
    return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
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

  // The app itself: open the saved copy right away (no waiting on the network, even with one bar),
  // then check GitHub in the background. If the page changed, save the new copy and tell the open app,
  // which shows a "New version" note; the next open gets it either way.
  // cache: 'no-cache' makes that check skip the browser's own 10 minute copy.
  // If this address stops serving the app (moved to a new domain: a 404 or a redirect), the saved copy keeps
  // opening, so its hand over code can carry your sign in to the new address.
  // (A redirect can't be handed straight to a page load; the browser shows an error.)
  // Page loads are saved under one name, so a link with ?k=… (home screen sign in) doesn't pile up copies.
  var nav = req.mode === 'navigate';
  var key = nav ? './' : req;
  var live = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
  e.respondWith(caches.open(VERSION).then(function (c) {
    return c.match(key).then(function (hit) {
      if (!hit && nav) return c.match('index.html');
      return hit;
    }).then(function (hit) {
      if (hit) {
        // Clone now: once the saved copy is handed to the page its body can't be read again.
        e.waitUntil(freshen(c, key, hit.clone(), live, nav || /\/index\.html$/.test(url.pathname), e.resultingClientId));
        return hit;
      }
      // Nothing saved yet (first open, or a file outside the shell): the network as before.
      return live.then(function (res) {
        if (res.ok && !res.redirected) c.put(key, res.clone());
        return res.redirected && nav ? Response.redirect(res.url, 302) : res;
      });
    });
  }));
});

/* Background check behind a saved copy: keep the newer one, and for the page itself tell open windows.
   The window being opened right now may not exist yet when the check finishes, so wait for it a few seconds. */
function freshen(c, key, hit, live, isPage, newId) {
  return live.then(function (res) {
    if (!res.ok || res.redirected) return;
    if (!isPage) return c.put(key, res);
    return Promise.all([hit.text(), res.clone().text()]).then(function (t) {
      if (t[0] === t[1]) return;
      return c.put(key, res).then(function () { if (newId) newer[newId] = true; return tellUpdate(newId, 20); });
    });
  }).catch(function () {});
}
/* Windows opened from a copy that's already been replaced. A page that's still loading can miss the note above,
   so it also asks once it's ready ({type:'ask'}), and gets the same note back. */
var newer = {};
self.addEventListener('message', function (e) {
  if (!e.data || e.data.type !== 'ask' || !e.source) return;
  if (newer[e.source.id]) { delete newer[e.source.id]; e.source.postMessage({ type: 'update' }); }
});
function tellUpdate(newId, tries) {
  var note = { type: 'update' };
  if (!newId) return self.clients.matchAll({ type: 'window' }).then(function (list) { list.forEach(function (w) { w.postMessage(note); }); });
  return self.clients.get(newId).then(function (w) {
    if (w) { w.postMessage(note); return; }
    if (tries <= 0) return tellUpdate(null, 0);
    return new Promise(function (ok) { setTimeout(ok, 250); }).then(function () { return tellUpdate(newId, tries - 1); });
  });
}

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
