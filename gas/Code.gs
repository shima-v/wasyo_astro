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

/**
 * 営業ルール（フロント src/data/config.js の BOOKING_RULES とそろえる）。
 * windows: ネット予約の「開始時刻」を受け付ける曜日別ウィンドウ（30分刻み・両端を含む）。
 *          終了時刻は問わない（開始がウィンドウ内なら、施術終了がウィンドウ外でも可）。
 */
var RULES = {
  slotStepMin: 30,
  leadTimeDays: 1, // 当日不可・翌日以降
  maxAdvanceDays: 60, // 受付上限（約2ヶ月先まで）
  cleanupBufferMin: 0,
  cancelDeadlineDays: 1,
  windows: {
    mtf: [{ start: '10:00', end: '15:00' }, { start: '17:30', end: '19:00' }], // 月・火・金
    wt: [{ start: '10:00', end: '15:00' }],                                     // 水・木
    sat: [{ start: '10:00', end: '19:00' }],                                    // 第2・第4土
  },
  tempOpenWindow: [{ start: '10:00', end: '19:00' }], // 臨時営業日（openDates）の既定枠
};

/** 祝日カレンダー（自動判定）。Script Property `HOLIDAY_CALENDAR_ID` で上書き可。 */
var DEFAULT_HOLIDAY_CALENDAR_ID = 'ja.japanese#holiday@group.v.calendar.google.com';

/**
 * メニュー（src/data/menu.js のミラー）。
 *   durationMin … お客様に見せる施術時間（firstTime は新規(初回)時の上書き）。
 *   slotMin     … カレンダー占有時間（施術＋待機）。空き枠計算とイベント長に使う。新規/常連で不変。
 */
var MENU = {
  'double-momi-part-oil-70': { name: '全身もみほぐし＋部位オイルケア', durationMin: 70, slotMin: 120, price: 4300 },
  'double-momi-full-oil-90': { name: '全身もみほぐし＋全身オイルケア', durationMin: 90, slotMin: 150, price: 5500 },
  'simple-momi-30': { name: '全身もみほぐし 30分', durationMin: 30, slotMin: 60, price: 3300, firstTime: { durationMin: 40, price: 3300 } },
  'simple-momi-50': { name: '全身もみほぐし 50分', durationMin: 50, slotMin: 120, price: 4000, firstTime: { durationMin: 60, price: 4000 } },
  'simple-momi-70': { name: '全身もみほぐし 70分', durationMin: 70, slotMin: 120, price: 4400 },
  'simple-momi-100': { name: '全身もみほぐし 100分', durationMin: 100, slotMin: 150, price: 5500 },
  'simple-oil-80': { name: '全身オイルケア', durationMin: 80, slotMin: 150, price: 6600 },
  'petit-foot-30': { name: 'フットケア', durationMin: 30, slotMin: 60, price: 3300 },
  'petit-hand-30': { name: 'ハンドケア', durationMin: 30, slotMin: 60, price: 3300 },
  'petit-head-30': { name: 'ヘッド&リフトアップ（顎ほぐし）', durationMin: 30, slotMin: 60, price: 3500 },
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
      case 'booking': // 管理ページ（front /reserve/manage）：トークンで予約内容取得
        return json_(getBookingByToken_(e.parameter.token));
      // 承認/辞退・メッセージ送信・管理パネルはすべて front（非 Google ドメイン）へ移行済み。
      //  - 承認/辞退: /reserve/decision + doPost 'decide'（token+sig capability）
      //  - メッセージ: /reserve/message + doPost 'messageInfo'/'messageSend'（'message:' sig）
      //  - 管理: /reserve/admin + doPost 各 admin アクション（bearer ADMIN_TOKENS）
      // これらの GET レンダリングは要 Google ログイン（管理デプロイ②）に依存していたため撤去した。
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
      case 'lineLogin': return json_(lineLogin_(body));
      case 'liffVerify': return json_(liffVerify_(body));
      // 承認/辞退（front /reserve/decision 経由・POST限定）。token+sig の capability で保護するため requireAdmin_ は付けない。
      // GET プリフェッチでの誤確定を防ぐ既存方針に沿い POST 限定。
      case 'decide': return json_(decideBySig(body.token, body.sig, !!body.approve, body.message));
      // 予約客への任意メッセージ送信（front /reserve/message 経由）。'message:' sig capability で保護するため requireAdmin_ 不要。
      // messageInfo=概要プリフェッチ（読み取り専用・連絡先なし） / messageSend=実送信。
      case 'messageInfo': return json_(messageInfoBySig_(body.token, body.sig));
      case 'messageSend': return json_(messageSendBySig_(body.token, body.sig, body.message));
      // 管理（front /reserve/admin 経由）。bearer トークン ADMIN_TOKENS で保護＝Googleログイン不要。
      // これにより管理操作も公開デプロイ①（executeAs=オーナー）で完結し、管理デプロイ②を不要にする布石。
      case 'getSlotConfig': return json_(requireAdminToken_(body, adminGetSlotConfig_));
      case 'setSlotConfig': return json_(requireAdminToken_(body, function () { return adminSetSlotConfig_(body); }));
      case 'listPending': return json_(requireAdminToken_(body, adminListPending_));
      case 'getQuota': return json_(requireAdminToken_(body, adminGetQuota_));
      case 'adminDecision': return json_(requireAdminToken_(body, function () { return adminDecision_(body); }));
      case 'broadcastPreview': return json_(requireAdminToken_(body, function () { return adminBroadcastPreview_(body); }));
      case 'broadcast': return json_(requireAdminToken_(body, function () { return adminBroadcast_(body); }));
      case 'broadcastTest': return json_(requireAdminToken_(body, function () { return adminBroadcastTest_(body); }));
      case 'setTempSchedule': return json_(requireAdminToken_(body, function () { return adminSetTempSchedule_(body); }));
      case 'ownerChannelTest': return json_(requireAdminToken_(body, adminOwnerChannelTest_));
      // デプロイ通知（deploy.yml / gas/deploy.sh から叩く）。DEPLOY_NOTIFY_TOKEN で保護（管理トークンとは別系統）。
      case 'deployNotify': return json_(requireDeployToken_(body, function () { return notifyDeploy_(body); }));
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
  // GAS の HtmlService は iframe 表示のため、HTML内の <meta viewport> は効かない。
  // addMetaTag('viewport', ...) で明示しないとスマホで縮小表示になる（admin は doGet:143 で同様に対応済み）。
  return HtmlService.createHtmlOutput(page)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
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
  var dur = effectiveMenu_(menu, isFirst).durationMin; // 表示用の施術時間
  var slot = slotMin_(menu);                            // カレンダー占有時間

  var today = startOfDay_(new Date());
  var from = p.from ? parseDate_(p.from) : addDays_(today, RULES.leadTimeDays);
  var minFrom = addDays_(today, RULES.leadTimeDays);
  if (from < minFrom) from = minFrom;
  var to = p.to ? parseDate_(p.to) : addDays_(today, RULES.maxAdvanceDays);
  var maxTo = addDays_(today, RULES.maxAdvanceDays);
  if (to > maxTo) to = maxTo;

  var cal = CalendarApp.getCalendarById(prop_('CALENDAR_ID'));
  var config = readSlotConfig_();
  var holidaySet = holidayDateSet_(from, to); // 祝日（自動判定）を一度だけ取得
  var days = [];

  // 既存予約は範囲全体を一度だけ取得し日付ごとにバケツ分け（getEvents 呼び出しを日数分→1回へ削減）
  var busyByDate = {};
  if (cal) {
    cal.getEvents(startOfDay_(from), addDays_(startOfDay_(to), 1)).forEach(function (ev) {
      if (isWasyoMarker_(ev)) return; // 臨時営業/休業マーカーは busy にしない（受付可否の正は SLOT_CONFIG）
      var dk = fmt_(ev.getStartTime(), 'yyyy-MM-dd');
      (busyByDate[dk] || (busyByDate[dk] = [])).push({ start: ev.getStartTime().getTime(), end: ev.getEndTime().getTime() });
    });
  }

  for (var d = new Date(from); d <= to; d = addDays_(d, 1)) {
    var dateStr = fmt_(d, 'yyyy-MM-dd');
    if (!isOpenDay_(d, config, holidaySet)) continue;
    var busy = busyByDate[dateStr] || [];
    var times = [];
    var candidates = candidateStarts_(d, config, holidaySet);
    for (var i = 0; i < candidates.length; i++) {
      var s = candidates[i];
      var slotEnd = new Date(s.getTime() + slot * 60000); // 占有時間で重複判定
      if (isClosedSlot_(dateStr, fmt_(s, 'HH:mm'), config)) continue;
      if (overlapsBusy_(s, slotEnd, busy)) continue;
      times.push(fmt_(s, 'HH:mm'));
    }
    if (times.length) days.push({ date: dateStr, times: times });
  }
  return { ok: true, menuId: p.menuId, durationMin: dur, slotMin: slot, isFirstTime: isFirst, days: days, holidays: holidaySet };
}

