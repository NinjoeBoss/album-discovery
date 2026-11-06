/**
 * Club Music website (server side), beta
 *
 * Reads the season tab live and serves the website in Index.html.
 * Columns are found by their header names, so moving columns around
 * in the sheet won't break the site as long as the headers keep their names.
 *
 * Beta: the Rate form also saves favorite song, least favorite song and a
 * comment, writing them to the Favorite Songs and Comments tabs.
 *
 * New Album Thursday: the Add Album page searches Apple Music for an album and
 * writes it (Album, Artist, Picked By, Year) into the next open row on the
 * season tab. Every other column in that row already has formulas, so the
 * date, cover, links, tracklist and song dropdowns fill themselves in.
 *
 * Seasons: every album stays on the same tab (so Favorite Songs, Comments and
 * Tracklists keep lining up row for row). The site works out which season an
 * album belongs to from its date, using AD_SEASONS below. To start a new
 * season later, add one line with its first Thursday.
 *
 * Installable app: Api.gs answers the app hosted on GitHub Pages and handles
 * its sign in. Everything below works the same for both.
 *
 * Sign in (old Apps Script site): the site knows who is visiting from their Google account, so there
 * is no "Who are you?" step and nobody can save a rating as someone else.
 * Deploy settings for this to work:
 *   Execute as: User accessing the web app
 *   Who has access: Anyone with Google account
 * Each member needs edit access to the spreadsheet (they already have it) and
 * approves the permissions screen once the first time they open the site.
 *
 * Profile pictures live in their own HTML file named "Avatars" (a script that
 * sets AVATARS = { Name: 'data:image/jpeg;base64,...' }). Index pulls it in
 * with include('Avatars'), so the photos stay separate from the page code.
 *
 * Removing albums: the picker can remove their own album until someone rates
 * it; anyone in AD_ADMINS can remove any unrated album.
 */

var AD_SHEET_NAME = 'Season 1'; // the tab every album lives on (all seasons)
var AD_SONGS_SHEET = 'Favorite Songs';
var AD_COMMENTS_SHEET = 'Comments';
var AD_TRACKS_SHEET = 'Tracklists';
var AD_HEADER_SCAN_ROWS = 15;
var AD_COMMENT_MAX = 200;
var AD_SLOTS_SHOWN = 8;

/**
 * Seasons, oldest first. Each one starts on its first Thursday (yyyy-MM-dd)
 * and runs until the next one starts. Season 1 ends with Nathan's Nov 5 pick.
 */
var AD_SEASONS = [
  { name: 'Season 1', start: '2026-07-16' },
  { name: 'Season 2', start: '2026-11-12' }
];

/*
 * Each member's Google account lives in a separate Apps Script file named
 * Members.gs (AD_MEMBER_EMAILS = { 'email@gmail.com': 'Name', ... }). It is kept
 * out of the public GitHub repo so nobody's email address is published there.
 * See Members.example.gs for the format.
 */

/** Set by Api.gs for requests from the installable app ('' = not signed in). */
var AD_REQUEST_EMAIL = null;

/**
 * Weekly pick order. Each open Thursday belongs to whoever comes next after the
 * week before it. A name typed into Picked By on the sheet overrides this
 * (that's how two people swap weeks). The order carries on across seasons.
 */
var AD_ROTATION = ['Brennan', 'Jonathan', 'William', 'Luke', 'Nathan'];

/** Members who can remove anyone's unrated pick. */
var AD_ADMINS = ['Jonathan'];

/** Where the club's app lives. Opening this script's /exec link in a browser sends people there. */
var AD_APP_URL = 'https://club-music.net/';

/**
 * The old Apps Script site was retired on Nov 5, 2026 (everyone uses the app now).
 * Opening the /exec link shows a short page with a button to the app instead.
 * The old page is still in the Index file; to bring it back, return
 * HtmlService.createTemplateFromFile('Index').evaluate() here instead.
 */
