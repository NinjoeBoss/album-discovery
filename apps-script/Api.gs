/**
 * Club Music app API
 *
 * Answers the installable app hosted on GitHub Pages. The app sends every
 * request as a POST with a plain text JSON body:
 *   { action: 'getData', args: [...], session: '<token>' }
 * and gets back { ok: true, result: ... } or { ok: false, error: '...' }.
 *
 * Deploy this project a SECOND time as its own web app (the old site keeps its
 * own deployment):
 *   Deploy > New deployment > Web app
 *   Execute as: Me
 *   Who has access: Anyone
 * Then put that deployment's /exec URL in config.js in the GitHub repo.
 *
 * Sign in: a member taps their name, the script emails a 6 digit code to the
 * Gmail listed for them in Members.gs, and typing the code gives that phone a
 * session that lasts AD_APP_SESSION_DAYS. Every data request must carry a valid
 * session; the session decides who is saving, never anything the app sends.
 */

var AD_APP_SESSION_DAYS = 365;
var AD_CODE_MINUTES = 10;
var AD_CODE_TRIES = 5;
var AD_CODES_PER_10_MIN = 3;

function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = { ok: true, result: adApiDispatch_(req) };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function adApiDispatch_(req) {
  AD_REQUEST_EMAIL = ''; // nobody until a session says otherwise (this deployment runs as the owner)
  var action = String(req.action || '');
  var args = Array.isArray(req.args) ? req.args : [];

  if (action === 'members') return adApiMembers_();
  if (action === 'requestCode') return adRequestCode_(args[0]);
  if (action === 'verifyCode') return adVerifyCode_(args[0], args[1]);

  var s = adSession_(req.session);
  if (!s) throw new Error('SIGNED_OUT');
  AD_REQUEST_EMAIL = s.email;

  switch (action) {
    case 'getData': return getData();
    case 'submitRating': return submitRating(args[0], args[1], args[2], args[3], args[4], args[5]);
    case 'searchAlbums': return searchAlbums(args[0]);
    case 'submitPick': return submitPick(args[0], args[1], args[2], args[3], args[4], args[5]);
    case 'removePick': return removePick(args[0], args[1]);
    case 'avatars': return adAvatars_();
    case 'setPlatform': return setPlatform(args[0]);
    case 'songLinks': return songLinks(args[0], args[1], args[2]);
    case 'signOut':
      PropertiesService.getScriptProperties().deleteProperty('sess|' + req.session);
      return true;
  }
  throw new Error('Unknown action: ' + action);
}

/* ---------- sign in ---------- */

/** Member names for the sign in screen (no emails). */
function adApiMembers_() {
  var L = adLayout_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AD_SHEET_NAME));
  return L.members.map(function (m) { return m.name; }).filter(function (n) { return !!adEmailFor_(n); });
}

/** Emails a 6 digit code to the member. Returns a masked address to show on screen. */
function adRequestCode_(name) {
  name = String(name || '');
  var email = adEmailFor_(name);
  if (!email) throw new Error('That name isn\'t on the club list.');
  var cache = CacheService.getScriptCache();
  var sentKey = 'sent|' + name;
  var sent = Number(cache.get(sentKey) || 0);
  if (sent >= AD_CODES_PER_10_MIN) throw new Error('Too many codes sent. Wait 10 minutes and try again.');

  var code = String(parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 8), 16) % 900000 + 100000);
  cache.put('code|' + name, JSON.stringify({ code: code, tries: 0 }), AD_CODE_MINUTES * 60);
  cache.put(sentKey, String(sent + 1), 600);

  MailApp.sendEmail({
    to: email,
    name: 'Club Music',
    subject: 'Your Club Music code: ' + code,
    body: 'Hi ' + name + ',\n\nYour sign in code is ' + code + '. It works for ' + AD_CODE_MINUTES + ' minutes.\n\nIf you didn\'t ask for this, you can ignore it.',
    htmlBody: '<div style="font-family:Roboto,Arial,sans-serif;color:#1e1b2e">' +
      '<p>Hi ' + name + ',</p><p>Your Club Music sign in code:</p>' +
      '<p style="font-size:32px;font-weight:900;letter-spacing:6px;background:#eceaf3;padding:14px 20px;border-radius:12px;display:inline-block">' + code + '</p>' +
      '<p style="color:#5e5873">It works for ' + AD_CODE_MINUTES + ' minutes. If you didn\'t ask for this, you can ignore it.</p></div>'
  });
  return { hint: adMask_(email) };
}

