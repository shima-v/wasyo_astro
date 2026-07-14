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
  'double-momi-part-oil-70': { name: '全身もみほぐし＋部位オイルケア', durationMin: 70, slotMin: 150, price: 4300 },
  'double-momi-full-oil-90': { name: '全身もみほぐし＋全身オイルケア', durationMin: 90, slotMin: 180, price: 5500 },
  'simple-momi-30': { name: '全身もみほぐし 30分', durationMin: 30, slotMin: 90, price: 3300, firstTime: { durationMin: 40, price: 3300 } },
  'simple-momi-50': { name: '全身もみほぐし 50分', durationMin: 50, slotMin: 150, price: 4000, firstTime: { durationMin: 60, price: 4000 } },
  'simple-momi-70': { name: '全身もみほぐし 70分', durationMin: 70, slotMin: 150, price: 4400 },
  'simple-momi-100': { name: '全身もみほぐし 100分', durationMin: 100, slotMin: 180, price: 5500 },
  'simple-oil-80': { name: '全身オイルケア', durationMin: 80, slotMin: 180, price: 6600 },
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
      case 'availabilityRaw': // menuId 非依存の「素材」（開始候補＋busy分レンジ）。slotMin 判定はクライアントで行う
        return json_(availabilityRaw_(e.parameter));
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
    // 例外の詳細（スタック・内部識別子）はクライアントに返さずログ側にとどめる（情報漏えい防止）。
    console.error('doGet failed: ' + err + ((err && err.stack) ? '\n' + err.stack : ''));
    return json_({ ok: false, error: 'server_error' });
  }
}

