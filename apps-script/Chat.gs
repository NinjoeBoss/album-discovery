/**
 * Club chat
 *
 * One group chat for the whole club, shown on the app's Chat tab. Messages live
 * on their own tab (AD_CHAT_SHEET), made the first time someone posts:
 *   Id | Time | Name | Message
 * Ids only ever go up, so the app asks for "everything after the last id I have"
 * every few seconds while the chat is open. The newest id is also kept in the
 * script cache, so a check with nothing new never opens the sheet.
 *
 * The name always comes from the signed in session, never from the app.
 * Deleting a row on the tab removes that message for everyone the next time
 * their chat loads from scratch.
 */

var AD_CHAT_SHEET = 'Chat';
var AD_CHAT_MAX = 500;          // characters per message
var AD_CHAT_LOAD = 200;         // messages sent on a fresh load
var AD_CHAT_PER_MINUTE = 20;    // messages one member can post in a minute
var AD_CHAT_CACHE_KEY = 'chat|last';

function adChatSheet_(create) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(AD_CHAT_SHEET);
  if (!sh && create) {
    sh = ss.insertSheet(AD_CHAT_SHEET);
    sh.getRange(1, 1, 1, 4).setValues([['Id', 'Time', 'Name', 'Message']])
      .setFontWeight('bold').setBackground('#3d3557').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 60); sh.setColumnWidth(2, 150); sh.setColumnWidth(3, 100); sh.setColumnWidth(4, 520);
    sh.getRange('B:B').setNumberFormat('mmm d, h:mm am/pm');
    sh.getRange('D:D').setWrap(true);
  }
  return sh;
}

/** The signed in member's name (from the session). */
function adChatMe_() {
  adAppOnly_();
  var name = AD_MEMBER_EMAILS[String(AD_REQUEST_EMAIL || '').toLowerCase()];
  if (!name) throw new Error('SIGNED_OUT');
  return name;
}

/** Newest message id, from the cache when it can. */
function adChatLastId_() {
  var cache = CacheService.getScriptCache();
  var c = cache.get(AD_CHAT_CACHE_KEY);
  if (c != null) return Number(c);
  var sh = adChatSheet_(false), last = 0;
  if (sh && sh.getLastRow() > 1) {
    var ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
    ids.forEach(function (r) { var n = Number(r[0]); if (n > last) last = n; });
  }
  cache.put(AD_CHAT_CACHE_KEY, String(last), 21600);
  return last;
}

function adChatRow_(r) {
  var t = r[1] instanceof Date ? r[1].getTime() : Number(new Date(r[1])) || 0;
  return { id: Number(r[0]), time: t, name: String(r[2] || ''), text: String(r[3] == null ? '' : r[3]) };
}

/**
 * Messages after `since` (0 = a fresh load: the latest AD_CHAT_LOAD).
 * Returns { last, messages, full }. full=true means the app should replace what it has.
 */
function getChat(since, gen) {
  adChatMe_();
  since = Math.max(0, Number(since) || 0);
  var last = adChatLastId_(), g = adChatGen_();
  if (String(gen || '') !== g) since = 0; // a message was deleted since this phone last loaded
  if (since && since >= last) return { last: last, gen: g, messages: [], full: false };
  var sh = adChatSheet_(false);
  if (!sh || sh.getLastRow() < 2) return { last: 0, gen: g, messages: [], full: true };
  var n = sh.getLastRow() - 1;
  var take = Math.min(n, since ? AD_CHAT_LOAD + 50 : AD_CHAT_LOAD);
  var rows = sh.getRange(sh.getLastRow() - take + 1, 1, take, 4).getValues()
    .filter(function (r) { return Number(r[0]) > 0 && String(r[3] || '').trim(); })
    .map(adChatRow_);
  var fresh = rows.filter(function (m) { return m.id > since; });
  // Asked for more than fits (been away a long time): send a fresh load instead.
  if (!since || fresh.length >= take) return { last: last, gen: g, messages: rows.slice(-AD_CHAT_LOAD), full: true };
  return { last: last, gen: g, messages: fresh, full: false };
}

/** Changes whenever a message is deleted, so open chats reload. */
function adChatGen_() {
  var cache = CacheService.getScriptCache();
  var g = cache.get('chat|gen');
  if (g == null) {
    g = PropertiesService.getScriptProperties().getProperty('chat|gen') || '1';
    cache.put('chat|gen', g, 21600);
  }
  return g;
}

/** Posts a message as the signed in member. Returns the saved message. */
function postChat(text) {
  var me = adChatMe_();
  text = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new Error('Type a message first.');
  if (text.length > AD_CHAT_MAX) throw new Error('Keep messages under ' + AD_CHAT_MAX + ' characters.');

  var cache = CacheService.getScriptCache();
  var rateKey = 'chatrate|' + me;
  var sent = Number(cache.get(rateKey) || 0);
  if (sent >= AD_CHAT_PER_MINUTE) throw new Error('Slow down a little. Try again in a minute.');

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = adChatSheet_(true);
    cache.remove(AD_CHAT_CACHE_KEY); // read the real newest id from the sheet
    var id = adChatLastId_() + 1;
    var now = new Date();
    // A leading = + - @ would turn into a formula; the apostrophe keeps it plain text (and isn't shown).
    var cell = /^[=+\-@]/.test(text) ? "'" + text : text;
    sh.getRange(sh.getLastRow() + 1, 1, 1, 4).setValues([[id, now, me, cell]]);
    SpreadsheetApp.flush();
    cache.put(AD_CHAT_CACHE_KEY, String(id), 21600);
    cache.put(rateKey, String(sent + 1), 60);
    return { id: id, time: now.getTime(), name: me, text: text };
  } finally {
    lock.releaseLock();
  }
}

/** Deletes one of your own messages (admins can delete any). */
function deleteChat(id) {
  var me = adChatMe_();
  id = Number(id);
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = adChatSheet_(false);
    if (!sh || sh.getLastRow() < 2) throw new Error('That message is already gone.');
    var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues();
    for (var i = vals.length - 1; i >= 0; i--) {
      if (Number(vals[i][0]) !== id) continue;
      if (String(vals[i][2]) !== me && AD_ADMINS.indexOf(me) < 0) throw new Error('You can only delete your own messages.');
      // Keep the row (and its id) but clear the text, so ids never get reused.
      sh.getRange(i + 2, 4).setValue('');
      var g = String(Date.now());
      PropertiesService.getScriptProperties().setProperty('chat|gen', g);
      CacheService.getScriptCache().put('chat|gen', g, 21600);
      return true;
    }
    throw new Error('That message is already gone.');
  } finally {
    lock.releaseLock();
  }
}
