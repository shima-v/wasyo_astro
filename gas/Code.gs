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
      case 'message': // 予約客への任意メッセージ送信（管理デプロイ：要Googleログイン。GETは入力ページのみ）
        return renderMessagePage_(e.parameter);
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
      case 'lineLogin': return json_(lineLogin_(body));
      case 'liffVerify': return json_(liffVerify_(body));
      // 管理（Googleログイン必須）
      case 'getSlotConfig': return json_(requireAdmin_(adminGetSlotConfig_));
      case 'setSlotConfig': return json_(requireAdmin_(function () { return adminSetSlotConfig_(body); }));
      case 'listPending': return json_(requireAdmin_(adminListPending_));
      case 'getQuota': return json_(requireAdmin_(adminGetQuota_));
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
      if (ev.getTag('wasyoBlock')) return; // 臨時営業/休業マーカーは busy にしない（受付可否の正は SLOT_CONFIG）
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
    esc_(b.menuName) + '<br>' + b.date + ' ' + b.time + '〜（' + b.durationMin + '分） ¥' + b.price +
    (b.note ? '<br><br><b>ご要望</b><br><span style="white-space:pre-wrap">' + esc_(b.note) + '</span>' : '');
  // 承認・辞退どちらでもお客様へメッセージを添えられる。辞退は既定文をプリセット、承認は任意で空。
  var msgLabel = approve ? 'お客様へのひとことメッセージ（任意）' : 'お客様へのメッセージ（このまま送信／編集可）';
  var msgDefault = approve ? '' : DECLINE_DEFAULT_MSG;
  var msgBox =
    '<label for="custMsg" style="display:block;text-align:left;font-size:.9rem;margin:.2rem 0 .35rem">' + msgLabel + '</label>' +
    '<textarea id="custMsg" rows="4" style="width:100%;font-family:inherit;font-size:1rem;padding:.6rem .7rem;border:1px solid #E2D0D8;border-radius:8px;box-sizing:border-box">' +
    esc_(msgDefault) + '</textarea>';
  var page = '' +
    '<h2 style="font-size:1.1rem;margin:0 0 .5rem">予約を' + act + 'しますか？</h2>' +
    statusNote +
    '<div style="background:#f6f3f6;border-radius:10px;padding:1rem;margin:1rem 0;text-align:left">' + summary + '</div>' +
    msgBox +
    '<button id="go" style="width:100%;min-height:48px;margin-top:1rem;border:0;border-radius:24px;color:#fff;background:' + color + ';font-size:1rem;cursor:pointer">' + act + 'する</button>' +
    '<p id="msg" style="color:#666;margin-top:1rem;min-height:1.2em"></p>' +
    '<script>' +
    'var T=' + JSON.stringify(p.token) + ',S=' + JSON.stringify(p.sig) + ',A=' + (approve ? 'true' : 'false') + ';' +
    'document.getElementById("go").onclick=function(){' +
    'var box=document.getElementById("custMsg");var MSG=box?box.value:"";' +
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
    // 承認時もお店からお客様へひとこと添えられる（空なら従来どおり固定文のみ）
    var extra = (message && String(message).trim()) ? '\n\n― サロンより ―\n' + String(message).trim() : '';
    notifyCustomerProps_(props, '【ご予約が確定しました】\n' +
      bookingSummary_(menu, ev.getStartTime(), { durationMin: displayDurationMin_(props, ev), price: Number(props.price || 0) }, props.isFirstTime === 'true') +
      '\nご来店をお待ちしております。' + extra);
  } else {
    var msg = (message && String(message).trim()) ? String(message).trim() : DECLINE_DEFAULT_MSG;
    notifyCustomerProps_(props, '【ご予約について】\n' + msg);
    ev.deleteEvent();
  }
  return { ok: true, status: approve ? STATUS.CONFIRMED : 'declined' };
}

// ============================================================
// 予約客への任意メッセージ送信（管理者・要Googleログイン）
// ============================================================

/**
 * 予約客へのメッセージ送信ページ（GET・`?action=message`）。**状態変更はしない**確認/入力ページを返す。
 * `renderDecisionPage_` を手本にした「GET は読み取り専用 → ボタン押下で google.script.run 実行」パターン。
 *
 * 重要（デプロイ形態）: 送信本体 `sendCustomerMessageBySig` は `requireAdmin_`（Googleログイン照合）を
 * 使うため、このページは **管理デプロイ（executeAs=アクセスユーザー・要ログイン）** で開く必要がある。
 * リンクの基底URLは公開API（①）ではなく管理デプロイ（②）の /exec を指すこと（createBooking_ 参照）。
 *
 * プライバシー: 表示は「名前・日時・メニュー」のみ。連絡先（電話・メール・lineUserId）はマスク（出さない）。
 * 署名は承認系（'decision:'）と分離するため 'message:' プレフィックスで検証する。
 */