function doPost(e) {
  var raw = (e && e.postData && e.postData.contents) || '{}';
  var body = {};
  try { body = JSON.parse(raw); } catch (_) {}
  // LINE Webhook（events を含む POST）: 通知先ID（グループ/ルーム/ユーザー）を捕捉する設定用ハンドラ。
  // 署名検証に本文（raw）が要るためそのまま渡す。X-Line-Signature の取得可否は handleLineWebhook_ 側で扱う。
  if (body.events) return handleLineWebhook_(body, raw, lineSignature_(e));
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
      case 'getNotifyConfig': return json_(requireAdminToken_(body, adminGetNotifyConfig_));
      case 'setNotifyConfig': return json_(requireAdminToken_(body, function () { return adminSetNotifyConfig_(body); }));
      case 'listPending': return json_(requireAdminToken_(body, adminListPending_));
      case 'adminListCustomers': return json_(requireAdminToken_(body, adminListCustomers_));
      case 'adminListConfirmed': return json_(requireAdminToken_(body, function () { return adminListConfirmed_(body); }));
      case 'adminSetCustomerNote': return json_(requireAdminToken_(body, function () { return adminSetCustomerNote_(body); }));
      case 'adminSetCustomerName': return json_(requireAdminToken_(body, function () { return adminSetCustomerName_(body); }));
      case 'getQuota': return json_(requireAdminToken_(body, adminGetQuota_));
      case 'adminDecision': return json_(requireAdminToken_(body, function () { return adminDecision_(body); }));
      case 'broadcastPreview': return json_(requireAdminToken_(body, function () { return adminBroadcastPreview_(body); }));
      case 'broadcast': return json_(requireAdminToken_(body, function () { return adminBroadcast_(body); }));
      case 'broadcastTest': return json_(requireAdminToken_(body, function () { return adminBroadcastTest_(body); }));
      case 'setTempSchedule': return json_(requireAdminToken_(body, function () { return adminSetTempSchedule_(body); }));
      case 'ownerChannelTest': return json_(requireAdminToken_(body, adminOwnerChannelTest_));
      // 代理登録（電話/来店で受けた予約を"確定"で代理登録）。bearer 保護必須。
      case 'adminCreateBooking': return json_(requireAdminToken_(body, function () { return adminCreateBooking_(body); }));
      // デプロイ通知（deploy.yml / gas/deploy.sh から叩く）。DEPLOY_NOTIFY_TOKEN で保護（管理トークンとは別系統）。
      case 'deployNotify': return json_(requireDeployToken_(body, function () { return notifyDeploy_(body); }));
      default: return json_({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    // 例外の詳細（スタック・内部識別子）はクライアントに返さずログ側にとどめる（情報漏えい防止）。
    console.error('doPost failed: ' + err + ((err && err.stack) ? '\n' + err.stack : ''));
    return json_({ ok: false, error: 'server_error' });
  }
}

/**
 * LINE Webhook 受信（通知先ID捕捉用・設定時のみ使用）。
 * グループ通知のグループID(C…)は Webhook の source からしか取得できない。
 * 手順: ①公式アカウントでグループ参加を許可 ②ボットを対象グループに招待
 *       ③グループで誰かが発言 → ここで source を捕捉し Script Property
 *       `LINE_LAST_SOURCE`（例: group:Cxxxx）へ保存 → その値を `LINE_OWNER_USER_ID` に設定。
 *
 * 【セキュリティ】この POST は匿名到達可能なため、詐称された events で Script Property
 * `LINE_LAST_SOURCE` を書き換えられないよう、LINE の署名検証を必須にする（検証できないなら書き込まない）。
 * 正規の LINE Webhook はヘッダ X-Line-Signature に「チャネルシークレットで本文を HMAC-SHA256 → base64」した値を載せる。
 *
 * 【GAS の制約・重要】GAS Web App の doPost(e) は HTTP リクエストヘッダを一切参照できない
 * （e に headers が無い）。したがって純 GAS 単体では X-Line-Signature を取得できず、本関数は
 * 事実上つねに「検証不能 → 無処理（fail-closed）」になる。実運用で Webhook 捕捉を使うには、
 * 段階2で導入する Cloudflare Worker を前段に置き、Worker がヘッダの署名を検証してから
 * GAS_ADMIN_SECRET 付きで転送する構成（Worker はヘッダを読める）に載せ替える。
 * その際は Worker が検証済み署名を lineSignature_(e) が拾える形（body 等）で引き渡すよう拡張する。
 */
function handleLineWebhook_(body, rawBody, signature) {
  var secret = prop_('LINE_CHANNEL_SECRET');
  // secret 未設定なら検証不能 → 安全側に倒して書き込まない（fail-closed）。
  if (!secret) {
    console.warn('handleLineWebhook_: LINE_CHANNEL_SECRET 未設定のため検証不可・無処理で返す');
    return json_({ ok: true, skipped: 'unverified' });
  }
  // 署名が取得できない／一致しない場合も書き込まない。
  if (!verifyLineSignature_(rawBody || '', signature || '', secret)) {
    console.warn('handleLineWebhook_: 署名検証に失敗（または署名を取得できない）ため無処理で返す');
    return json_({ ok: true, skipped: 'unverified' });
  }
  (body.events || []).forEach(function (ev) {
    var s = (ev && ev.source) || {};
    var id = s.groupId || s.roomId || s.userId || '';
    console.log('LINE webhook: type=' + s.type + ' id=' + id);
    if (id) PropertiesService.getScriptProperties().setProperty('LINE_LAST_SOURCE', (s.type || '?') + ':' + id);
  });
  return json_({ ok: true });
}

/**
 * doPost の event から X-Line-Signature を取り出す（取得できなければ空文字）。
 * ※GAS Web App はリクエストヘッダを公開しないため純 GAS ではつねに空になる。
 *   段階2で Worker を前段に置いた場合に、検証済み署名を body 経由で受け取れるよう
 *   フォールバック（body._lineSignature）だけ用意しておく（Worker 連携時に活用）。
 */
function lineSignature_(e) {
  try {
    if (e && e.postData && e.postData.contents) {
      var b = JSON.parse(e.postData.contents);
      if (b && b._lineSignature) return String(b._lineSignature);
    }
  } catch (_) {}
  return '';
}

/**
 * LINE Messaging API Webhook の署名検証。
 * X-Line-Signature は「チャネルシークレットを鍵に、リクエスト本文そのものを HMAC-SHA256 した値の base64」。
 * 同じ手順で再計算し、定数時間（constEq_）で突き合わせる。一致すれば LINE からの正規リクエストと判断できる。
 * ※LINE の署名は標準 base64（webSafe ではない）。
 */
function verifyLineSignature_(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  var mac = Utilities.computeHmacSha256Signature(rawBody, secret);
  var expected = Utilities.base64Encode(mac);
  return constEq_(expected, signature);
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
 * 空き枠計算の「素材」だけを menuId 非依存で返す（slotMin 依存の最終判定はクライアントへ寄せる）。
 * @param {Object} p { from?, to? }
 * @returns {{ok:boolean, days:Array<{date:string, candidates:string[], busy:number[][]}>, holidays:Object}}
 *   - candidates: 'HH:mm' の開始候補（休枠 isClosedSlot_ 除外済み・menuId 非依存）。
 *   - busy: その日の予約占有を 0:00 起点の「分」レンジ [startMin,endMin] で（TZ 非依存。顧客情報は含めない）。
 * getAvailability_ と from/to・busy 取得ロジックを共有し、slotMin 当てはめだけを外した版。
 */
function availabilityRaw_(p) {
  var today = startOfDay_(new Date());
  var from = p && p.from ? parseDate_(p.from) : addDays_(today, RULES.leadTimeDays);
  var minFrom = addDays_(today, RULES.leadTimeDays);
  if (from < minFrom) from = minFrom;
  var to = p && p.to ? parseDate_(p.to) : addDays_(today, RULES.maxAdvanceDays);
  var maxTo = addDays_(today, RULES.maxAdvanceDays);
  if (to > maxTo) to = maxTo;

  var cal = CalendarApp.getCalendarById(prop_('CALENDAR_ID'));
  var config = readSlotConfig_();
  var holidaySet = holidayDateSet_(from, to); // 祝日（自動判定）を一度だけ取得
  var days = [];

  // 既存予約は範囲全体を一度だけ取得し日付ごとにバケツ分け（getAvailability_ と同じ集約）
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

    // 開始候補（menuId 非依存）: 休枠 isClosedSlot_ を除外して 'HH:mm' 化
    var candidates = [];
    var starts = candidateStarts_(d, config, holidaySet);
    for (var i = 0; i < starts.length; i++) {
      var hhmm = fmt_(starts[i], 'HH:mm');
      if (isClosedSlot_(dateStr, hhmm, config)) continue;
      candidates.push(hhmm);
    }
    if (!candidates.length) continue; // 現行 times.length と同じ扱い（候補ゼロの日は days に入れない）

    // 予約占有を 0:00 起点の分レンジへ換算（epoch → 当日始点からの経過分）。日跨ぎは [0,1440] にクランプ
    var dayStartMs = startOfDay_(d).getTime();
    var busy = (busyByDate[dateStr] || []).map(function (b) {
      var sMin = Math.round((b.start - dayStartMs) / 60000);
      var eMin = Math.round((b.end - dayStartMs) / 60000);
      if (sMin < 0) sMin = 0;
      if (eMin > 1440) eMin = 1440;
      return [sMin, eMin];
    });

    days.push({ date: dateStr, candidates: candidates, busy: busy });
  }
  return { ok: true, days: days, holidays: holidaySet };
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

/**
 * 予約作成の既定 opts。createBooking_（お客様の通常予約）が渡す値で、
 * この既定は抽出前の createBooking_ の挙動を 100% 再現する。
 * 将来の代理予約（adminCreateBooking_）は opts を差し替えて分岐する土台。
 */
var DEFAULT_CREATE_OPTS = {
  requireContact: true,      // 連絡手段（contactMethod / email / line）の必須チェック
  requireReferrer: true,     // 男性は紹介者必須のチェック
  confirm: false,            // false=【仮】/ORANGE/pending・台帳更新は承認時。true=生成時点で確定
  bypassWindow: false,       // false=リードタイム・受付上限・営業日/開始時刻/休枠を検証
  notifyOwnerPending: true,  // 仮予約のオーナー通知を送る
};

/**
 * 予約作成の本体。opts で挙動を分岐できるが、既定 opts（= DEFAULT_CREATE_OPTS 相当）
 * は現行 createBooking_ を 100% 再現する。
 * 【重要】ダブルブッキング防止（overlapsBusy_）は opts に関係なく常に実施する。
 * @param {Object} b 予約入力
 * @param {Object} [opts] 分岐フラグ（省略時は全既定＝現行挙動）
 */
function createBookingCore_(b, opts) {
  opts = opts || {};
  var requireContact = opts.requireContact !== false;    // 既定 true
  var requireReferrer = opts.requireReferrer !== false;  // 既定 true
  var confirm = opts.confirm === true;                   // 既定 false
  var bypassWindow = opts.bypassWindow === true;         // 既定 false
  var notifyOwnerPending = opts.notifyOwnerPending !== false; // 既定 true
  var notifyCustomerFlag = opts.notifyCustomer !== false; // 既定 true（代理予約は自前で控えを送るため false で渡す）

  var menu = MENU[b.menuId];
  if (!menu) return { ok: false, error: 'invalid_menu' };
  if (requireContact) {
    if (!b.name || !b.contactMethod) return { ok: false, error: 'missing_required' };
    if (b.contactMethod === 'email' && !b.email) return { ok: false, error: 'missing_email' };
    if (b.contactMethod === 'line' && !b.lineUserId && !b.email) return { ok: false, error: 'missing_contact' };
  }
  if (requireReferrer) {
    if (b.gender === 'male' && !b.referrer) return { ok: false, error: 'referrer_required' };
  }
  if (!b.date || !b.time) return { ok: false, error: 'missing_slot' };

  // リードタイム・受付上限の検証
  var start = atTime_(parseDate_(b.date), b.time);
  var today = startOfDay_(new Date());
  if (!bypassWindow) {
    if (start < addDays_(today, RULES.leadTimeDays)) return { ok: false, error: 'too_soon' };
    if (start > addDays_(today, RULES.maxAdvanceDays + 1)) return { ok: false, error: 'too_far' };
  }

  // 新規/常連判定 → 初回料金確定
  var ledgerKey = ledgerKey_(b);
  var isFirst = ledgerKey ? !ledgerLookup_(ledgerKey) : true;
  var eff = effectiveMenu_(menu, isFirst);
  var slot = slotMin_(menu);
  var end = new Date(start.getTime() + slot * 60000); // イベント長＝占有時間

  var cal = CalendarApp.getCalendarById(prop_('CALENDAR_ID'));
  if (!cal) return { ok: false, error: 'calendar_not_configured' };

  var status = confirm ? STATUS.CONFIRMED : STATUS.PENDING;

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  var token, ev, evProps;
  try {
    // 直前再検証（受付日・開始時刻・休枠）。フロント値は信用しない。
    if (!bypassWindow) {
      var config = readSlotConfig_();
      var holidaySet = holidayDateSet_(start, start);
      if (!isOpenDay_(start, config, holidaySet) ||
          !isValidStart_(start, b.time, config, holidaySet) ||
          isClosedSlot_(b.date, b.time, config)) {
        return { ok: false, error: 'slot_closed' };
      }
    }
    // ダブルブッキング防止（重複）は opts に関係なく常に実施する。
    var busy = busySpansForDay_(cal, start, null);
    if (overlapsBusy_(start, end, busy)) return { ok: false, error: 'slot_taken' };

    token = Utilities.getUuid();
    ev = cal.createEvent((confirm ? '【確定】' : '【仮】') + menu.name + ' / ' + b.name, start, end);
    evProps = {
      token: token, status: status, menuId: b.menuId,
      name: b.name, phone: b.phone || '', email: b.email || '',
      gender: b.gender || '', referrer: b.referrer || '',
      lineUserId: b.lineUserId || '', isFirstTime: String(isFirst),
      price: String(eff.price), durationMin: String(eff.durationMin), slotMin: String(slot),
      note: b.note || '',
    };
    setEventProps_(ev, evProps);
    try { ev.setColor(confirm ? CalendarApp.EventColor.GREEN : CalendarApp.EventColor.ORANGE); } catch (_) {}
    // カレンダー説明欄に管理者向けリンクを入れる（オーナーが予約を開いて操作できる導線）。
    // 説明欄には PII（連絡先）を生書きしない。載せるのは署名付きリンクのみ。
    try { ev.setDescription(adminEventDescription_(token)); } catch (_) {}
    // 生成時点で確定扱いのときのみ、この場で台帳を更新（既定は承認時 decide_ で更新）。
    if (confirm) ledgerUpsert_(evProps, start);
  } finally {
    lock.releaseLock();
  }

  // 通知
  if (notifyOwnerPending) {
    notifyOwnerNewBooking_(token, b, menu, start, end, eff, isFirst);
  }
  // 顧客への自動通知（代理予約は notifyCustomer:false で無効化し、確定控えを自前で送る）
  if (notifyCustomerFlag && notifyOn_('customerReceipt')) {
    notifyCustomer_(b, '【仮予約を受付ました】\n' + bookingSummary_(menu, start, eff, isFirst) +
      '\nサロンの確認後、確定のご連絡をいたします。\n\n▼ ご予約の確認・変更・キャンセル\n' + manageUrl_(token));
  }

  return {
    ok: true, token: token, status: status,
    isFirstTime: isFirst, durationMin: eff.durationMin, price: eff.price,
    manageUrl: manageUrl_(token),
  };
}

/** お客様の通常予約。既定 opts（現行挙動）で本体を呼ぶ薄いラッパ。 */
function createBooking_(b) {
  return createBookingCore_(b, DEFAULT_CREATE_OPTS);
}

/**
 * 代理登録。管理者が電話・来店で受けた予約を代わりに"確定"で登録する。
 * front /reserve/admin/reservations → Worker → doPost 'adminCreateBooking'（bearer 保護）。
 * 【設計3点（本人ロック済み）】
 *   1. 即確定  : confirm:true（生成時点で CONFIRMED・【確定】・GREEN・台帳即時 upsert）。
 *   2. 同一受付制約: bypassWindow:false（リードタイム・受付上限・営業日/開始時刻/休枠を通常客同様に検証）。
 *   3. 控えはメール入力時だけ: email があれば顧客へ確定控えメール。空なら顧客へは送らずオーナーへは必ず通知。
 * 代理は連絡手段/性別/紹介者を集めないため core の requireContact/requireReferrer は外し、
 * 組み込み通知（notifyOwnerPending/notifyCustomer）も両方オフにして、確定用の通知を自前で出す。
 */
function adminCreateBooking_(b) {
  b = b || {};
  // core は menu/date/time を検証する。代理では連絡手段チェックを外す分、name/phone をここで必須化する。
  if (!b.name || !b.phone) return { ok: false, error: 'missing_required' };

  var res = createBookingCore_(b, {
    requireContact: false,    // 連絡手段（contactMethod/email/line）は代理では集めない
    requireReferrer: false,   // 男性の紹介者チェックも代理では課さない
    confirm: true,            // 生成時点で確定（【確定】/GREEN/台帳即時 upsert）
    bypassWindow: false,      // 受付制約は通常客と同じ（特別扱いしない）
    notifyOwnerPending: false, // 「承認待ち」通知は出さない（確定済みのため）
    notifyCustomer: false,     // 顧客への自動通知はオフ。確定控えを下で自前送信
  });
  if (!res.ok) return res;

  var menu = MENU[b.menuId] || { name: b.menuId };
  var start = atTime_(parseDate_(b.date), b.time);
  var eff = { durationMin: res.durationMin, price: res.price };

  // オーナー通知（Discord優先→LINEフォールバック＝notifyOwner_）。確定済みなので承認/辞退リンクは付けない。
  // 顧客 PII を LINE 履歴に生で残さない既存方針は Discord 優先で踏襲する。
  if (notifyOn_('ownerProxy')) notifyOwner_('【代理で"確定"予約を登録しました】\n' +
    'お名前: ' + b.name + (res.isFirstTime ? '（新規）' : '（常連）') + '\n' +
    '電話: ' + (b.phone || '（未登録）') + '\n' +
    bookingSummary_(menu, start, eff, res.isFirstTime));

  // 顧客控え（メール入力時だけ）。代理では lineUserId を集めないためメール限定。
  if (b.email) {
    sendMail_(b.email, 'サロン和笑〜Violane〜 ご予約',
      '【ご予約が確定しました】\n' +
      bookingSummary_(menu, start, eff, res.isFirstTime) +
      '\nご来店をお待ちしております。' +
      '\n\n▼ ご予約の確認・変更・キャンセル\n' + manageUrl_(res.token));
  }

  // 監査ログ（顧客PIIに関わる代理予約の証跡）。既存顧客を一覧から選んだ（pickedKey あり）か手入力かを op で区別する。
  // 操作者は生トークンを残さず tokenFp_（HMAC指紋）で、対象電話は auditPush_ 内の maskId_ が末尾4桁のみに落とす。
  // auditPush_ は try/catch 済み・LEDGER 未設定なら no-op＝監査失敗が予約本体（上で確定・通知済み）を巻き込まないよう、
  // 副作用なしで最後に呼ぶだけにする。
  auditPush_(tokenFp_(b.adminToken), b.pickedKey ? 'proxyBook:picked' : 'proxyBook:manual', b.phone, res.ok ? 'ok' : 'ng');

  return res;
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
  if (notifyOn_('ownerCancel')) notifyOwner_('【お客様がキャンセルしました】\n' + props.name + ' 様 / ' + menu.name +
    '\n日時: ' + fmt_(start, 'M/d(E) HH:mm') + '（' + (props.status === STATUS.CONFIRMED ? '確定' : '仮予約') + '）');
  if (notifyOn_('customerCancel')) notifyCustomerProps_(props, '【ご予約をキャンセルしました】\nまたのご利用をお待ちしております。');
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
  // 変更後は再承認が必要（status=PENDING）。仮予約通知と同じ形式でオーナーに承認/辞退/メッセージの3リンクを送る。
  var changeDetail = '【お客様が日時変更（要再承認）】\n' +
    'お名前: ' + props.name + ' 様\n' +
    'メニュー: ' + menu.name + '\n' +
    '新日時: ' + fmt_(start, 'M/d(E) HH:mm') +
    (props.note ? '\n要望: ' + props.note : '');
  notifyOwnerPendingApproval_(changeDetail, props.token, { altLabel: '日時変更の承認/辞退' });
  if (notifyOn_('customerChange')) notifyCustomerProps_(props, '【日時変更を受付ました】\n' + bookingSummary_(menu, start, eff, props.isFirstTime === 'true') + '\nサロンの確認後、確定のご連絡をいたします。');
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
  // 定数時間比較で全件を走査する（一致しても break しない＝どのトークンに当たったかも時間差で漏らさない）。
  var matched = false;
  for (var i = 0; i < tokens.length; i++) {
    if (constEq_(tokens[i], given)) matched = true;
  }
  if (!given || !matched) return { ok: false, error: 'forbidden' };
  return fn();
}

/**
 * Worker だけが持つ共有秘密 `GAS_ADMIN_SECRET`（Script Property）を検証するラッパ。
 * 段階2で管理系の GAS 呼び出しを Cloudflare Worker 経由に集約したのち、顧客系・代理予約の
 * 新エンドポイント（P4/P5）を「Worker からの呼び出しに限る」ために使う土台。
 * GAS Web App は HTTP ヘッダを読めないため、Worker は POST body の `workerSecret` として送る。
 * 照合は定数時間比較（constEq_）。未設定・不一致・空は forbidden。
 * ※段階1では関数の新設のみ（まだ呼び出し側には配線しない）。値は Script Properties のみ・リポには書かない。
 */
function requireWorkerSecret_(body, fn) {
  var expected = prop_('GAS_ADMIN_SECRET');
  var given = (body && body.workerSecret) || '';
  if (!expected || !given || !constEq_(expected, given)) return { ok: false, error: 'forbidden' };
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

function adminGetNotifyConfig_() { return { ok: true, config: readNotifyConfig_() }; }

function adminSetNotifyConfig_(b) {
  var cfg = b.config || {};
  PropertiesService.getScriptProperties().setProperty('NOTIFY_CONFIG', JSON.stringify(cfg));
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
    // person 層（identity 土台・非破壊）: この channel 行の personId を解決（無ければ採番して col7 へ
    // backfill）し、person シートの集約（来店回数・最終来店・氏名）を channel と同期する。col0〜6 は不変。
    var pid = personResolve_(key);
    if (pid) personRowSync_(pid, { displayName: String(props.name || ''), count: count, lastVisit: dateStr });
  } else {
    // 新規: person を採番し、channel 行の col7 へ personId を含めて追加（col0〜6 は従来どおり同順・同値）。
    var newPid = personResolve_(key);
    sh.appendRow([key, type, props.name || '', dateStr, 1, dateStr, '', newPid]);
    if (newPid) personRowSync_(newPid, { displayName: String(props.name || ''), firstVisit: dateStr, count: 1, lastVisit: dateStr });
  }
}

// 顧客メモ（列7）の最大長。フロント textarea の maxlength と揃える（超過は too_long で拒否）。
var CUSTOMER_NOTE_MAX = 2000;

/**
 * 顧客台帳の note（列7）を上書きする（P2 顧客カルテ・1顧客1つの恒久メモ）。
 * requireAdminToken_ で保護。body {action, adminToken, key:<hash>, note:<string>}。
 * key は adminListCustomers_ が返す opaque な突合トークン（台帳キーの SHA-256 hex）で、生の識別子は
 * 受け取らない。全行を hashKey_(row[0])===key で突合し、該当行の列7に setValue する（PII 最小化の帰結・
 * ledgerLookup_ は生キー前提ゆえ流用不可）。空文字 note＝クリア許可。
 * 書き込みは列7のみ・カレンダー変更・通知・外部 fetch・他列の改変は一切しない（ledgerUpsert_ は無改変）。
 * 監査は karteEdit で1行残す（note 本文・生トークンは残さない。target は生の body.key＝ハッシュを渡し
 * auditPush_ 内の maskId_ に一任＝事前マスクしない）。
 */
function adminSetCustomerNote_(body) {
  var key = (body && body.key) || '';
  var note = (body && body.note != null) ? String(body.note) : '';
  if (!key) return { ok: false, error: 'bad_request' };
  if (note.length > CUSTOMER_NOTE_MAX) return { ok: false, error: 'too_long' };
  var sh = ledgerSheet_();
  if (!sh) return { ok: false, error: 'ledger_unconfigured' };

  var res;
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var values = sh.getDataRange().getValues();
    var found = 0;
    for (var r = 1; r < values.length; r++) {   // r=0 はヘッダ行なのでスキップ
      if (hashKey_(String(values[r][0] || '')) === key) { found = r; break; }
    }
    if (!found) {
      res = { ok: false, error: 'not_found' };
    } else {
      sh.getRange(found + 1, 7).setValue(note);  // 1始まりの行番号・列7＝note
      res = { ok: true };
    }
  } finally {
    lock.releaseLock();
  }
  // 監査はロック解放後。note 本文は渡さず、target は生の body.key（ハッシュ）を渡して maskId_ に一任する。
  auditPush_(tokenFp_(body.adminToken), 'karteEdit', body.key, res.ok ? 'ok' : 'ng');
  return res;
}

// お客様の表示名（displayName）の最大長。フロント input の maxlength と揃える（超過は too_long で拒否）。
var CUSTOMER_NAME_MAX = 100;

/**
 * お客様の表示名（person.displayName）を店主が編集する（P2 Phase 2・identity 層・adminSetCustomerNote_ の雛形）。
 * requireAdminToken_ で保護。body {action, adminToken, key:<hash>, name:<string>}。
 *
 * 【表示名の"正"は person 側（identity 層）に置く — 設計判断】
 *   - 台帳（channel）の col2=name は「予約時にお客様が入力した生の氏名」で、来店ごとに ledgerUpsert_ が最新の
 *     予約名で上書きする（channel＝連絡手段ごとの生データ）。ここは一切触らない（channel col0〜6 不変）。
 *   - 店主が付ける表示名は person.displayName に持たせ、これを表示の"正"とする。adminListCustomers_ は
 *     person.displayName があればそれを、無ければ channel.name を返す（回帰ゼロのフォールバック）。
 *   - ※既知の限界: ledgerUpsert_→personRowSync_ は次回来店時に予約名で person.displayName を上書きしうる
 *     （店主の編集が再予約で戻る）。「編集を sticky にする」は Phase 3/4 の設計判断事項として別途（本 Phase では未対応）。
 *
 * 手順:
 *   ①key（突合トークン＝台帳キーの SHA-256）で channel 行を特定 → 生キー(col0)と personId(col7) を得る。
 *   ②personId 未採番なら personResolve_(生キー) で採番＋col7 backfill＋person 行を鏡写しで用意（channel col0〜6 不変）。
 *   ③person シートの displayName（col2）に setValue（person 行のみ・channel/カレンダー/通知/外部 fetch には触れない）。
 * 100字上限・LockService で排他。空文字は「店主の表示名を消す＝channel.name へ戻す」意味で許可（note と同流儀）。
 * 監査は nameEdit で1行（氏名本文・生トークンは残さない。target は body.key＝ハッシュを maskId_ に一任）。
 */
function adminSetCustomerName_(body) {
  var key = (body && body.key) || '';
  var name = (body && body.name != null) ? String(body.name) : '';
  if (!key) return { ok: false, error: 'bad_request' };
  if (name.length > CUSTOMER_NAME_MAX) return { ok: false, error: 'too_long' };
  var sh = ledgerSheet_();
  if (!sh) return { ok: false, error: 'ledger_unconfigured' };

  var res;
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var values = sh.getDataRange().getValues();
    var rawKey = '';
    var pid = '';
    for (var r = 1; r < values.length; r++) {   // r=0 はヘッダ行なのでスキップ
      if (hashKey_(String(values[r][0] || '')) === key) {
        rawKey = String(values[r][0] || '');
        pid = String(values[r][7] || '');       // col7 = personId（未採番なら空）
        break;
      }
    }
    if (!rawKey) {
      res = { ok: false, error: 'not_found' };
    } else {
      if (!pid) pid = personResolve_(rawKey);    // 未採番なら採番＋col7 backfill＋person 行を用意
      if (!pid) {
        res = { ok: false, error: 'person_unresolved' };
      } else {
        var psh = personSheet_();                // ledger 設定済み＝psh は非 null（personResolve_ で既に触れている）
        var prow = personLookup_(pid);
        if (prow) {
          psh.getRange(prow, 2).setValue(name);  // person.displayName（col2）を直書き（空文字＝クリアも許可）
        } else {
          psh.appendRow([pid, name, '', 0, '', '']); // 念のため（personResolve_ は通常 person 行を作る）
          prow = personLookup_(pid);
        }
        res = prow ? { ok: true } : { ok: false, error: 'person_unresolved' };
      }
    }
  } finally {
    lock.releaseLock();
  }
  // 監査はロック解放後。氏名本文は渡さず、target は生の body.key（ハッシュ）を渡して maskId_ に一任する。
  auditPush_(tokenFp_(body.adminToken), 'nameEdit', body.key, res.ok ? 'ok' : 'ng');
  return res;
}

