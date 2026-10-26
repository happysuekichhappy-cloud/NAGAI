// 列: 1ASIN 2商品名 3URL 4仕入値 5販売価格 6粗利益 7利益率 8前回購入日 9前回数量 10サイクル 11次回目安日 15備考 17稼働/停止 18カート価格 19価格確認日 20アラート停止 21スレッドID（22商品コード・23通知アドレスは現在未使用）
var MARKETPLACE_ID = 'A1VC38T7YXB528';

// ===== Amazon SP-API =====

function getAccessToken_() {
  var props = PropertiesService.getScriptProperties();
  var response = UrlFetchApp.fetch('https://api.amazon.com/auth/o2/token', {
    method: 'post',
    payload: {
      'grant_type': 'refresh_token',
      'refresh_token': props.getProperty('REFRESH_TOKEN'),
      'client_id': props.getProperty('CLIENT_ID'),
      'client_secret': props.getProperty('CLIENT_SECRET')
    },
    muteHttpExceptions: true
  });
  return JSON.parse(response.getContentText()).access_token;
}

function getBuyBoxPrice_(accessToken, asin) {
  var url = 'https://sellingpartnerapi-fe.amazon.com/products/pricing/v0/items/' + asin +
            '/offers?MarketplaceId=' + MARKETPLACE_ID + '&ItemType=Asin&ItemCondition=New';

  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'x-amz-access-token': accessToken },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) return null;

  var json = JSON.parse(response.getContentText());
  var summary = json.payload && json.payload.Summary;
  if (!summary || !summary.BuyBoxPrices || summary.BuyBoxPrices.length === 0) return null;

  return summary.BuyBoxPrices[0].LandedPrice.Amount;
}

function fetchInventorySummaries_(accessToken) {
  var url = 'https://sellingpartnerapi-fe.amazon.com/fba/inventory/v1/summaries' +
            '?granularityType=Marketplace&granularityId=' + MARKETPLACE_ID +
            '&marketplaceIds=' + MARKETPLACE_ID + '&details=true';

  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'x-amz-access-token': accessToken },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    Logger.log('在庫取得失敗。ステータスコード: ' + response.getResponseCode());
    return null;
  }

  var json = JSON.parse(response.getContentText());
  var summaries = json.payload && json.payload.inventorySummaries;
  if (!summaries) {
    Logger.log('在庫データの形式が想定外です');
    return null;
  }
  return summaries;
}

function getOutOfStockAsins_(accessToken) {
  var items = fetchInventorySummaries_(accessToken);
  if (items === null) return null;

  var totals = {};
  for (var i = 0; i < items.length; i++) {
    totals[items[i].asin] = (totals[items[i].asin] || 0) + (items[i].totalQuantity || 0);
  }

  var result = {};
  for (var asin in totals) {
    if (totals[asin] === 0) result[asin] = true;
  }
  return result;
}

// ===== Slack通知 =====

function postSlackWebhook_(text) {
  var webhookUrl = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL');
  UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: text }),
    muteHttpExceptions: true
  });
}

// ===== 在庫切れチェック =====

function checkStockouts() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var lastRow = getLastDataRow_(sheet);
  if (lastRow < 2) {
    Logger.log('シートにASINが登録されていないため、チェックをスキップしました。');
    return;
  }

  var rows = sheet.getRange(2, 1, lastRow - 1, 20).getValues();
  var today = new Date();
  today.setHours(0, 0, 0, 0);

  var nextDateByAsin = {};
  for (var i = 0; i < rows.length; i++) {
    var asin = rows[i][0];
    if (!asin || asin.toString().trim() === '') continue;
    if (rows[i][16] === '停止') continue;
    if (rows[i][19] === true) continue;
    nextDateByAsin[asin.toString().trim()] = rows[i][10];
  }

  if (Object.keys(nextDateByAsin).length === 0) {
    Logger.log('シートにASINが登録されていないため、チェックをスキップしました。');
    return;
  }

  var items = fetchInventorySummaries_(getAccessToken_());
  if (items === null) return;

  var outOfStock = [];
  var seenAsins = {};

  for (var j = 0; j < items.length; j++) {
    var itemAsin = items[j].asin;
    if (items[j].totalQuantity !== 0) continue;
    if (!nextDateByAsin.hasOwnProperty(itemAsin)) continue;
    if (seenAsins[itemAsin]) continue;

    var nextDate = nextDateByAsin[itemAsin];
    if (nextDate) {
      var nextDateObj = new Date(nextDate);
      nextDateObj.setHours(0, 0, 0, 0);
      if (nextDateObj > today) continue;
    }

    outOfStock.push(items[j]);
    seenAsins[itemAsin] = true;
  }

  Logger.log('登録商品のうち在庫0の商品数: ' + outOfStock.length);

  if (outOfStock.length > 0) {
    sendStockoutAlert_(outOfStock);
  }
}

