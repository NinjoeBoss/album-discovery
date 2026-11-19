/**
 * Club Music: move to Supabase (Nov 2026)
 *
 * Two small jobs left for Apps Script once the app runs on Supabase:
 *
 * 1. Export. The "Move data to Supabase" GitHub job opens
 *    /exec?check=export&token=<deploy token> and gets everything the new
 *    database needs as one JSON answer: every week on the season tab, ratings,
 *    song picks, comments, rating times, shares, the chat, platform choices and
 *    the current sign ins (so nobody has to sign in again). Only the deploy job
 *    knows the token (CheckToken.gs, new every run, never committed).
 *
 * 2. Mailer. Sign in codes still come from Jonathan's Gmail. The Supabase
 *    server posts { action: 'mail', secret, to, subject, body, html } and this
 *    sends it, but only to a club member's address and only with the secret
 *    from MailerSecret.gs (written by the deploy job from the MAILER_SECRET secret).
 */

function adMigrationExport_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = ss.getSpreadsheetTimeZone();
  var admin = Object.keys(AD_MEMBER_EMAILS).filter(function (e) { return AD_ADMINS.indexOf(AD_MEMBER_EMAILS[e]) >= 0; })[0];
  AD_REQUEST_EMAIL = admin; // getData runs as an admin for the export
  var data = getData();

  // Every row on the season tab (getData only lists the first few open weeks).
  var sh = ss.getSheetByName(AD_SHEET_NAME);
  var L = adLayout_(sh);
  var n = sh.getLastRow() - L.headerRow;
  var rows = [];
  if (n > 0) {
    sh.getRange(L.headerRow + 1, 1, n, L.lastCol).getValues().forEach(function (r, i) {
      var title = String(r[L.album] || '').trim();
      rows.push({
        row: L.headerRow + 1 + i,
        date: r[L.date] instanceof Date ? Utilities.formatDate(r[L.date], tz, 'yyyy-MM-dd') : '',
        album: /^tbd$/i.test(title) ? '' : title,
        artist: String(r[L.artist] || '').trim(),
        year: L.year >= 0 ? String(r[L.year] || '') : '',
        pickedBy: String(r[L.pickedBy] || '').trim()
      });
    });
  }

  var props = PropertiesService.getScriptProperties().getProperties();
  var sessions = [], appKeys = [], platforms = {};
  Object.keys(props).forEach(function (k) {
    try {
      if (k.indexOf('sess|') === 0) {
        var s = JSON.parse(props[k]);
        if (AD_MEMBER_EMAILS[s.email]) sessions.push({ token: k.slice(5), name: AD_MEMBER_EMAILS[s.email], created: s.created });
      } else if (k.indexOf('appkey|') === 0) {
        var a = JSON.parse(props[k]);
        if (AD_MEMBER_EMAILS[a.email]) appKeys.push({ key: k.slice(7), name: AD_MEMBER_EMAILS[a.email], created: a.created });
      } else if (k.indexOf('pref|platform|') === 0) {
        platforms[k.slice(14)] = props[k];
      }
    } catch (e) { /* skip a damaged entry */ }
  });
  // Which session each app key belongs to.
  Object.keys(props).forEach(function (k) {
    if (k.indexOf('appkeyof|') !== 0) return;
    appKeys.forEach(function (a) { if (a.key === props[k]) a.session = k.slice(9); });
  });

  var chat = [];
  var csh = ss.getSheetByName(AD_CHAT_SHEET);
  if (csh && csh.getLastRow() > 1) {
    csh.getRange(2, 1, csh.getLastRow() - 1, 4).getValues().forEach(function (r) {
      var id = Number(r[0]);
      if (!(id > 0)) return;
      chat.push({ id: id, time: r[1] instanceof Date ? r[1].getTime() : Number(new Date(r[1])) || 0, name: String(r[2] || ''), text: String(r[3] == null ? '' : r[3]) });
    });
  }

  var shareRows = [];
  var S = adSharesLayout_(ss, L.members.map(function (m) { return m.name; }), false);
  if (S && S.sh.getLastRow() > 1) shareRows = S.sh.getRange(2, 1, S.sh.getLastRow() - 1, 1).getValues().map(function (r, i) { return AD_SHARE_BASE + i + 2; });

  return {
    exportedAt: Date.now(),
    members: L.members.map(function (m) { return m.name; }),
    rotation: AD_ROTATION, admins: AD_ADMINS, seasons: AD_SEASONS,
    rows: rows, data: data, shareRows: shareRows,
    sessions: sessions, appKeys: appKeys, platforms: platforms,
    chat: chat, chatGen: props['chat|gen'] || '1'
  };
}

/** Sends one email for the Supabase server. Returns true. */
function adMailerSend_(req) {
  var secret = typeof AD_MAILER_SECRET === 'string' ? AD_MAILER_SECRET : '';
  if (!secret || secret.length < 32 || String(req.secret || '') !== secret) throw new Error('Not allowed.');
  var to = String(req.to || '').trim().toLowerCase();
  if (!AD_MEMBER_EMAILS[to]) throw new Error('Not a club address.');
  var msg = { to: to, name: 'Club Music', subject: String(req.subject || '').slice(0, 200), body: String(req.body || '').slice(0, 5000) };
  if (req.html) msg.htmlBody = String(req.html).slice(0, 10000);
  MailApp.sendEmail(msg);
  return true;
}