/**
 * 顧客台帳（LEDGER_SHEET）を read-only で一覧化して返す（P2 顧客管理ページ用）。
 * requireAdminToken_ で保護。シートへの書き込み・カレンダー変更・通知・PII の外部送出は一切しない。
 * 台帳が未設定（LEDGER_SHEET_ID なし）なら空配列を返す（作話しない）。
 * 列は ledgerUpsert_ と対応:
 *   col0 key / col1 type / col2 name / col3 firstVisit / col4 count / col5 lastVisit / col6 note
 * 連絡先は key から復元する（台帳には正規化済み電話＝数字のみが入る。ハイフン付きの整形はフロントで行う）。
 * 各顧客に台帳キー（col0）を hashKey_ で SHA-256 化した opaque な突合トークンを追加フィールド key として返す
 * ＝顧客詳細の来店履歴で adminListConfirmed_ の突合に使う。生の識別子は突合トークンとして出さない
 * （PII 最小化・既存フィールド・挙動は不変の純追加）。
 */
function adminListCustomers_() {
  var sh = ledgerSheet_();
  if (!sh) return { ok: true, customers: [] };
  var values = sh.getDataRange().getValues();

  // person 層の join 素材（Phase 2・いずれも read-only）:
  //   ① personId → displayName（表示名の"正"）。person シートを1回だけ読む。無ければ空マップ。
  //   ② personId → その person が持つ全 channel の突合トークン matchTokens[]（OR 突合の土台）。
  // どちらも personId を持つ行にだけ効く。personId 未採番の行は従来どおり channel.name／単一キーになる。
  // 【回帰ゼロ】Phase 1 は 1 channel=1 person ゆえ matchTokens は実質 [key]、displayName は channel.name の
  //   鏡写し（personRowSync_）。person シート未作成（未migrate・以降の予約なし）なら nameByPid 空＝全行が
  //   channel.name にフォールバック＝完全に従来挙動。matchTokens は純追加フィールド。
  var nameByPid = personDisplayNameMap_();
  var tokensByPid = {};
  for (var i = 1; i < values.length; i++) {
    var k0 = String(values[i][0] || '');
    if (!k0) continue;
    var pid0 = String(values[i][7] || '');       // col7 = personId
    if (!pid0) continue;
    (tokensByPid[pid0] = tokensByPid[pid0] || []).push(hashKey_(k0));
  }

  var list = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var key = String(row[0] || '');
    if (!key) continue;
    var type = String(row[1] || '');
    var count = Number(row[4] || 0);
    var pid = String(row[7] || '');
    var hashed = hashKey_(key);
    // 表示名は person.displayName を"正"に、無ければ channel.name（回帰ゼロのフォールバック）。
    var displayName = (pid && nameByPid[pid]) ? nameByPid[pid] : String(row[2] || '');
    var c = {
      name: displayName,
      type: type,
      count: count,
      firstVisit: ledgerDateStr_(row[3]),
      lastVisit: ledgerDateStr_(row[5]),
      tag: count <= 1 ? '新規' : '常連',
      // 顧客ごとの恒久メモ（列7・adminSetCustomerNote_ で上書き）。空なら空文字。
      // 本文は管理ゲート内でのみ扱い、一覧は「メモ有り」マークのみ・本文はフロント詳細パネルで表示する。
      note: String(row[6] || ''),
      // 来店履歴の突合トークン（adminListConfirmed_ の params.key）。台帳キーを hashKey_ で SHA-256 化した
      // opaque 値＝生の識別子（lineUserId・電話・メール）は突合トークンとして出さない（PII 最小化）。
      // クライアントは中身を解釈せずそのまま echo する（管理ゲート内・HTTPS・no-store）。
      key: hashed,
      // その person が持つ全 channel の突合トークン（Phase 3/4 の複数 channel 名寄せの土台・OR 突合用）。
      // Phase 1 は 1:1 ゆえ実質 [key]。personId 未採番なら自キーのみ＝従来と同一集合（回帰ゼロ）。
      matchTokens: (pid && tokensByPid[pid] && tokensByPid[pid].length) ? tokensByPid[pid] : [hashed],
    };
    // 連絡先は key（type:value）の value 部から復元する。整形前の電話は台帳に無いので正規化数字を使う。
    var idx = key.indexOf(':');
    var val = idx >= 0 ? key.slice(idx + 1) : '';
    if (type === 'phone') c.phone = val;       // 正規化（数字のみ）。表示整形はフロント
    else if (type === 'email') c.email = val;  // 小文字
    // line 型は連絡先を持たない（phone/email なし）
    list.push(c);
  }
  // 最終来店日の降順（yyyy-MM-dd の文字列比較で足りる。空は末尾）。
  list.sort(function (a, b) {
    return (b.lastVisit || '').localeCompare(a.lastVisit || '');
  });
  return { ok: true, customers: list };
}

