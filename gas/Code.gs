/**
 * サロン和笑〜Violane〜 予約システム バックエンド（Google Apps Script）
 *
 * 役割: 空き枠計算 / 仮予約作成 / 承認・辞退 / キャンセル・変更 / 新規・常連判定 / 通知。
 * 保存先はサロン所有の Google（予約カレンダー＋顧客台帳シート）と LINE のみ。独自DBは持たない。
 *
 * 設定は「スクリプト プロパティ」(docs/SETUP.md F) を参照。
 * フロントは POST を Content-Type: text/plain で送り CORS プリフライトを回避する。
 *
 * ※メニュー定義は src/data/menu.js と二重管理。変更時は両方を更新すること。
 */

// ============================================================
// 設定・定数
// ============================================================

/** 営業ルール（フロント src/data/config.js の BOOKING_RULES とそろえる） */
var RULES = {
  openTime: '10:00',
  closeTime: '20:00',
  slotStepMin: 30,
  leadTimeDays: 1, // 当日不可・翌日以降
  maxAdvanceDays: 30,
  cleanupBufferMin: 0,
  cancelDeadlineDays: 1,
};

/** メニュー（src/data/menu.js のミラー）。firstTime は新規(初回)時の上書き。 */
var MENU = {
  'double-momi-part-oil-70': { name: '全身もみほぐし＋部位オイルケア', durationMin: 70, price: 4300 },
  'double-momi-full-oil-90': { name: '全身もみほぐし＋全身オイルケア', durationMin: 90, price: 5500 },
  'simple-momi-30': { name: '全身もみほぐし 30分', durationMin: 30, price: 3300, firstTime: { durationMin: 40, price: 3300 } },
  'simple-momi-50': { name: '全身もみほぐし 50分', durationMin: 50, price: 4000, firstTime: { durationMin: 60, price: 4000 } },
  'simple-momi-70': { name: '全身もみほぐし 70分', durationMin: 70, price: 4400 },
  'simple-momi-100': { name: '全身もみほぐし 100分', durationMin: 100, price: 5500 },
  'simple-oil-80': { name: '全身オイルケア', durationMin: 80, price: 6600 },
  'petit-foot-30': { name: 'フットケア', durationMin: 30, price: 3300 },
  'petit-hand-30': { name: 'ハンドケア', durationMin: 30, price: 3300 },
  'petit-head-30': { name: 'ヘッド&リフトアップ（顎ほぐし）', durationMin: 30, price: 3500 },
};

var TZ = 'Asia/Tokyo';
var STATUS = { PENDING: 'pending', CONFIRMED: 'confirmed' };

/** 辞退時にお客様へ送る既定メッセージ（確認ページでオーナーが編集可能） */
var DECLINE_DEFAULT_MSG = '申し訳ございませんが、今回はご希望の日時でご予約をお受けできませんでした。\nお手数ですが、別の日時で改めてお申し込みいただけますと幸いです。';

function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

/**
 * 初回認可用。公開API（実行=自分）はオーナーが事前に各サービスを認可しておく必要がある。
 * GAS エディタでこの関数を一度だけ実行し、表示される同意画面で
 * Calendar / Sheets / メール送信 / 外部通信(LINE) のアクセスを許可する。
 * 認可後は公開API（?action=availability 等）が匿名アクセスでも動作する。
 */
function authorize() {
  // プロジェクト全体で使うスコープを宣言・確認するため各サービスへ軽く触れる
  CalendarApp.getCalendarById(prop_('CALENDAR_ID'));
  SpreadsheetApp.openById(prop_('LEDGER_SHEET_ID'));
  UrlFetchApp.getRequest('https://api.line.me/', {}); // 送信はしない（スコープ宣言用）
  MailApp.getRemainingDailyQuota();                   // 送信はしない（スコープ宣言用）
  console.log('authorize: OK — 全スコープ認可済み');
}

/**
 * 診断用。GASエディタで実行し「実行ログ」を確認する。
 * Script Properties の設定有無・LINE push の実レスポンス・実行ユーザーを出力する。
 * 秘密情報（トークン/HMAC/ownerId）は値を出さず、長さ・接頭辞のみ表示する。
 * 実行すると LINE へ実テスト通知を1件送る（届けば LINE 設定は正常）。
 */