function doGet(e) {
  if (e && e.parameter && e.parameter.check === 'spotify') {
    var st = albumLinks_spotifyStatus_();
    if (e.parameter.album) st += ' || ' + albumLinks_spotifyProbe_(e.parameter.album, e.parameter.artist || '');
    return ContentService.createTextOutput(st);
  }
  var url = AD_APP_URL;
  var html = '<!DOCTYPE html><html><head><base target="_top"><meta charset="utf-8">' +
    '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1e1b2e;font-family:Roboto,Arial,sans-serif;color:#fff;text-align:center}' +
    '.box{padding:32px 24px;max-width:360px}h1{font-size:26px;margin:0 0 8px}p{color:#b9b2cf;margin:0 0 22px;line-height:1.4}' +
    'a{display:inline-block;background:#d99a09;color:#fff;text-decoration:none;font-weight:700;padding:13px 24px;border-radius:99px}</style></head>' +
    '<body><div class="box"><h1>Club Music</h1><p>The club site lives in the app now. Rate albums, add your pick and see the leaderboard there.</p>' +
    '<a href="' + url + '">Open the app</a></div></body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle('Club Music')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Lets Index pull in another HTML file (used for the Avatars file). Missing file = no photos. */
function include(name) {
  try { return HtmlService.createHtmlOutputFromFile(name).getContent(); }
  catch (e) { return '<script>var AVATARS = {};</script>'; }
}

/** Everything the website needs, in one call. */
function getData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(AD_SHEET_NAME);
  if (!sh) throw new Error('Could not find a tab named "' + AD_SHEET_NAME + '"');
  var tz = ss.getSpreadsheetTimeZone();
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var L = adLayout_(sh);
  var memberNames = L.members.map(function (m) { return m.name; });

  var songs = adSongsLayout_(ss, memberNames);
  var notes = adCommentsLayout_(ss, memberNames);
  var tracks = adTracklists_(ss);

  var albums = [];
  var blanks = [];      // open rows: { index, reserved }
  var dateAnchor = null; // { ymd, index } of the first dated album, used to date open rows
  var values = [];
  var lastRow = sh.getLastRow();
  if (lastRow > L.headerRow) {
    var rng = sh.getRange(L.headerRow + 1, 1, lastRow - L.headerRow, L.lastCol);
    values = rng.getValues();
    var formulas = rng.getFormulas();

    // One read of every saved cover, link and artist page instead of one per album.
    if (typeof artistLinks_start_ === 'function') { artistLinks_start_(); adProps_ = adArtistMemo_; }
    else adProps_ = PropertiesService.getScriptProperties().getProperties();
    adLinkDeadline_ = Date.now() + AD_LINK_LOOKUP_MS;
    values.forEach(function (row, i) {
      var title = String(row[L.album] || '').trim();
      if (!title || /^tbd$/i.test(title)) {
        blanks.push({ index: i, reserved: String(row[L.pickedBy] || '').trim() });
        return;
      }
      var artist = String(row[L.artist] || '').trim();
      var ratings = {}, nums = [], fav = {}, least = {}, comments = {};
      L.members.forEach(function (m) {
        var v = row[m.col];
        if (typeof v === 'number' && !isNaN(v)) { ratings[m.name] = v; nums.push(v); }
        else ratings[m.name] = null;
        fav[m.name] = songs ? adCell_(songs.values, i, songs.cols[m.name]) : '';
        least[m.name] = songs ? adCell_(songs.values, i, songs.cols[m.name] + 1) : '';
        comments[m.name] = notes ? adCell_(notes.values, i, notes.cols[m.name]) : '';
      });
      var d = row[L.date];
      var ymd = (d instanceof Date) ? Utilities.formatDate(d, tz, 'yyyy-MM-dd') : '';
      if (ymd && !dateAnchor) dateAnchor = { ymd: ymd, index: i };
      albums.push({
        row: L.headerRow + 1 + i,
        index: i,
        number: albums.length + 1,
        date: ymd,
        season: adSeasonOf_(ymd),
        album: title,
        artist: artist,
        year: L.year >= 0 ? String(row[L.year] || '') : '',
        pickedBy: String(row[L.pickedBy] || '').trim(),
        ratings: ratings,
        fav: fav,
        least: least,
        comments: comments,
        groupFav: songs && songs.groupCol >= 0 ? adCell_(songs.values, i, songs.groupCol) : '',
        groupLeast: songs && songs.groupCol >= 0 ? adCell_(songs.values, i, songs.groupCol + 1) : '',
        tracks: tracks[i] || [],
        avg: nums.length ? nums.reduce(function (a, b) { return a + b; }, 0) / nums.length : null,
        count: nums.length,
        spotify: adLink_(L.spotify >= 0 ? formulas[i][L.spotify] : '', 'spotify', title, artist),
        apple: adLink_(L.apple >= 0 ? formulas[i][L.apple] : '', 'apple', title, artist),
        cover: adCover_(title, artist),
        spotifyArtist: typeof artistLinks_get_ === 'function' ? artistLinks_get_('spotify', artist) : '',
        appleArtist: typeof artistLinks_get_ === 'function' ? artistLinks_get_('apple', artist) : ''
      });
    });
  }

  // Number albums within their own season (Season 2 starts again at #1).
  var perSeason = {};
  albums.forEach(function (a) { perSeason[a.season] = (perSeason[a.season] || 0) + 1; a.number = perSeason[a.season]; });

  // Open Thursdays, earliest first. Each row's date follows the weekly pattern in the Date column.
  var turns = values.length ? adTurns_(values, L, memberNames) : [];
  var slots = blanks.slice(0, AD_SLOTS_SHOWN).map(function (b) {
    var date = dateAnchor ? adShiftWeeks_(dateAnchor.ymd, b.index - dateAnchor.index) : '';
    return {
      row: L.headerRow + 1 + b.index,
      date: date,
      season: adSeasonOf_(date),
      reserved: memberNames.indexOf(b.reserved) >= 0 ? b.reserved : '',
      turn: turns[b.index] || ''
    };
  });
  var turn = slots.length ? slots[0].turn : '';

  var email = adEmail_();
  var meName = AD_MEMBER_EMAILS[email] || '';
  if (memberNames.indexOf(meName) < 0) meName = '';
  return {
    season: adSeasonOf_(today),
    currentSeason: adSeasonOf_(today),
    seasons: AD_SEASONS.map(function (s) {
      return { name: s.name, start: s.start, count: perSeason[s.name] || 0 };
    }),
    me: { email: email, name: meName, admin: AD_ADMINS.indexOf(meName) >= 0, platform: meName ? adPlatformOf_(meName) : '' },
    members: memberNames,
    albums: albums,
    slots: slots,
    turn: turn,
    rotation: adRotation_(memberNames),
    commentMax: AD_COMMENT_MAX,
    today: today
  };
}