/**
 * その日のネット予約「受付ウィンドウ」（開始可能な時間帯）を返す。受付不可なら []。
 *   closedDates → 終日クローズ / openDates → 臨時営業（既定枠）
 *   祝日・日曜・第1/3/5土 → 休 / 月火金・水木・第2/4土 → 曜日別ウィンドウ
 * @param {Object} holidaySet { 'yyyy-MM-dd': '祝日名' } 祝日マップ（値は名称・省略可。真値なら祝日扱い）
 */
function receptionWindows_(d, config, holidaySet) {
  var dateStr = fmt_(d, 'yyyy-MM-dd');
  if (config.closedDates && config.closedDates.indexOf(dateStr) >= 0) return [];
  if (config.openWindows && config.openWindows[dateStr]) return config.openWindows[dateStr]; // 臨時営業（時間帯指定）
  if (config.openDates && config.openDates.indexOf(dateStr) >= 0) return RULES.tempOpenWindow; // 臨時営業
  if (holidaySet && holidaySet[dateStr]) return []; // 祝日休
  var dow = d.getDay(); // 0=日, 6=土
  if (dow === 0) return []; // 日曜休
  if (dow === 6) {
    var nth = Math.ceil(d.getDate() / 7);
    return (nth === 2 || nth === 4) ? RULES.windows.sat : []; // 第2・第4土のみ
  }
  if (dow === 1 || dow === 2 || dow === 5) return RULES.windows.mtf; // 月・火・金
  if (dow === 3 || dow === 4) return RULES.windows.wt;               // 水・木
  return [];
}

/** その日がネット予約を受け付ける日か（受付ウィンドウが1つでもあるか） */
function isOpenDay_(d, config, holidaySet) {
  return receptionWindows_(d, config, holidaySet).length > 0;
}

/**
 * 30分刻みの開始候補。各受付ウィンドウの start〜end（両端を含む）を列挙する。
 * 終了時刻は問わない（施術がウィンドウ外まで延びても、開始がウィンドウ内なら受付可）。
 */
function candidateStarts_(d, config, holidaySet) {
  var wins = receptionWindows_(d, config, holidaySet);
  var out = [];
  var step = RULES.slotStepMin * 60000;
  for (var w = 0; w < wins.length; w++) {
    var s = atTime_(d, wins[w].start), e = atTime_(d, wins[w].end);
    for (var t = new Date(s); t <= e; t = new Date(t.getTime() + step)) out.push(new Date(t));
  }
  return out;
}

/** 開始時刻 hhmm がその日の受付ウィンドウ内の候補に含まれるか（サーバ再検証用） */
function isValidStart_(d, hhmm, config, holidaySet) {
  var starts = candidateStarts_(d, config, holidaySet);
  for (var i = 0; i < starts.length; i++) {
    if (fmt_(starts[i], 'HH:mm') === hhmm) return true;
  }
  return false;
}

/**
 * 範囲内の祝日（自動判定）を { 'yyyy-MM-dd': '祝日名' } で返す。
 * 値は祝日名（カレンダーのイベント名）。受付判定では真値かどうかだけ見るので名称はUI表示用。
 * 祝日カレンダーが購読されていない/例外時は空（=祝日なし扱い）でフォールバックし警告ログを出す。
 */
function holidayDateSet_(from, to) {
  var set = {};
  var id = prop_('HOLIDAY_CALENDAR_ID') || DEFAULT_HOLIDAY_CALENDAR_ID;
  try {
    var hcal = CalendarApp.getCalendarById(id);
    if (!hcal) { console.warn('holiday calendar not found: ' + id + '（GAS実行アカウントで「日本の祝日」を購読してください）'); return set; }
    hcal.getEvents(startOfDay_(from), addDays_(startOfDay_(to), 1)).forEach(function (ev) {
      set[fmt_(ev.getStartTime(), 'yyyy-MM-dd')] = ev.getTitle() || '祝日';
    });
  } catch (err) {
    console.warn('holidayDateSet_ failed: ' + err);
  }
  return set;
}

function overlapsBusy_(s, e, busy) {
  var buf = RULES.cleanupBufferMin * 60000;
  for (var i = 0; i < busy.length; i++) {
    if (s.getTime() < busy[i].end + buf && e.getTime() + buf > busy[i].start) return true;
  }
  return false;
}

/** 臨時営業/休業の目印イベント(wasyoBlockタグ)か。受付可否の正はSLOT_CONFIGのためbusy計算から除外する。 */
function isWasyoMarker_(ev) { return !!ev.getTag('wasyoBlock'); }

/**
 * 指定日の予約占有(busy)区間を返す。臨時営業/休業の目印(wasyoBlock)は除外する。
 * excludeEventId を渡すと当該イベント(日時変更中の自分)も除外する。
 * getAvailability_/createBooking_/changeBooking_ が同じ busy 判定を共有するための集約点。
 * @return {Array<{start:number,end:number}>}
 */
function busySpansForDay_(cal, day, excludeEventId) {
  return cal.getEvents(startOfDay_(day), addDays_(startOfDay_(day), 1)).filter(function (e) {
    if (isWasyoMarker_(e)) return false;
    if (excludeEventId && e.getId() === excludeEventId) return false;
    return true;
  }).map(function (e) { return { start: e.getStartTime().getTime(), end: e.getEndTime().getTime() }; });
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
  var slot = slotMin_(menu);
  var end = new Date(start.getTime() + slot * 60000); // イベント長＝占有時間

  var cal = CalendarApp.getCalendarById(prop_('CALENDAR_ID'));
  if (!cal) return { ok: false, error: 'calendar_not_configured' };

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  var token, ev;
  try {
    // 直前再検証（受付日・開始時刻・休枠・重複）。フロント値は信用しない。
    var config = readSlotConfig_();
    var holidaySet = holidayDateSet_(start, start);
    if (!isOpenDay_(start, config, holidaySet) ||
        !isValidStart_(start, b.time, config, holidaySet) ||
        isClosedSlot_(b.date, b.time, config)) {
      return { ok: false, error: 'slot_closed' };
    }
    var busy = busySpansForDay_(cal, start, null);
    if (overlapsBusy_(start, end, busy)) return { ok: false, error: 'slot_taken' };

    token = Utilities.getUuid();
    ev = cal.createEvent('【仮】' + menu.name + ' / ' + b.name, start, end);
    setEventProps_(ev, {
      token: token, status: STATUS.PENDING, menuId: b.menuId,
      name: b.name, phone: b.phone || '', email: b.email || '',
      gender: b.gender || '', referrer: b.referrer || '',
      lineUserId: b.lineUserId || '', isFirstTime: String(isFirst),
      price: String(eff.price), durationMin: String(eff.durationMin), slotMin: String(slot),
      note: b.note || '',
    });
    try { ev.setColor(CalendarApp.EventColor.ORANGE); } catch (_) {}
    // カレンダー説明欄に管理者向けリンクを入れる（オーナーが予約を開いて操作できる導線）。
    // 説明欄には PII（連絡先）を生書きしない。載せるのは署名付きリンクのみ。
    try { ev.setDescription(adminEventDescription_(token)); } catch (_) {}
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
 * front /reserve/decision の「確定/辞退」ボタンから doPost 'decide' 経由で呼ばれる。
 * 署名検証のうえ確定/辞退を実行する（'decision:' 署名 capability で保護）。
 * ※旧 GET 確認ページ（renderDecisionPage_・?action=approve/decline）は front 化により撤去済み。
 */
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
    // 承認時もお店からお客様へひとこと添えられる（空なら従来どおり固定文のみ）
    var extra = (message && String(message).trim()) ? '\n\n― サロンより ―\n' + String(message).trim() : '';
    notifyCustomerProps_(props, '【ご予約が確定しました】\n' +
      bookingSummary_(menu, ev.getStartTime(), { durationMin: displayDurationMin_(props, ev), price: Number(props.price || 0) }, props.isFirstTime === 'true') +
      '\nご来店をお待ちしております。' + extra +
      '\n\n▼ ご予約の確認・変更・キャンセル\n' + manageUrl_(token));
  } else {
    var msg = (message && String(message).trim()) ? String(message).trim() : DECLINE_DEFAULT_MSG;
    notifyCustomerProps_(props, '【ご予約について】\n' + msg);
    ev.deleteEvent();
  }
  return { ok: true, status: approve ? STATUS.CONFIRMED : 'declined' };
}