/**
 * personId → displayName のマップを返す（adminListCustomers_ の表示名 join 用・read-only）。
 * person シートが無ければ空マップ（＝全行が channel.name にフォールバック＝従来挙動・回帰ゼロ）。
 * ※personSheet_ と違い getSheetByName を直接使い、シートを"作らない"（一覧は read-only を厳守）。
 * 空 displayName はマップに入れない（呼び出し側で channel.name にフォールバックさせるため）。
 */
function personDisplayNameMap_() {
  var map = {};
  var id = prop_('LEDGER_SHEET_ID');
  if (!id) return map;
  var sh = SpreadsheetApp.openById(id).getSheetByName('person');
  if (!sh) return map;                 // person シート未作成＝Phase 1 未migrate＝従来どおり
  var vals = sh.getDataRange().getValues();
  for (var r = 1; r < vals.length; r++) {   // r=0 はヘッダ行
    var pid = String(vals[r][0] || '');
    var dn = String(vals[r][1] || '');
    if (pid && dn) map[pid] = dn;      // 空 displayName は入れない（channel.name フォールバックに委ねる）
  }
  return map;
}

/**
 * 台帳の日付セルは Sheets により Date 型で返ることがある（ledgerUpsert_ は yyyy-MM-dd 文字列で
 * 書くが、Sheets が日付として解釈し直すため）。String(Date) の醜い表記を避け yyyy-MM-dd に正規化する。
 */