function sendStockoutAlert_(outOfStock) {
  var text = '⚠️ 登録リピート商品で在庫切れがあります（' + outOfStock.length + '件）\n';
  for (var i = 0; i < outOfStock.length; i++) {
    text += '・' + outOfStock[i].productName + '（ASIN: ' + outOfStock[i].asin + '）\n';
  }
  postSlackWebhook_(text);
}

// ===== リピート購入アラート（次回購入目安日が来て、在庫が0のとき） =====

function checkRepeatPurchaseAlerts() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var lastRow = getLastDataRow_(sheet);
  if (lastRow < 2) return;

  var data = sheet.getRange(2, 1, lastRow - 1, 20).getValues();
  var today = new Date();
  today.setHours(0, 0, 0, 0);

  var accessToken = null;
  var outOfStock;

  for (var i = 0; i < data.length; i++) {
    var row = i + 2;
    var asin = data[i][0];
    var name = data[i][1];
    var cost = data[i][3];
    var price = data[i][4];
    var profit = data[i][5];
    var nextDate = data[i][10];
    var status = data[i][16];
    var alertStop = data[i][19];

    if (!asin || !nextDate) continue;
    if (status === '停止') continue;
    if (alertStop === true) continue;

    var nextDateObj = new Date(nextDate);
    nextDateObj.setHours(0, 0, 0, 0);
    if (nextDateObj > today) continue;

    if (!accessToken) accessToken = getAccessToken_();

    if (outOfStock === undefined) outOfStock = getOutOfStockAsins_(accessToken);
    if (outOfStock !== null && !outOfStock[asin]) continue;

    var currentPrice = null;
    try {
      currentPrice = getBuyBoxPrice_(accessToken, asin);
    } catch (err) {
      Logger.log('価格取得エラー(' + asin + '): ' + err.toString());
    }

    sheet.getRange(row, 18).setValue(currentPrice !== null ? currentPrice : '');
    sheet.getRange(row, 19).setValue(today);

    var currentProfit = null;
    var currentMargin = null;

    if (currentPrice !== null && cost && price && profit !== '') {
      var totalFeeAtReg = price - cost - profit;
      var referralAtReg = price * 0.08;
      var fixedFee = totalFeeAtReg - referralAtReg;
      var feeNow = currentPrice * 0.08 + fixedFee;
      currentProfit = currentPrice - cost - feeNow;
      currentMargin = currentProfit / currentPrice;
    }

    var ts = sendSingleProductAlert_({
      name: name,
      asin: asin,
      price: price,
      profit: profit,
      currentPrice: currentPrice,
      currentProfit: currentProfit,
      currentMargin: currentMargin
    });
    if (ts) {
      sheet.getRange(row, 21).setNumberFormat('@').setValue(ts);
    }

    Utilities.sleep(1100);
  }
}