// ============================================================
// 予約客への任意メッセージ送信（front /reserve/message・'message:' sig 保護）
// ============================================================
// 旧 GET 入力ページ（renderMessagePage_・?action=message）と requireAdmin_ 版
// sendCustomerMessageBySig は、管理デプロイ②（要 Google ログイン）依存のため撤去済み。
// 現在は front（/reserve/message）→ doPost 'messageInfo'/'messageSend' の2関数で完結する。

/**
 * メッセージ送信ページ（front /reserve/message）の初期読み込み用。**状態変更しない**読み取り専用。
 * 'message:' 署名を検証し、OK なら getBookingByToken_ の概要（連絡先を含まない）をそのまま返す。
 * 連絡先（電話・メール・lineUserId）は getBookingByToken_ が返さないため、PII は露出しない。
 */
function messageInfoBySig_(token, sig) {
  if (!verifySig_('message:' + token, sig)) return { ok: false, error: 'bad_signature' };
  return getBookingByToken_(token);
}

/**
 * メッセージ送信ページ（front /reserve/message）の送信本体。
 * 保護は 'message:' sig capability のみ（front 経由・POST限定）で、公開デプロイ①上で完結する
 * （＝管理デプロイ② 不要。旧 requireAdmin_ 版 sendCustomerMessageBySig は工程⑥で撤去済み）。
 * 挙動: 空 → empty_message / 未存在 → not_found / 連絡先なし → no_channel / それ以外は送信。
 */
function messageSendBySig_(token, sig, message) {
  if (!verifySig_('message:' + token, sig)) return { ok: false, error: 'bad_signature' };
  if (!message || !String(message).trim()) return { ok: false, error: 'empty_message' };
  var found = findEventByToken_(token);
  if (!found) return { ok: false, error: 'not_found' };
  var props = found.props;
  if (!props.lineUserId && !props.email) return { ok: false, error: 'no_channel' };
  // お店からの自由文メッセージ。承認/辞退の定型文とは独立（テンプレなし・毎回自由記述）。
  notifyCustomerProps_(props, '【サロン和笑〜Violane〜より】\n' + String(message).trim(), 'message');
  return { ok: true };
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
  var start = found.event.getStartTime(); // 通知に載せる日時は deleteEvent の前に退避する
  found.event.deleteEvent();
  notifyOwner_('【お客様がキャンセルしました】\n' + props.name + ' 様 / ' + menu.name +
    '\n日時: ' + fmt_(start, 'M/d(E) HH:mm') + '（' + (props.status === STATUS.CONFIRMED ? '確定' : '仮予約') + '）');
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
  var slot = slotMin_(menu);
  var start = atTime_(parseDate_(b.date), b.time);
  var end = new Date(start.getTime() + slot * 60000); // イベント長＝占有時間

  var cal = CalendarApp.getCalendarById(prop_('CALENDAR_ID'));
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    // 受付日・開始時刻・休枠をサーバ側で再検証
    var config = readSlotConfig_();
    var holidaySet = holidayDateSet_(start, start);
    if (!isOpenDay_(start, config, holidaySet) ||
        !isValidStart_(start, b.time, config, holidaySet) ||
        isClosedSlot_(b.date, b.time, config)) {
      return { ok: false, error: 'slot_closed' };
    }
    var busy = busySpansForDay_(cal, start, found.event.getId());
    if (overlapsBusy_(start, end, busy)) return { ok: false, error: 'slot_taken' };
    found.event.setTime(start, end);
    // 変更後は再承認のため仮に戻す（占有変更に備え durationMin/slotMin タグも整える）
    found.event.setTitle('【仮】' + menu.name + ' / ' + props.name);
    setEventProps_(found.event, { status: STATUS.PENDING, durationMin: String(eff.durationMin), slotMin: String(slot) });
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
    durationMin: displayDurationMin_(p, found.event), price: Number(p.price || 0),
    canCancel: withinCancelDeadline_(found.event.getStartTime()),
    note: p.note || '',
  };
}

// ============================================================
// 管理（front /reserve/admin・bearer ADMIN_TOKENS で保護）
// ============================================================

/**
 * bearer トークン認証（Googleログイン非依存）。front /reserve/admin から POST body の
 * adminToken を受け取り、Script Property `ADMIN_TOKENS`（カンマ区切りの強ランダム）に
 * 含まれるかを照合する。複数管理者に個別トークンを配れば個別失効も可能。
 * ①公開デプロイ（executeAs=オーナー・匿名到達可）上でも管理操作を安全側で保護でき、
 * 管理デプロイ②（executeAs=アクセスユーザー・要Googleログイン）を不要にする。
 * ※秘密は Script Properties のみ。リポ/フロントには置かない。
 */
function requireAdminToken_(body, fn) {
  var tokens = (prop_('ADMIN_TOKENS') || '').split(',').map(function (s) { return s.trim(); }).filter(String);
  var given = (body && body.adminToken) || '';
  if (!given || tokens.indexOf(given) < 0) return { ok: false, error: 'forbidden' };
  return fn();
}