/**
 * Saves a rating plus (optionally) favorite song, least favorite song and a comment.
 * Pass null for any extra you don't want to touch; pass '' to clear it.
 */
/* ---------- preferred streaming platform (saved per member, follows them to any device) ---------- */

function adPlatformOf_(name) {
  var p = PropertiesService.getScriptProperties().getProperty('pref|platform|' + name);
  return p === 'spotify' || p === 'apple' ? p : '';
}

/** Saves the signed in member's choice: 'spotify' or 'apple'. */
function setPlatform(p) {
  p = String(p || '');
  if (p !== 'spotify' && p !== 'apple') throw new Error('Pick Spotify or Apple Music.');
  var name = AD_MEMBER_EMAILS[adEmail_()] || '';
  if (!name) throw new Error('Sign in first.');
  PropertiesService.getScriptProperties().setProperty('pref|platform|' + name, p);
  return p;
}

function submitRating(albumRow, member, score, fav, least, comment) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(AD_SHEET_NAME);
    var L = adLayout_(sh);
    var memberNames = L.members.map(function (m) { return m.name; });

    member = adMe_(memberNames); // always the signed in person, whatever the page sent
    var m = L.members.filter(function (x) { return x.name === member; })[0];

    score = Number(score);
    if (isNaN(score) || score < 1 || score > 10 || Math.round(score * 4) !== score * 4) {
      throw new Error('Scores must be from 1 to 10 in quarter steps.');
    }

    albumRow = Number(albumRow);
    if (!(albumRow > L.headerRow)) throw new Error('That album could not be found.');
    var title = String(sh.getRange(albumRow, L.album + 1).getValue() || '').trim();
    if (!title) throw new Error('That album could not be found.');
    var index = albumRow - L.headerRow - 1;

    sh.getRange(albumRow, m.col + 1).setValue(score);

    if (fav != null || least != null) {
      var songs = adSongsLayout_(ss, memberNames);
      if (!songs) throw new Error('Could not find the Favorite Songs tab.');
      var r = songs.firstRow + index;
      if (fav != null) ss.getSheetByName(AD_SONGS_SHEET).getRange(r, songs.cols[member] + 1).setValue(String(fav));
      if (least != null) ss.getSheetByName(AD_SONGS_SHEET).getRange(r, songs.cols[member] + 2).setValue(String(least));
    }

    if (comment != null) {
      var text = String(comment).trim();
      if (text.length > AD_COMMENT_MAX) throw new Error('Comments can be up to ' + AD_COMMENT_MAX + ' characters.');
      var notes = adCommentsLayout_(ss, memberNames);
      if (!notes) throw new Error('Could not find the Comments tab.');
      ss.getSheetByName(AD_COMMENTS_SHEET).getRange(notes.firstRow + index, notes.cols[member] + 1).setValue(text);
    }

    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return getData();
}

