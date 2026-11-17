/**
 * Club Music: "Heard it before" shares
 *
 * On their turn, after picking an album nobody has heard, a member can also
 * share one album they already know and love. Everyone can rate it, pick songs
 * and comment, but it stays out of the leaderboard, stats and "still to rate"
 * lists: it's a bonus, not homework.
 *
 * Shares live on their own tab (AD_SHARES_SHEET), made the first time someone
 * shares, so the season tab, Favorite Songs, Comments and Tracklists keep lining
 * up row for row. One row per share:
 *   Date | Album | Artist | Year | Shared By | Group Avg |
 *   <Name> | <Name> ♥ | <Name> ✕ | <Name> Comment  (for each member) | Tracklist
 * Columns are found by header name. Date is the Thursday of the sharer's own
 * pick that week, which is how the app shows the share next to that album.
 *
 * In the app a share's "row" is AD_SHARE_BASE + its sheet row, so it can never
 * clash with an album row on the season tab. Removing a share clears its row
 * (never deletes it), so those numbers never shift under someone mid save.
 */

var AD_SHARES_SHEET = 'Shared Albums';
var AD_SHARE_BASE = 100000;
var AD_SHARE_DAYS = 6; // a pick can get a share from the day it's added until 6 days after its Thursday

function adIsShareRow_(row) { return Number(row) >= AD_SHARE_BASE; }

/** The Shares tab layout: { sh, lastCol, date, album, artist, year, by, avg, tracks, m: { Name: { score, fav, least, comment } } }, or null. */
function adSharesLayout_(ss, memberNames, create) {
  var sh = ss.getSheetByName(AD_SHARES_SHEET);
  if (!sh) {
    if (!create) return null;
    sh = ss.insertSheet(AD_SHARES_SHEET);
    var top = ['Date', 'Album', 'Artist', 'Year', 'Shared By', 'Group Avg'];
    memberNames.forEach(function (n) { top.push(n, n + ' ♥', n + ' ✕', n + ' Comment'); });
    top.push('Tracklist');
    sh.getRange(1, 1, 1, top.length).setValues([top]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('@'); // dates stay plain yyyy-MM-dd text
  }
  var lastCol = Math.max(1, sh.getLastColumn());
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (v) { return String(v).trim(); });
  var low = head.map(function (v) { return v.toLowerCase(); });

  // A member added to the club later gets their four columns on the end.
  if (create) {
    var add = [];
    memberNames.forEach(function (n) {
      if (head.indexOf(n) < 0) add.push(n, n + ' ♥', n + ' ✕', n + ' Comment');
    });
    if (add.length) {
      sh.getRange(1, lastCol + 1, 1, add.length).setValues([add]).setFontWeight('bold');
      head = head.concat(add); low = head.map(function (v) { return v.toLowerCase(); });
      lastCol = head.length;
    }
  }

  var L = {
    sh: sh, lastCol: lastCol,
    date: low.indexOf('date'), album: low.indexOf('album'), artist: low.indexOf('artist'), year: low.indexOf('year'),
    by: low.indexOf('shared by'), avg: low.indexOf('group avg'), tracks: low.indexOf('tracklist'), m: {}
  };
  if (L.album < 0 || L.by < 0) throw new Error('The ' + AD_SHARES_SHEET + ' tab is missing its Album or Shared By header.');
  memberNames.forEach(function (n) {
    L.m[n] = {
      score: head.indexOf(n), fav: head.indexOf(n + ' ♥'), least: head.indexOf(n + ' ✕'),
      comment: low.indexOf((n + ' comment').toLowerCase())
    };
  });
  return L;
}

function adShareYmd_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  var s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