function ledgerDateStr_(v) {
  if (v instanceof Date) return fmt_(v, 'yyyy-MM-dd');
  return String(v || '');
}

// ============================================================
// person（人・identity 層）— Phase 1: 土台だけ（非破壊・追加のみ・冪等）
// ------------------------------------------------------------
// 目的: 連絡先＝主キーの癒着（電話を変えると履歴が切れる／媒体違いで別人扱い）を解くため、
//       「人（person＝不変の内部背番号 personId）」と「連絡手段（channel＝既存の台帳行）」を層分離する。
// Phase 1 の約束:
//   - 既存の表示・挙動は一切変えない（adminListCustomers_ 等は従来どおり channel を表示）。
//   - channel（台帳＝getSheets()[0]）の col0〜6 は不変。personId は col7 に純追加（append only）。
//   - person は名前付きシート 'person' として"末尾"に作る（位置0の台帳参照 getSheets()[0] を壊さない）。
//   - カレンダー（来店履歴の原本）には一切書き込まない。
//   - 冪等: 既に personId がある行は再採番しない（二度流しても同結果）。
// 次フェーズ以降で、履歴を personId に紐づけ替え／媒体をまたいだ名寄せ／表示の person 化を行う。
// ============================================================

/**
 * person シートを取得（無ければ作成）。列 = personId|displayName|firstVisit|count|lastVisit|note。
 * 台帳（getSheets()[0]）を末尾以外へずらさないよう、必ず"末尾"の index に挿入する。
 * 台帳未設定（LEDGER_SHEET_ID なし）なら null（作話しない）。logPush_/auditPush_ と同じ流儀。
 */