// オーナー通知（新規予約・枠警告）の接続テスト。実際の notifyOwner_ 経路で1通送る。
// OWNER_DISCORD_WEBHOOK_URL 設定時は Discord、未設定なら LINE に届く。届いたチャネルを via で返す。
function adminOwnerChannelTest_() {
  var url = prop_('OWNER_DISCORD_WEBHOOK_URL');
  var out = { ok: true, discordConfigured: !!url, discordOk: false, discordCode: 0, discordError: '' };
  if (url) {
    // 実際に Discord へ1回送って結果（HTTPコード・エラー本文）を返す＝失敗の切り分けに使う
    var r = postDiscord_(url, '【接続テスト】オーナー通知（Discord）の接続確認です。届けば設定は正常です。');
    out.discordOk = r.ok;
    out.discordCode = r.code;
    out.discordError = r.ok ? '' : String(r.body || '').slice(0, 300);
  }
  // Discord 未設定/失敗時は実際の到達先である LINE にもテスト送信する
  if (url && out.discordOk) {
    out.via = 'discord';
  } else {
    linePush_(prop_('LINE_OWNER_USER_ID'), withEnvLabel_('【接続テスト】オーナー通知（LINE）です。'), 'owner');
    out.via = 'line';
  }
  return out;
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

/**
 * カレンダーイベントの説明欄に入れる管理者向けリンクを生成する。
 * オーナーはカレンダー（名前/メニューで検索可）で予約を開き、説明欄のリンクから
 * お客様へメッセージを送れる。PII（連絡先）は載せない。載せるのは署名付きリンクのみ。
 * 承認/辞退は管理画面(admin)・LINE通知の導線で行うため、説明欄には置かない。
 *  - メッセージ: front /reserve/message（非 Google ドメイン）基底。'message:' 署名で保護（要Googleログイン不要）。
 *    従来は管理デプロイ②（executeAs=アクセスユーザー・要ログイン）の /exec 基底だったが、
 *    承認/辞退と同じ front 経由モデルへ張替（②依存を外す。②撤去は別工程⑥）。
 */
function adminEventDescription_(token) {
  var base = prop_('FRONT_BASE_URL').replace(/\/$/, '');
  var msgSig = encodeURIComponent(sign_('message:' + token));
  return '【管理者用】\n' +
    '✉️ お客様へメッセージを送る:\n' + base + '/reserve/message/?token=' + token + '&sig=' + msgSig;
}

function notifyOwnerNewBooking_(token, b, menu, start, end, eff, isFirst) {
  var sig = sign_('decision:' + token);
  // 承認/辞退リンクは front の /reserve/decision（非 Google ドメイン）へ。
  // Google 複数アカウント時の /u/N/ リダイレクトエラーを回避する（sig 検証モデルは維持）。
  var base = decisionBaseUrl_();
  var approve = base + '?action=approve&token=' + token + '&sig=' + encodeURIComponent(sig);
  var decline = base + '?action=decline&token=' + token + '&sig=' + encodeURIComponent(sig);
  var label = prop_('ENV_LABEL'); // dev のみ【開発】
  // 顧客PII（電話・メール）は本文に載せない。名前・日時/メニュー・性別・紹介者・要望のみ。
  var detail = (label ? label + '\n' : '') +
    '【新規 仮予約】\n' +
    'お名前: ' + b.name + (isFirst ? '（新規）' : '（常連）') + '\n' +
    bookingSummary_(menu, start, eff, isFirst) + '\n' +
    '性別: ' + (b.gender === 'male' ? '男性' : '女性') + (b.gender === 'male' ? '\n紹介者: ' + b.referrer : '') +
    (b.note ? '\n要望: ' + b.note : '');
  // Discord Webhook が設定されていればそちらへ（顧客PIIを LINE の履歴に残さない移行）。
  // 承認/辞退はプレーンテキストのURLで併記する（Discord はテンプレートボタン不可）。
  if (prop_('OWNER_DISCORD_WEBHOOK_URL')) {
    // Discord 送信が成功したら終了。失敗（非2xx/例外で false）なら下の LINE 経路へフォールバックし、
    // オーナー通知を取りこぼさない（通知が静かに消えないようにする恒久ハードニング）。
    if (notifyOwnerDiscord_(detail + '\n\n✅ 承認: ' + approve + '\n❌ 辞退: ' + decline)) return;
    detail = ownerLineFallbackNote_() + '\n' + detail; // Discord失敗→LINE。二重通知の可能性を明記
  }
  // LINE 経路（Discord 未設定 or 送信失敗時のフォールバック）。詳細はテキスト、承認/辞退は confirm テンプレのボタンで送る（長いURLを直接見せない）
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
  ], 'owner');
}

function notifyOwner_(text) {
  // LINE Messaging API は dev/prod 共有のため、dev は ENV_LABEL(例:【開発】)を先頭に付けて区別する
  var label = prop_('ENV_LABEL');
  var body = (label ? label + '\n' : '') + text;
  // Discord 優先。送信成功なら終了、失敗（false）なら LINE へフォールバック。未設定時も LINE。
  if (prop_('OWNER_DISCORD_WEBHOOK_URL')) {
    if (notifyOwnerDiscord_(body)) return;
    body = ownerLineFallbackNote_() + '\n' + body; // Discord失敗→LINE。二重通知の可能性を明記
  }
  linePush_(prop_('LINE_OWNER_USER_ID'), body, 'owner');
}

/**
 * Discord Webhook へ1回 POST し、詳細（成否・HTTPコード・本文・一時的失敗か）を返す。
 * Discord は受理で 200/204。429（レート制限）と 5xx は一時的失敗＝retryable。
 */
function postDiscord_(url, text) {
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ content: text }),
      muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    var ok = code === 200 || code === 204;
    var retryable = code === 429 || (code >= 500 && code < 600);
    var body = ok ? '' : res.getContentText();
    if (!ok) console.error('postDiscord_ http ' + code + ': ' + body);
    return { ok: ok, code: code, retryable: retryable, body: body };
  } catch (err) {
    console.error('postDiscord_ failed: ' + err);
    return { ok: false, code: 0, retryable: true, body: String(err) };
  }
}

/**
 * オーナー通知を Discord Webhook へ送る（即時リトライ付き）。
 * OWNER_DISCORD_WEBHOOK_URL 未設定なら false（呼び出し側で LINE にフォールバック）。
 * 即時リトライで送れず、かつ一時的失敗（429/5xx/例外）なら再送キューへ積み、
 * 時間トリガ（retryOwnerDiscordQueue_）が数十分かけて追送する。成否を返す。
 */
function notifyOwnerDiscord_(text) {
  var url = prop_('OWNER_DISCORD_WEBHOOK_URL');
  if (!url) return false;
  var r;
  for (var i = 0; i < 3; i++) {
    r = postDiscord_(url, text);
    if (r.ok) return true;
    if (!r.retryable) break;        // 4xx(429以外)は再試行しても無駄（URL不正など）
    Utilities.sleep(600 * (i + 1)); // 短いバックオフ
  }
  if (r && r.retryable) enqueueOwnerDiscord_(text); // 一時的失敗のみ後追いキューへ
  return false;
}

/** Discord 再送キューに1件積み、時間トリガを確保する（暴走防止に上限50件）。 */
function enqueueOwnerDiscord_(text) {
  var props = PropertiesService.getScriptProperties();
  var q = [];
  try { q = JSON.parse(props.getProperty('OWNER_DISCORD_RETRY_QUEUE') || '[]'); } catch (_) {}
  q.push({ text: text, ts: Date.now(), tries: 0 });
  if (q.length > 50) q = q.slice(q.length - 50);
  props.setProperty('OWNER_DISCORD_RETRY_QUEUE', JSON.stringify(q));
  try { ensureDiscordRetryTrigger_(); } catch (err) { console.error('ensureDiscordRetryTrigger_ failed: ' + err); }
}

/** retryOwnerDiscordQueue_ の時間トリガ（10分毎）が無ければ作る。 */
function ensureDiscordRetryTrigger_() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'retryOwnerDiscordQueue_';
  });
  if (!exists) ScriptApp.newTrigger('retryOwnerDiscordQueue_').timeBased().everyMinutes(10).create();
}

/** retryOwnerDiscordQueue_ の時間トリガを全て削除する（キューが空になったら呼ぶ）。 */
function removeDiscordRetryTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'retryOwnerDiscordQueue_') ScriptApp.deleteTrigger(t);
  });
}

/**
 * 時間トリガの実体（10分毎）。Discord 未達分をまとめて追送する。
 * 送信成功・期限切れ（3時間）・試行上限（30回）でキューから除去。空になればトリガを撤去。
 */
function retryOwnerDiscordQueue_() {
  var props = PropertiesService.getScriptProperties();
  var url = prop_('OWNER_DISCORD_WEBHOOK_URL');
  var q;
  try { q = JSON.parse(props.getProperty('OWNER_DISCORD_RETRY_QUEUE') || '[]'); } catch (_) { q = []; }
  if (!url || !q.length) { removeDiscordRetryTrigger_(); return; }
  var MAX_AGE = 3 * 60 * 60 * 1000; // 3時間で諦める
  var remain = [];
  q.forEach(function (item) {
    if (Date.now() - (item.ts || 0) > MAX_AGE) return;      // 期限切れは破棄
    var r = postDiscord_(url, item.text);
    if (r.ok) return;                                        // 成功→除去
    item.tries = (item.tries || 0) + 1;
    if (r.retryable && item.tries < 30) remain.push(item);   // 一時的失敗のみ残す
  });
  props.setProperty('OWNER_DISCORD_RETRY_QUEUE', JSON.stringify(remain));
  if (!remain.length) removeDiscordRetryTrigger_();
}