function renderMessagePage_(p) {
  if (!verifySig_('message:' + p.token, p.sig)) return html_('署名が無効です。');
  var b = getBookingByToken_(p.token);
  if (!b.ok) {
    return html_('<h2 style="font-size:1.1rem">この予約は見つかりませんでした</h2>' +
      '<p>すでに処理済み、または取消済みの可能性があります。</p>');
  }
  // 連絡先はマスク（電話/メール/lineUserId は表示しない）。名前・日時・メニューのみ。
  // 連絡先はマスク（電話/メール/lineUserId は表示しない）。名前・日時・メニューのみ。
  var summary = esc_(b.name) + ' 様' + (b.isFirstTime ? '（新規）' : '（常連）') + '<br>' +
    esc_(b.menuName) + '<br>' + b.date + ' ' + b.time + '〜（' + b.durationMin + '分）' +
    (b.note ? '<br><br><b>ご要望</b><br><span style="white-space:pre-wrap">' + esc_(b.note) + '</span>' : '');
  var statusNote = b.status === STATUS.CONFIRMED
    ? '<p style="color:#2e7d32;font-size:1.15rem;margin:.4rem 0">この予約は「確定」済みです。</p>'
    : '<p style="color:#b26a00;font-size:1.15rem;margin:.4rem 0">この予約は「仮予約」の状態です。</p>';
  // スマホで読みやすいよう本文・入力・ボタンを大きめに。入力16px以上で iOS の自動ズームも防ぐ（html_() が addMetaTag で viewport を付与）。
  var msgBox =
    '<label for="custMsg" style="display:block;text-align:left;font-size:1.1rem;margin:.3rem 0 .45rem">お客様へのメッセージ</label>' +
    '<textarea id="custMsg" rows="6" placeholder="お客様へお送りするメッセージを入力してください" ' +
    'style="width:100%;font-family:inherit;font-size:1.25rem;line-height:1.6;padding:.9rem .95rem;border:1px solid #E2D0D8;border-radius:10px;box-sizing:border-box"></textarea>';
  var page = '' +
    '<h2 style="font-size:1.65rem;margin:0 0 .7rem">お客様へメッセージを送る</h2>' +
    statusNote +
    '<div style="background:#f6f3f6;border-radius:12px;padding:1.25rem 1.2rem;margin:1.1rem 0;text-align:left;font-size:1.2rem;line-height:1.75">' + summary + '</div>' +
    msgBox +
    '<button id="go" style="width:100%;min-height:60px;margin-top:1.2rem;border:0;border-radius:30px;color:#fff;background:#8B6080;font-size:1.4rem;cursor:pointer">送信する</button>' +
    '<p id="msg" style="color:#666;font-size:1.05rem;margin-top:1rem;min-height:1.2em"></p>' +
    '<script>' +
    'var T=' + JSON.stringify(p.token) + ',S=' + JSON.stringify(p.sig) + ';' +
    'document.getElementById("go").onclick=function(){' +
    'var box=document.getElementById("custMsg");var MSG=box?box.value:"";' +
    'if(!MSG||!MSG.trim()){document.getElementById("msg").textContent="メッセージを入力してください。";return;}' +
    'this.disabled=true;this.style.opacity=.5;this.textContent="送信中…";' +
    'google.script.run.withSuccessHandler(function(r){' +
    'var m=document.getElementById("msg");' +
    'if(r&&r.ok){m.innerHTML="<b>送信しました。</b>お客様へ通知済みです。";document.getElementById("go").style.display="none";if(box)box.disabled=true;}' +
    'else{m.textContent="エラー: "+errText_(r);var g=document.getElementById("go");g.disabled=false;g.style.opacity=1;g.textContent="送信する";}' +
    '}).withFailureHandler(function(e){var m=document.getElementById("msg");m.textContent="通信エラー: "+e;var g=document.getElementById("go");g.disabled=false;g.style.opacity=1;g.textContent="送信する";}).sendCustomerMessageBySig(T,S,MSG);' +
    '};' +
    'function errText_(r){var e=(r&&r.error)||"unknown";' +
    'return {bad_signature:"署名が無効です",forbidden:"管理権限がありません（要Googleログイン）",empty_message:"メッセージが空です",no_channel:"送信先（LINE/メール）が登録されていません",not_found:"予約が見つかりません"}[e]||e;}' +
    '</script>';
  return html_(page);
}

/**
 * メッセージ送信ページのボタン（google.script.run）から呼ばれる。
 * 二重チェック: ①HMAC 署名（'message:' プレフィックス）②requireAdmin_（Googleログイン照合）。
 * どちらも通れば notifyCustomerProps_ で LINE/メール自動フォールバック送信する。
 */
