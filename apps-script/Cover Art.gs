/**
 * Finds an album's cover art image URL via the open iTunes database.
 *
 * Beta changes:
 *  - Looks at the top 10 results and picks the closest title and artist match
 *    (standard edition preferred), instead of trusting the first result.
 *  - Returns a blank instead of a message like "Missing inputs", so an empty
 *    row doesn't feed text into IMAGE() and show an error.
 *  - Saves each cover once found, so the sheet doesn't look it up again.
 *
 * @param {string} albumName The name of the album.
 * @param {string} artistName The name of the artist.
 * @return {string} The direct 600x600 image URL, or "" if not found.
 * @customfunction
 */
function GET_ALBUM_COVER(albumName, artistName) {
  if (!albumName) return '';
  var album = String(albumName).trim();
  var artist = String(artistName || '').trim();

  var props = PropertiesService.getScriptProperties();
  var key = ('cover|' + album + '|' + artist).slice(0, 250);   // same key the web app uses
  var saved = props.getProperty(key);
  if (saved) return saved;

  var url = 'https://itunes.apple.com/search?entity=album&limit=10&country=us&term=' +
    encodeURIComponent(album + ' ' + artist);
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('iTunes is busy, try again in a minute');

  var results = JSON.parse(res.getContentText()).results || [];
  var pick = coverArt_bestMatch_(results, album, artist);
  // Apple's search sometimes hides an album that is in the catalog (e.g. Midnight Marauders),
  // so look through the artist's own album list before settling for the top result.
  if (!pick) pick = coverArt_bestMatch_(itunesArtistAlbums_(artist), album, artist) || results[0];
  if (!pick || !pick.artworkUrl100) return '';

  var big = pick.artworkUrl100.replace('100x100bb', '600x600bb');
  props.setProperty(key, big);
  return big;
}

/** Run this from the editor if a cover is wrong; it clears saved covers so they're looked up again. */
function clearSavedCoverArt() {
  var props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach(function (k) {
    if (k.indexOf('cover|') === 0) props.deleteProperty(k);
  });
}

function coverArt_bestMatch_(items, album, artist) {
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
/**
 * Every album Apple lists for an artist (artist search, then the artist's album list).
 * Used when the plain album search misses an album that is really in the catalog.
 */
function itunesArtistAlbums_(artist) {
  artist = String(artist || '').trim();
  if (!artist) return [];
  try {
    var res = UrlFetchApp.fetch('https://itunes.apple.com/search?entity=musicArtist&limit=5&country=us&term=' +
      encodeURIComponent(artist), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return [];
    var norm = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
    var people = JSON.parse(res.getContentText()).results || [];
    var who = people.filter(function (p) { return norm(p.artistName) === norm(artist); })[0] || people[0];
    if (!who || !who.artistId) return [];
    var list = UrlFetchApp.fetch('https://itunes.apple.com/lookup?entity=album&limit=200&country=us&id=' + who.artistId,
      { muteHttpExceptions: true });
    if (list.getResponseCode() !== 200) return [];
    return (JSON.parse(list.getContentText()).results || []).filter(function (r) { return r.wrapperType === 'collection'; });
  } catch (e) { return []; }
}