/** Discord 失敗で LINE へフォールバックした通知の先頭に付ける注記（二重通知の可能性を明示）。 */
function ownerLineFallbackNote_() {
  return '⚠️Discord通知に失敗したためLINEで送信しています（復旧後にDiscordにも届く場合があります）';
}

// ==== デプロイ通知（deploy.yml / gas/deploy.sh から叩く・DEPLOY_NOTIFY_TOKEN で保護）====

/**
 * デプロイ通知エンドポイントの認可。requireAdminToken_ と同じ書き味。
 * Script Property `DEPLOY_NOTIFY_TOKEN` と body.deployToken を照合。
 * 未設定 or 不一致なら forbidden、一致で fn() を実行する。
 */
function requireDeployToken_(body, fn) {
  var expected = prop_('DEPLOY_NOTIFY_TOKEN');
  var given = (body && body.deployToken) || '';
  if (!expected || given !== expected) return { ok: false, error: 'forbidden' };
  return fn();
}

/** env（技術名）を店主向けの平易な日本語ラベルに変換する。未知の env はそのまま返す。 */
function deployEnvLabel_(env) {
  var map = {
    'front-prod': '予約サイト（本番・wwwasyo.com）',
    'gas-prod': '予約システム（本番）',
    'gas-dev': '予約システム（テスト環境）',
  };
  return map[env] || env || '';
}

/**
 * commit 件名を店主向けの平易な要約に変換する。
 * 先頭の短縮/フルSHA（`^[0-9a-f]{7,40}\s+`）と Conventional Commits の
 * type接頭辞（`^feat: ` `^fix(scope)!: ` 等・大文字小文字無視）を除去した要約部のみを返す。
 */
function plainCommitSummary_(subject) {
  var s = String(subject || '');
  s = s.replace(/^[0-9a-f]{7,40}\s+/i, '');       // 先頭SHA
  s = s.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, ''); // type(scope)!: 接頭辞
  return s.trim();
}

/**
 * デプロイ通知本文を組み立てて送る。payload = { env, status, commits, detail }。
 * commits は改行区切り文字列でも配列でも受けて正規化する。
 * 本文は【概要】（店主向け・平易日本語）＋【詳細（開発者向け）】（技術情報そのまま）の2部構成。
 * 送信は Discord（DEPLOY_DISCORD_WEBHOOK_URL・最大3回リトライ・後追いキューなし）を優先し、
 * 全滅 or 未設定なら sendMail_ でメール（DEPLOY_MAIL_TO・既定は GAS 所有者）へフォールバックする。
 * return { ok:true, discordSent:<bool> }。
 */
function notifyDeploy_(payload) {
  payload = payload || {};
  var env = payload.env || '';
  var status = (payload.status === 'success') ? 'success' : 'failure';
  var success = status === 'success';
  var label = deployEnvLabel_(env);

  // commits を「短縮SHA 件名フル」の配列に正規化（文字列は改行区切りで分割）
  var commits = payload.commits;
  if (typeof commits === 'string') commits = commits.split('\n');
  if (!Array.isArray(commits)) commits = [];
  commits = commits.map(function (c) { return String(c).trim(); }).filter(String);

  var detail = String(payload.detail || '').trim();
  var now = fmt_(new Date(), 'yyyy-MM-dd HH:mm');

  // ---- 【概要】（店主向け・平易日本語）----
  var summary;
  if (success) {
    summary = '✅ ' + label + 'を更新しました\n' +
      '更新は正常に反映されています。予約の受付・通知はこれまでどおりご利用いただけます。';
    if (commits.length) {
      summary += '\n\n【今回の変更点】';
      commits.forEach(function (c) {
        var plain = plainCommitSummary_(c);
        if (plain) summary += '\n・' + plain;
      });
    }
  } else {
    summary = '❌ ' + label + 'の更新に失敗しました\n' +
      '直前の状態のまま動いているので、予約の受付・通知は止まっていません。\n' +
      'お手数ですが開発担当にご確認ください。';
  }

  // ---- 【詳細（開発者向け）】（技術情報そのまま）----
  var detailLines = [
    'env: ' + env,
    'status: ' + status,
  ];
  if (commits.length) {
    detailLines.push('変更コミット:');
    commits.forEach(function (c) { detailLines.push('・' + c); });
  }
  if (detail) detailLines.push(detail);
  detailLines.push('時刻: ' + now + ' JST');
  var detailBlock = detailLines.join('\n');

  var text = '【概要】\n' + summary +
    '\n\n――――――――――\n' +
    '【詳細（開発者向け）】\n' + detailBlock;

  // Discord を最大3回リトライ（notifyOwnerDiscord_ のループを踏襲・後追いキューは付けない＝即時のみ）
  var url = prop_('DEPLOY_DISCORD_WEBHOOK_URL');
  var discordSent = false;
  if (url) {
    for (var i = 0; i < 3; i++) {
      var r = postDiscord_(url, text);
      if (r.ok) { discordSent = true; break; }
      if (!r.retryable) break;         // 4xx(429以外)は再試行しても無駄（URL不正など）
      Utilities.sleep(600 * (i + 1));  // 短いバックオフ
    }
  }

  // Discord 全滅（or 未設定）ならメールへフォールバック
  if (!discordSent) {
    var to = prop_('DEPLOY_MAIL_TO') || Session.getEffectiveUser().getEmail();
    var subject = '【デプロイ通知】' + label + (success ? ' 完了' : ' 失敗');
    sendMail_(to, subject, text);
  }

  return { ok: true, discordSent: discordSent };
}

function notifyCustomer_(b, text) {
  // LINE は dev/prod 共有のため dev は ENV_LABEL を先頭に付ける。
  // メールは sendMail_ 内で付与されるため、ここでは LINE 分岐のみ付ける（二重付与回避）。
  if (b.lineUserId) linePush_(b.lineUserId, withEnvLabel_(text), 'customer');
  else if (b.email) sendMail_(b.email, 'サロン和笑〜Violane〜 ご予約', text);
}

function notifyCustomerProps_(props, text, kind) {
  // LINE は dev/prod 共有のため dev は ENV_LABEL を先頭に付ける。
  // メールは sendMail_ 内で付与されるため、ここでは LINE 分岐のみ付ける（二重付与回避）。
  if (props.lineUserId) linePush_(props.lineUserId, withEnvLabel_(text), kind || 'customer');
  else if (props.email) sendMail_(props.email, 'サロン和笑〜Violane〜 ご予約', text);
}

/** dev のとき本文の先頭に ENV_LABEL（例:【開発】）を付ける。prod はキー未登録＝無印のまま。 */
function withEnvLabel_(text) {
  var label = prop_('ENV_LABEL');
  return (label ? label + '\n' : '') + text;
}

function linePush_(to, text, kind) {
  linePushMessages_(to, [{ type: 'text', text: text }], kind);
}

/**
 * 任意のメッセージ配列（テキスト/テンプレート等）を push する。
 * kind は送信ログの種別（owner/customer/reminder/followup/share 等）。
 */
function linePushMessages_(to, messages, kind) {
  var token = prop_('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token || !to) return;
  var ok = false;
  try {
    var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ to: to, messages: messages }),
      muteHttpExceptions: true,
    });
    ok = res.getResponseCode() === 200;
    if (!ok) console.error('linePushMessages_ http ' + res.getResponseCode() + ': ' + res.getContentText());
  } catch (err) { console.error('linePushMessages_ failed: ' + err); }
  logPush_(kind || 'other', to, ok);
}

/**
 * push 送信履歴を台帳スプレッドシートの「送信ログ」シートへ記録する（無料枠の消費追跡用）。
 * 宛先(userId/グループID)は生で残さず末尾4桁のみのマスク表示にする（PIIを溜めない）。
 */