function sendSingleProductAlert_(a) {
  var token = PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
  var channel = PropertiesService.getScriptProperties().getProperty('SLACK_CHANNEL_ID');

  var text = '🔔 次回購入目安：' + a.name + '（ASIN: ' + a.asin + '）\n';
  text += '登録時価格: ¥' + a.price + ' → 現在カート価格: ' +
          (a.currentPrice !== null ? '¥' + a.currentPrice : '取得不可') + '\n';

  if (a.currentProfit !== null) {
    text += '予想利益: ¥' + a.profit + ' → ¥' + Math.round(a.currentProfit) +
            '（利益率 ' + (a.currentMargin * 100).toFixed(1) + '%）';
    if (a.currentMargin < 0.05) text += ' ⚠️利益薄';
    text += '\n';
  }
  text += '\n買ったら「◯個」、今回は見送りなら「保留」とこのスレッドに返信してね';

  var response = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json; charset=utf-8' },
    payload: JSON.stringify({ channel: channel, text: text }),
    muteHttpExceptions: true
  });
  var json = JSON.parse(response.getContentText());
  if (!json.ok) {
    Logger.log('Slack投稿失敗（' + a.name + '）: ' + json.error);
    return null;
  }
  return json.ts;
}

// ===== 商品登録・更新の共通処理 =====

function writeProductRow_(sheet, row, data) {
  if (data.asin) sheet.getRange(row, 1).setValue(data.asin);
  if (data.productName) sheet.getRange(row, 2).setValue(data.productName);
  if (data.sourceUrl) sheet.getRange(row, 3).setValue(data.sourceUrl);
  if (data.cost) sheet.getRange(row, 4).setValue(data.cost);
  if (data.price) sheet.getRange(row, 5).setValue(data.price);
  if (data.cost && data.price) {
    if (data.fee) {
      sheet.getRange(row, 6).setFormula('=E' + row + '-D' + row + '-' + data.fee);
    } else {
      sheet.getRange(row, 6).setFormula('=E' + row + '-D' + row + '-E' + row + '*0.08');
    }
    sheet.getRange(row, 7).setFormula('=F' + row + '/E' + row);
  }
  if (data.note) sheet.getRange(row, 15).setValue(data.note);
}

// ===== Webアプリ（Slackイベント受信・外部からの商品登録） =====