function sendCustomerMessageBySig(token, sig, message) {
  if (!verifySig_('message:' + token, sig)) return { ok: false, error: 'bad_signature' };
  return requireAdmin_(function () {
    if (!message || !String(message).trim()) return { ok: false, error: 'empty_message' };
    var found = findEventByToken_(token);
    if (!found) return { ok: false, error: 'not_found' };
    var props = found.props;
    if (!props.lineUserId && !props.email) return { ok: false, error: 'no_channel' };
    // お店からの自由文メッセージ。承認/辞退の定型文とは独立（テンプレなし・毎回自由記述）。
    notifyCustomerProps_(props, '【サロン和笑〜Violane〜より】\n' + String(message).trim(), 'message');
    return { ok: true };
  });
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
    var busy = cal.getEvents(startOfDay_(start), addDays_(startOfDay_(start), 1)).filter(function (e) {
      return e.getId() !== found.event.getId();
    }).map(function (e) { return { start: e.getStartTime().getTime(), end: e.getEndTime().getTime() }; });
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
function adminApiDecision(token, approve, message) {
  return requireAdmin_(function () { return adminDecision_({ token: token, approve: !!approve, message: message }); });
}
function adminApiGetQuota() { return requireAdmin_(adminGetQuota_); }
function adminApiBroadcastPreview(scope) { return requireAdmin_(function () { return adminBroadcastPreview_({ scope: scope }); }); }
function adminApiBroadcast(scope, message) { return requireAdmin_(function () { return adminBroadcast_({ scope: scope, message: message }); }); }
function adminApiBroadcastTest(message) { return requireAdmin_(function () { return adminBroadcastTest_({ message: message }); }); }
function adminApiSetTempSchedule(payload) { return requireAdmin_(function () { return adminSetTempSchedule_(payload); }); }
// オーナー通知（新規予約・枠警告）の接続テスト。実際の notifyOwner_ 経路で1通送る。
// OWNER_DISCORD_WEBHOOK_URL 設定時は Discord、未設定なら LINE に届く。届いたチャネルを via で返す。
function adminApiOwnerChannelTest() {
  return requireAdmin_(function () {
    notifyOwner_('【接続テスト】オーナー通知の接続確認です。この通知が届けば設定は正常です。');
    return { ok: true, via: prop_('OWNER_DISCORD_WEBHOOK_URL') ? 'discord' : 'line' };
  });
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
 *  - メッセージ: 管理デプロイ②（executeAs=アクセスユーザー・要ログイン）基底。'message:' 署名。
 */
function adminEventDescription_(token) {
  var admin = adminExecUrl_();
  var msgSig = encodeURIComponent(sign_('message:' + token));
  return '【管理者用】\n' +
    '✉️ お客様へメッセージを送る:\n' + admin + '?action=message&token=' + token + '&sig=' + msgSig;
}

function notifyOwnerNewBooking_(token, b, menu, start, end, eff, isFirst) {
  var sig = sign_('decision:' + token);
  var base = publicExecUrl_();
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
    notifyOwnerDiscord_(detail + '\n\n✅ 承認: ' + approve + '\n❌ 辞退: ' + decline);
    return;
  }
  // 従来の LINE 経路（フォールバック）。詳細はテキスト、承認/辞退は confirm テンプレのボタンで送る（長いURLを直接見せない）
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
  // Discord Webhook が設定されていればそちらへ。無ければ従来どおり LINE（無停止フォールバック）。
  if (prop_('OWNER_DISCORD_WEBHOOK_URL')) { notifyOwnerDiscord_(body); return; }
  linePush_(prop_('LINE_OWNER_USER_ID'), body, 'owner');
}

/**
 * オーナー通知を Discord Webhook へ送る。
 * OWNER_DISCORD_WEBHOOK_URL 未設定なら false（呼び出し側で LINE にフォールバック）。
 * Discord はメッセージ受理時に 200/204 を返す。成否を返す。
 */
function notifyOwnerDiscord_(text) {
  var url = prop_('OWNER_DISCORD_WEBHOOK_URL');
  if (!url) return false;
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ content: text }),
      muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    var ok = code === 200 || code === 204;
    if (!ok) console.error('notifyOwnerDiscord_ http ' + code + ': ' + res.getContentText());
    return ok;
  } catch (err) {
    console.error('notifyOwnerDiscord_ failed: ' + err);
    return false;
  }
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
 * 管理デプロイ（②・executeAs=アクセスユーザー・要ログイン）の /exec 基底URL。
 * 予約客へのメッセージ送信リンク（?action=message）はここを指す必要がある
 * （公開API① だと requireAdmin_ の getActiveUser() が空になり必ず弾かれるため）。
 * Script Property `ADMIN_EXEC_URL` に管理デプロイの /exec を登録する（SETUP.md F 参照）。
 * 未設定時は publicExecUrl_() にフォールバックするが、その場合メッセージ送信は
 * requireAdmin_ で forbidden になる（＝安全側。誤送信は起きない）。
 */
function adminExecUrl_() {
  return prop_('ADMIN_EXEC_URL') || publicExecUrl_();
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