function personSheet_() {
  var id = prop_('LEDGER_SHEET_ID');
  if (!id) return null;
  var ss = SpreadsheetApp.openById(id);
  var sh = ss.getSheetByName('person');
  if (!sh) {
    sh = ss.insertSheet('person', ss.getSheets().length); // 末尾に追加＝位置0の台帳を動かさない
    sh.appendRow(['personId', 'displayName', 'firstVisit', 'count', 'lastVisit', 'note']);
  }
  return sh;
}

/** personId に該当する person 行（1始まり）を返す。無ければ 0。 */
function personLookup_(personId) {
  if (!personId) return 0;
  var sh = personSheet_();
  if (!sh) return 0;
  var values = sh.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {   // r=0 はヘッダ行
    if (String(values[r][0]) === personId) return r + 1;
  }
  return 0;
}

/**
 * person 行の集約を upsert（無ければ作成、あれば更新）。
 * agg = { displayName, firstVisit, count, lastVisit, note }（部分指定可）。
 * 空文字/未指定のフィールドは"上書きしない"（既存値を保全）。count のみ数値として常に反映。
 * カレンダー・channel（台帳）には触れない。person シートのみ。
 */
function personRowSync_(personId, agg) {
  if (!personId) return;
  var sh = personSheet_();
  if (!sh) return;
  agg = agg || {};
  var row = personLookup_(personId);
  if (row) {
    if (agg.displayName != null && agg.displayName !== '') sh.getRange(row, 2).setValue(String(agg.displayName));
    if (agg.firstVisit != null && agg.firstVisit !== '') sh.getRange(row, 3).setValue(String(agg.firstVisit));
    if (agg.count != null) sh.getRange(row, 4).setValue(Number(agg.count) || 0);
    if (agg.lastVisit != null && agg.lastVisit !== '') sh.getRange(row, 5).setValue(String(agg.lastVisit));
    if (agg.note != null && agg.note !== '') sh.getRange(row, 6).setValue(String(agg.note));
  } else {
    sh.appendRow([
      personId,
      String(agg.displayName || ''),
      String(agg.firstVisit || ''),
      Number(agg.count || 0),
      String(agg.lastVisit || ''),
      String(agg.note || ''),
    ]);
  }
}

/**
 * channel キー（type:value 文字列）または予約 props から personId を解決する。
 *   - 該当 channel 行に personId(col7) が既にあればそれを返す（冪等・再採番しない）。
 *   - 無ければ Utilities.getUuid() で採番し、channel 行の col7 へ backfill（col0〜6 は不変）。
 *     このとき person シートへ当該行の集約を鏡写しで作成する。
 *   - channel 行自体が未作成（新規予約の appendRow 直前）なら、personId のみ採番して最小 person 行を作り
 *     返す（channel 行の作成＝col7 への書き込みは呼び出し側 ledgerUpsert_ の appendRow が担う）。
 * 台帳未設定なら '' を返す。カレンダーには一切触れない。
 */
function personResolve_(keyOrProps) {
  var sh = ledgerSheet_();
  if (!sh) return '';
  var key = (typeof keyOrProps === 'string') ? keyOrProps : ledgerKey_(keyOrProps || {});
  if (!key) return '';
  var row = ledgerLookup_(key);
  if (row) {
    var pid = String(sh.getRange(row, 8).getValue() || '');  // col7 = 1始まり8列目
    if (pid) return pid;                                      // 既に解決済み（冪等）
    pid = Utilities.getUuid();
    sh.getRange(row, 8).setValue(pid);                        // channel col7 へ backfill（col0〜6 不変）
    var vals = sh.getRange(row, 1, 1, 7).getValues()[0];      // col0..6 を読み取り person へ鏡写し
    personRowSync_(pid, {
      displayName: String(vals[2] || ''),
      firstVisit: ledgerDateStr_(vals[3]),
      count: Number(vals[4] || 0),
      lastVisit: ledgerDateStr_(vals[5]),
      note: String(vals[6] || ''),
    });
    return pid;
  }
  // channel 行が未作成: personId のみ採番し、最小 person 行を用意（channel 行作成は呼び出し側）。
  var newPid = Utilities.getUuid();
  var seedName = (typeof keyOrProps === 'object' && keyOrProps) ? String(keyOrProps.name || '') : '';
  personRowSync_(newPid, { displayName: seedName });
  return newPid;
}

/**
 * 既存の全 channel（台帳）行へ person を割り当てる移行関数。**既定は dry-run（安全側）**。
 *   - dry-run（引数省略 or true）: 件数と同名衝突を集計して返すだけ。**一切書き込まない**。
 *   - 実行（migrateToPersonModel_(false)）: personId 未設定の行に採番して col7 へ書き、person 行を作成。
 * 性質:
 *   - 冪等: 既に personId(col7) がある行は再採番せず alreadyAssigned に数える（二度流しても同結果）。
 *   - 非破壊: col0〜6・カレンダーには一切触れない（personId は col7、person シートのみ書き込む）。
 *   - 名寄せはしない（Phase 1 は 1 channel 行 = 1 person の 1:1）。同名 channel は「将来の名寄せ候補」として
 *     グループ数と行番号だけ報告する（実名は載せない）＝自動統合はしない。
 * ※本関数はどの HTTP ルータ（doGet/doPost）にも配線していない。実行はオーナーが GAS エディタ／clasp run で
 *   手動起動する前提。返り値は件数・行番号のみで氏名などの個人情報を含まない（読み手側の匿名化）。
 * @param {boolean} dryRun 既定 true。実書き込みは明示的に false を渡したときだけ。
 * @return {{ok:boolean, dryRun:boolean, total:number, alreadyAssigned:number, assigned:number, nameCollisionGroups:number, nameCollisionRows:Array}}
 */
function migrateToPersonModel_(dryRun) {
  dryRun = (dryRun !== false); // 省略・true は dry-run。実書き込みは false を明示したときのみ。
  var sh = ledgerSheet_();
  if (!sh) return { ok: false, error: 'ledger_unconfigured' };
  var values = sh.getDataRange().getValues();
  var total = 0, already = 0, assigned = 0;
  var nameMap = {}; // displayName -> 行番号(1始まり)配列。将来の名寄せ候補（同名）検出用。
  for (var r = 1; r < values.length; r++) {   // r=0 はヘッダ行
    var row = values[r];
    var key = String(row[0] || '');
    if (!key) continue;
    total++;
    var name = String(row[2] || '');
    if (name) { (nameMap[name] = nameMap[name] || []).push(r + 1); }
    var existingPid = String(row[7] || ''); // col7
    if (existingPid) { already++; continue; } // 冪等: 既に personId があれば触らない
    assigned++;
    if (!dryRun) {
      var pid = Utilities.getUuid();
      sh.getRange(r + 1, 8).setValue(pid); // channel col7 のみ（col0〜6・カレンダー不変）
      personRowSync_(pid, {
        displayName: name,
        firstVisit: ledgerDateStr_(row[3]),
        count: Number(row[4] || 0),
        lastVisit: ledgerDateStr_(row[5]),
        note: String(row[6] || ''),
      });
    }
  }
  // 同名グループ（将来の名寄せ候補）は「件数」と「行番号」だけを返す。
  // 実名(row[2]) は個人情報なので出力に載せない（dry-run 結果を人が読む前提の匿名化）。
  var nameCollisionRows = [];
  for (var nm in nameMap) {
    if (nameMap[nm].length > 1) nameCollisionRows.push(nameMap[nm]);
  }
  return {
    ok: true, dryRun: dryRun,
    total: total, alreadyAssigned: already, assigned: assigned,
    nameCollisionGroups: nameCollisionRows.length, // 同名グループの数
    nameCollisionRows: nameCollisionRows,          // 各グループの行番号のみ（非PII）
  };
}

// ============================================================
// 確定予約の集約（P2・read-only）
// ============================================================

// 来店履歴の遡り期間（月）。既定 12ヶ月・後で調整可（定数）。窓が広くなり過ぎれば要見直し。
var CONFIRMED_HISTORY_MONTHS = 12;