function doPost(e) {
  try {
    var raw = e.postData.contents;
    var data = JSON.parse(raw);

    if (data.type === 'url_verification') {
      return ContentService.createTextOutput(data.challenge);
    }

    if (data.type === 'event_callback') {
      var expectedToken = PropertiesService.getScriptProperties().getProperty('SLACK_VERIFICATION_TOKEN');
      if (expectedToken && data.token !== expectedToken) {
        Logger.log('不正なSlackリクエストを拒否しました（トークン不一致）');
        return ContentService.createTextOutput('ignored');
      }
      var expectedTeamId = PropertiesService.getScriptProperties().getProperty('SLACK_TEAM_ID');
      if (expectedTeamId && data.team_id !== expectedTeamId) {
        return ContentService.createTextOutput('ignored');
      }
      if (!expectedTeamId && data.team_id) {
        PropertiesService.getScriptProperties().setProperty('SLACK_TEAM_ID', data.team_id);
      }

      var slackLock = LockService.getScriptLock();
      if (!slackLock.tryLock(10000)) {
        Logger.log('doPost(Slackイベント): ロック取得に失敗しました');
        return ContentService.createTextOutput('ok');
      }
      try {
        return handleSlackEvent_(data.event);
      } finally {
        slackLock.releaseLock();
      }
    }

    var expectedKey = PropertiesService.getScriptProperties().getProperty('WRITE_API_KEY');
    if (data.apiKey !== expectedKey) {
      return ContentService.createTextOutput(JSON.stringify({status: 'error', message: 'unauthorized'}))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var writeLock = LockService.getScriptLock();
    if (!writeLock.tryLock(10000)) {
      return ContentService.createTextOutput(JSON.stringify({status: 'error', message: 'locked, please retry'}))
        .setMimeType(ContentService.MimeType.JSON);
    }
    try {
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
      var newRow = getLastDataRow_(sheet) + 1;
      writeProductRow_(sheet, newRow, data);

      return ContentService.createTextOutput(JSON.stringify({status: 'success', row: newRow}))
        .setMimeType(ContentService.MimeType.JSON);
    } finally {
      writeLock.releaseLock();
    }
  } catch (err) {
    Logger.log('doPostエラー: ' + err.toString());
    return ContentService.createTextOutput(JSON.stringify({status: 'error', message: err.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function toHalfWidthDigits_(str) {
  return str.replace(/[０-９]/g, function(ch) {
    return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
  });
}

function handleSlackEvent_(event) {
  try {
    var expectedChannel = PropertiesService.getScriptProperties().getProperty('SLACK_CHANNEL_ID');
    if (event.type !== 'message' || event.bot_id || event.subtype || !event.thread_ts) {
      return ContentService.createTextOutput('ok');
    }
    if (expectedChannel && event.channel !== expectedChannel) {
      return ContentService.createTextOutput('ok');
    }

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    var lastRow = getLastDataRow_(sheet);
    if (lastRow < 2) return ContentService.createTextOutput('ok');

    var threadCol = sheet.getRange(2, 21, lastRow - 1, 1).getValues();
    var targetRow = null;
    for (var i = 0; i < threadCol.length; i++) {
      if (String(threadCol[i][0]) === String(event.thread_ts)) {
        targetRow = i + 2;
        break;
      }
    }
    if (!targetRow) return ContentService.createTextOutput('ok');

    var text = event.text || '';
    var normalizedText = toHalfWidthDigits_(text);

    if (text.indexOf('保留') !== -1) {
      var snoozeDate = new Date();
      snoozeDate.setDate(snoozeDate.getDate() + 7);
      sheet.getRange(targetRow, 11).setValue(snoozeDate);
    } else {
      var match = normalizedText.match(/([0-9]+)\s*個/);
      if (match) {
        var qty = parseInt(match[1], 10);
        sheet.getRange(targetRow, 8).setValue(new Date());
        sheet.getRange(targetRow, 9).setValue(qty);
        sheet.getRange(targetRow, 11).setFormula('=H' + targetRow + '+J' + targetRow);
      }
    }

    return ContentService.createTextOutput('ok');
  } catch (err) {
    Logger.log('handleSlackEvent_エラー: ' + err.toString());
    return ContentService.createTextOutput('ok');
  }
}

// ===== メール経由の更新（AUTO_ADD_PRODUCT / AUTO_ADD_HOLD） =====

function forEachUnreadMail_(searchQuery, handler) {
  var threads = GmailApp.search(searchQuery);
  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      if (!msg.isUnread()) continue;
      try {
        handler(msg);
        msg.markRead();
      } catch (err) {
        Logger.log('メール処理エラー: ' + err.toString());
      }
    }
  }
}

function withLock_(name, waitMs, fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs)) {
    Logger.log(name + ': ロック取得に失敗したため今回はスキップします');
    return;
  }
  try {
    fn();
  } finally {
    lock.releaseLock();
  }
}

function findRow_(values, target) {
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === target) return i + 2;
  }
  return null;
}

function processIncomingEmails() {
  withLock_('processIncomingEmails', 30000, function() {
    forEachUnreadMail_('subject:"AUTO_ADD_PRODUCT" is:unread', function(msg) {
      var data = JSON.parse(msg.getPlainBody().replace(/[\r\n]+/g, ''));
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
      var lastRow = getLastDataRow_(sheet);

      var targetRow = null;
      if (data.asin && lastRow >= 2) {
        targetRow = findRow_(sheet.getRange(2, 1, lastRow - 1, 1).getValues(), data.asin);
      }
      var row = targetRow || (lastRow + 1);

      writeProductRow_(sheet, row, data);
      if (data.lastPurchaseDate) sheet.getRange(row, 8).setValue(data.lastPurchaseDate);
      if (data.quantity) sheet.getRange(row, 9).setValue(data.quantity);
      if (data.cycleDays) {
        sheet.getRange(row, 10).setValue(data.cycleDays);
        sheet.getRange(row, 11).setFormula('=H' + row + '+J' + row);
      }
    });
  });
}

