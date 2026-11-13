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
  var nameOf = function (r) { return r.collectionName; }, artistOf = function (r) { return r.artistName; };
  var pick;
  try { pick = albumLinks_bestMatch_(results, album, artist, nameOf, artistOf); }
  catch (e) {
    // Search can miss albums that are in the catalog; try the artist's own album list.
    if (typeof itunesArtistAlbums_ !== 'function') throw e;
    pick = albumLinks_bestMatch_(itunesArtistAlbums_(artist), album, artist, nameOf, artistOf);
  }
  // Apple's search sometimes only returns the clean copy (e.g. ALL-AMERIKKKAN BADA$$);
  // the artist's own album list has the explicit one too.
  if (pick.collectionExplicitness === 'cleaned' && typeof itunesArtistAlbums_ === 'function') {
    var n = albumLinks_norm_(pick.collectionName);
    var exp = itunesArtistAlbums_(artist).filter(function (r) {
      return r.collectionExplicitness === 'explicit' && albumLinks_norm_(r.collectionName) === n;
    })[0];
    if (exp && exp.collectionViewUrl) pick = exp;
  }

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
    var tied = albumLinks_topMatches_(items, album, artist,
      function (a) { return a.name; },
      function (a) { return (a.artists || []).map(function (x) { return x.name; }).join(', '); });
    pick = albumLinks_preferExplicitSpotify_(tied); // null: try the next, looser search
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
  adOwnerOnly_();
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
  adOwnerOnly_();
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

/**
 * Picks the result whose title and artist best match, preferring the standard
 * edition and the explicit (uncensored) version over a clean one.
 */
function albumLinks_bestMatch_(items, album, artist, nameOf, artistOf) {
  var top = albumLinks_topMatches_(items, album, artist, nameOf, artistOf);
  if (!top.length) throw new Error('No close match found');
  return top[0];
}

/**
 * Every result tied for the best score (at least 5), best first. Clean and
 * explicit copies of an album have the same title, so they tie here unless the
 * result says which it is (Apple's collectionExplicitness does; Spotify's album
 * search doesn't, see albumLinks_preferExplicitSpotify_).
 */
function albumLinks_topMatches_(items, album, artist, nameOf, artistOf) {
  var a = albumLinks_norm_(album), ar = albumLinks_norm_(artist);
  var scored = [], bestScore = -1;
  items.forEach(function (it) {
    var s = albumLinks_score_(albumLinks_norm_(nameOf(it)), albumLinks_norm_(artistOf(it)), a, ar) + albumLinks_explicitBonus_(it);
    scored.push({ it: it, s: s });
    if (s > bestScore) bestScore = s;
  });
  if (bestScore < 5) return [];
  return scored.filter(function (x) { return x.s === bestScore; }).map(function (x) { return x.it; });
}