/** Every share, in the same shape as an album (plus shared: true). Called by getData. */
function adShares_(ss, memberNames, tz) {
  var S = adSharesLayout_(ss, memberNames, false);
  if (!S) return [];
  var n = S.sh.getLastRow() - 1;
  if (n <= 0) return [];
  var vals = S.sh.getRange(2, 1, n, S.lastCol).getValues();
  var out = [];
  vals.forEach(function (row, i) {
    var title = String(row[S.album] || '').trim();
    if (!title) return; // removed share
    var artist = S.artist >= 0 ? String(row[S.artist] || '').trim() : '';
    var ymd = S.date >= 0 ? adShareYmd_(row[S.date], tz) : '';
    var ratings = {}, fav = {}, least = {}, comments = {}, nums = [];
    memberNames.forEach(function (m) {
      var c = S.m[m] || {};
      var v = c.score >= 0 ? row[c.score] : '';
      if (typeof v === 'number' && !isNaN(v)) { ratings[m] = v; nums.push(v); } else ratings[m] = null;
      fav[m] = c.fav >= 0 ? String(row[c.fav] || '').trim() : '';
      least[m] = c.least >= 0 ? String(row[c.least] || '').trim() : '';
      comments[m] = c.comment >= 0 ? String(row[c.comment] || '').trim() : '';
    });
    var tracks = S.tracks >= 0 ? String(row[S.tracks] || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean) : [];
    if (!tracks.length && (!adLinkDeadline_ || Date.now() < adLinkDeadline_)) {
      tracks = adShareTracks_(title, artist);
      if (tracks.length && S.tracks >= 0) S.sh.getRange(i + 2, S.tracks + 1).setValue(tracks.join('\n'));
    }
    out.push({
      row: AD_SHARE_BASE + i + 2,
      shared: true,
      number: 0,
      date: ymd,
      season: adSeasonOf_(ymd),
      album: title,
      artist: artist,
      year: S.year >= 0 ? String(row[S.year] || '') : '',
      pickedBy: String(row[S.by] || '').trim(),
      ratings: ratings, fav: fav, least: least, comments: comments,
      groupFav: '', groupLeast: '',
      tracks: tracks,
      avg: nums.length ? nums.reduce(function (a, b) { return a + b; }, 0) / nums.length : null,
      count: nums.length,
      spotify: adLink_('', 'spotify', title, artist),
      apple: adLink_('', 'apple', title, artist),
      cover: adCover_(title, artist),
      spotifyArtist: typeof artistLinks_get_ === 'function' ? artistLinks_get_('spotify', artist) : '',
      appleArtist: typeof artistLinks_get_ === 'function' ? artistLinks_get_('apple', artist) : '',
      ratedAt: {}
    });
  });
  return out;
}

/** The album's songs from iTunes (saved by GET_TRACKLIST), or [] if it can't be found. */
function adShareTracks_(album, artist) {
  try {
    var rows = GET_TRACKLIST(album, artist);
    return Array.isArray(rows) ? rows.map(function (r) { return String(r[0] || '').trim(); }).filter(Boolean) : [];
  } catch (e) { return []; }
}

/** { album, artist } of a share row, for song links. */
function adShareAlbum_(row) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(AD_SHARES_SHEET);
  var r = Number(row) - AD_SHARE_BASE;
  if (!sh || !(r >= 2) || r > sh.getLastRow()) throw new Error('That album could not be found.');
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (v) { return String(v).trim().toLowerCase(); });
  var v = sh.getRange(r, 1, 1, head.length).getValues()[0];
  var album = String(v[head.indexOf('album')] || '').trim();
  if (!album) throw new Error('That album could not be found.');
  return { album: album, artist: head.indexOf('artist') >= 0 ? String(v[head.indexOf('artist')] || '').trim() : '' };
}

/**
 * Shares an album the member already knows, alongside their own pick in pickRow
 * (a season tab row). With replaceRow, swaps out their existing share instead.
 * Returns { album, date, data }.
 */
