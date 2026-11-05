/**
 * Album Discovery: Comment of the Day
 *
 * Picks one comment from the Comments tab each day and saves it on the
 * hidden "Fantano Bank" tab (K2:K5). The Season 1 card reads the saved pick,
 * so comments added during the day don't change it.
 *
 * Setup (once): pick "setupCommentOfTheDay" in the function menu at the top
 * of the Apps Script editor and click Run. Approve the permissions prompt.
 * That's it: it checks every hour and picks a new comment once the date changes.
 */

var COTD_STORE_SHEET = 'Fantano Bank';
var COTD_STORE_RANGE = 'K2:K5';   // date, name, album, comment

/** Run once. Creates the hourly check and makes today's pick if needed. */
function setupCommentOfTheDay() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'pickCommentOfTheDay') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('pickCommentOfTheDay').timeBased().everyHours(1).create();
  pickCommentOfTheDay();
}

/** Picks a new comment only when there's no saved pick for today. */
function pickCommentOfTheDay() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = ss.getSpreadsheetTimeZone();
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  var store = ss.getSheetByName(COTD_STORE_SHEET).getRange(COTD_STORE_RANGE);
  var saved = store.getValues().map(function (r) { return r[0]; });
  var savedDate = saved[0] instanceof Date
    ? Utilities.formatDate(saved[0], tz, 'yyyy-MM-dd')
    : String(saved[0] || '').trim();
  if (savedDate === today && String(saved[3] || '').trim() !== '') return; // already picked today

  var comments = ss.getSheetByName('Comments');
  var names = comments.getRange('B4:F4').getValues()[0];
  var grid = comments.getRange('B5:F62').getValues();
  var albums = ss.getSheetByName('Season 1').getRange('C7:C64').getValues();

  var pool = [];
  grid.forEach(function (row, i) {
    row.forEach(function (value, j) {
      var text = String(value || '').trim();
      var album = String(albums[i][0] || '').trim();
      if (text && album) pool.push([names[j], album, text]);
    });
  });

  store.setNumberFormat('@');  // keep the date as plain text
  if (!pool.length) {          // nothing to feature yet; try again next hour
    store.setValues([[today], [''], [''], ['']]);
    return;
  }

  // Don't repeat yesterday's comment when there's another option
  var choices = pool.filter(function (p) { return p[2] !== String(saved[3] || '').trim(); });
  if (!choices.length) choices = pool;
  var pick = choices[Math.floor(Math.random() * choices.length)];
  store.setValues([[today], [pick[0]], [pick[1]], [pick[2]]]);
}

/** Optional: run this to force a new pick right now. */
function rerollCommentOfTheDay() {
  var store = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(COTD_STORE_SHEET).getRange(COTD_STORE_RANGE);
  store.setValues([[''], [''], [''], ['']]);
  pickCommentOfTheDay();
}