/* ---------- New Album Thursday ---------- */

/** Searches Apple Music's catalog for albums. Returns up to 12 matches with art and release year. */
function searchAlbums(query) {
  query = String(query || '').trim();
  if (query.length < 2) return [];
  var res = UrlFetchApp.fetch('https://itunes.apple.com/search?entity=album&limit=25&country=us&term=' +
    encodeURIComponent(query), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error('Album search is busy right now. Try again in a minute, or type the album in by hand.');
  }
  var items = JSON.parse(res.getContentText()).results || [];
  var norm = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
  var seen = {}, out = [];
  items.forEach(function (it) {
    if (!it.collectionName) return;
    var raw = String(it.collectionName);
    var kind = /\s-\sSingle$/i.test(raw) ? 'Single' : /\s-\sEP$/i.test(raw) ? 'EP' : 'Album';
    var name = raw.replace(/\s-\s(Single|EP)$/i, '').trim();
    var key = norm(name) + '|' + norm(it.artistName);
    if (seen[key]) return; // clean and explicit versions show up twice
    seen[key] = true;
    out.push({
      album: name,
      artist: String(it.artistName || ''),
      year: String(it.releaseDate || '').slice(0, 4),
      cover: it.artworkUrl100 ? it.artworkUrl100.replace('100x100bb', '600x600bb') : '',
      tracks: it.trackCount || 0,
      kind: kind
    });
  });
  // Full albums first, keeping Apple's relevance order inside each group.
  return out.filter(function (x) { return x.kind === 'Album'; })
    .concat(out.filter(function (x) { return x.kind !== 'Album'; }))
    .slice(0, 12);
}

/**
 * Adds a member's album pick to the next open Thursday they can take, or
 * (with replaceRow) swaps out their own upcoming pick that nobody has rated yet.
 * Returns { data, row, date } so the site can confirm what happened.
 */
