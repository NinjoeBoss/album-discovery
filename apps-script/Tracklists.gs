/**
 * Club Music: tracklists from iTunes
 *
 * Adds one custom function used by the Tracklists tab:
 *   =GET_TRACKLIST(album, artist)
 * It returns the album's songs in order, one per row, which feed the
 * song dropdowns on the Favorite Songs tab.
 *
 * Songs are saved once found, so each album is only looked up one time.
 */

/**
 * Returns the songs on an album, in track order, one per row.
 *
 * @param {string} album  Album title
 * @param {string} artist Artist name
 * @return {string[][]} Song titles
 * @customfunction
 */
function GET_TRACKLIST(album, artist) {
  if (!album) return '';
  var key = ('tracks|' + album + '|' + (artist || '')).slice(0, 240);

  var cache = CacheService.getScriptCache();
  var hit = cache.get(key);
  if (hit) return tracklist_rows_(JSON.parse(hit));

  var props = PropertiesService.getScriptProperties();
  var saved = props.getProperty(key);
  if (saved) {
    cache.put(key, saved, 21600);
    return tracklist_rows_(JSON.parse(saved));
  }

  // 1. Find the album (album + artist first, then everything by the artist)
  var results = tracklist_fetchJson_('https://itunes.apple.com/search?entity=album&limit=25&country=us&term=' +
    encodeURIComponent(album + ' ' + (artist || ''))).results || [];
  var pick = tracklist_bestMatch_(results, album, artist);
  if (!pick && artist) {
    var byArtist = tracklist_fetchJson_('https://itunes.apple.com/search?entity=album&attribute=artistTerm&limit=100&country=us&term=' +
      encodeURIComponent(artist)).results || [];
    pick = tracklist_bestMatch_(byArtist, album, artist);
  }
  if (!pick) throw new Error('Album not found on iTunes');

  // 2. Get its songs
  var songs = (tracklist_fetchJson_('https://itunes.apple.com/lookup?entity=song&limit=200&country=us&id=' + pick.collectionId).results || [])
    .filter(function (r) { return r.wrapperType === 'track' && r.kind === 'song'; })
    .sort(function (a, b) { return (a.discNumber - b.discNumber) || (a.trackNumber - b.trackNumber); });

  var seen = {};
  var names = [];
  songs.forEach(function (s) {
    var n = String(s.trackName || '').trim();
    if (n && !seen[n]) { seen[n] = true; names.push(n); }
  });
  if (!names.length) throw new Error('No songs found for this album');

  var json = JSON.stringify(names);
  props.setProperty(key, json);
  cache.put(key, json, 21600);
  return tracklist_rows_(names);
}

/**
 * Run this from the editor if an album pulled the wrong tracklist
 * (for example a deluxe edition). It clears saved lists so they're looked up again.
 */
function clearSavedTracklists() {
  var props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach(function (k) {
    if (k.indexOf('tracks|') === 0) props.deleteProperty(k);
  });
}

/**
 * Fills in any albums still missing a tracklist, one at a time so Apple's
 * rate limit isn't hit. Pick "refreshTracklists" in the function menu at the
 * top of the editor and click Run. Results show in the Execution log.
 */
function refreshTracklists() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Tracklists');
  if (!sh) throw new Error('No tab named Tracklists');
  var lastCol = sh.getLastColumn();
  var top = sh.getRange(1, 1, 4, lastCol).getValues();
  var formulas = sh.getRange(4, 1, 1, lastCol).getFormulas()[0];

  for (var c = 1; c < lastCol; c++) {
    var album = String(top[0][c] || '').trim();
    var artist = String(top[1][c] || '').trim();
    if (!album || String(top[3][c] || '') !== '') continue; // empty slot or already filled

    try {
      var rows = GET_TRACKLIST(album, artist);   // looks it up and saves it
      Logger.log('Found ' + rows.length + ' songs: ' + album);
    } catch (e) {
      Logger.log('Problem with ' + album + ': ' + e.message);
    }

    // Re-enter the formula so the sheet picks up the saved list
    var cell = sh.getRange(4, c + 1);
    var f = formulas[c];
    if (f) { cell.setValue(''); SpreadsheetApp.flush(); cell.setFormula(f); SpreadsheetApp.flush(); }
    Utilities.sleep(3500);
  }
}

/* ---------- helpers ---------- */

/** Fetches JSON from iTunes, waiting and retrying if Apple says to slow down. */
function tracklist_fetchJson_(url) {
  var wait = 2000;
  for (var attempt = 1; attempt <= 4; attempt++) {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var code = res.getResponseCode();
    if (code === 200) return JSON.parse(res.getContentText());
    if (code !== 403 && code !== 429 && code < 500) throw new Error('iTunes request failed (' + code + ')');
    Utilities.sleep(wait);
    wait += 2000;
  }
  throw new Error('iTunes is busy, try again in a minute');
}

function tracklist_rows_(names) {
  return names.map(function (n) { return [n]; });
}

/** Picks the closest album match, preferring the standard edition over deluxe or live versions. */
function tracklist_bestMatch_(items, album, artist) {
  var norm = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
  var extras = /\b(deluxe|remaster(ed)?|edition|version|live|anniversary|expanded|instrumental)\b/;
  var a = norm(album), ar = norm(artist), best = null, bestScore = -1;
  items.forEach(function (it) {
    var n = norm(it.collectionName), who = norm(it.artistName), s = 0;
    if (n === a) s += 10; else if (n.indexOf(a) === 0) s += 5; else if (n.indexOf(a) >= 0) s += 2;
    if (ar && who.indexOf(ar) >= 0) s += 6;
    if (extras.test(n) && !extras.test(a)) s -= 3;
    if (s > bestScore) { best = it; bestScore = s; }
  });
  return bestScore >= 5 ? best : null;
}