function processIncomingHoldEmails() {
  withLock_('processIncomingHoldEmails', 30000, function() {
    forEachUnreadMail_('subject:"AUTO_ADD_HOLD" is:unread', function(msg) {
      var data = JSON.parse(msg.getPlainBody().replace(/[\r\n]+/g, ''));
      var sheet = getHoldSheet_();
      var lastRow = getLastDataRow_(sheet);

      var targetRow = null;
      if (data.asin && lastRow >= 2) {
        targetRow = findRow_(sheet.getRange(2, 2, lastRow - 1, 1).getValues(), data.asin);
      }
      var row = targetRow || (lastRow + 1);

      sheet.getRange(row, 1).setValue(data.productName || '');
      sheet.getRange(row, 2).setValue(data.asin || '');
      sheet.getRange(row, 3).setValue(data.candidateCost || '');
      sheet.getRange(row, 4).setValue(data.candidatePrice || '');
      sheet.getRange(row, 5).setValue(data.estimatedMargin || '');
      sheet.getRange(row, 6).setValue(data.holdReason || '');
      sheet.getRange(row, 7).setValue(new Date());
      sheet.getRange(row, 8).setValue('保留中');
      if (data.sourceUrl) {
        sheet.getRange(row, 9).setValue(unwrapGoogleUrl_(data.sourceUrl));
      }
    });
  });
}

// ===== 保留商品シート =====

function getHoldSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('仕入れ保留商品');
  if (!sheet) {
    sheet = ss.insertSheet('仕入れ保留商品');
  }
  if (sheet.getRange(1, 1).getValue() === '') {
    var headers = ['商品名', 'ASIN', '仕入れ候補価格', '想定販売価格', '想定利益率', '保留理由', '検討日', 'ステータス', '仕入れ先商品ページ'];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#d9d9d9');
    sheet.setFrozenRows(1);

    var existingFilter = sheet.getFilter();
    if (existingFilter) existingFilter.remove();
    sheet.getRange(1, 1, 100, headers.length).createFilter();
  }
  // 既存シートにI1の見出しがなければ追加
  if (sheet.getRange(1, 9).getValue() === '') {
    sheet.getRange(1, 9).setValue('仕入れ先商品ページ').setFontWeight('bold').setBackground('#d9d9d9');
  }
  return sheet;
}

function sendHoldListReminder() {
  // 毎月10日・20日・30日だけ送る（2月は月末日）
  var now = new Date();
  var lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  var targetDays = [10, 20, Math.min(30, lastDay)];
  if (targetDays.indexOf(now.getDate()) === -1) return;

  var sheet = getHoldSheet_();
  var lastRow = getLastDataRow_(sheet);
  if (lastRow < 2) return;

  var data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
  var pending = [];
  for (var i = 0; i < data.length; i++) {
    if (data[i][7] !== '解決済み') {
      pending.push(data[i]);
    }
  }
  if (pending.length === 0) return;

  var text = '📋 保留中の商品が' + pending.length + '件あります（再検討タイミングかも）\n\n';
  for (var j = 0; j < pending.length; j++) {
    var row = pending[j];
    text += '・' + row[0] + '（ASIN: ' + row[1] + '）\n';
    text += '  仕入れ¥' + row[2] + ' → 販売¥' + row[3] + '（想定利益率' + row[4] + '）\n';
    text += '  保留理由: ' + row[5] + '\n\n';
  }
  postSlackWebhook_(text);
}

// ===== シート編集トリガー・共通ヘルパー =====

function onEdit(e) {
  var sheet = e.range.getSheet();
  var mainSheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  if (sheet.getSheetId() !== mainSheet.getSheetId()) return;

  if (e.range.getColumn() === 8 && e.range.getRow() >= 2) {
    sheet.getRange(e.range.getRow(), 20).setValue(false);
  }
}

function getLastDataRow_(sheet) {
  var values = sheet.getRange(1, 1, sheet.getMaxRows(), 1).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    if (values[i][0] !== '') {
      return i + 1;
    }
  }
  return 1;
}

// Gmail経由でURLが google.com/url?q=… の形に変わっても、元のURLに戻す
function unwrapGoogleUrl_(url) {
  var m = String(url).match(/^https?:\/\/www\.google\.com\/url\?q=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : String(url);
}