function submitPick(member, album, artist, year, cover, replaceRow) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(AD_SHEET_NAME);
    var tz = ss.getSpreadsheetTimeZone();
    var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    var L = adLayout_(sh);
    var memberNames = L.members.map(function (m) { return m.name; });
    member = adMe_(memberNames); // always the signed in person, whatever the page sent

    album = String(album || '').replace(/\s+/g, ' ').trim();
    artist = String(artist || '').replace(/\s+/g, ' ').trim();
    if (!album) throw new Error('Add the album name.');
    if (!artist) throw new Error('Add the artist.');
    if (album.length > 150 || artist.length > 150) throw new Error('That name is too long.');
    year = String(year == null ? '' : year).trim();
    if (year && !(/^\d{4}$/.test(year) && +year >= 1900 && +year <= 2030)) throw new Error('Year should look like 1997.');

    var n = sh.getLastRow() - L.headerRow;
    if (n <= 0) throw new Error('Could not find any album rows.');
    var values = sh.getRange(L.headerRow + 1, 1, n, L.lastCol).getValues();
    var norm = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
    var ymdOf = function (v) { return v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : ''; };
    var rated = function (row) { return L.members.some(function (m) { return typeof row[m.col] === 'number'; }); };
    replaceRow = replaceRow ? Number(replaceRow) : null;

    // No repeats, in any season.
    for (var i = 0; i < values.length; i++) {
      if (L.headerRow + 1 + i === replaceRow) continue;
      if (norm(values[i][L.album]) === norm(album) && norm(values[i][L.artist]) === norm(artist)) {
        var when = ymdOf(values[i][L.date]);
        throw new Error(album + ' by ' + artist + ' has already been picked' +
          (values[i][L.pickedBy] ? ' (' + values[i][L.pickedBy] + '\'s pick' + (when ? ', ' + adSeasonOf_(when) + ', ' + adPretty_(when) : '') + ')' : '') + '.');
      }
    }

    var target;
    if (replaceRow) {
      var ri = replaceRow - L.headerRow - 1;
      var cur = values[ri];
      if (!cur || !String(cur[L.album] || '').trim()) throw new Error('That pick could not be found.');
      if (String(cur[L.pickedBy] || '').trim() !== member) throw new Error('You can only change your own pick.');
      if (rated(cur)) throw new Error('People have already rated that one, so it can\'t be swapped.');
      var curDate = ymdOf(cur[L.date]);
      if (curDate && curDate < today) throw new Error('That Thursday has already passed.');
      target = replaceRow;
    } else {
      // One album lined up ahead at a time; change it instead of adding another.
      for (var j = 0; j < values.length; j++) {
        var d = ymdOf(values[j][L.date]);
        if (String(values[j][L.album] || '').trim() && String(values[j][L.pickedBy] || '').trim() === member &&
            d && d > today && !rated(values[j])) {
          throw new Error('You already have ' + values[j][L.album] + ' lined up for ' + adPretty_(d) + '. Change that one instead.');
        }
      }
      // Earliest open Thursday that is this member's turn in the rotation.
      var turns = adTurns_(values, L, memberNames);
      var anyOpen = false;
      for (var k = 0; k < values.length; k++) {
        var open = String(values[k][L.album] || '').trim();
        if (open && !/^tbd$/i.test(open)) continue;
        anyOpen = true;
        if (turns[k] === member) { target = L.headerRow + 1 + k; break; }
      }
      if (!target) throw new Error(anyOpen ? 'You don\'t have another turn in the open weeks on the sheet yet.'
        : 'Every row on the sheet is filled. Ask Jonathan to add more rows.');
    }

    sh.getRange(target, L.album + 1).setValue(album);
    if (L.artist >= 0) sh.getRange(target, L.artist + 1).setValue(artist);
    sh.getRange(target, L.pickedBy + 1).setValue(member);
    if (L.year >= 0) sh.getRange(target, L.year + 1).setValue(year ? Number(year) : '');

    // Remember the cover from the exact edition they chose, so the site shows the right art.
    if (cover && /^https:\/\//.test(String(cover))) {
      PropertiesService.getScriptProperties().setProperty(('cover|' + album + '|' + artist).slice(0, 250), String(cover));
    }

    SpreadsheetApp.flush();
    var dateVal = sh.getRange(target, L.date + 1).getValue();
    var result = { row: target, date: ymdOf(dateVal) };
    result.season = adSeasonOf_(result.date);
  } finally {
    lock.releaseLock();
  }
  result.data = getData();
  return result;
}

/**
 * Removes an album that nobody has rated yet. The picker can remove their own;
 * admins can remove anyone's. Picked By is kept so the week stays that
 * person's turn (pass freeWeek = true to clear it as well).
 */
function removePick(row, freeWeek) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(AD_SHEET_NAME);
    var tz = ss.getSpreadsheetTimeZone();
    var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    var L = adLayout_(sh);
    var memberNames = L.members.map(function (m) { return m.name; });
    var me = adMe_(memberNames);

    row = Number(row);
    if (!(row > L.headerRow)) throw new Error('That album could not be found.');
    var vals = sh.getRange(row, 1, 1, L.lastCol).getValues()[0];
    var title = String(vals[L.album] || '').trim();
    if (!title) throw new Error('That album could not be found.');
    var picker = String(vals[L.pickedBy] || '').trim();
    if (picker !== me && AD_ADMINS.indexOf(me) < 0) throw new Error('Only ' + (picker || 'the person who picked it') + ' can remove this album.');
    if (L.members.some(function (m) { return typeof vals[m.col] === 'number'; })) {
      throw new Error('Someone has already rated ' + title + ', so it can\'t be removed from the site. Edit the sheet directly if you really need to.');
    }
    var d = vals[L.date] instanceof Date ? Utilities.formatDate(vals[L.date], tz, 'yyyy-MM-dd') : '';
    if (d && d < today) throw new Error('That Thursday has already passed.');

    sh.getRange(row, L.album + 1).setValue('');
    if (L.artist >= 0) sh.getRange(row, L.artist + 1).setValue('');
    if (L.year >= 0) sh.getRange(row, L.year + 1).setValue('');
    if (freeWeek) sh.getRange(row, L.pickedBy + 1).setValue('');

    // Clear any song picks or comments left on that album's row in the other tabs.
    var index = row - L.headerRow - 1;
    var songs = adSongsLayout_(ss, memberNames);
    if (songs) memberNames.forEach(function (n) { ss.getSheetByName(AD_SONGS_SHEET).getRange(songs.firstRow + index, songs.cols[n] + 1, 1, 2).clearContent(); });
    var notes = adCommentsLayout_(ss, memberNames);
    if (notes) memberNames.forEach(function (n) { ss.getSheetByName(AD_COMMENTS_SHEET).getRange(notes.firstRow + index, notes.cols[n] + 1).clearContent(); });

    SpreadsheetApp.flush();
    var result = { album: title, date: d };
  } finally {
    lock.releaseLock();
  }
  result.data = getData();
  return result;
}