function albumLinks_norm_(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Title and artist score (n, who = the result's; a, ar = what we looked for, all normalized). */
function albumLinks_score_(n, who, a, ar) {
  var extras = /\b(deluxe|remaster(ed)?|edition|version|live|anniversary|expanded)\b/;
  var s = 0;
  if (n === a) s += 10;
  else if (n.indexOf(a) === 0) s += 5;
  else if (n.indexOf(a) >= 0) s += 2;
  if (ar && who.indexOf(ar) >= 0) s += 6;
  if (extras.test(n) && !extras.test(a)) s -= 3;
  return s;
}

/**
 * Apple results say "explicit", "cleaned" or "notExplicit". Small enough that it
 * only breaks ties between copies of the same album, never beats a better title.
 */
function albumLinks_explicitBonus_(it) {
  var e = String((it && (it.collectionExplicitness || it.trackExplicitness)) || '').toLowerCase();
  if (e === 'explicit') return 1;
  if (e === 'cleaned') return -2;
  return 0;
}

/**
 * Spotify's album search doesn't say which copy is explicit, but each track
 * does. When several albums tie, opens up to three and takes the first with an
 * explicit track; if none has one (an album with no swearing), keeps the first.
 */
function albumLinks_preferExplicitSpotify_(tied) {
  if (tied.length < 2) return tied[0] || null;
  for (var i = 0; i < tied.length && i < 3; i++) {
    if (albumLinks_spotifyHasExplicit_(tied[i].id) === true) return tied[i];
  }
  return tied[0];
}

/** true / false, or null if Spotify couldn't be asked. */
function albumLinks_spotifyHasExplicit_(albumId) {
  if (!albumId) return null;
  try {
    var res = UrlFetchApp.fetch('https://api.spotify.com/v1/albums/' + albumId + '/tracks?limit=50&market=US',
      { headers: { Authorization: 'Bearer ' + albumLinks_spotifyToken_() }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    return (JSON.parse(res.getContentText()).items || []).some(function (t) { return t.explicit; });
  } catch (e) { return null; }
}

/** Apple: "explicit", "cleaned", "notExplicit", or '' if it couldn't be looked up. */
function albumLinks_appleExplicitness_(albumUrl) {
  var m = String(albumUrl || '').match(/music\.apple\.com\/.*\/album\/(?:[^\/?]+\/)?(\d+)/);
  if (!m) return '';
  try {
    var res = UrlFetchApp.fetch('https://itunes.apple.com/lookup?country=us&id=' + m[1], { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return '';
    var r = (JSON.parse(res.getContentText()).results || [])[0];
    return r ? String(r.collectionExplicitness || '') : '';
  } catch (e) { return ''; }
}

/** Debug for the explicit check: the albums Apple offers for a title, with their explicitness and id. */
function albumLinks_appleCandidates_(album, artist) {
  var show = function (r) { return r.collectionName + ' / ' + r.artistName + ' / ' + r.collectionExplicitness + ' / ' + r.collectionId; };
  try {
    var res = UrlFetchApp.fetch('https://itunes.apple.com/search?entity=album&limit=10&country=us&term=' +
      encodeURIComponent(album + ' ' + (artist || '')), { muteHttpExceptions: true });
    var found = res.getResponseCode() === 200 ? (JSON.parse(res.getContentText()).results || []).map(show) : ['search ' + res.getResponseCode()];
    var a = albumLinks_norm_(album);
    var mine = (typeof itunesArtistAlbums_ === 'function' ? itunesArtistAlbums_(artist) : [])
      .filter(function (r) { return albumLinks_norm_(r.collectionName).indexOf(a) >= 0; }).map(show);
    return 'search: ' + (found.join('; ') || 'none') + ' || artist list: ' + (mine.join('; ') || 'none');
  } catch (e) { return e.message; }
}

/**
 * Deploy check (?check=explicit): one line per album,
 * "album | artist | apple: <kind> <link> | spotify: <kind> <link>", where kind is
 * explicit / clean / no-swearing / ?. A link typed into the sheet is marked
 * (sheet), and if it's the clean copy the line adds what the lookup picks now.
 */
function albumLinks_explicitReport_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AD_SHEET_NAME);
  var L = adLayout_(sh);
  var n = sh.getLastRow() - L.headerRow;
  if (n <= 0) return '';
  var range = sh.getRange(L.headerRow + 1, 1, n, L.lastCol);
  var vals = range.getValues(), formulas = range.getFormulas();
  var lit = function (f) { var m = String(f || '').match(/HYPERLINK\(\s*"(https?:\/\/[^"]+)"/i); return m ? m[1] : ''; };
  var out = [];
  vals.forEach(function (r, i) {
    var album = String(r[L.album] || '').trim(), artist = String(r[L.artist] || '').trim();
    if (!album || /^tbd$/i.test(album)) return;
    var parts = [album, artist];
    ['apple', 'spotify'].forEach(function (p) {
      var col = p === 'apple' ? L.apple : L.spotify;
      var f = col >= 0 ? formulas[i][col] : '';
      var typed = lit(f);
      var url = typed || adLink_(f, p, album, artist);
      var kind = '?';
      if (p === 'apple') {
        var e = albumLinks_appleExplicitness_(url);
        kind = e === 'explicit' ? 'explicit' : e === 'cleaned' ? 'clean' : e === 'notExplicit' ? 'no-swearing' : '?';
      } else {
        var m = String(url).match(/open\.spotify\.com\/album\/([A-Za-z0-9]+)/);
        var h = m ? albumLinks_spotifyHasExplicit_(m[1]) : null;
        kind = h === true ? 'explicit' : h === false ? 'clean-or-none' : '?';
      }
      var line = p + ': ' + kind + ' ' + url + (typed ? ' (sheet)' : '');
      if (p === 'apple' && kind === 'clean') line += ' [apple has: ' + albumLinks_appleCandidates_(album, artist) + ']';
      if (typed && (kind === 'clean' || kind === 'clean-or-none')) {
        try {
          var now = p === 'apple' ? GET_APPLE_MUSIC_LINK(album, artist) : GET_SPOTIFY_LINK(album, artist);
          if (now && now !== typed) line += ' -> lookup now picks ' + now;
        } catch (err) { line += ' -> lookup: ' + err.message; }
      }
      parts.push(line);
    });
    out.push(parts.join(' | '));
  });
  return out.join('\n');
}

function albumLinks_cacheKey_(prefix, album, artist) {
  // "x2": Nov 12, 2026 explicit version fix, so links cached before it aren't reused.
  return (prefix + 'x3|' + album + '|' + (artist || '')).slice(0, 240);
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
/* ---------- song links (tap a song in the app to play it) ---------- */

/**
 * Direct links for songs on one album, for one platform ('spotify' or 'apple').
 * Returns { '<song>': 'https://...' }. Songs come from the album's own page first
 * (Apple: the album's id; Spotify: the album's track list), so the right version
 * opens, then a song search. Found links are saved for good; misses get a search link.
 */
function songLinks(row, p, songs) {
  adAppOnly_();
  p = p === 'apple' ? 'apple' : 'spotify';
  songs = (Array.isArray(songs) ? songs : []).map(function (s) { return String(s || '').trim(); })
    .filter(function (s, i, all) { return s && all.indexOf(s) === i; }).slice(0, 12);
  if (!songs.length) return {};

  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AD_SHEET_NAME);
  var L = adLayout_(sh);
  row = Number(row);
  if (!(row > L.headerRow) || row > sh.getLastRow()) throw new Error('That album could not be found.');
  var rng = sh.getRange(row, 1, 1, L.lastCol);
  var v = rng.getValues()[0], f = rng.getFormulas()[0];
  var album = String(v[L.album] || '').trim(), artist = String(v[L.artist] || '').trim();
  if (!album) throw new Error('That album could not be found.');

  var props = PropertiesService.getScriptProperties();
  var cache = CacheService.getScriptCache();
  var out = {}, todo = [];
  songs.forEach(function (s) {
    var key = songLinks_key_(p, album, artist, s);
    var saved = props.getProperty(key);
    if (saved) out[s] = saved;
    else if (cache.get(key) === 'none') out[s] = songLinks_search_(p, s, artist);
    else todo.push(s);
  });
  if (!todo.length) return out;

  // The album's own track list, so a song resolves to this album's version.
  var albumTracks = [];
  try {
    var col = p === 'apple' ? L.apple : L.spotify;
    var albumUrl = adLink_(col >= 0 ? f[col] : '', p, album, artist);
    albumTracks = p === 'apple' ? songLinks_appleAlbum_(albumUrl) : songLinks_spotifyAlbum_(albumUrl);
  } catch (e) { /* fall back to searching each song */ }

  todo.forEach(function (s) {
    var key = songLinks_key_(p, album, artist, s), url = '';
    try {
      url = songLinks_match_(albumTracks, s) || (p === 'apple' ? songLinks_appleSearch_(s, artist) : songLinks_spotifySearch_(s, artist));
    } catch (e) { url = ''; }
    if (url) { props.setProperty(key, url); out[s] = url; }
    else { cache.put(key, 'none', 21600); out[s] = songLinks_search_(p, s, artist); }
  });
  return out;
}

function songLinks_key_(p, album, artist, song) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, [album, artist, song].join('|').toLowerCase(), Utilities.Charset.UTF_8);
  return 'song|' + p + '|' + Utilities.base64EncodeWebSafe(d);
}

function songLinks_search_(p, song, artist) {
  var q = encodeURIComponent(song + ' ' + (artist || ''));
  return p === 'apple' ? 'https://music.apple.com/us/search?term=' + q : 'https://open.spotify.com/search/' + q;
}

/** "Song Name (feat. X) - Remastered 2011" -> "song name" */
function songLinks_norm_(s) {
  return String(s || '').toLowerCase()
    .replace(/\s*[\(\[][^\)\]]*[\)\]]/g, ' ')
    .replace(/\s+-\s+.*$/, '')
    .replace(/[‘’'".]/g, '').replace(/&/g, 'and')
    .replace(/[^a-z0-9$]+/g, ' ').trim();
}

/** tracks = [{ name, url }]. Exact title first, then the same title without (feat.) / " - Remaster" bits. */
function songLinks_match_(tracks, song) {
  if (!tracks || !tracks.length) return '';
  var exact = tracks.filter(function (t) { return t.name === song; })[0];
  if (exact) return exact.url;
  var n = songLinks_norm_(song);
  var loose = n && tracks.filter(function (t) { return songLinks_norm_(t.name) === n; })[0];
  return loose ? loose.url : '';
}

function songLinks_appleAlbum_(albumUrl) {
  var m = String(albumUrl || '').match(/music\.apple\.com\/.*\/album\/(?:[^\/?]+\/)?(\d+)/);
  if (!m) return [];
  var res = UrlFetchApp.fetch('https://itunes.apple.com/lookup?entity=song&limit=200&country=us&id=' + m[1], { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return [];
  return (JSON.parse(res.getContentText()).results || [])
    .filter(function (r) { return r.wrapperType === 'track' && r.trackViewUrl; })
    .map(function (r) { return { name: String(r.trackName || '').trim(), url: songLinks_appleUrl_(r.trackViewUrl) }; });
}

/** Keeps the ?i=<song id> part (that's what opens the song), drops tracking bits. */
function songLinks_appleUrl_(u) {
  var m = String(u).match(/^([^?]+)\?(?:.*&)?i=(\d+)/);
  return m ? m[1] + '?i=' + m[2] : String(u).split('&')[0];
}

function songLinks_appleSearch_(song, artist) {
  var res = UrlFetchApp.fetch('https://itunes.apple.com/search?entity=song&limit=25&country=us&term=' +
    encodeURIComponent(song + ' ' + (artist || '')), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return '';
  var ar = artistLinks_norm_(artist);
  var items = (JSON.parse(res.getContentText()).results || []).filter(function (r) {
    return r.trackViewUrl && (!ar || artistLinks_norm_(r.artistName).indexOf(ar) >= 0);
  });
  items = songLinks_explicitFirst_(items, function (r) { return r.trackExplicitness === 'explicit'; }).map(function (r) { return { name: String(r.trackName || '').trim(), url: songLinks_appleUrl_(r.trackViewUrl) }; });
  return songLinks_match_(items, song);
}

function songLinks_spotifyAlbum_(albumUrl) {
  var m = String(albumUrl || '').match(/open\.spotify\.com\/album\/([A-Za-z0-9]+)/);
  if (!m) return [];
  var token = albumLinks_spotifyToken_(), out = [];
  var next = 'https://api.spotify.com/v1/albums/' + m[1] + '/tracks?limit=50&market=US';
  for (var page = 0; next && page < 4; page++) {
    var res = UrlFetchApp.fetch(next, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) break;
    var j = JSON.parse(res.getContentText());
    (j.items || []).forEach(function (t) {
      if (t.external_urls && t.external_urls.spotify) out.push({ name: String(t.name || '').trim(), url: t.external_urls.spotify });
    });
    next = j.next;
  }
  return out;
}

function songLinks_spotifySearch_(song, artist) {
  var token = albumLinks_spotifyToken_();
  var clean = function (s) { return String(s || '').replace(/[‘’'"]/g, ''); };
  var queries = ['track:"' + clean(song) + '"' + (artist ? ' artist:"' + clean(artist) + '"' : ''), clean(song) + ' ' + clean(artist)];
  var ar = artistLinks_norm_(artist);
  for (var i = 0; i < queries.length; i++) {
    var res = UrlFetchApp.fetch('https://api.spotify.com/v1/search?type=track&limit=10&market=US&q=' + encodeURIComponent(queries[i]),
      { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) continue;
    var items = ((JSON.parse(res.getContentText()).tracks) || {}).items || [];
    items = items.filter(function (t) {
      return t.external_urls && t.external_urls.spotify &&
        (!ar || (t.artists || []).some(function (x) { return artistLinks_norm_(x.name).indexOf(ar) >= 0 || ar.indexOf(artistLinks_norm_(x.name)) >= 0; }));
    });
    items = songLinks_explicitFirst_(items, function (t) { return t.explicit; })
      .map(function (t) { return { name: String(t.name || '').trim(), url: t.external_urls.spotify }; });
    var hit = songLinks_match_(items, song);
    if (hit) return hit;
  }
  return '';
}

/** Explicit copies first, otherwise keeping the search's order (so the first match is the uncensored song). */
function songLinks_explicitFirst_(items, isExplicit) {
  return items.filter(function (x) { return isExplicit(x); })
    .concat(items.filter(function (x) { return !isExplicit(x); }));
}

/** Run from the editor if a song opens the wrong version; clears saved song links so they're looked up again. */
function clearSavedSongLinks() {
  adOwnerOnly_();
  var props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach(function (k) { if (k.indexOf('song|') === 0) props.deleteProperty(k); });
}