function submitShare(album, artist, year, cover, pickRow, replaceRow) {
  adAppOnly_();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var tz = ss.getSpreadsheetTimeZone();
    var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    var main = ss.getSheetByName(AD_SHEET_NAME);
    var L = adLayout_(main);
    var memberNames = L.members.map(function (m) { return m.name; });
    var me = adMe_(memberNames);

    album = String(album || '').replace(/\s+/g, ' ').trim();
    artist = String(artist || '').replace(/\s+/g, ' ').trim();
    if (!album) throw new Error('Add the album name.');
    if (!artist) throw new Error('Add the artist.');
    if (album.length > 150 || artist.length > 150) throw new Error('That name is too long.');
    year = String(year == null ? '' : year).trim();
    if (year && !(/^\d{4}$/.test(year) && +year >= 1900 && +year <= 2030)) throw new Error('Year should look like 1997.');

    // The share rides along with the member's own pick for that week.
    pickRow = Number(pickRow);
    if (!(pickRow > L.headerRow) || pickRow > main.getLastRow()) throw new Error('Pick your album for the week first, then share one.');
    var pv = main.getRange(pickRow, 1, 1, L.lastCol).getValues()[0];
    if (!String(pv[L.album] || '').trim() || String(pv[L.pickedBy] || '').trim() !== me) {
      throw new Error('Pick your album for the week first, then share one.');
    }
    var pickDate = pv[L.date] instanceof Date ? Utilities.formatDate(pv[L.date], tz, 'yyyy-MM-dd') : '';
    if (!pickDate) throw new Error('That week doesn\'t have a date on the sheet yet.');
    if (adShiftDays_(pickDate, AD_SHARE_DAYS) < today) throw new Error('That week is over, so it can\'t get a share now.');

    // No repeats: not an album the club already picked, and not shared before.
    var norm = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
    var n = main.getLastRow() - L.headerRow;
    var mv = n > 0 ? main.getRange(L.headerRow + 1, 1, n, L.lastCol).getValues() : [];
    mv.forEach(function (r) {
      if (norm(r[L.album]) === norm(album) && norm(r[L.artist]) === norm(artist)) {
        throw new Error(album + ' was already a club pick' + (r[L.pickedBy] ? ' (' + r[L.pickedBy] + ')' : '') + '.');
      }
    });

    var S = adSharesLayout_(ss, memberNames, true);
    var sh = S.sh;
    var sn = sh.getLastRow() - 1;
    var sv = sn > 0 ? sh.getRange(2, 1, sn, S.lastCol).getValues() : [];
    var target = null;
    replaceRow = replaceRow ? Number(replaceRow) - AD_SHARE_BASE : null;
    sv.forEach(function (r, i) {
      var at = i + 2;
      if (!String(r[S.album] || '').trim()) return;
      if (at === replaceRow) return;
      if (norm(r[S.album]) === norm(album) && norm(r[S.artist]) === norm(artist)) {
        throw new Error(album + ' has already been shared by ' + (r[S.by] || 'someone') + '.');
      }
      if (String(r[S.by] || '').trim() === me && adShareYmd_(r[S.date], tz) === pickDate) {
        throw new Error('You already shared ' + r[S.album] + ' this week. Swap that one instead.');
      }
    });

    if (replaceRow) {
      var cur = sv[replaceRow - 2];
      if (!cur || !String(cur[S.album] || '').trim()) throw new Error('That share could not be found.');
      if (String(cur[S.by] || '').trim() !== me) throw new Error('You can only change your own share.');
      if (adShareRatedByOthers_(cur, S, memberNames, me)) throw new Error('People have already rated that one, so it can\'t be swapped.');
      sh.getRange(replaceRow, 1, 1, S.lastCol).clearContent();
      target = replaceRow;
    } else {
      target = sh.getLastRow() + 1;
    }

    var line = [];
    for (var c = 0; c < S.lastCol; c++) line.push('');
    if (S.date >= 0) line[S.date] = pickDate;
    line[S.album] = album;
    if (S.artist >= 0) line[S.artist] = artist;
    if (S.year >= 0) line[S.year] = year ? Number(year) : '';
    line[S.by] = me;
    if (S.tracks >= 0) line[S.tracks] = adShareTracks_(album, artist).join('\n');
    if (S.date >= 0) sh.getRange(target, S.date + 1).setNumberFormat('@');
    sh.getRange(target, 1, 1, S.lastCol).setValues([line]);
    if (S.avg >= 0) {
      var refs = memberNames.map(function (m) { return S.m[m].score; }).filter(function (c) { return c >= 0; })
        .map(function (c) { return 'R[0]C' + (c + 1); });
      if (refs.length) sh.getRange(target, S.avg + 1).setFormulaR1C1('=IFERROR(AVERAGE(' + refs.join(',') + '),"")');
    }

    // Remember the cover from the exact edition they chose.
    if (cover && /^https:\/\//.test(String(cover))) {
      PropertiesService.getScriptProperties().setProperty(('cover|' + album + '|' + artist).slice(0, 250), String(cover));
    }
    SpreadsheetApp.flush();
    var result = { album: album, date: pickDate };
  } finally {
    lock.releaseLock();
  }
  result.data = getData();
  return result;
}