/* ---------- helpers ---------- */

/** Which season a yyyy-MM-dd date falls in. Undated rows count as the newest season. */
function adSeasonOf_(ymd) {
  if (!ymd) return AD_SEASONS[AD_SEASONS.length - 1].name;
  var name = AD_SEASONS[0].name;
  AD_SEASONS.forEach(function (s) { if (ymd >= s.start) name = s.name; });
  return name;
}

/** The rotation, keeping only names that are member columns, plus any member missing from it at the end. */
function adRotation_(memberNames) {
  var rot = AD_ROTATION.filter(function (n) { return memberNames.indexOf(n) >= 0; });
  memberNames.forEach(function (n) { if (rot.indexOf(n) < 0) rot.push(n); });
  return rot;
}

/**
 * Whose week each row is (by index into values). Filled rows belong to whoever
 * picked them; an open row belongs to the name typed in Picked By if there is one,
 * otherwise to whoever comes after the previous week's picker in the rotation.
 */
function adTurns_(values, L, memberNames) {
  var rot = adRotation_(memberNames), out = [], prev = '';
  values.forEach(function (row, i) {
    var title = String(row[L.album] || '').trim();
    var who = String(row[L.pickedBy] || '').trim();
    var filled = title && !/^tbd$/i.test(title);
    var name;
    if (rot.indexOf(who) >= 0) name = who;
    else if (filled) name = '';
    else name = rot[(rot.indexOf(prev) + 1) % rot.length];
    out[i] = name;
    if (name) prev = name;
  });
  return out;
}

/**
 * Email of the person using the site. Requests from the installable app carry
 * their own signed in member (set by Api.gs). The old Apps Script site reads the
 * Google account instead (needs "Execute as: User accessing the web app").
 */
function adEmail_() {
  if (AD_REQUEST_EMAIL != null) return String(AD_REQUEST_EMAIL).toLowerCase();
  var email = '';
  try { email = Session.getActiveUser().getEmail(); } catch (e) {}
  return String(email || '').trim().toLowerCase();
}

/** The signed in member's name, or an error if this Google account isn't in the club. */
function adMe_(memberNames) {
  var email = adEmail_();
  if (!email) throw new Error('Could not tell which Google account you are using. Make sure you are signed in to Google, then reload.');
  var name = AD_MEMBER_EMAILS[email];
  if (!name || memberNames.indexOf(name) < 0) throw new Error(email + ' is not on the club list. Ask Jonathan to add it.');
  return name;
}

/** Run from the editor to check the email list matches the member columns. */
function checkMemberEmails() {
  var L = adLayout_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AD_SHEET_NAME));
  var names = L.members.map(function (m) { return m.name; });
  var mapped = Object.keys(AD_MEMBER_EMAILS).map(function (k) { return AD_MEMBER_EMAILS[k]; });
  Logger.log('Members on the sheet: ' + names.join(', '));
  Logger.log('Missing an email: ' + (names.filter(function (n) { return mapped.indexOf(n) < 0; }).join(', ') || 'nobody'));
  Logger.log('You are signed in as: ' + adEmail_() + ' (' + (AD_MEMBER_EMAILS[adEmail_()] || 'not on the list') + ')');
}

/** Run from the editor to see which season each album lands in. */
function checkSeasons() {
  var d = getData();
  d.seasons.forEach(function (s) {
    Logger.log(s.name + ' (from ' + s.start + '): ' + s.count + ' albums');
    d.albums.filter(function (a) { return a.season === s.name; }).forEach(function (a) {
      Logger.log('   #' + a.number + '  ' + a.date + '  ' + a.album + ' (' + a.pickedBy + ')');
    });
  });
  d.slots.forEach(function (s) { Logger.log('Open: ' + s.date + ' ' + s.season + ', ' + (s.turn || 'anyone') + '\'s turn'); });
}