/**
 * 顧客突合トークン。台帳キー（line:/phone:/email:）を SHA-256 の hex 文字列にして返す。
 * 生の識別子（lineUserId・電話・メール）をクライアントへ突合トークンとして出さないための一方向化
 * （PII 最小化・本人判断で採用）。対象は管理ゲート内の owner 自身のデータで脅威モデルが小さいため、
 * 素の SHA-256 hex で十分（salt/HMAC は付けない）。空文字は空文字のまま返す。
 * ※adminListCustomers_（返す key）と adminListConfirmed_（イベント側の突合）で**同一関数**を使うこと。
 */
function hashKey_(rawKey) {
  if (!rawKey) return '';
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, rawKey, Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    hex += ('0' + (bytes[i] & 0xff).toString(16)).slice(-2);
  }
  return hex;
}

/**
 * 確定予約（status===CONFIRMED のカレンダーイベント）を read-only で集約する（P2 顧客管理／ハブ用）。
 * requireAdminToken_ で保護。シート書き込み・カレンダー変更・通知・外部 fetch は一切しない
 * （CalendarApp.getEvents と MENU 参照のみ）。2用途を引数で分岐し payload と計算コストを最小化する:
 *   - params.scope==='today'（ハブ用）: 当日の確定件数だけを返す（{ok:true, count:N}）。顧客 PII は載せない軽量応答。
 *   - params.key（顧客詳細用・来店履歴）: 指定顧客キーに一致する確定イベントだけを、過去
 *     CONFIRMED_HISTORY_MONTHS ヶ月〜今後の窓で読み、[{date,time,menuName}] を新しい順で返す
 *     （{ok:true, visits:[...]}）。他人の来店は混ぜない（PII 最小化）。
 * params.key は adminListCustomers_ が返す opaque な突合トークン（台帳キーの SHA-256 hex）で、各イベントの
 * hashKey_(ledgerKey_(getEventProps_(ev))) と突合する（生の識別子は突合トークンとして出さない・adminListPending_ を雛形にした確定版）。
 */
