/**
 * Album Discovery: automatic album links
 *
 * Adds two custom functions for the sheet:
 *   =GET_APPLE_MUSIC_LINK(album, artist)  works right away, no setup
 *   =GET_SPOTIFY_LINK(album, artist)      needs Spotify keys (see bottom of file)
 *
 * Each returns the direct album page (the kind of link that shows a preview).
 * Results are cached for 6 hours so the sheet doesn't look albums up over and over.
 */

/**
 * Returns the Apple Music album page for an album and artist.
 *
 * @param {string} album  Album title, e.g. B20
 * @param {string} artist Artist name, e.g. C20
 * @return {string} Direct Apple Music album link
 * @customfunction
 */
function GET_APPLE_MUSIC_LINK(album, artist) {
  if (!album) return '';
  var cache = CacheService.getScriptCache();
  var key = albumLinks_cacheKey_('am', album, artist);
  var hit = cache.get(key);
  if (hit) return hit;

  var url = 'https://itunes.apple.com/search?entity=album&limit=10&country=us&term=' +
    encodeURIComponent(album + ' ' + (artist || ''));
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Apple Music lookup failed');

  var results = JSON.parse(res.getContentText()).results || [];
  var pick = albumLinks_bestMatch_(results, album, artist,
    function (r) { return r.collectionName; },
    function (r) { return r.artistName; });

  var link = String(pick.collectionViewUrl).split('?')[0];
  cache.put(key, link, 21600);
  return link;
}

/**
 * Returns the Spotify album page for an album and artist.
 * Requires SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in Script Properties.
 *
 * @param {string} album  Album title, e.g. B20
 * @param {string} artist Artist name, e.g. C20
 * @return {string} Direct Spotify album link
 * @customfunction
 */
function GET_SPOTIFY_LINK(album, artist) {
  if (!album) return '';
  var cache = CacheService.getScriptCache();
  var key = albumLinks_cacheKey_('sp', album, artist);
  var hit = cache.get(key);
  if (hit) return hit;

  var token = albumLinks_spotifyToken_();
  var q = 'album:' + album + (artist ? ' artist:' + artist : '');
  var res = UrlFetchApp.fetch(
    'https://api.spotify.com/v1/search?type=album&limit=10&q=' + encodeURIComponent(q),
    { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error('Spotify lookup failed (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 300));
  }

  var items = ((JSON.parse(res.getContentText()).albums) || {}).items || [];
  var pick = albumLinks_bestMatch_(items, album, artist,
    function (a) { return a.name; },
    function (a) { return (a.artists || []).map(function (x) { return x.name; }).join(', '); });

  var link = pick.external_urls.spotify;
  cache.put(key, link, 21600);
  return link;
}

/**
 * Troubleshooting: pick "testSpotify" in the function menu at the top of the
 * Apps Script editor and click Run. The result shows in the Execution log.
 */
function testSpotify() {
  try {
    var props = PropertiesService.getScriptProperties();
    Logger.log('Client ID set: ' + !!props.getProperty('SPOTIFY_CLIENT_ID'));
    Logger.log('Client secret set: ' + !!props.getProperty('SPOTIFY_CLIENT_SECRET'));
    CacheService.getScriptCache().remove('albumLinks_spotify_token');
    Logger.log('Success: ' + GET_SPOTIFY_LINK('Graduation', 'Kanye West'));
  } catch (e) {
    Logger.log('Problem: ' + e.message);
  }
}

/* ---------- helpers (not called from the sheet) ---------- */

function albumLinks_spotifyToken_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('albumLinks_spotify_token');
  if (cached) return cached;

  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SPOTIFY_CLIENT_ID');
  var secret = props.getProperty('SPOTIFY_CLIENT_SECRET');
  if (!id || !secret) throw new Error('Spotify keys not set: add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in Project Settings > Script Properties');
  id = id.trim();
  secret = secret.trim();

  var res = UrlFetchApp.fetch('https://accounts.spotify.com/api/token', {
    method: 'post',
    payload: { grant_type: 'client_credentials' },
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(id + ':' + secret) },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Spotify sign in failed (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 300));
  }

  var data = JSON.parse(res.getContentText());
  cache.put('albumLinks_spotify_token', data.access_token, Math.max(60, data.expires_in - 120));
  return data.access_token;
}

/** Picks the result whose title and artist best match, preferring the standard edition. */
function albumLinks_bestMatch_(items, album, artist, nameOf, artistOf) {
  var norm = function (s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  };
  var extras = /\b(deluxe|remaster(ed)?|edition|version|live|anniversary|expanded)\b/;
  var a = norm(album), ar = norm(artist);
  var best = null, bestScore = -1;

  items.forEach(function (it) {
    var n = norm(nameOf(it)), who = norm(artistOf(it));
    var s = 0;
    if (n === a) s += 10;
    else if (n.indexOf(a) === 0) s += 5;
    else if (n.indexOf(a) >= 0) s += 2;
    if (ar && who.indexOf(ar) >= 0) s += 6;
    if (extras.test(n) && !extras.test(a)) s -= 3;
    if (s > bestScore) { best = it; bestScore = s; }
  });

  if (!best || bestScore < 5) throw new Error('No close match found');
  return best;
}

function albumLinks_cacheKey_(prefix, album, artist) {
  return (prefix + '|' + album + '|' + (artist || '')).slice(0, 240);
}

/*
 * OPTIONAL: turning on Spotify links
 * 1. Someone with Spotify Premium signs in at https://developer.spotify.com/dashboard
 * 2. Create an app (any name; for Redirect URI you can enter https://example.com/callback;
 *    tick "Web API").
 * 3. Open the app's Settings and copy the Client ID and Client Secret.
 * 4. In this Apps Script editor: Project Settings (gear icon) > Script Properties > Add:
 *      SPOTIFY_CLIENT_ID      = <your client id>
 *      SPOTIFY_CLIENT_SECRET  = <your client secret>
 * 5. Back in the sheet, Spotify links switch from search links to album links on their own.
 */