/** Finds the header row and the column of each field (0 based). */
function adLayout_(sh) {
  var scan = sh.getRange(1, 1, Math.min(AD_HEADER_SCAN_ROWS, sh.getMaxRows()), sh.getLastColumn()).getValues();
  for (var r = 0; r < scan.length; r++) {
    var row = scan[r].map(function (v) { return String(v).trim().toLowerCase(); });
    var album = row.indexOf('album');
    var picked = row.indexOf('picked by');
    var avg = row.indexOf('group avg');
    if (album >= 0 && picked >= 0 && avg > picked) {
      var members = [];
      for (var c = picked + 1; c < avg; c++) {
        var name = String(scan[r][c]).trim();
        if (name) members.push({ name: name, col: c });
      }
      return {
        headerRow: r + 1,
        lastCol: sh.getLastColumn(),
        num: row.indexOf('#'),
        date: row.indexOf('date'),
        album: album,
        artist: row.indexOf('artist'),
        year: row.indexOf('year'),
        spotify: row.indexOf('spotify'),
        apple: row.indexOf('apple music'),
        pickedBy: picked,
        members: members
      };
    }
  }
  throw new Error('Could not find the header row (needs Album, Picked By and Group Avg).');
}

/** yyyy-MM-dd moved by a number of weeks (done in UTC at noon so daylight saving can't shift the day). */
function adShiftWeeks_(ymd, weeks) {
  var p = ymd.split('-');
  return Utilities.formatDate(new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + 7 * weeks, 12)), 'UTC', 'yyyy-MM-dd');
}

/** "Thu, Nov 5" from yyyy-MM-dd. */
function adPretty_(ymd) {
  var p = ymd.split('-');
  return Utilities.formatDate(new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12)), 'UTC', 'EEE, MMM d');
}

/**
 * Favorite Songs: finds the row with member names (each name sits over its
 * ♥ Favorite column, with ✕ Least Favorite right after it) and the "Group" column.
 * Album rows start two rows below the names row.
 */
function adSongsLayout_(ss, memberNames) {
  var sh = ss.getSheetByName(AD_SONGS_SHEET);
  if (!sh) return null;
  var lastCol = sh.getLastColumn();
  var scan = sh.getRange(1, 1, 8, lastCol).getValues();
  for (var r = 0; r < scan.length; r++) {
    var row = scan[r].map(function (v) { return String(v).trim(); });
    var cols = {}, found = 0;
    memberNames.forEach(function (n) { var c = row.indexOf(n); if (c >= 0) { cols[n] = c; found++; } });
    if (found === memberNames.length) {
      var firstRow = r + 3; // names row, then the ♥ / ✕ row, then albums (1 based)
      var n = Math.max(0, sh.getMaxRows() - firstRow + 1);
      return {
        cols: cols,
        groupCol: row.indexOf('Group'),
        firstRow: firstRow,
        values: n ? sh.getRange(firstRow, 1, n, lastCol).getDisplayValues() : []
      };
    }
  }
  return null;
}

/** Comments: finds the header row with member names. Album rows start right below it. */
function adCommentsLayout_(ss, memberNames) {
  var sh = ss.getSheetByName(AD_COMMENTS_SHEET);
  if (!sh) return null;
  var lastCol = sh.getLastColumn();
  var scan = sh.getRange(1, 1, 8, lastCol).getValues();
  for (var r = 0; r < scan.length; r++) {
    var row = scan[r].map(function (v) { return String(v).trim(); });
    var cols = {}, found = 0;
    memberNames.forEach(function (n) { var c = row.indexOf(n); if (c >= 0) { cols[n] = c; found++; } });
    if (found === memberNames.length) {
      var firstRow = r + 2;
      var n = Math.max(0, sh.getMaxRows() - firstRow + 1);
      return { cols: cols, firstRow: firstRow, values: n ? sh.getRange(firstRow, 1, n, lastCol).getDisplayValues() : [] };
    }
  }
  return null;
}