function adminListConfirmed_(params) {
  params = params || {};
  var cal = CalendarApp.getCalendarById(prop_('CALENDAR_ID'));

  // 用途1: 今日の確定件数（ハブ用・PII なし・当日枠のみ）。件数（数値）だけ返す。
  if (params.scope === 'today') {
    var dayStart = startOfDay_(new Date());
    var dayEnd = addDays_(dayStart, 1);
    var count = cal.getEvents(dayStart, dayEnd).filter(function (ev) {
      return getEventProp_(ev, 'status') === STATUS.CONFIRMED;
    }).length;
    return { ok: true, count: count };
  }

  // 用途2: 顧客詳細の来店履歴。突合は「その person が持つ全 channel キー」の OR（Phase 2 配線）。
  //   - params.matchTokens（配列・非空）があればその集合で OR 突合（Phase 3/4 の複数 channel 対応の土台）。
  //   - 無ければ従来どおり単一 params.key で突合（後方互換）。
  // 【回帰ゼロ】Phase 1 は 1 channel=1 person ゆえ matchTokens は実質 [key]＝単一突合と同結果。空配列や
  //   未指定は key へフォールバックし、"全部一致 0 件"にならないようガードする。
  var tokenSet = {};
  var hasToken = false;
  if (Array.isArray(params.matchTokens)) {
    for (var ti = 0; ti < params.matchTokens.length; ti++) {
      var tk = String(params.matchTokens[ti] || '');
      if (tk) { tokenSet[tk] = true; hasToken = true; }
    }
  }
  if (!hasToken) {
    var key = params.key || '';
    if (!key) return { ok: true, visits: [] };
    tokenSet[key] = true;
  }
  var from = startOfDay_(new Date());
  from.setMonth(from.getMonth() - CONFIRMED_HISTORY_MONTHS); // 過去 N ヶ月まで遡る
  var to = addDays_(startOfDay_(new Date()), RULES.maxAdvanceDays + 1); // 今後の確定予約も含める
  var visits = cal.getEvents(from, to).filter(function (ev) {
    if (getEventProp_(ev, 'status') !== STATUS.CONFIRMED) return false;
    // イベント側の台帳キーも同じ hashKey_ でハッシュ化してから OR 突合（tokenSet はハッシュ済みトークンの集合）。
    return tokenSet[hashKey_(ledgerKey_(getEventProps_(ev)))] === true; // その person の来店だけ（他人の履歴は混ぜない）
  }).map(function (ev) {
    var p = getEventProps_(ev);
    var menu = MENU[p.menuId];
    return {
      date: fmt_(ev.getStartTime(), 'yyyy-MM-dd'),
      time: fmt_(ev.getStartTime(), 'HH:mm'),
      menuName: menu ? menu.name : p.menuId,
    };
  });
  // 新しい順（yyyy-MM-dd + HH:mm の文字列を連結した降順で足りる）。
  visits.sort(function (a, b) {
    return (b.date + b.time).localeCompare(a.date + a.time);
  });
  return { ok: true, visits: visits };
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

/**
 * オーナー通知に載せる3リンク（承認/辞退/メッセージ）を作る。
 *  - 承認/辞退: front /reserve/decision（'decision:' 署名）。複数 Google アカウント時の /u/N/ リダイレクト回避。
 *  - メッセージ: front /reserve/message（'message:' 署名）。
 * 仮予約通知・日時変更通知の両方から使い、リンク生成の重複を作らない。
 * @param {string} token 予約トークン
 * @returns {{approve: string, decline: string, message: string}}
 */
function ownerActionLinks_(token) {
  var decSig = encodeURIComponent(sign_('decision:' + token));
  var base = decisionBaseUrl_();
  var msgBase = prop_('FRONT_BASE_URL').replace(/\/$/, '');
  var msgSig = encodeURIComponent(sign_('message:' + token));
  return {
    approve: base + '?action=approve&token=' + token + '&sig=' + decSig,
    decline: base + '?action=decline&token=' + token + '&sig=' + decSig,
    message: msgBase + '/reserve/message/?token=' + token + '&sig=' + msgSig,
  };
}

/**
 * リンク付きのオーナー「要承認」通知を送る共通関数。仮予約・日時変更の両方から使う。
 * detail（見出し＋お名前/メニュー/日時 等の本文）に承認/辞退/メッセージの3リンクを付けて
 * Discord 優先・失敗時 LINE フォールバックで送信する。ENV_LABEL 先頭付与・顧客PII非掲載は不変。
 *  - Discord: 3リンクをプレーンテキストで併記（テンプレートボタン不可）。
 *  - LINE: 承認/辞退は confirm テンプレの2ボタン、メッセージURLは text に併記
 *    （confirm は2ボタンまでのため。主経路は Discord なので LINE はテキスト併記で足りる）。
 * @param {string} detail 通知本文（ENV_LABEL と3リンクは含めない。呼び出し側で組む）
 * @param {string} token 予約トークン（3リンクの署名素材）
 * @param {{altLabel?: string}} [opts] altLabel: LINE confirm テンプレの altText 用ラベル
 */
function notifyOwnerPendingApproval_(detail, token, opts) {
  opts = opts || {};
  var label = prop_('ENV_LABEL'); // dev のみ【開発】
  var links = ownerActionLinks_(token);
  var body = (label ? label + '\n' : '') + detail;
  // Discord Webhook が設定されていればそちらへ（顧客PIIを LINE の履歴に残さない移行）。
  if (prop_('OWNER_DISCORD_WEBHOOK_URL')) {
    // Discord 送信が成功したら終了。失敗（非2xx/例外で false）なら下の LINE 経路へフォールバックし、
    // オーナー通知を取りこぼさない（通知が静かに消えないようにする恒久ハードニング）。
    if (notifyOwnerDiscord_(body + '\n\n✅ 承認: ' + links.approve + '\n❌ 辞退: ' + links.decline + '\n✉️ メッセージ: ' + links.message)) return;
    body = ownerLineFallbackNote_() + '\n' + body; // Discord失敗→LINE。二重通知の可能性を明記
  }
  // LINE 経路（Discord 未設定 or 送信失敗時のフォールバック）。詳細＋メッセージURLはテキスト、承認/辞退は confirm テンプレのボタンで送る（長いURLを直接見せない）
  linePushMessages_(prop_('LINE_OWNER_USER_ID'), [
    { type: 'text', text: body + '\n\n✉️ お客様へメッセージ: ' + links.message },
    {
      type: 'template',
      altText: (label ? label + ' ' : '') + (opts.altLabel || '要承認の予約'),
      template: {
        type: 'confirm',
        text: 'この予約を承認しますか？\n（ボタンから確認ページが開きます）',
        actions: [
          { type: 'uri', label: '✅ 承認する', uri: links.approve },
          { type: 'uri', label: '❌ 辞退する', uri: links.decline },
        ],
      },
    },
  ], 'owner');
}

function notifyOwnerNewBooking_(token, b, menu, start, end, eff, isFirst) {
  // 顧客PII（電話・メール）は本文に載せない。名前・日時/メニュー・性別・紹介者・要望のみ。
  var detail = '【新規 仮予約】\n' +
    'お名前: ' + b.name + (isFirst ? '（新規）' : '（常連）') + '\n' +
    bookingSummary_(menu, start, eff, isFirst) + '\n' +
    '性別: ' + (b.gender === 'male' ? '男性' : '女性') + (b.gender === 'male' ? '\n紹介者: ' + b.referrer : '') +
    (b.note ? '\n要望: ' + b.note : '');
  notifyOwnerPendingApproval_(detail, token, { altLabel: '仮予約の承認/辞退' });
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
  // 秘密の直接 === 比較を避け、定数時間比較（double-HMAC）に統一する。
  if (!expected || !given || !constEq_(expected, given)) return { ok: false, error: 'forbidden' };
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
 * 監査ログ基盤。顧客台帳ブックの「監査ログ」シートへ1行追記する（logPush_ と同じ流儀）。
 * 顧客PII（全顧客閲覧・伏字解除・カルテ・代理予約）に関わる操作の証跡を残すための土台。
 * 列: 日時 / 操作者 / 操作 / 対象(マスク) / 結果。
 *   - operator: 操作者識別子。**生トークンは絶対に渡さない**。呼び出し側で tokenFp_()（HMAC指紋）や
 *               'via:line' 等のラベルに変換してから渡す。
 *   - op: 操作種別（view | unmask | karteView | karteEdit | proxyBook）。
 *   - target: 顧客キー等。maskId_ でさらに末尾4桁のみに落として記録する。
 *   - result: ok | ng | forbidden 等の結果。
 * ※段階1では関数の新設のみ。実際の呼び出しは顧客系・代理予約を載せる P4/P5 で配線する。
 */
function auditPush_(operator, op, target, result) {
  try {
    var id = prop_('LEDGER_SHEET_ID');
    if (!id) return;
    var ss = SpreadsheetApp.openById(id);
    var sh = ss.getSheetByName('監査ログ');
    if (!sh) {
      sh = ss.insertSheet('監査ログ');
      sh.appendRow(['日時', '操作者', '操作', '対象(マスク)', '結果']);
    }
    sh.appendRow([fmt_(new Date(), 'yyyy-MM-dd HH:mm:ss'), String(operator || ''), String(op || ''), maskId_(target), String(result || '')]);
  } catch (err) { console.error('auditPush_ failed: ' + err); }
}

/**
 * 監査ログの操作者識別子に使う「トークン指紋」。生トークンを残さないため、
 * HMAC（sign_）に通した非可逆・安定なダイジェストの先頭のみを返す。
 * 同一トークンなら同一指紋になるので、操作者の突き合わせには十分機能する。
 */
function tokenFp_(t) { return t ? 'fp:' + sign_(String(t)).slice(0, 12) : ''; }

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
    if (notifyOn_('reminder')) {
      notifyCustomerProps_(props,
        '【ご予約前日のお知らせ】\n明日のご予約です。お気をつけてお越しください。\n' +
        bookingSummary_(menu, ev.getStartTime(), eff, props.isFirstTime === 'true') +
        '\n\n▼ ご予約の確認・変更・キャンセル\n' + manageUrl_(props.token),
        'reminder');
      ev.setTag('reminded', 'true'); // 送ったときだけ処理済みに（OFF→ON再開が直感どおりになる）
    }
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
    if (notifyOn_('followup')) {
      notifyCustomerProps_(props,
        '【ご来店ありがとうございました】\n先日はサロン和笑〜Violane〜をご利用いただき、ありがとうございました。\n' +
        'お身体の調子はいかがでしょうか。またのご来店を心よりお待ちしております。',
        'followup');
      ev.setTag('followedUp', 'true'); // 送ったときだけ処理済みに（OFF→ON再開が直感どおりになる）
    }
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
  if (notifyOn_('ownerDigest')) notifyOwner_(lines.join('\n'));
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
  // 警告送信と月フラグをまとめてゲート＝送ったときだけ警告済みにする（OFF中は月フラグを立てず、ON復帰で再警告できる）。
  if (notifyOn_('ownerQuotaWarn')) {
    notifyOwner_('【LINE無料枠の警告】\n今月の送信数が ' + used + '/' + limit + ' 通に達しました（80%超）。\n上限を超えると追加メッセージは送信されません。');
    PropertiesService.getScriptProperties().setProperty('QUOTA_WARNED_YYYYMM', ym);
  }
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

/** 通知トグルの設定ストア（専用キー NOTIFY_CONFIG・SLOT_CONFIG とは別枠）。失敗時 {}。 */
function readNotifyConfig_() {
  try { return JSON.parse(prop_('NOTIFY_CONFIG') || '{}'); } catch (_) { return {}; }
}

/** 任意通知の送信可否。未設定/true は送る・明示 false のみ抑止（既定ON＝未設定時は現行挙動を厳密維持）。 */
function notifyOn_(key) {
  var c = readNotifyConfig_();
  return c[key] !== false;
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

/**
 * 定数時間比較（double-HMAC）。
 * 生の秘密同士を `===` / `indexOf` で比べると「先頭から何文字一致したか」で処理時間が変わり、
 * タイミング攻撃で秘密を1文字ずつ推測される足がかりになる。そこで双方を一旦 sign_()
 * （HMAC-SHA256 → 固定長 base64url）に通し、得られた同一長ダイジェスト同士をバイト単位で
 * 差分積算して比較する（一致・不一致にかかわらず全長を走査＝早期 return しない）。
 * sign_ の出力は攻撃者に予測不能なため、比較の分岐時間から元の秘密は復元できない。
 */
function constEq_(a, b) {
  var ha = sign_(String(a == null ? '' : a));
  var hb = sign_(String(b == null ? '' : b));
  if (ha.length !== hb.length) return false; // sign_ は常に同一長（32byte → base64url 43文字）
  var diff = 0;
  for (var i = 0; i < ha.length; i++) diff |= (ha.charCodeAt(i) ^ hb.charCodeAt(i));
  return diff === 0;
}

// capability 署名の検証。期待署名 sign_(data) と提示署名 sig を定数時間（double-HMAC）で比較する。
function verifySig_(data, sig) { return !!sig && constEq_(sign_(data), sig); }

// 日付ユーティリティ（スクリプトTZ=Asia/Tokyo 前提）
function fmt_(d, pat) { return Utilities.formatDate(d, TZ, pat); }
function parseDate_(s) { var a = s.split('-'); return new Date(Number(a[0]), Number(a[1]) - 1, Number(a[2])); }
function atTime_(d, hhmm) { var a = hhmm.split(':'); var x = new Date(d); x.setHours(Number(a[0]), Number(a[1]), 0, 0); return x; }
function startOfDay_(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays_(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