function logPush_(kind, to, ok) {
  try {
    var id = prop_('LEDGER_SHEET_ID');
    if (!id) return;
    var ss = SpreadsheetApp.openById(id);
    var sh = ss.getSheetByName('送信ログ');
    if (!sh) {
      sh = ss.insertSheet('送信ログ');
      sh.appendRow(['日時', '種別', '宛先(マスク)', '成否']);
    }
    sh.appendRow([fmt_(new Date(), 'yyyy-MM-dd HH:mm:ss'), kind, maskId_(to), ok ? 'ok' : 'ng']);
  } catch (err) { console.error('logPush_ failed: ' + err); }
}

function maskId_(s) {
  s = String(s || '');
  return s.length <= 4 ? '****' : '****' + s.slice(-4);
}

/**
 * LINE Login（Web OAuth）の認可コードを userId・表示名に交換する。
 * フロントが authorize で得た code を渡してくる（POST {action:'lineLogin', code, redirectUri}）。
 *  1) code → token 交換（要 channel id/secret。秘密情報は Script Properties から取得しコードに保持しない）
 *  2) 返ってきた id_token を verify エンドポイントで検証 → sub(=userId)・name(=表示名) を取り出す
 * 取得できるのは userId・表示名のみ（電話番号・性別は LINE Login では取得不可）。
 * 成功: { ok:true, lineUserId, displayName } / 失敗: { ok:false, error:'line_login_failed' }
 */
function lineLogin_(b) {
  var channelId = prop_('LINE_LOGIN_CHANNEL_ID');
  var channelSecret = prop_('LINE_LOGIN_CHANNEL_SECRET');
  var code = (b && b.code) || '';
  var redirectUri = (b && b.redirectUri) || '';
  if (!channelId || !channelSecret) { console.error('lineLogin_: channel id/secret 未設定'); return { ok: false, error: 'line_login_failed' }; }
  if (!code || !redirectUri) return { ok: false, error: 'line_login_failed' };
  try {
    // 1) 認可コード → トークン交換
    var tokenRes = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      payload: {
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri,
        client_id: channelId,
        client_secret: channelSecret,
      },
      muteHttpExceptions: true,
    });
    var tokenCode = tokenRes.getResponseCode();
    var tokenJson = JSON.parse(tokenRes.getContentText() || '{}');
    if (tokenCode !== 200 || !tokenJson.id_token) {
      console.error('lineLogin_ token exchange failed: ' + tokenCode + ' ' + tokenRes.getContentText());
      return { ok: false, error: 'line_login_failed' };
    }
    // 2) id_token 検証（共通ヘルパに集約）→ sub(userId)・name(表示名)
    var verified = verifyLineIdToken_(tokenJson.id_token);
    if (!verified) return { ok: false, error: 'line_login_failed' };
    return { ok: true, lineUserId: verified.userId, displayName: verified.displayName };
  } catch (err) {
    console.error('lineLogin_ failed: ' + err);
    return { ok: false, error: 'line_login_failed' };
  }
}

/**
 * LINE の id_token を verify エンドポイントで検証し claims を取り出す共通処理。
 * LINE Login（code交換後の id_token）と LIFF（liff.getIDToken()）の双方から使う。
 * aud 検証のため client_id に LINE Login チャネルID（= LIFFアプリの所属チャネル）を渡す。
 * 成功: { userId, displayName, email } / 失敗: null
 */
function verifyLineIdToken_(idToken) {
  var channelId = prop_('LINE_LOGIN_CHANNEL_ID');
  if (!channelId || !idToken) return null;
  try {
    var res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      payload: { id_token: idToken, client_id: channelId },
      muteHttpExceptions: true,
    });
    var claims = JSON.parse(res.getContentText() || '{}');
    if (res.getResponseCode() !== 200 || !claims.sub) {
      console.error('verifyLineIdToken_ failed: ' + res.getResponseCode() + ' ' + res.getContentText());
      return null;
    }
    return { userId: claims.sub, displayName: claims.name || '', email: claims.email || '' };
  } catch (err) {
    console.error('verifyLineIdToken_ error: ' + err);
    return null;
  }
}

/**
 * LIFF 経由の認証。フロントが liff.getIDToken() で得た id_token を渡してくる
 * （POST {action:'liffVerify', idToken}）。サーバ側で検証して userId を確定する。
 * クライアントの getProfile().userId は詐称可能なため信用せず、必ず検証済みの sub を使う。
 * email は LINE Login チャネルで email スコープが許可されているときのみ返る。
 * 成功: { ok:true, lineUserId, displayName, email } / 失敗: { ok:false, error:'liff_verify_failed' }
 */