function diag() {
  function mask(v) { return v ? '(len=' + v.length + ', head=' + v.slice(0, 4) + '…)' : '(未設定)'; }
  var token = prop_('LINE_CHANNEL_ACCESS_TOKEN');
  var owner = prop_('LINE_OWNER_USER_ID');
  Logger.log('CALENDAR_ID: ' + (prop_('CALENDAR_ID') ? 'set' : '未設定'));
  Logger.log('LEDGER_SHEET_ID: ' + (prop_('LEDGER_SHEET_ID') ? 'set' : '未設定'));
  Logger.log('HMAC_SECRET: ' + (prop_('HMAC_SECRET') ? 'set' : '未設定'));
  Logger.log('FRONT_BASE_URL: ' + prop_('FRONT_BASE_URL'));
  Logger.log('ENV_LABEL: "' + prop_('ENV_LABEL') + '"');
  Logger.log('ADMIN_EMAILS: ' + prop_('ADMIN_EMAILS'));
  Logger.log('activeUser: ' + Session.getActiveUser().getEmail());
  Logger.log('webapp url (getService): ' + ScriptApp.getService().getUrl());
  Logger.log('PUBLIC_EXEC_URL prop: ' + (prop_('PUBLIC_EXEC_URL') || '(未設定→getServiceにフォールバック)'));
  Logger.log('承認リンクbase(実際に使う値): ' + publicExecUrl_());
  Logger.log('LINE_CHANNEL_ACCESS_TOKEN: ' + mask(token));
  Logger.log('LINE_OWNER_USER_ID: ' + mask(owner) + ' prefix=' + owner.charAt(0));
  Logger.log('LINE_LAST_SOURCE: ' + (prop_('LINE_LAST_SOURCE') || '(未捕捉)'));
  if (token && owner) {
    var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ to: owner, messages: [{ type: 'text', text: '【開発】diag テスト通知' }] }),
      muteHttpExceptions: true,
    });
    Logger.log('LINE push status: ' + res.getResponseCode());
    Logger.log('LINE push body: ' + res.getContentText());
  } else {
    Logger.log('LINE push skipped (token か owner が未設定)');
  }
}