/** Checks the code. Returns { session, name } on success. */
function adVerifyCode_(name, code) {
  name = String(name || '');
  code = String(code || '').replace(/\D/g, '');
  var email = adEmailFor_(name);
  if (!email) throw new Error('That name isn\'t on the club list.');
  var cache = CacheService.getScriptCache();
  var key = 'code|' + name;
  var saved = cache.get(key);
  if (!saved) throw new Error('That code expired. Send a new one.');
  saved = JSON.parse(saved);
  if (saved.code !== code) {
    saved.tries++;
    if (saved.tries >= AD_CODE_TRIES) { cache.remove(key); throw new Error('Too many wrong tries. Send a new code.'); }
    cache.put(key, JSON.stringify(saved), AD_CODE_MINUTES * 60);
    throw new Error('That code isn\'t right. Check the email and try again.');
  }
  cache.remove(key);
  var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').toLowerCase();
  PropertiesService.getScriptProperties().setProperty('sess|' + token,
    JSON.stringify({ email: email, name: name, created: Date.now() }));
  return { session: token, name: name };
}

/** The session behind a token, or null if it's missing, expired or the member was removed. */
function adSession_(token) {
  token = String(token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty('sess|' + token);
  if (!raw) return null;
  var s = JSON.parse(raw);
  if (Date.now() - s.created > AD_APP_SESSION_DAYS * 864e5 || !AD_MEMBER_EMAILS[s.email]) {
    props.deleteProperty('sess|' + token);
    return null;
  }
  return s;
}

function adEmailFor_(name) {
  return Object.keys(AD_MEMBER_EMAILS).filter(function (k) { return AD_MEMBER_EMAILS[k] === name; })[0] || '';
}

/** "jo•••••@gmail.com" */
function adMask_(email) {
  var p = email.split('@');
  return p[0].slice(0, 2) + '•••••@' + p[1];
}

/** Club photos from the Avatars file, as { Name: 'data:image/jpeg;base64,...' }. */
function adAvatars_() {
  var out = {};
  try {
    var text = HtmlService.createHtmlOutputFromFile('Avatars').getContent();
    var re = /["']?([A-Za-z][\w ]*)["']?\s*:\s*["'](data:image\/[^"']+)["']/g, m;
    while ((m = re.exec(text))) out[m[1].trim()] = m[2];
  } catch (e) { /* no Avatars file: everyone shows their initial */ }
  return out;
}

/* ---------- run these from the editor ---------- */

/** Run once after pasting: approves sending email and checks the member list. */
function setupApp() {
  Logger.log('Emails left today: ' + MailApp.getRemainingDailyQuota());
  Logger.log('Members who can sign in: ' + adApiMembers_().join(', '));
}

/** Signs every phone out (everyone will need a new code). */
function signOutEveryone() {
  var props = PropertiesService.getScriptProperties();
  var n = 0;
  Object.keys(props.getProperties()).forEach(function (k) { if (k.indexOf('sess|') === 0) { props.deleteProperty(k); n++; } });
  Logger.log('Signed out ' + n + ' sessions.');
}

/** Lists who is signed in and since when. */
function listSessions() {
  var props = PropertiesService.getScriptProperties().getProperties();
  Object.keys(props).forEach(function (k) {
    if (k.indexOf('sess|') !== 0) return;
    var s = JSON.parse(props[k]);
    Logger.log(s.name + ' since ' + new Date(s.created));
  });
}