function liffVerify_(b) {
  var verified = verifyLineIdToken_((b && b.idToken) || '');
  if (!verified) return { ok: false, error: 'liff_verify_failed' };
  return { ok: true, lineUserId: verified.userId, displayName: verified.displayName, email: verified.email };
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
// 定期実行（時間トリガー）：前日リマインド / 来店後フォロー / 無料枠監視
//   GAS の「トリガー」で日次（毎朝）実行を登録する。手順は docs/SETUP.md 参照。
//   ※リマインド/フォローは push 枠を消費するため checkQuota の監視対象。
//   トリガーから選べるよう、エントリポイントは末尾 _ を付けない公開関数にする
//   （末尾 _ の関数はトリガーUIの一覧に出ない）。
// ============================================================

/**
 * 前日リマインド。翌日に予定されている【確定】予約のお客様へ LINE/メールで通知する。
 * 二重送信防止に送信済みイベントへ reminded=true タグを付ける（再実行しても多重送信しない）。
 */
function sendReminders() {
  var cal = CalendarApp.getCalendarById(prop_('CALENDAR_ID'));
  if (!cal) return;
  var from = startOfDay_(addDays_(new Date(), 1)); // 翌日 0:00
  var to = addDays_(from, 1);                       // 翌々日 0:00
  cal.getEvents(from, to).forEach(function (ev) {
    if (getEventProp_(ev, 'status') !== STATUS.CONFIRMED) return;
    if (getEventProp_(ev, 'reminded') === 'true') return;
    var props = getEventProps_(ev);
    var menu = MENU[props.menuId] || { name: props.menuId };
    var eff = { durationMin: displayDurationMin_(props, ev), price: Number(props.price || 0) };
    notifyCustomerProps_(props,
      '【ご予約前日のお知らせ】\n明日のご予約です。お気をつけてお越しください。\n' +
      bookingSummary_(menu, ev.getStartTime(), eff, props.isFirstTime === 'true') +
      '\n\n▼ ご予約の確認・変更・キャンセル\n' + manageUrl_(props.token),
      'reminder');
    ev.setTag('reminded', 'true');
  });
}

/**
 * 来店後フォロー。前日に終了した【確定】予約のお客様へお礼/再来店メッセージを送る。
 * 二重送信防止に followedUp=true タグを付ける。
 */
function sendFollowUps() {
  var cal = CalendarApp.getCalendarById(prop_('CALENDAR_ID'));
  if (!cal) return;
  var from = startOfDay_(addDays_(new Date(), -1)); // 前日 0:00
  var to = startOfDay_(new Date());                  // 当日 0:00
  cal.getEvents(from, to).forEach(function (ev) {
    if (getEventProp_(ev, 'status') !== STATUS.CONFIRMED) return;
    if (getEventProp_(ev, 'followedUp') === 'true') return;
    var props = getEventProps_(ev);
    notifyCustomerProps_(props,
      '【ご来店ありがとうございました】\n先日はサロン和笑〜Violane〜をご利用いただき、ありがとうございました。\n' +
      'お身体の調子はいかがでしょうか。またのご来店を心よりお待ちしております。',
      'followup');
    ev.setTag('followedUp', 'true');
  });
}

/**
 * オーナー向け日次ダイジェスト。当日の【確定】予約一覧と、未確定の【仮予約】一覧をまとめて通知する。
 * notifyOwner_ 経由のため Discord 優先（失敗時 LINE ＋ 未達はリトライキューで追送）。
 * PII 方針: 名前・日時・メニューのみ（電話/メールは載せない＝既存オーナー通知と同一）。
 * トリガー: GAS UI で日次（毎朝）実行を登録する（手順は docs/SETUP.md）。
 */
function sendOwnerDailyDigest() {
  var cal = CalendarApp.getCalendarById(prop_('CALENDAR_ID'));
  if (!cal) return;
  var dayStart = startOfDay_(new Date());
  var dayEnd = addDays_(dayStart, 1);
  // 当日の確定予約（時刻順）
  var today = cal.getEvents(dayStart, dayEnd).filter(function (ev) {
    return getEventProp_(ev, 'status') === STATUS.CONFIRMED;
  }).sort(function (a, b) { return a.getStartTime() - b.getStartTime(); }).map(function (ev) {
    var p = getEventProps_(ev);
    var menu = MENU[p.menuId] || { name: p.menuId };
    return '・' + fmt_(ev.getStartTime(), 'HH:mm') + ' ' + p.name + ' 様 / ' + menu.name;
  });
  // 未確定の仮予約（承認待ち一覧を再利用。now〜maxAdvanceDays の pending）
  var pending = adminListPending_().pending.map(function (p) {
    return '・' + fmt_(parseDate_(p.date), 'M/d(E)') + ' ' + p.time + ' ' + p.name + ' 様 / ' + p.menuName;
  });
  var lines = ['【本日のご予約と未確定の仮予約】 ' + fmt_(dayStart, 'M/d(E)'), ''];
  lines.push('■ 本日のご予約（確定 ' + today.length + '件）');
  lines.push(today.length ? today.join('\n') : '・本日のご予約はありません');
  lines.push('');
  lines.push('■ 未確定の仮予約（' + pending.length + '件）');
  lines.push(pending.length ? pending.join('\n') : '・未確定の仮予約はありません');
  // 未確定があるときだけ、承認/辞退に進める予約管理画面へ誘導する
  if (pending.length) lines.push('\n▼ 承認/辞退はこちら（予約管理画面）\n' + adminUrl_());
  notifyOwner_(lines.join('\n'));
}

// ---- 無料枠（Messaging API push）の監視 ----

/** 当月の push 送信数（無料枠カウント対象）を取得。失敗時は null。 */
function getQuotaConsumption_() {
  var token = prop_('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) return null;
  try {
    var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/quota/consumption', {
      method: 'get',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      console.error('quota/consumption http ' + res.getResponseCode() + ': ' + res.getContentText());
      return null;
    }
    return Number(JSON.parse(res.getContentText() || '{}').totalUsage || 0);
  } catch (err) { console.error('getQuotaConsumption_ failed: ' + err); return null; }
}

/**
 * 無料枠の上限。Script Property MONTHLY_FREE_QUOTA（既定200）。
 * free プランは message/quota API が上限を返さないことがあるため固定値で持つ。
 */
function monthlyFreeQuota_() {
  return Number(prop_('MONTHLY_FREE_QUOTA')) || 200;
}

/** 管理画面用：当月送信数と上限・残量を返す（used が null は取得失敗）。 */
function adminGetQuota_() {
  var used = getQuotaConsumption_();
  var limit = monthlyFreeQuota_();
  return { ok: true, used: used, limit: limit, available: used == null ? null : Math.max(0, limit - used) };
}

// ============================================================
// 臨時のお知らせを常連さんへ一斉送信
//   台帳から対象（LINE/メール）を集計し、LINE は multicast・メールは個別送信する。
//   LINE は無料枠を消費するため、送信前に残枠を確認できる（プレビュー）。
// ============================================================

/**
 * 一斉送信の対象を台帳から集計する。
 * scope='all' は全予約客（来店1回以上）、それ以外は常連（既定 REGULAR_MIN_VISITS=2 回以上）。
 * type=phone は連絡手段を持たない（LINE/メール不可）ため unreachable にカウントする。
 *  返り値: { lineUserIds:[], emails:[], unreachable:Number, total:Number }
 */
function broadcastRecipients_(scope) {
  var sh = ledgerSheet_();
  if (!sh) return { lineUserIds: [], emails: [], unreachable: 0, total: 0 };
  var threshold = (scope === 'all') ? 1 : (Number(prop_('REGULAR_MIN_VISITS')) || 2);
  var values = sh.getDataRange().getValues();
  var lineUserIds = [];
  var emails = [];
  var unreachable = 0;
  for (var r = 1; r < values.length; r++) { // 0行目はヘッダ
    var row = values[r];
    if (Number(row[4]) < threshold) continue; // 5列目=来店回数
    var type = row[1];
    if (type === 'line') lineUserIds.push(String(row[0]).replace(/^line:/, ''));
    else if (type === 'email') emails.push(String(row[0]).replace(/^email:/, ''));
    else if (type === 'phone') unreachable++;
  }
  return {
    lineUserIds: lineUserIds, emails: emails, unreachable: unreachable,
    total: lineUserIds.length + emails.length + unreachable,
  };
}

/**
 * LINE の multicast で複数ユーザーへ同報する。
 * multicast は1リクエスト最大500件のため 500 件ずつに分割して送る。
 * kind は送信ログの種別。成功送信できた人数の合計を返す（userIds 空なら 0）。
 */
function lineMulticast_(userIds, messages, kind) {
  var token = prop_('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token || !userIds || !userIds.length) return 0;
  var sent = 0;
  for (var i = 0; i < userIds.length; i += 500) {
    var chunk = userIds.slice(i, i + 500);
    var ok = false;
    try {
      var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/multicast', {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + token },
        payload: JSON.stringify({ to: chunk, messages: messages }),
        muteHttpExceptions: true,
      });
      ok = res.getResponseCode() === 200;
      if (!ok) console.error('lineMulticast_ http ' + res.getResponseCode() + ': ' + res.getContentText());
    } catch (err) { console.error('lineMulticast_ failed: ' + err); }
    if (ok) sent += chunk.length;
    logPush_(kind || 'broadcast', 'multicast:' + chunk.length, ok);
  }
  return sent;
}

/**
 * 管理画面用：一斉送信のプレビュー（対象人数と残枠）。送信はしない。
 * willExceed は LINE 対象人数が残枠を超えるか（available 取得失敗時は判定しない）。
 */
function adminBroadcastPreview_(b) {
  var scope = b.scope || 'regulars';
  var rec = broadcastRecipients_(scope);
  var q = adminGetQuota_();
  return {
    ok: true, scope: scope,
    lineCount: rec.lineUserIds.length, mailCount: rec.emails.length, unreachable: rec.unreachable,
    used: q.used, limit: q.limit, available: q.available,
    willExceed: q.available != null && rec.lineUserIds.length > q.available,
  };
}

/**
 * 管理画面用：一斉送信を実行する。LINE は multicast、メールは個別送信。
 * 残枠（available）を LINE 対象人数が超える場合は送信せず quota_exceeded を返す。
 */
function adminBroadcast_(b) {
  var message = (b && b.message) || '';
  if (!message.trim()) return { ok: false, error: 'empty_message' };
  var scope = b.scope || 'regulars';
  var rec = broadcastRecipients_(scope);
  var q = adminGetQuota_();
  if (q.available != null && rec.lineUserIds.length > q.available) {
    return { ok: false, error: 'quota_exceeded', need: rec.lineUserIds.length, available: q.available };
  }
  // LINE：無料枠を消費するため multicast でまとめ送り（dev は ENV_LABEL 付与）
  var sentLine = lineMulticast_(rec.lineUserIds, [{ type: 'text', text: withEnvLabel_(message.trim()) }], 'broadcast');
  // メール：無料枠外。各宛先へ個別送信（sendMail_ 内で ENV_LABEL 付与）
  var sentMail = 0;
  rec.emails.forEach(function (email) {
    sendMail_(email, 'サロン和笑〜Violane〜 からのお知らせ', message.trim());
    sentMail++;
  });
  return { ok: true, sentLine: sentLine, sentMail: sentMail, unreachable: rec.unreachable };
}