// ============================================================
// ルーティング（doGet / doPost）
// ============================================================

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  try {
    switch (action) {
      case 'availability':
        return json_(getAvailability_(e.parameter));
      case 'booking': // 管理ページ：トークンで予約内容取得
        return json_(getBookingByToken_(e.parameter.token));
      case 'approve': // LINE通知の署名リンク（GETは読み取り専用の確認ページ）
        return renderDecisionPage_(e.parameter, true);
      case 'decline':
        return renderDecisionPage_(e.parameter, false);
      case 'admin': { // 管理パネル（別デプロイ：executeAs=アクセスユーザー / アクセス=自分のみ）
        var envLabel = prop_('ENV_LABEL') || ''; // dev のみ '【開発】'。dev インジケータの出し分けに使う
        var t = HtmlService.createTemplateFromFile('admin');
        t.envLabel = envLabel;
        return t.evaluate()
          .setTitle(envLabel + '予約管理 — サロン和笑〜Violane〜')
          .addMetaTag('viewport', 'width=device-width, initial-scale=1');
      }
      default:
        return json_({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (_) {}
  // LINE Webhook（events を含む POST）: 通知先ID（グループ/ルーム/ユーザー）を捕捉する設定用ハンドラ
  if (body.events) return handleLineWebhook_(body);
  var action = body.action || '';
  try {
    switch (action) {
      // 一般（お客様）
      case 'createBooking': return json_(createBooking_(body));
      case 'cancelBooking': return json_(cancelBooking_(body));
      case 'changeBooking': return json_(changeBooking_(body));
      // 管理（Googleログイン必須）
      case 'getSlotConfig': return json_(requireAdmin_(adminGetSlotConfig_));
      case 'setSlotConfig': return json_(requireAdmin_(function () { return adminSetSlotConfig_(body); }));
      case 'listPending': return json_(requireAdmin_(adminListPending_));
      case 'adminDecision': return json_(requireAdmin_(function () { return adminDecision_(body); }));
      default: return json_({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/**
 * LINE Webhook 受信（通知先ID捕捉用・設定時のみ使用）。
 * グループ通知のグループID(C…)は Webhook の source からしか取得できない。
 * 手順: ①公式アカウントでグループ参加を許可 ②ボットを対象グループに招待
 *       ③グループで誰かが発言 → ここで source を捕捉し Script Property
 *       `LINE_LAST_SOURCE`（例: group:Cxxxx）へ保存 → その値を `LINE_OWNER_USER_ID` に設定。
 */
function handleLineWebhook_(body) {
  (body.events || []).forEach(function (ev) {
    var s = (ev && ev.source) || {};
    var id = s.groupId || s.roomId || s.userId || '';
    console.log('LINE webhook: type=' + s.type + ' id=' + id);
    if (id) PropertiesService.getScriptProperties().setProperty('LINE_LAST_SOURCE', (s.type || '?') + ':' + id);
  });
  return json_({ ok: true });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function html_(message) {
  var page = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<div style="font-family:sans-serif;max-width:480px;margin:3rem auto;padding:1.5rem;text-align:center;line-height:1.8">' +
    message + '</div>';
  return HtmlService.createHtmlOutput(page);
}

// ============================================================
// 空き枠計算
// ============================================================

/**
 * @param {Object} p { menuId, from?, to?, isFirstTime? }
 * @returns {{ok:boolean, menuId:string, durationMin:number, days:Array}}
 */
function getAvailability_(p) {
  var menu = MENU[p.menuId];
  if (!menu) return { ok: false, error: 'invalid_menu' };
  var isFirst = String(p.isFirstTime || '') === '1';
  var dur = effectiveMenu_(menu, isFirst).durationMin;

  var today = startOfDay_(new Date());
  var from = p.from ? parseDate_(p.from) : addDays_(today, RULES.leadTimeDays);
  var minFrom = addDays_(today, RULES.leadTimeDays);
  if (from < minFrom) from = minFrom;
  var to = p.to ? parseDate_(p.to) : addDays_(today, RULES.maxAdvanceDays);
  var maxTo = addDays_(today, RULES.maxAdvanceDays);
  if (to > maxTo) to = maxTo;

  var cal = CalendarApp.getCalendarById(prop_('CALENDAR_ID'));
  var config = readSlotConfig_();
  var days = [];

  // 既存予約は範囲全体を一度だけ取得し日付ごとにバケツ分け（getEvents 呼び出しを日数分→1回へ削減）
  var busyByDate = {};
  if (cal) {
    cal.getEvents(startOfDay_(from), addDays_(startOfDay_(to), 1)).forEach(function (ev) {
      var dk = fmt_(ev.getStartTime(), 'yyyy-MM-dd');
      (busyByDate[dk] || (busyByDate[dk] = [])).push({ start: ev.getStartTime().getTime(), end: ev.getEndTime().getTime() });
    });
  }

  for (var d = new Date(from); d <= to; d = addDays_(d, 1)) {
    var dateStr = fmt_(d, 'yyyy-MM-dd');
    if (!isOpenDay_(d, config)) continue;
    var busy = busyByDate[dateStr] || [];
    var times = [];
    var candidates = candidateStarts_(d, dur);
    for (var i = 0; i < candidates.length; i++) {
      var s = candidates[i];
      var slotEnd = new Date(s.getTime() + dur * 60000);
      if (isClosedSlot_(dateStr, fmt_(s, 'HH:mm'), config)) continue;
      if (overlapsBusy_(s, slotEnd, busy)) continue;
      times.push(fmt_(s, 'HH:mm'));
    }
    if (times.length) days.push({ date: dateStr, times: times });
  }
  return { ok: true, menuId: p.menuId, durationMin: dur, isFirstTime: isFirst, days: days };
}

/** その日が営業日か（曜日ルール＋手動 closedDates） */
function isOpenDay_(d, config) {
  var dateStr = fmt_(d, 'yyyy-MM-dd');
  if (config.closedDates && config.closedDates.indexOf(dateStr) >= 0) return false;
  if (config.openDates && config.openDates.indexOf(dateStr) >= 0) return true; // 臨時営業
  var dow = d.getDay(); // 0=日, 6=土
  if (dow === 0) return false; // 日曜休
  if (dow === 6) {
    var nth = Math.ceil(d.getDate() / 7);
    return nth === 2 || nth === 4; // 第2・第4土のみ営業
  }
  return true; // 月〜金
}

/** 30分刻みの開始候補（営業時間内で施術が閉店までに終わるもの） */
function candidateStarts_(d, dur) {
  var open = atTime_(d, RULES.openTime);
  var close = atTime_(d, RULES.closeTime);
  var lastStart = new Date(close.getTime() - dur * 60000);
  var out = [];
  for (var t = new Date(open); t <= lastStart; t = new Date(t.getTime() + RULES.slotStepMin * 60000)) {
    out.push(new Date(t));
  }
  return out;
}

function overlapsBusy_(s, e, busy) {
  var buf = RULES.cleanupBufferMin * 60000;
  for (var i = 0; i < busy.length; i++) {
    if (s.getTime() < busy[i].end + buf && e.getTime() + buf > busy[i].start) return true;
  }
  return false;
}

function isClosedSlot_(dateStr, hhmm, config) {
  return !!(config.closedSlots && config.closedSlots[dateStr] && config.closedSlots[dateStr].indexOf(hhmm) >= 0);
}

// ============================================================
// 予約作成（仮予約）
// ============================================================

function createBooking_(b) {
  var menu = MENU[b.menuId];
  if (!menu) return { ok: false, error: 'invalid_menu' };
  if (!b.name || !b.contactMethod) return { ok: false, error: 'missing_required' };
  if (b.contactMethod === 'email' && !b.email) return { ok: false, error: 'missing_email' };
  if (b.contactMethod === 'line' && !b.lineUserId && !b.email) return { ok: false, error: 'missing_contact' };
  if (b.gender === 'male' && !b.referrer) return { ok: false, error: 'referrer_required' };
  if (!b.date || !b.time) return { ok: false, error: 'missing_slot' };

  // リードタイム・受付上限の検証
  var start = atTime_(parseDate_(b.date), b.time);
  var today = startOfDay_(new Date());
  if (start < addDays_(today, RULES.leadTimeDays)) return { ok: false, error: 'too_soon' };
  if (start > addDays_(today, RULES.maxAdvanceDays + 1)) return { ok: false, error: 'too_far' };

  // 新規/常連判定 → 初回料金確定
  var ledgerKey = ledgerKey_(b);
  var isFirst = ledgerKey ? !ledgerLookup_(ledgerKey) : true;
  var eff = effectiveMenu_(menu, isFirst);
  var end = new Date(start.getTime() + eff.durationMin * 60000);

  var cal = CalendarApp.getCalendarById(prop_('CALENDAR_ID'));
  if (!cal) return { ok: false, error: 'calendar_not_configured' };

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  var token, ev;
  try {
    // 直前再検証（重複・休枠）
    var config = readSlotConfig_();
    if (!isOpenDay_(start, config) || isClosedSlot_(b.date, b.time, config)) {
      return { ok: false, error: 'slot_closed' };
    }
    var busy = cal.getEvents(startOfDay_(start), addDays_(startOfDay_(start), 1)).map(function (e) {
      return { start: e.getStartTime().getTime(), end: e.getEndTime().getTime() };
    });
    if (overlapsBusy_(start, end, busy)) return { ok: false, error: 'slot_taken' };

    token = Utilities.getUuid();
    ev = cal.createEvent('【仮】' + menu.name + ' / ' + b.name, start, end);
    setEventProps_(ev, {
      token: token, status: STATUS.PENDING, menuId: b.menuId,
      name: b.name, phone: b.phone || '', email: b.email || '',
      gender: b.gender || '', referrer: b.referrer || '',
      lineUserId: b.lineUserId || '', isFirstTime: String(isFirst),
      price: String(eff.price), note: b.note || '',
    });
    try { ev.setColor(CalendarApp.EventColor.ORANGE); } catch (_) {}
  } finally {
    lock.releaseLock();
  }

  // 通知
  notifyOwnerNewBooking_(token, b, menu, start, end, eff, isFirst);
  notifyCustomer_(b, '【仮予約を受付ました】\n' + bookingSummary_(menu, start, eff, isFirst) +
    '\nサロンの確認後、確定のご連絡をいたします。\n\n▼ ご予約の確認・変更・キャンセル\n' + manageUrl_(token));

  return {
    ok: true, token: token, status: STATUS.PENDING,
    isFirstTime: isFirst, durationMin: eff.durationMin, price: eff.price,
    manageUrl: manageUrl_(token),
  };
}

// ============================================================
// 承認・辞退
// ============================================================

/**
 * LINE署名リンク経由（GET）。**状態変更はしない**確認ページを返す。
 * 重要: GET は読み取り専用にする。承認/辞退リンクを LINE/メール等のクローラが
 * プリフェッチ（プレビュー生成）すると、GET で確定/辞退が誤発火し予約が
 * 勝手に削除される事故が起きるため、実処理はボタン押下→google.script.run に分離する。
 */
function renderDecisionPage_(p, approve) {
  var act = approve ? '確定' : '辞退';
  if (!verifySig_('decision:' + p.token, p.sig)) return html_('署名が無効です。');
  var b = getBookingByToken_(p.token);
  if (!b.ok) {
    return html_('<h2 style="font-size:1.1rem">この予約は見つかりませんでした</h2>' +
      '<p>すでに処理済み、または取消済みの可能性があります。</p>');
  }
  var color = approve ? '#2e7d32' : '#b00020';
  var statusNote = b.status === STATUS.CONFIRMED ? '<p style="color:#2e7d32">※この予約はすでに「確定」済みです。</p>' : '';
  var summary = esc_(b.name) + ' 様' + (b.isFirstTime ? '（新規）' : '（常連）') + '<br>' +
    esc_(b.menuName) + '<br>' + b.date + ' ' + b.time + '〜（' + b.durationMin + '分） ¥' + b.price;
  // 辞退時はお客様へ送るメッセージを入力できる（既定文をプリセット）
  var declineBox = approve ? '' : (
    '<label for="declineMsg" style="display:block;text-align:left;font-size:.9rem;margin:.2rem 0 .35rem">お客様へのメッセージ（このまま送信／編集可）</label>' +
    '<textarea id="declineMsg" rows="4" style="width:100%;font-family:inherit;font-size:1rem;padding:.6rem .7rem;border:1px solid #E2D0D8;border-radius:8px;box-sizing:border-box">' +
    esc_(DECLINE_DEFAULT_MSG) + '</textarea>'
  );
  var page = '' +
    '<h2 style="font-size:1.1rem;margin:0 0 .5rem">予約を' + act + 'しますか？</h2>' +
    statusNote +
    '<div style="background:#f6f3f6;border-radius:10px;padding:1rem;margin:1rem 0;text-align:left">' + summary + '</div>' +
    declineBox +
    '<button id="go" style="width:100%;min-height:48px;margin-top:1rem;border:0;border-radius:24px;color:#fff;background:' + color + ';font-size:1rem;cursor:pointer">' + act + 'する</button>' +
    '<p id="msg" style="color:#666;margin-top:1rem;min-height:1.2em"></p>' +
    '<script>' +
    'var T=' + JSON.stringify(p.token) + ',S=' + JSON.stringify(p.sig) + ',A=' + (approve ? 'true' : 'false') + ';' +
    'document.getElementById("go").onclick=function(){' +
    'var box=document.getElementById("declineMsg");var MSG=box?box.value:"";' +
    'this.disabled=true;this.style.opacity=.5;this.textContent="処理中…";' +
    'google.script.run.withSuccessHandler(function(r){' +
    'var m=document.getElementById("msg");' +
    'if(r&&r.ok){m.innerHTML="<b>' + act + 'しました。</b>お客様へ通知済みです。";document.getElementById("go").style.display="none";if(box)box.disabled=true;}' +
    'else{m.textContent="エラー: "+((r&&r.error)||"unknown");}' +
    '}).withFailureHandler(function(e){document.getElementById("msg").textContent="通信エラー: "+e;}).decideBySig(T,S,A,MSG);' +
    '};' +
    '</script>';
  return html_(page);
}

/** 確認ページのボタン（google.script.run）から呼ばれる。署名検証のうえ確定/辞退を実行。 */
function decideBySig(token, sig, approve, message) {
  if (!verifySig_('decision:' + token, sig)) return { ok: false, error: 'bad_signature' };
  return decide_(token, !!approve, message);
}

/** 管理画面経由（POST・要Googleログイン） */
function adminDecision_(b) {
  return decide_(b.token, !!b.approve, b.message);
}

function decide_(token, approve, message) {
  var found = findEventByToken_(token);
  if (!found) return { ok: false, error: 'not_found' };
  var ev = found.event, props = found.props;
  var menu = MENU[props.menuId] || { name: props.menuId };
  if (approve) {
    ev.setTitle('【確定】' + menu.name + ' / ' + props.name);
    setEventProps_(ev, { status: STATUS.CONFIRMED });
    try { ev.setColor(CalendarApp.EventColor.GREEN); } catch (_) {}
    ledgerUpsert_(props, ev.getStartTime());
    notifyCustomerProps_(props, '【ご予約が確定しました】\n' +
      bookingSummary_(menu, ev.getStartTime(), { durationMin: durationMin_(ev), price: Number(props.price || 0) }, props.isFirstTime === 'true') +
      '\nご来店をお待ちしております。');
  } else {
    var msg = (message && String(message).trim()) ? String(message).trim() : DECLINE_DEFAULT_MSG;
    notifyCustomerProps_(props, '【ご予約について】\n' + msg);
    ev.deleteEvent();
  }
  return { ok: true, status: approve ? STATUS.CONFIRMED : 'declined' };
}

// ============================================================
// キャンセル・変更（お客様・トークン）
// ============================================================

function cancelBooking_(b) {
  var found = findEventByToken_(b.token);
  if (!found) return { ok: false, error: 'not_found' };
  if (!withinCancelDeadline_(found.event.getStartTime())) return { ok: false, error: 'too_late' };
  var props = found.props;
  var menu = MENU[props.menuId] || { name: props.menuId };
  found.event.deleteEvent();
  notifyOwner_('【お客様がキャンセルしました】\n' + props.name + ' 様 / ' + menu.name);
  notifyCustomerProps_(props, '【ご予約をキャンセルしました】\nまたのご利用をお待ちしております。');
  return { ok: true };
}

function changeBooking_(b) {
  var found = findEventByToken_(b.token);
  if (!found) return { ok: false, error: 'not_found' };
  if (!withinCancelDeadline_(found.event.getStartTime())) return { ok: false, error: 'too_late' };
  if (!b.date || !b.time) return { ok: false, error: 'missing_slot' };
  var props = found.props;
  var menu = MENU[props.menuId];
  if (!menu) return { ok: false, error: 'invalid_menu' };
  var eff = effectiveMenu_(menu, props.isFirstTime === 'true');
  var start = atTime_(parseDate_(b.date), b.time);
  var end = new Date(start.getTime() + eff.durationMin * 60000);

  var cal = CalendarApp.getCalendarById(prop_('CALENDAR_ID'));
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var busy = cal.getEvents(startOfDay_(start), addDays_(startOfDay_(start), 1)).filter(function (e) {
      return e.getId() !== found.event.getId();
    }).map(function (e) { return { start: e.getStartTime().getTime(), end: e.getEndTime().getTime() }; });
    if (overlapsBusy_(start, end, busy)) return { ok: false, error: 'slot_taken' };
    found.event.setTime(start, end);
    // 変更後は再承認のため仮に戻す
    found.event.setTitle('【仮】' + menu.name + ' / ' + props.name);
    setEventProps_(found.event, { status: STATUS.PENDING });
    try { found.event.setColor(CalendarApp.EventColor.ORANGE); } catch (_) {}
  } finally {
    lock.releaseLock();
  }
  notifyOwner_('【お客様が日時変更（要再承認）】\n' + props.name + ' 様 / ' + menu.name + '\n新日時: ' + fmt_(start, 'M/d(E) HH:mm'));
  notifyCustomerProps_(props, '【日時変更を受付ました】\n' + bookingSummary_(menu, start, eff, props.isFirstTime === 'true') + '\nサロンの確認後、確定のご連絡をいたします。');
  return { ok: true, status: STATUS.PENDING };
}

function getBookingByToken_(token) {
  var found = findEventByToken_(token);
  if (!found) return { ok: false, error: 'not_found' };
  var p = found.props, menu = MENU[p.menuId] || { name: p.menuId };
  return {
    ok: true, menuId: p.menuId, menuName: menu.name, name: p.name, status: p.status,
    isFirstTime: p.isFirstTime === 'true',
    date: fmt_(found.event.getStartTime(), 'yyyy-MM-dd'), time: fmt_(found.event.getStartTime(), 'HH:mm'),
    durationMin: durationMin_(found.event), price: Number(p.price || 0),
    canCancel: withinCancelDeadline_(found.event.getStartTime()),
  };
}

// ============================================================
// 管理（Googleログイン必須）
// ============================================================

function requireAdmin_(fn) {
  var email = Session.getActiveUser().getEmail();
  var allow = prop_('ADMIN_EMAILS').split(',').map(function (s) { return s.trim(); });
  if (!email || allow.indexOf(email) < 0) return { ok: false, error: 'forbidden' };
  return fn();
}

// ---- 管理パネル（admin.html）用の公開ラッパ ----
// 末尾アンダースコアの関数は google.script.run から呼べないため、公開名で薄くラップする。
// 管理デプロイ（executeAs=アクセスユーザー）下では Session.getActiveUser() が
// アクセス中の管理者本人になるため requireAdmin_ が機能する。
function adminApiGetConfig() { return requireAdmin_(adminGetSlotConfig_); }
function adminApiSetConfig(config) {
  return requireAdmin_(function () { return adminSetSlotConfig_({ config: config }); });
}
function adminApiListPending() { return requireAdmin_(adminListPending_); }
function adminApiDecision(token, approve) {
  return requireAdmin_(function () { return adminDecision_({ token: token, approve: !!approve }); });
}

function adminGetSlotConfig_() { return { ok: true, config: readSlotConfig_() }; }

function adminSetSlotConfig_(b) {
  var cfg = b.config || {};
  PropertiesService.getScriptProperties().setProperty('SLOT_CONFIG', JSON.stringify(cfg));
  return { ok: true };
}

function adminListPending_() {
  var cal = CalendarApp.getCalendarById(prop_('CALENDAR_ID'));
  var from = new Date();
  var to = addDays_(startOfDay_(from), RULES.maxAdvanceDays + 1);
  var list = cal.getEvents(from, to).filter(function (ev) {
    return getEventProp_(ev, 'status') === STATUS.PENDING;
  }).map(function (ev) {
    var p = getEventProps_(ev);
    var menu = MENU[p.menuId] || { name: p.menuId };
    return {
      token: p.token, name: p.name, menuName: menu.name,
      date: fmt_(ev.getStartTime(), 'yyyy-MM-dd'), time: fmt_(ev.getStartTime(), 'HH:mm'),
      gender: p.gender, referrer: p.referrer, isFirstTime: p.isFirstTime === 'true',
      phone: p.phone, email: p.email, note: p.note,
    };
  });
  return { ok: true, pending: list };
}

// ============================================================
// 顧客台帳（新規/常連判定）
// ============================================================

function ledgerKey_(b) {
  if (b.lineUserId) return 'line:' + b.lineUserId;
  if (b.phone) return 'phone:' + normalizePhone_(b.phone);
  if (b.email) return 'email:' + String(b.email).trim().toLowerCase();
  return '';
}

function ledgerSheet_() {
  var id = prop_('LEDGER_SHEET_ID');
  if (!id) return null;
  return SpreadsheetApp.openById(id).getSheets()[0];
}

/** キーに該当する行（1始まり）を返す。無ければ 0。 */
function ledgerLookup_(key) {
  var sh = ledgerSheet_();
  if (!sh) return 0;
  var values = sh.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]) === key) return r + 1;
  }
  return 0;
}

function ledgerUpsert_(props, visitDate) {
  var sh = ledgerSheet_();
  if (!sh) return;
  var key = props.lineUserId ? 'line:' + props.lineUserId
    : props.phone ? 'phone:' + normalizePhone_(props.phone)
      : props.email ? 'email:' + String(props.email).trim().toLowerCase() : '';
  if (!key) return;
  var type = key.split(':')[0];
  var row = ledgerLookup_(key);
  var dateStr = fmt_(visitDate, 'yyyy-MM-dd');
  if (row) {
    var count = Number(sh.getRange(row, 5).getValue() || 0) + 1;
    sh.getRange(row, 5).setValue(count);
    sh.getRange(row, 6).setValue(dateStr);
  } else {
    sh.appendRow([key, type, props.name || '', dateStr, 1, dateStr, '']);
  }
}

// ============================================================
// 通知（LINE / メール）
// ============================================================

function notifyOwnerNewBooking_(token, b, menu, start, end, eff, isFirst) {
  var sig = sign_('decision:' + token);
  var base = publicExecUrl_();
  var approve = base + '?action=approve&token=' + token + '&sig=' + encodeURIComponent(sig);
  var decline = base + '?action=decline&token=' + token + '&sig=' + encodeURIComponent(sig);
  var label = prop_('ENV_LABEL'); // dev のみ【開発】
  var detail = (label ? label + '\n' : '') +
    '【新規 仮予約】\n' +
    'お名前: ' + b.name + (isFirst ? '（新規）' : '（常連）') + '\n' +
    bookingSummary_(menu, start, eff, isFirst) + '\n' +
    '性別: ' + (b.gender === 'male' ? '男性' : '女性') + (b.gender === 'male' ? '\n紹介者: ' + b.referrer : '') + '\n' +
    '連絡: ' + (b.phone || '') + ' ' + (b.email || '') +
    (b.note ? '\n要望: ' + b.note : '');
  // 詳細はテキスト、承認/辞退は confirm テンプレートのボタンで送る（長いURLを直接見せない）
  linePushMessages_(prop_('LINE_OWNER_USER_ID'), [
    { type: 'text', text: detail },
    {
      type: 'template',
      altText: (label ? label + ' ' : '') + '仮予約の承認/辞退',
      template: {
        type: 'confirm',
        text: 'この仮予約を承認しますか？\n（ボタンから確認ページが開きます）',
        actions: [
          { type: 'uri', label: '✅ 承認する', uri: approve },
          { type: 'uri', label: '❌ 辞退する', uri: decline },
        ],
      },
    },
  ]);
}

function notifyOwner_(text) {
  // LINE Messaging API は dev/prod 共有のため、dev は ENV_LABEL(例:【開発】)を先頭に付けて区別する
  var label = prop_('ENV_LABEL');
  linePush_(prop_('LINE_OWNER_USER_ID'), (label ? label + '\n' : '') + text);
}

function notifyCustomer_(b, text) {
  if (b.lineUserId) linePush_(b.lineUserId, text);
  else if (b.email) sendMail_(b.email, 'サロン和笑〜Violane〜 ご予約', text);
}

function notifyCustomerProps_(props, text) {
  if (props.lineUserId) linePush_(props.lineUserId, text);
  else if (props.email) sendMail_(props.email, 'サロン和笑〜Violane〜 ご予約', text);
}

function linePush_(to, text) {
  linePushMessages_(to, [{ type: 'text', text: text }]);
}

/** 任意のメッセージ配列（テキスト/テンプレート等）を push する。 */
function linePushMessages_(to, messages) {
  var token = prop_('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token || !to) return;
  try {
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ to: to, messages: messages }),
      muteHttpExceptions: true,
    });
  } catch (err) { console.error('linePushMessages_ failed: ' + err); }
}

function sendMail_(to, subject, body) {
  // dev は ENV_LABEL を件名・本文の先頭に付けて本番メールと区別する（prod はキー未登録＝無印）
  var label = prop_('ENV_LABEL');
  if (label) { subject = label + ' ' + subject; body = label + '\n' + body; }
  // プレーン本文をフォールバックに残しつつ HTML メールも送る（URL単独行はボタン化）
  var opts = { htmlBody: mailHtml_(body), name: 'サロン和笑〜Violane〜' };
  // 通知専用の差出人。MAIL_FROM は「スクリプト実行アカウントの Send mail as エイリアス」である必要がある。
  // 返信先(MAIL_REPLY_TO 未指定時は MAIL_FROM)も合わせて通知アドレスに向ける。
  var from = prop_('MAIL_FROM');
  if (from) { opts.from = from; opts.replyTo = prop_('MAIL_REPLY_TO') || from; }
  try {
    MailApp.sendEmail(to, subject, body, opts);
  } catch (err) {
    // from がエイリアス未登録だと例外になりうる。from を外して再送し、お客様には必ず届ける。
    console.error('sendMail_ failed (retry without from): ' + err);
    delete opts.from;
    try { MailApp.sendEmail(to, subject, body, opts); }
    catch (e2) { console.error('sendMail_ retry failed: ' + e2); }
  }
}

/** プレーン本文から簡易HTMLメールを生成する。URL単独行はボタン化する。 */
function mailHtml_(text) {
  var rows = '';
  String(text).split('\n').forEach(function (ln) {
    var t = ln.trim();
    if (/^https?:\/\/\S+$/.test(t)) {
      rows += '<p style="text-align:center;margin:18px 0">' +
        '<a href="' + esc_(t) + '" style="display:inline-block;background:#8B6080;color:#ffffff;' +
        'text-decoration:none;border-radius:24px;padding:13px 26px;font-size:15px">予約内容を確認・変更する</a></p>';
    } else if (t === '') {
      rows += '<div style="height:8px"></div>';
    } else {
      rows += '<div>' + esc_(ln) + '</div>';
    }
  });
  return '<div style="font-family:\'Hiragino Mincho ProN\',\'YuMincho\',serif;background:#FDF2F5;padding:22px;color:#2C1F3A;line-height:1.9">' +
    '<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #E2D0D8;border-radius:12px;padding:24px">' + rows + '</div>' +
    '<p style="max-width:520px;margin:14px auto 0;text-align:center;color:#7A6080;font-size:12px">サロン和笑〜Violane〜</p></div>';
}

function bookingSummary_(menu, start, eff, isFirst) {
  return 'メニュー: ' + menu.name + (isFirst && eff.durationMin ? '（初回）' : '') + '\n' +
    '日時: ' + fmt_(start, 'M/d(E) HH:mm') + '〜（' + eff.durationMin + '分）\n' +
    '料金: ¥' + Number(eff.price).toLocaleString('ja-JP');
}

// ============================================================
// イベント・プロパティ / ユーティリティ
// ============================================================

function setEventProps_(ev, obj) {
  Object.keys(obj).forEach(function (k) { ev.setTag(k, String(obj[k])); });
}
function getEventProp_(ev, key) { return ev.getTag(key) || ''; }
function getEventProps_(ev) {
  var keys = ['token', 'status', 'menuId', 'name', 'phone', 'email', 'gender', 'referrer', 'lineUserId', 'isFirstTime', 'price', 'note'];
  var o = {};
  keys.forEach(function (k) { o[k] = ev.getTag(k) || ''; });
  return o;
}

function findEventByToken_(token) {
  if (!token) return null;
  var cal = CalendarApp.getCalendarById(prop_('CALENDAR_ID'));
  if (!cal) return null;
  var from = addDays_(startOfDay_(new Date()), -1);
  var to = addDays_(startOfDay_(new Date()), RULES.maxAdvanceDays + 2);
  var events = cal.getEvents(from, to);
  for (var i = 0; i < events.length; i++) {
    if (events[i].getTag('token') === token) return { event: events[i], props: getEventProps_(events[i]) };
  }
  return null;
}

function durationMin_(ev) {
  return Math.round((ev.getEndTime().getTime() - ev.getStartTime().getTime()) / 60000);
}

function effectiveMenu_(menu, isFirst) {
  if (isFirst && menu.firstTime) return { durationMin: menu.firstTime.durationMin, price: menu.firstTime.price };
  return { durationMin: menu.durationMin, price: menu.price };
}

function readSlotConfig_() {
  try { return JSON.parse(prop_('SLOT_CONFIG') || '{}'); } catch (_) { return {}; }
}

function manageUrl_(token) {
  var base = prop_('FRONT_BASE_URL').replace(/\/$/, '');
  return base + '/reserve/manage/?token=' + token;
}

function withinCancelDeadline_(start) {
  var today = startOfDay_(new Date());
  return start >= addDays_(today, RULES.cancelDeadlineDays);
}

function normalizePhone_(p) { return String(p).replace(/[^0-9]/g, ''); }

/** HTML特殊文字をエスケープ（確認ページに名前等を埋め込む際のXSS対策） */
function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 店通知の承認/辞退リンクの基底URL。
 * ScriptApp.getService().getUrl() は複数デプロイ環境で別デプロイ（HEAD等）のURLを
 * 返すことがあり不安定なため、公開APIの /exec を Script Property に固定しておく。
 * 未設定時のみ getUrl() にフォールバック。
 */
function publicExecUrl_() {
  return prop_('PUBLIC_EXEC_URL') || ScriptApp.getService().getUrl();
}

// HMAC 署名（base64url）
function sign_(data) {
  var raw = Utilities.computeHmacSha256Signature(data, prop_('HMAC_SECRET'));
  return Utilities.base64EncodeWebSafe(raw);
}
function verifySig_(data, sig) { return sig && sign_(data) === sig; }

// 日付ユーティリティ（スクリプトTZ=Asia/Tokyo 前提）
function fmt_(d, pat) { return Utilities.formatDate(d, TZ, pat); }
function parseDate_(s) { var a = s.split('-'); return new Date(Number(a[0]), Number(a[1]) - 1, Number(a[2])); }
function atTime_(d, hhmm) { var a = hhmm.split(':'); var x = new Date(d); x.setHours(Number(a[0]), Number(a[1]), 0, 0); return x; }
function startOfDay_(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays_(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