/** Tracklists: one column per album (B = album 1). Songs start two rows below the ALBUM label. */
function adTracklists_(ss) {
  var sh = ss.getSheetByName(AD_TRACKS_SHEET);
  if (!sh) return [];
  var lastCol = sh.getLastColumn();
  var labels = sh.getRange(1, 1, Math.min(15, sh.getMaxRows()), 1).getValues()
    .map(function (r) { return String(r[0]).trim().toUpperCase(); });
  var albumRow = labels.indexOf('ALBUM') + 1;
  if (!albumRow || lastCol < 2) return [];
  var songRow = albumRow + 2;
  var n = sh.getMaxRows() - songRow + 1;
  if (n <= 0) return [];
  var grid = sh.getRange(songRow, 2, n, lastCol - 1).getDisplayValues();
  var out = [];
  for (var c = 0; c < lastCol - 1; c++) {
    var list = [];
    for (var r = 0; r < n; r++) {
      var s = String(grid[r][c] || '').trim();
      if (s && s.charAt(0) !== '#') list.push(s);
    }
    out.push(list);
  }
  return out;
}

function adCell_(values, i, col) {
  if (col == null || col < 0 || !values[i]) return '';
  return String(values[i][col] || '').trim();
}

/**
 * Saved lookups for this request (filled once by getData from Script Properties),
 * and how long one load may spend finding links it hasn't saved yet.
 */
var adProps_ = null;
var AD_LINK_LOOKUP_MS = 5000;
var adLinkDeadline_ = 0;

function adSaved_(key) {
  if (!adProps_) adProps_ = PropertiesService.getScriptProperties().getProperties();
  return adProps_[key] || '';
}
function adSave_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
  if (adProps_) adProps_[key] = value;
}

/**
 * Uses a link typed into the sheet if there is one, then a saved link, then the
 * AlbumLinks script (saved for good once found), then a search link.
 */
function adLink_(formula, service, album, artist) {
  var m = String(formula || '').match(/HYPERLINK\(\s*"(https?:\/\/[^"]+)"/i);
  if (m) return m[1];
  var key = ('link|' + service + '|' + album + '|' + artist).slice(0, 250);
  var saved = adSaved_(key);
  if (saved) return saved;
  if (!adLinkDeadline_ || Date.now() < adLinkDeadline_) {
    try {
      var found = '';
      if (service === 'apple' && typeof GET_APPLE_MUSIC_LINK === 'function') found = GET_APPLE_MUSIC_LINK(album, artist);
      if (service === 'spotify' && typeof GET_SPOTIFY_LINK === 'function') found = GET_SPOTIFY_LINK(album, artist);
      if (found && /^https:\/\//.test(found)) { adSave_(key, found); return found; }
    } catch (e) { /* fall through to a search link; tried again next load */ }
  }
  var q = encodeURIComponent(album + ' ' + artist);
  return service === 'apple'
    ? 'https://music.apple.com/us/search?term=' + q
    : 'https://open.spotify.com/search/' + q;
}

/** Album art: saved once found, so the site stays fast. */
function adCover_(album, artist) {
  var key = ('cover|' + album + '|' + artist).slice(0, 250);
  var saved = adSaved_(key);
  if (saved) return saved;

  var url = '';
  try {
    var res = UrlFetchApp.fetch('https://itunes.apple.com/search?entity=album&limit=10&country=us&term=' +
      encodeURIComponent(album + ' ' + artist), { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) {
      var results = JSON.parse(res.getContentText()).results || [];
      var pick = adBestMatch_(results, album, artist);
      if (pick && pick.artworkUrl100) url = pick.artworkUrl100.replace('100x100bb', '600x600bb');
    }
  } catch (e) { /* leave blank */ }

  if (!url) {
    try { if (typeof GET_ALBUM_COVER === 'function') url = String(GET_ALBUM_COVER(album, artist) || ''); } catch (e) {}
  }
  if (url) adSave_(key, url);
  return url;
}

function adBestMatch_(items, album, artist) {
  var norm = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
  var extras = /\b(deluxe|remaster(ed)?|edition|version|live|anniversary|expanded)\b/;
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

/** Run this from the editor if an album's art is wrong; it clears saved art so it's looked up again. */
function clearSavedCovers() {
  var props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach(function (k) { if (k.indexOf('cover|') === 0) props.deleteProperty(k); });
}
/** Run this from the editor if an album's Spotify or Apple Music link is wrong; it clears saved links so they're looked up again. */
function clearSavedLinks() {
  var props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach(function (k) { if (k.indexOf('link|') === 0) props.deleteProperty(k); });
}