function adShareRatedByOthers_(r, S, memberNames, me) {
  return memberNames.some(function (m) {
    var c = S.m[m];
    return m !== me && c && c.score >= 0 && typeof r[c.score] === 'number';
  });
}

/** Takes a share down. The sharer can until someone else rates it; admins any time nobody else has. */
function removeShare(row) {
  adAppOnly_();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var L = adLayout_(ss.getSheetByName(AD_SHEET_NAME));
    var memberNames = L.members.map(function (m) { return m.name; });
    var me = adMe_(memberNames);
    var S = adSharesLayout_(ss, memberNames, false);
    var r = Number(row) - AD_SHARE_BASE;
    if (!S || !(r >= 2) || r > S.sh.getLastRow()) throw new Error('That share could not be found.');
    var v = S.sh.getRange(r, 1, 1, S.lastCol).getValues()[0];
    var title = String(v[S.album] || '').trim();
    if (!title) throw new Error('That share could not be found.');
    var by = String(v[S.by] || '').trim();
    if (by !== me && AD_ADMINS.indexOf(me) < 0) throw new Error('Only ' + (by || 'the person who shared it') + ' can remove this one.');
    if (adShareRatedByOthers_(v, S, memberNames, by)) {
      throw new Error('Someone has already rated ' + title + ', so it can\'t be removed from the app. Edit the ' + AD_SHARES_SHEET + ' tab if you really need to.');
    }
    S.sh.getRange(r, 1, 1, S.lastCol).clearContent();
    SpreadsheetApp.flush();
    var result = { album: title };
  } finally {
    lock.releaseLock();
  }
  result.data = getData();
  return result;
}

/** Saves a rating, songs and comment on a share. Same rules as submitRating. */
function adRateShare_(row, score, fav, least, comment) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var L = adLayout_(ss.getSheetByName(AD_SHEET_NAME));
    var memberNames = L.members.map(function (m) { return m.name; });
    var me = adMe_(memberNames);
    score = Number(score);
    if (isNaN(score) || score < 1 || score > 10 || Math.round(score * 4) !== score * 4) {
      throw new Error('Scores must be from 1 to 10 in quarter steps.');
    }
    var S = adSharesLayout_(ss, memberNames, true); // adds columns for a newer member if needed
    var r = Number(row) - AD_SHARE_BASE;
    if (!(r >= 2) || r > S.sh.getLastRow() || !String(S.sh.getRange(r, S.album + 1).getValue() || '').trim()) {
      throw new Error('That album could not be found.');
    }
    var c = S.m[me];
    S.sh.getRange(r, c.score + 1).setValue(score);
    if (fav != null && c.fav >= 0) S.sh.getRange(r, c.fav + 1).setValue(String(fav));
    if (least != null && c.least >= 0) S.sh.getRange(r, c.least + 1).setValue(String(least));
    if (comment != null && c.comment >= 0) {
      var text = String(comment).trim();
      if (text.length > AD_COMMENT_MAX) throw new Error('Comments can be up to ' + AD_COMMENT_MAX + ' characters.');
      S.sh.getRange(r, c.comment + 1).setValue(text);
    }
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return getData();
}

/** yyyy-MM-dd moved by a number of days. */
function adShiftDays_(ymd, days) {
  var p = ymd.split('-');
  return Utilities.formatDate(new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + days, 12)), 'UTC', 'yyyy-MM-dd');
}
