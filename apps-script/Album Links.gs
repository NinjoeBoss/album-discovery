/**
 * Club Music: automatic album links
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

  var pick = null;
  var queries = albumLinks_spotifyQueries_(album, artist);
  for (var i = 0; i < queries.length && !pick; i++) {
    var items = albumLinks_spotifySearch_(queries[i]);
    try {
      pick = albumLinks_bestMatch_(items, album, artist,
        function (a) { return a.name; },
        function (a) { return (a.artists || []).map(function (x) { return x.name; }).join(', '); });
    } catch (e) { /* try the next, looser search */ }
  }
  if (!pick) throw new Error('No close match found on Spotify');

  var link = pick.external_urls.spotify;
  cache.put(key, link, 21600);
  return link;
}

/**
 * Searches to try, strictest first. Apostrophes and other punctuation are
 * dropped because Spotify's album:/artist: filters only bind the first word
 * of an unquoted multiword title (e.g. "There's No Gettin' Over Me").
 */
function albumLinks_spotifyQueries_(album, artist) {
  var clean = function (s) { return String(s || '').replace(/[\u2018\u2019'"]/g, '').replace(/\s+/g, ' ').trim(); };
  var a = clean(album), ar = clean(artist);
  var list = [];
  if (ar) list.push('album:"' + a + '" artist:"' + ar + '"');
  list.push(ar ? a + ' ' + ar : a);
  if (ar) list.push('artist:"' + ar + '" ' + a);
  return list;
}

/** Runs one Spotify album search (10 results, the dev mode maximum). */
function albumLinks_spotifySearch_(q) {
  var token = albumLinks_spotifyToken_();
  var res = UrlFetchApp.fetch(
    'https://api.spotify.com/v1/search?type=album&limit=10&q=' + encodeURIComponent(q),
    { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error('Spotify lookup failed (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 300));
  }
  return ((JSON.parse(res.getContentText()).albums) || {}).items || [];
}

/** Debug: what each search returns for an album, used by ?check=spotify&album=..&artist=.. */
function albumLinks_spotifyProbe_(album, artist) {
  var out = [];
  albumLinks_spotifyQueries_(album, artist).forEach(function (q) {
    var items = [];
    try { items = albumLinks_spotifySearch_(q); } catch (e) { out.push(q + ' => ' + e.message); return; }
    out.push(q + ' => ' + (items.slice(0, 5).map(function (a) {
      return a.name + ' / ' + (a.artists || []).map(function (x) { return x.name; }).join(', ') + ' [' + a.album_type + ']';
    }).join(' | ') || 'no results'));
  });
  var cache = CacheService.getScriptCache();
  cache.remove(albumLinks_cacheKey_('sp', album, artist));
  try { out.push('PICK => ' + GET_SPOTIFY_LINK(album, artist)); } catch (e) { out.push('PICK => ' + e.message); }
  return out.join(' || ');
}

/**
 * Troubleshooting: pick "testSpotify" in the function menu at the top of the
 * Apps Script editor and click Run. The result shows in the Execution log.
 */
function testSpotify() {
  try {
    var keys = albumLinks_spotifyKeys_();
    Logger.log('Client ID set: ' + !!keys.id);
    Logger.log('Client secret set: ' + !!keys.secret);
    CacheService.getScriptCache().remove('albumLinks_spotify_token');
    Logger.log('Success: ' + GET_SPOTIFY_LINK('Graduation', 'Kanye West'));
  } catch (e) {
    Logger.log('Problem: ' + e.message);
  }
}

/* ---------- artist pages (for the app's clickable artist names) ---------- */

/*
 * Direct artist page links. Found ones are saved for good in Script Properties
 * (artist pages don't move), so each artist is only looked up once. Each getData
 * spends at most AD_ARTIST_LOOKUP_MS on new lookups; anything left over gets a
 * search link this time and fills in on a later load.
 */
var AD_ARTIST_LOOKUP_MS = 6000;
var adArtistMemo_ = null, adArtistDeadline_ = 0;

/** Call once before a batch of artistLinks_get_ calls. */
function artistLinks_start_() {
  adArtistMemo_ = PropertiesService.getScriptProperties().getProperties();
  adArtistDeadline_ = Date.now() + AD_ARTIST_LOOKUP_MS;
}

/** Artist page on 'spotify' or 'apple', or '' (the app then uses a search link). */
function artistLinks_get_(service, artist) {
  artist = String(artist || '').trim();
  if (!artist) return '';
  if (!adArtistMemo_) artistLinks_start_();
  var key = ('artist|' + service + '|' + artist.toLowerCase()).slice(0, 200);
  if (adArtistMemo_[key] != null) return adArtistMemo_[key];
  var cache = CacheService.getScriptCache();
  if (cache.get(key) === 'none') return '';
  if (Date.now() > adArtistDeadline_) return '';
  var link = '';
  try {
    link = service === 'apple' ? artistLinks_apple_(artist) : artistLinks_spotify_(artist);
  } catch (e) {
    return ''; // network or key trouble: try again next load
  }
  if (link) {
    PropertiesService.getScriptProperties().setProperty(key, link);
    adArtistMemo_[key] = link;
  } else {
    cache.put(key, 'none', 21600); // no match: don't search again for 6 hours
  }
  return link;
}

/** Names to try: the full credit, then the first name in it ("A & B" → "A"). */
function artistLinks_names_(artist) {
  var first = artist.split(/\s*(?:,|&|\band\b|\bx\b|\bfeat\.?|\bft\.?|\bwith\b)\s*/i)[0].trim();
  return first && first.toLowerCase() !== artist.toLowerCase() ? [artist, first] : [artist];
}

function artistLinks_norm_(s) {
  return String(s || '').toLowerCase().replace(/[‘’'".]/g, '').replace(/[^a-z0-9$¥]+/g, ' ').trim();
}

/** Exact name match first; otherwise the top result when it at least contains the name. */
function artistLinks_pick_(items, name, nameOf) {
  var n = artistLinks_norm_(name);
  var exact = items.filter(function (it) { return artistLinks_norm_(nameOf(it)) === n; })[0];
  if (exact) return exact;
  var top = items[0];
  return top && n && artistLinks_norm_(nameOf(top)).indexOf(n) >= 0 ? top : null;
}

function artistLinks_spotify_(artist) {
  var token = albumLinks_spotifyToken_();
  var names = artistLinks_names_(artist);
  for (var i = 0; i < names.length; i++) {
    var q = 'artist:"' + names[i].replace(/[‘’'"]/g, '') + '"';
    var res = UrlFetchApp.fetch('https://api.spotify.com/v1/search?type=artist&limit=10&q=' + encodeURIComponent(q),
      { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('Spotify artist lookup failed (' + res.getResponseCode() + ')');
    var items = ((JSON.parse(res.getContentText()).artists) || {}).items || [];
    var pick = artistLinks_pick_(items, names[i], function (a) { return a.name; });
    if (pick && pick.external_urls && pick.external_urls.spotify) return pick.external_urls.spotify;
  }
  return '';
}

function artistLinks_apple_(artist) {
  var names = artistLinks_names_(artist);
  for (var i = 0; i < names.length; i++) {
    var res = UrlFetchApp.fetch('https://itunes.apple.com/search?entity=musicArtist&limit=10&country=us&term=' + encodeURIComponent(names[i]),
      { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('Apple Music artist lookup failed (' + res.getResponseCode() + ')');
    var items = JSON.parse(res.getContentText()).results || [];
    var pick = artistLinks_pick_(items, names[i], function (a) { return a.artistName; });
    if (pick && pick.artistLinkUrl) return String(pick.artistLinkUrl).split('?')[0];
  }
  return '';
}

/** Editor helper: run to see the artist links for every album in the Logs. */
function checkArtistLinks() {
  artistLinks_start_();
  getData().albums.forEach(function (a) {
    Logger.log(a.artist + '  |  ' + (a.spotifyArtist || '(search)') + '  |  ' + (a.appleArtist || '(search)'));
  });
}

/* ---------- helpers (not called from the sheet) ---------- */

function albumLinks_spotifyToken_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('albumLinks_spotify_token');
  if (cached) return cached;

  var keys = albumLinks_spotifyKeys_();
  var id = keys.id, secret = keys.secret;
  if (!id || !secret) throw new Error('Spotify keys not set: add the SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET secrets on GitHub (or Script Properties)');
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

/**
 * Spotify keys come from Script Properties if set there, otherwise from the
 * private SpotifyKeys.gs file the GitHub deploy writes from repo secrets.
 */
function albumLinks_spotifyKeys_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SPOTIFY_CLIENT_ID');
  var secret = props.getProperty('SPOTIFY_CLIENT_SECRET');
  if ((!id || !secret) && typeof AD_SPOTIFY_KEYS !== 'undefined') {
    id = AD_SPOTIFY_KEYS.id;
    secret = AD_SPOTIFY_KEYS.secret;
  }
  return { id: id || '', secret: secret || '' };
}

/** One line status for the deploy check. Never includes the keys themselves. */
function albumLinks_spotifyStatus_() {
  var k = albumLinks_spotifyKeys_();
  if (!k.id || !k.secret) return 'Spotify: keys not set';
  try {
    CacheService.getScriptCache().remove('albumLinks_spotify_token');
    CacheService.getScriptCache().remove(albumLinks_cacheKey_('sp', 'Graduation', 'Kanye West'));
    return 'Spotify: working (test album ' + GET_SPOTIFY_LINK('Graduation', 'Kanye West') + ')';
  } catch (e) {
    return 'Spotify: problem: ' + String(e.message).replace(k.secret, '***').replace(k.id, '***');
  }
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
 * Easiest: add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET as GitHub repo secrets
 * (Settings > Secrets and variables > Actions); the deploy job puts them into a
 * private SpotifyKeys.gs that never goes into the public repo. Or by hand:
 * 1. Someone with Spotify Premium signs in at https://developer.spotify.com/dashboard
 * 2. Create an app (any name; for Redirect URI you can enter https://example.com/callback;
 *    tick "Web API").
 * 3. Open the app's Settings and copy the Client ID and Client Secret.
 * 4. In this Apps Script editor: Project Settings (gear icon) > Script Properties > Add:
 *      SPOTIFY_CLIENT_ID      = <your client id>
 *      SPOTIFY_CLIENT_SECRET  = <your client secret>
 * 5. Back in the sheet, Spotify links switch from search links to album links on their own.
 */