/**
 * 管理画面用：一斉送信の試し送り。オーナー本人にだけ LINE で送る（本番送信の前確認）。
 */
function adminBroadcastTest_(b) {
  var message = (b && b.message) || '';
  if (!message.trim()) return { ok: false, error: 'empty_message' };
  var owner = prop_('LINE_OWNER_USER_ID');
  if (!owner) return { ok: false, error: 'no_owner' };
  linePush_(owner, withEnvLabel_('【一斉送信テスト】\n' + message.trim()), 'broadcast_test');
  return { ok: true };
}

/**
 * 管理画面用：臨時営業・臨時休業を登録する。
 *   ① 営業設定（SLOT_CONFIG）へ反映＝ネット予約の受付可否に効く
 *   ② Google カレンダー（予約カレンダー）へ目印イベントを作成（wasyoBlock タグ付き＝空き枠計算の busy からは除外）
 * b = { kind:'closed'|'open', date:'yyyy-MM-dd', allDay:Boolean, start?:'HH:MM', end?:'HH:MM' }
 *   kind='closed' 終日 → closedDates に追加 ／ 時間帯 → closedSlots[date] に 30分刻みで追加
 *   kind='open'   終日 → openDates に追加   ／ 時間帯 → openWindows[date] に受付ウィンドウを設定
 */
function adminSetTempSchedule_(b) {
  b = b || {};
  // ---- バリデーション ----
  if (b.kind !== 'closed' && b.kind !== 'open') return { ok: false, error: 'invalid_input' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ''))) return { ok: false, error: 'invalid_input' };
  var allDay = !!b.allDay;
  if (!allDay) {
    if (!/^\d{2}:\d{2}$/.test(String(b.start || '')) || !/^\d{2}:\d{2}$/.test(String(b.end || ''))) return { ok: false, error: 'invalid_input' };
    if (b.start >= b.end) return { ok: false, error: 'invalid_input' }; // 'HH:MM' は辞書順＝時刻順で比較可
  }

  // start,end('HH:MM') を [start,end) で slotStepMin 刻みの 'HH:MM' 配列に展開する
  function expandSlots_(start, end) {
    var d = parseDate_(b.date);
    var s = atTime_(d, start), e = atTime_(d, end);
    var step = RULES.slotStepMin * 60000;
    var out = [];
    for (var t = new Date(s); t.getTime() < e.getTime(); t = new Date(t.getTime() + step)) out.push(fmt_(t, 'HH:mm'));
    return out;
  }
  // 配列に値を（重複なく）追加する
  function union_(arr, v) { if (arr.indexOf(v) < 0) arr.push(v); }

  var config = readSlotConfig_();

  if (b.kind === 'closed') {
    if (allDay) {
      config.closedDates = config.closedDates || [];
      union_(config.closedDates, b.date);
    } else {
      config.closedSlots = config.closedSlots || {};
      var list = config.closedSlots[b.date] || (config.closedSlots[b.date] = []);
      expandSlots_(b.start, b.end).forEach(function (hhmm) { union_(list, hhmm); });
    }
  } else { // open
    if (allDay) {
      config.openDates = config.openDates || [];
      union_(config.openDates, b.date);
    } else {
      config.openWindows = config.openWindows || {};
      config.openWindows[b.date] = [{ start: b.start, end: b.end }];
    }
  }

  PropertiesService.getScriptProperties().setProperty('SLOT_CONFIG', JSON.stringify(config));

  // ---- Google カレンダーへ目印イベントを作成（失敗しても登録自体は成功扱い） ----
  try {
    var cal = CalendarApp.getCalendarById(prop_('CALENDAR_ID'));
    if (cal) {
      var label = prop_('ENV_LABEL'); // dev のみ【開発】
      var title = b.kind === 'closed' ? '【臨時休業】' : '【臨時営業】';
      var ev;
      if (allDay) {
        ev = cal.createAllDayEvent((label ? label : '') + title, parseDate_(b.date));
      } else {
        var s = atTime_(parseDate_(b.date), b.start), e = atTime_(parseDate_(b.date), b.end);
        ev = cal.createEvent((label ? label : '') + title + ' ' + b.start + '-' + b.end, s, e);
      }
      ev.setTag('wasyoBlock', '1'); // 空き枠計算の busy から除外する目印
    }
  } catch (err) {
    console.error('adminSetTempSchedule_ calendar failed: ' + err);
  }

  return { ok: true, kind: b.kind, date: b.date, allDay: allDay, start: b.start || '', end: b.end || '' };
}

/**
 * 無料枠監視（日次トリガー）。当月送信数が上限の80%以上ならオーナーへ警告する。
 * 月内の多重警告を避けるため、警告済みの月(yyyy-MM)を QUOTA_WARNED_YYYYMM に記録する。
 */
function checkQuota() {
  var used = getQuotaConsumption_();
  if (used == null) return;
  var limit = monthlyFreeQuota_();
  if (used < limit * 0.8) return;
  var ym = fmt_(new Date(), 'yyyy-MM');
  if (prop_('QUOTA_WARNED_YYYYMM') === ym) return; // 今月は警告済み
  notifyOwner_('【LINE無料枠の警告】\n今月の送信数が ' + used + '/' + limit + ' 通に達しました（80%超）。\n上限を超えると追加メッセージは送信されません。');
  PropertiesService.getScriptProperties().setProperty('QUOTA_WARNED_YYYYMM', ym);
}

// ============================================================
// イベント・プロパティ / ユーティリティ
// ============================================================

function setEventProps_(ev, obj) {
  Object.keys(obj).forEach(function (k) { ev.setTag(k, String(obj[k])); });
}
function getEventProp_(ev, key) { return ev.getTag(key) || ''; }
function getEventProps_(ev) {
  var keys = ['token', 'status', 'menuId', 'name', 'phone', 'email', 'gender', 'referrer', 'lineUserId', 'isFirstTime', 'price', 'durationMin', 'slotMin', 'note'];
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

/**
 * お客様表示用の「施術時間」。イベント長は占有時間(slotMin)なので durationMin_(ev) は使えない。
 * 予約作成時に保存した durationMin タグを優先し、無い旧イベントはイベント長にフォールバック。
 */
function displayDurationMin_(props, ev) {
  return Number(props.durationMin) || durationMin_(ev);
}

function effectiveMenu_(menu, isFirst) {
  if (isFirst && menu.firstTime) return { durationMin: menu.firstTime.durationMin, price: menu.firstTime.price };
  return { durationMin: menu.durationMin, price: menu.price };
}

/** カレンダー占有時間（分）。slotMin 未定義のメニューは施術時間にフォールバック。 */
function slotMin_(menu) {
  return Number(menu.slotMin) || menu.durationMin;
}

function readSlotConfig_() {
  try { return JSON.parse(prop_('SLOT_CONFIG') || '{}'); } catch (_) { return {}; }
}

function manageUrl_(token) {
  var base = prop_('FRONT_BASE_URL').replace(/\/$/, '');
  return base + '/reserve/manage/?token=' + token;
}

/** オーナー向け予約管理画面（bearer トークンで開く）の URL。日次ダイジェスト等の導線に使う。 */
function adminUrl_() {
  return prop_('FRONT_BASE_URL').replace(/\/$/, '') + '/reserve/admin/';
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

/**
 * 店通知の承認/辞退リンクの基底URL（front の /reserve/decision）。
 * クリック先を非 Google ドメインの自社サイトにすることで、オーナーのスマホが
 * 複数 Google アカウントにログイン中に script.google.com が /u/N/ へ回して
 * 「ファイルを開けません」になる Google 側の癖を根絶する。
 * リンク土台は既存 Script Property `FRONT_BASE_URL`（prod=wwwasyo.com / dev=workers.dev）。
 */
function decisionBaseUrl_() {
  return prop_('FRONT_BASE_URL').replace(/\/$/, '') + '/reserve/decision/';
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
