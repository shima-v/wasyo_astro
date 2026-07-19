// [QA・独立検証] gas/Code.gs の連絡手段(channel)「削除／編集」A案（＝過去のご来店履歴を切らさない）の
// 不変条件を、実装者(CTO)のテストとは独立に「仕様・不変条件側」から敵対的に崩しにいくユニットテスト。
//
// 方針: CTO の customer-contact-archive.test.js を"なぞらない"。CTO が緑にしていない境界・複数 channel・
//   フェイルセーフの穴・handover との相互作用・冪等シーケンスを自分でケース化する。実 GAS・実台帳・実
//   カレンダーには一切触れない（VM サンドボックス＋インメモリのフェイク）。ダミーは架空の一般例のみ
//   （実顧客 PII なし。電話=0901111xxxx 系・メール=name@example.com 系）。
//
// 置き場所は src/ 配下（`node --test "src/**/*.test.js"` が拾う）。gas/ に置くと clasp push で Apps Script
// 側へ流出するため置かない（CTO 版と同じ制約）。ファイル名 qa- 接頭辞＝QA が独立に追加したものと分かるように。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import { createHash, createHmac, randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CODE_PATH = resolve(__dirname, '../../gas/Code.gs');
const SOURCE = readFileSync(CODE_PATH, 'utf8');

// col0..8 = key|type|name|firstVisit|count|lastVisit|note|personId|status（status=A案の追加列）。
const HEADER = ['key', 'type', 'name', 'firstVisit', 'count', 'lastVisit', 'note', 'personId', 'status'];
const ADMIN = 'test-admin-token';

// ---- CTO 版と同型の最小フェイク（Sheet/Spreadsheet/Calendar/Utilities）----
class FakeSheet {
  constructor(name, rows) { this.name = name; this.rows = rows.map((r) => r.slice()); }
  getName() { return this.name; }
  getDataRange() { const rows = this.rows; return { getValues: () => rows.map((r) => r.slice()) }; }
  getRange(row, col, numRows, numCols) {
    const sheet = this;
    if (numRows == null && numCols == null) {
      return {
        getValue: () => { const r = sheet.rows[row - 1]; return r && r[col - 1] != null ? r[col - 1] : ''; },
        setValue: (v) => { sheet._ensure(row - 1, col - 1); sheet.rows[row - 1][col - 1] = v; },
        getValues: () => [[(sheet.rows[row - 1] || [])[col - 1]]],
      };
    }
    const nr = numRows || 1; const nc = numCols || 1;
    return {
      getValues: () => {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const src = sheet.rows[row - 1 + i] || []; const line = [];
          for (let j = 0; j < nc; j++) line.push(src[col - 1 + j] != null ? src[col - 1 + j] : '');
          out.push(line);
        }
        return out;
      },
      setValue: (v) => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) { sheet._ensure(row - 1 + i, col - 1 + j); sheet.rows[row - 1 + i][col - 1 + j] = v; } },
    };
  }
  appendRow(arr) { this.rows.push(arr.slice()); }
  deleteRow(rowPosition) { this.rows.splice(rowPosition - 1, 1); }
  _ensure(ri, ci) { while (this.rows.length <= ri) this.rows.push([]); const row = this.rows[ri]; while (row.length <= ci) row.push(''); }
}
class FakeSpreadsheet {
  constructor(ledger) { this.sheets = [ledger]; }
  getSheets() { return this.sheets; }
  getSheetByName(name) { return this.sheets.find((s) => s.getName() === name) || null; }
  insertSheet(name, index) { const sh = new FakeSheet(name, []); if (index == null || index >= this.sheets.length) this.sheets.push(sh); else this.sheets.splice(index, 0, sh); return sh; }
}
function fakeEvent(tags, start) { return { getTag: (k) => (k in tags ? tags[k] : ''), getStartTime: () => start }; }

// propsOverride で CALENDAR_ID を消す／calNull で getCalendarById を null にできる（フェイルセーフ検証用）。
function buildCtx(ledgerRows, events, opts) {
  opts = opts || {};
  events = events || [];
  const ledger = new FakeSheet('台帳', ledgerRows);
  const ss = new FakeSpreadsheet(ledger);
  const props = {
    LEDGER_SHEET_ID: 'sheet-id', HMAC_SECRET: 'test-hmac-secret', ADMIN_TOKENS: 'test-admin-token',
    CALENDAR_ID: 'cal-id', REGULAR_MIN_VISITS: '2',
  };
  if (opts.noCalendarId) delete props.CALENDAR_ID;
  const toSigned = (buf) => Array.from(buf).map((b) => (b > 127 ? b - 256 : b));
  const cal = { getEvents: (from, to) => events.filter((e) => e.getStartTime() >= from && e.getStartTime() < to) };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    SpreadsheetApp: { openById: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CalendarApp: { getCalendarById: () => (opts.calNull ? null : cal) },
    Utilities: {
      getUuid: () => randomUUID(),
      computeDigest: (_algo, str) => Array.from(createHash('sha256').update(String(str), 'utf8').digest()),
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      computeHmacSha256Signature: (data, keyStr) => toSigned(createHmac('sha256', String(keyStr)).update(String(data)).digest()),
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes.map((b) => b & 0xff)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      formatDate: (d, _tz, pat) => { const p = (n) => String(n).padStart(2, '0'); return String(pat).replace('yyyy', d.getFullYear()).replace('MM', p(d.getMonth() + 1)).replace('dd', p(d.getDate())).replace('HH', p(d.getHours())).replace('mm', p(d.getMinutes())).replace('ss', p(d.getSeconds())); },
    },
    UrlFetchApp: {}, MailApp: {}, ContentService: {}, HtmlService: {},
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SOURCE, ctx, { filename: 'Code.gs' });
  return { ctx, ss, ledger };
}
function dataRows(ledger) { return ledger.rows.slice(1).filter((r) => r[0]); }
function daysAgo(n) { const d = new Date(); d.setHours(10, 0, 0, 0); d.setDate(d.getDate() - n); return d; }
// 一覧から突合トークン tk を含む person エントリを取る（active/archived 問わず）。
function findByToken(list, tk) { return list.find((c) => (c.matchTokens || []).includes(tk)); }

// ============================================================
// 観点1: 削除で履歴が残る（複数 channel＝名寄せ後にも切れない）— CTO は単一 channel のみ検証
// ============================================================
test('QA-1 観点1: active 電話＋active メールの person でメールを削除しても、両方の来店履歴が残り count が減らない', () => {
  const { ctx, ledger } = buildCtx(
    [
      HEADER,
      ['phone:09011112222', 'phone', '山田', '2026-01-01', 2, '2026-05-01', '', 'pid-A'],
      ['email:aaa@example.com', 'email', '山田', '2026-02-01', 1, '2026-06-01', '', 'pid-A'],
    ],
    [
      fakeEvent({ status: 'confirmed', phone: '09011112222' }, daysAgo(120)),
      fakeEvent({ status: 'confirmed', phone: '09011112222' }, daysAgo(60)),
      fakeEvent({ status: 'confirmed', email: 'aaa@example.com' }, daysAgo(20)),
    ],
  );
  const phoneTok = ctx.hashKey_('phone:09011112222');
  const emailTok = ctx.hashKey_('email:aaa@example.com');

  // 削除前スナップショット（col0〜7）を控える＝不変検証に使う。
  const before = ledger.rows.map((r) => r.slice());

  const res = ctx.adminDeleteContact_({ adminToken: ADMIN, key: emailTok });
  assert.equal(res.ok, true);
  assert.equal(res.archived, true, '履歴があるのでアーカイブ');

  const rows = dataRows(ledger);
  assert.equal(rows.length, 2, 'アーカイブは行を消さない');
  const phoneRow = rows.find((r) => r[0] === 'phone:09011112222');
  const emailRow = rows.find((r) => r[0] === 'email:aaa@example.com');
  // col0〜7 不変（削除対象メール行も含め、identity 層は一切変えない）。
  for (let ci = 0; ci <= 7; ci++) {
    assert.equal(String(phoneRow[ci]), String(before[1][ci]), `電話行 col${ci} 不変`);
    assert.equal(String(emailRow[ci]), String(before[2][ci]), `メール行 col${ci} 不変`);
  }
  assert.equal(emailRow[8], 'archived', '削除したメール行だけ col8=archived');
  assert.ok(!phoneRow[8], '電話行は active のまま');

  // 一覧: person の matchTokens は active＋archived の和集合（両キー）で、全来店(3件)へ到達する。
  const list = ctx.adminListCustomers_().customers;
  const activeEntry = list.find((c) => c.phone === '09011112222');
  assert.ok(activeEntry, 'active 電話エントリが残る');
  assert.ok(activeEntry.matchTokens.includes(phoneTok) && activeEntry.matchTokens.includes(emailTok), 'matchTokens に旧メールキーが残る');
  assert.equal(ctx.adminListConfirmed_({ matchTokens: activeEntry.matchTokens }).visits.length, 3, '削除後も来店3件すべてに到達（履歴が切れない）');
  // アーカイブ済みメール行の count(=1)・electric は保持（減っていない）。
  const archEntry = findByToken(list, emailTok);
  assert.equal(archEntry.count, 1, 'アーカイブ行の count は不変');
  assert.equal(archEntry.email, undefined, 'archived は連絡先値を出さない');
});

// ============================================================
// 観点2: 送信先から外れる（LINE・phone・複数 type・scope・active 兄弟の生存）
// ============================================================
test('QA-2 観点2: archived は line/phone/email 全 type・all/regulars 全 scope で送信先から外れ、active 兄弟は残る', () => {
  const { ctx } = buildCtx(
    [
      HEADER,
      // active な兄弟（残るべき）と archived（外れるべき）を type ごとに用意。
      ['line:Uactive', 'line', '常連A', '2026-01-01', 5, '2026-06-01', '', 'pid-1'],
      ['line:Uarch', 'line', '常連B', '2026-01-01', 5, '2026-06-01', '', 'pid-2', 'archived'],
      ['email:live@example.com', 'email', '常連C', '2026-01-01', 5, '2026-06-01', '', 'pid-3'],
      ['email:dead@example.com', 'email', '常連C', '2026-01-01', 3, '2026-06-01', '', 'pid-3', 'archived'],
      ['phone:09033334444', 'phone', '常連D', '2026-01-01', 4, '2026-06-01', '', 'pid-4', 'archived'],
    ],
    [],
  );
  const all = ctx.broadcastRecipients_('all');
  const reg = ctx.broadcastRecipients_('regulars');
  for (const rec of [all, reg]) {
    assert.ok(rec.lineUserIds.includes('Uactive'), 'active な LINE は送信先に残る');
    assert.ok(!rec.lineUserIds.includes('Uarch'), 'archived な LINE は送信先から外れる');
    assert.ok(rec.emails.includes('live@example.com'), 'active なメールは残る');
    assert.ok(!rec.emails.includes('dead@example.com'), 'archived なメールは外れる（同一 person の別経路でも復活しない）');
  }
  // archived phone は unreachable にも計上しない（continue が threshold/unreachable より前）。
  assert.equal(all.lineUserIds.length + all.emails.length, all.total, 'archived phone は total を膨らませない（unreachable 加算されない）');
  assert.equal(all.unreachable, 0, 'archived phone は unreachable に数えない');
});

// ============================================================
// 観点3: フェイルセーフ（判定不能→安全側アーカイブ）
// ============================================================
test('QA-3 観点3: CALENDAR_ID 未設定でも履歴判定不能→物理削除せずアーカイブ（安全側）', () => {
  const { ctx, ledger } = buildCtx(
    [HEADER, ['phone:09055556666', 'phone', '田中', '2026-05-01', 1, '2026-05-01', '', 'pid-X']],
    [],
    { noCalendarId: true },
  );
  const token = ctx.hashKey_('phone:09055556666');
  const res = ctx.adminDeleteContact_({ adminToken: ADMIN, key: token });
  assert.equal(res.ok, true);
  assert.equal(res.archived, true, 'カレンダー未設定＝判定不能→アーカイブへ倒す（物理削除しない）');
  assert.equal(dataRows(ledger).length, 1, '行は残る');
  assert.equal(dataRows(ledger)[0][8], 'archived');
});
test('QA-3b 観点3: getCalendarById が null でも判定不能→アーカイブ（安全側）', () => {
  const { ctx, ledger } = buildCtx(
    [HEADER, ['phone:09055556666', 'phone', '田中', '2026-05-01', 1, '2026-05-01', '', 'pid-X']],
    [],
    { calNull: true },
  );
  const token = ctx.hashKey_('phone:09055556666');
  const res = ctx.adminDeleteContact_({ adminToken: ADMIN, key: token });
  assert.equal(res.archived, true, 'カレンダー取得不可＝判定不能→アーカイブ');
  assert.equal(dataRows(ledger).length, 1);
});

// ============================================================
// 観点3 の穴（F-1 修正の回帰ガード）: 台帳 col4(count)>0 / col3(firstVisit) を履歴の証跡として使い、
//   Calendar 窓外の常連でも物理削除せずアーカイブ＝person も来店回数も失わない。
//   （旧実装は channelHasHistory_ の12ヶ月窓しか見ず物理削除していた＝A案不変条件に抵触。修正済み。）
// ============================================================
test('QA-4 観点3: 最終来店>12ヶ月前の常連(count=8)の唯一の連絡先を削除してもアーカイブされ person と回数が残る', () => {
  const { ctx, ledger } = buildCtx(
    [HEADER, ['phone:09077778888', 'phone', '常連老舗', '2023-01-01', 8, '2025-04-01', '', 'pid-L']],
    // 来店は実在するが 400日前＝channelHasHistory_ の12ヶ月窓の外。窓内 CONFIRMED は0件。だが台帳 count=8 が証跡。
    [fakeEvent({ status: 'confirmed', phone: '09077778888' }, daysAgo(400))],
  );
  const token = ctx.hashKey_('phone:09077778888');

  // 削除前: 一覧に count=8 で存在。
  const before = ctx.adminListCustomers_().customers;
  assert.equal(before.length, 1);
  assert.equal(before[0].count, 8);

  const res = ctx.adminDeleteContact_({ adminToken: ADMIN, key: token });
  assert.equal(res.ok, true);
  assert.equal(res.archived, true, 'count>0＝履歴の証跡ありとしてアーカイブ（窓外でも物理削除しない）');
  assert.equal(dataRows(ledger).length, 1, '行は残る');
  assert.equal(dataRows(ledger)[0][8], 'archived');

  // ★不変条件: person は一覧に残り、count(=8) は保持される（減らない）。
  const after = ctx.adminListCustomers_().customers;
  assert.equal(after.length, 1, 'person が一覧に残る');
  const entry = findByToken(after, token);
  assert.equal(entry.count, 8, 'count=8 が保持される（履歴が失われない）');
});
test('QA-4b 観点3: count=1 で Calendar に一致イベントが無くてもアーカイブされ person が残る', () => {
  // 例: 予約確定で台帳 count=1 になった後にカレンダー予定が取消/削除されたケース（台帳 count が証跡として残る）。
  const { ctx, ledger } = buildCtx(
    [HEADER, ['email:onceonly@example.com', 'email', '一度きり', '2026-03-01', 1, '2026-03-01', '', 'pid-1']],
    [], // カレンダー側に対応イベント無し
  );
  const token = ctx.hashKey_('email:onceonly@example.com');
  const res = ctx.adminDeleteContact_({ adminToken: ADMIN, key: token });
  assert.equal(res.archived, true, 'count>0/firstVisit あり＝履歴の証跡ありとしてアーカイブ');
  assert.equal(dataRows(ledger).length, 1, '行は残る');
  const entry = findByToken(ctx.adminListCustomers_().customers, token);
  assert.ok(entry, 'person が一覧に残る（台帳 count=1 の証跡が失われない）');
  assert.equal(entry.count, 1);
});
// 全ゼロ（count0・firstVisit空・カレンダー一致なし）の純粋な打ち間違いだけは物理削除される（境界の下側）。
test('QA-4c 観点3: 全ゼロ（count0・firstVisit空・一致なし）の打ち間違いのみ物理削除', () => {
  const { ctx, ledger } = buildCtx(
    [HEADER, ['email:typo@example.com', 'email', '', '', 0, '', '', 'pid-Z']],
    [],
  );
  const token = ctx.hashKey_('email:typo@example.com');
  const res = ctx.adminDeleteContact_({ adminToken: ADMIN, key: token });
  assert.equal(res.archived, false, '証跡ゼロ→物理削除');
  assert.equal(dataRows(ledger).length, 0, '行が消える（失う履歴が無い）');
});

// ============================================================
// 観点4/観点5（F-2 修正の回帰ガード）: 編集先が「同一 person の archived エイリアスと同じキー」の場合
//   → その archived エイリアスを **再アクティブ化**（col8→active）し、編集元(旧)をアーカイブ＝正しい差し替え。
//   （旧実装は unchanged で no-op のままフロントが偽の成功トーストを出していた＝サイレント no-op。修正済み。）
// ============================================================
test('QA-5 観点5: 編集先が同一 person の archived エイリアス→ 再アクティブ化＋旧アーカイブで正しく差し替わる', () => {
  const { ctx, ledger } = buildCtx(
    [
      HEADER,
      ['phone:09011112222', 'phone', '佐藤', '2026-01-01', 3, '2026-06-01', '', 'pid-A'],            // active（代表）
      ['email:old@example.com', 'email', '佐藤', '2026-01-01', 3, '2026-06-01', '', 'pid-A', 'archived'], // 過去に削除した自分のメール
    ],
    // old メールに過去の来店1件（再アクティブ化後も履歴が引ける確認用）
    [fakeEvent({ status: 'confirmed', email: 'old@example.com' }, daysAgo(30))],
  );
  const phoneTok = ctx.hashKey_('phone:09011112222');
  const emailTok = ctx.hashKey_('email:old@example.com');

  // 店主「電話→old@example.com に差し替え」。old は自分の archived エイリアスと同キー。
  const res = ctx.adminEditContact_({ adminToken: ADMIN, key: phoneTok, contactType: 'email', value: 'old@example.com' });
  assert.equal(res.ok, true);
  assert.equal(res.reactivated, true, 'archived エイリアスを再アクティブ化（unchanged ではない）');
  assert.ok(!res.unchanged, '偽の no-op ではない＝フロントは正当な成功表示になる');

  const rows = dataRows(ledger);
  assert.equal(rows.length, 2, '新 channel は増やさない（既存 archived を復活させる）');
  const phoneRow = rows.find((r) => r[0] === 'phone:09011112222');
  const emailRow = rows.find((r) => r[0] === 'email:old@example.com');
  assert.equal(phoneRow[8], 'archived', '旧(電話)はアーカイブされる＝差し替え完了');
  assert.ok(!emailRow[8], 'archived エイリアスは active に復活する（有効な連絡先になる）');
  // col0〜7 は不変（identity 層は触らない・状態列 col8 のみ動く）。
  assert.equal(emailRow[7], 'pid-A');

  // 一覧: 有効な連絡先＝復活した old メール。旧電話・旧メール双方の履歴に到達（切れない）。
  const list = ctx.adminListCustomers_().customers;
  const activeEntry = list.find((c) => c.email === 'old@example.com');
  assert.ok(activeEntry, '復活したメールが有効な連絡先として出る');
  assert.equal(activeEntry.status, 'active');
  assert.ok(activeEntry.matchTokens.includes(phoneTok) && activeEntry.matchTokens.includes(emailTok), 'matchTokens に新旧両キー');
});

// ============================================================
// 観点4: 変更先キーを「別 person の archived channel」が使用中でも key_conflict で拒否（履歴の誤ルート防止）
// ============================================================
test('QA-6 観点4: 別 person の archived メールへ差し替えようとしても key_conflict（archived もキーを予約し続ける）', () => {
  const { ctx, ledger } = buildCtx(
    [
      HEADER,
      ['phone:09011112222', 'phone', 'A', '2026-01-01', 3, '2026-06-01', '', 'pid-A'],
      ['email:shared@example.com', 'email', 'B', '2026-02-01', 2, '2026-05-01', '', 'pid-B', 'archived'], // 別人Bが過去に削除
    ],
    [],
  );
  const aTok = ctx.hashKey_('phone:09011112222');
  const res = ctx.adminEditContact_({ adminToken: ADMIN, key: aTok, contactType: 'email', value: 'shared@example.com' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'key_conflict', 'archived でも別 person のキーは予約されたまま＝誤統合防止で拒否（妥当）');
  const rows = dataRows(ledger);
  assert.ok(!rows.find((r) => r[0] === 'phone:09011112222')[8], '拒否時は A の電話をアーカイブしない');
});

// ============================================================
// 観点5: handover（名寄せ引き継ぎ）と archived の相互作用【論点提示】
//   handoverLookupByEmail_ は col8(status) を見ない＝archived な email キーでも「過去 person」として拾う。
//   → 店主が削除(アーカイブ)した email でも、その email を LINE idToken で attested できるお客様は
//     引き継ぎで過去履歴を復元できる。A案の「キーは matchTokens に残す」思想とは整合するが、
//     「連絡先を削除したのに引き継げる」点は設計判断が要る。挙動を確定的に固定して報告する。
// ============================================================
test('QA-7 観点5【論点】: archived な email キーでも handoverLookupByEmail_ は過去 person として拾う', () => {
  const { ctx } = buildCtx(
    [
      HEADER,
      ['email:kept@example.com', 'email', '過去客', '2026-01-01', 4, '2026-05-01', '', 'pid-P', 'archived'],
    ],
    [],
  );
  const hit = ctx.handoverLookupByEmail_('email:kept@example.com');
  assert.equal(hit.found, true, '【実挙動】archived でも email キーは過去 person として引ける');
  assert.equal(hit.pid, 'pid-P');
  assert.equal(hit.count, 4, 'count はアーカイブ行/ person 集約から復元される');
  // personIdForKey_ も archived を無視せず pid を返す（alreadyLinked 判定が archived でも機能する）。
  assert.equal(ctx.personIdForKey_('email:kept@example.com'), 'pid-P');
});

// ============================================================
// 観点5: 冪等シーケンス（削除→編集→削除／二重削除）で台帳が壊れず履歴が保たれる
// ============================================================
test('QA-8 観点5: 削除(アーカイブ)→そのキーを編集で差し替え→新 channel が増え person と履歴は保たれる', () => {
  const { ctx, ledger } = buildCtx(
    [HEADER, ['phone:09011112222', 'phone', '佐藤', '2026-01-01', 3, '2026-06-01', '', 'pid-A']],
    [
      fakeEvent({ status: 'confirmed', phone: '09011112222' }, daysAgo(50)),
      fakeEvent({ status: 'confirmed', phone: '09011112222' }, daysAgo(10)),
    ],
  );
  const oldTok = ctx.hashKey_('phone:09011112222');

  // ① 削除（履歴あり→アーカイブ）
  const d1 = ctx.adminDeleteContact_({ adminToken: ADMIN, key: oldTok });
  assert.equal(d1.archived, true);
  // ② 二重削除（既 archived→ unchanged・冪等）
  const d2 = ctx.adminDeleteContact_({ adminToken: ADMIN, key: oldTok });
  assert.equal(d2.unchanged, true, '二重削除は無操作（冪等）');
  assert.equal(dataRows(ledger).length, 1, '二重削除で行が増減しない');
  // ③ archived なキーを編集で差し替え（新 email を追加）
  const e1 = ctx.adminEditContact_({ adminToken: ADMIN, key: oldTok, contactType: 'email', value: 'revived@example.com' });
  assert.equal(e1.ok, true);
  const rows = dataRows(ledger);
  assert.equal(rows.length, 2, 'archived 元＋新 email＝2行');
  const newRow = rows.find((r) => r[0] === 'email:revived@example.com');
  assert.equal(newRow[7], 'pid-A', '新 channel も同一 person にぶら下がる');
  assert.ok(!newRow[8], '新 channel は active');
  // 履歴: person の matchTokens union で旧電話の来店2件に引き続き到達（切れていない）。
  const list = ctx.adminListCustomers_().customers;
  const activeEntry = list.find((c) => c.email === 'revived@example.com');
  assert.ok(activeEntry.matchTokens.includes(oldTok), 'matchTokens に旧電話キーが残る');
  assert.equal(ctx.adminListConfirmed_({ matchTokens: activeEntry.matchTokens }).visits.length, 2, '旧電話の来店履歴に到達（回数保持）');
});

// ============================================================
// 観点5: LINE channel（連絡先値なし type）の削除
//   UI は LINE 行に編集/削除ボタンを出さない（contactRow は active な phone/email だけ）が、
//   GAS エンドポイントは line キーも受理する。挙動を確定させ、broadcast からの離脱も確認する。
// ============================================================
test('QA-9 観点5: 履歴のある LINE channel を削除するとアーカイブされ、broadcast の lineUserIds から外れる', () => {
  const { ctx, ledger } = buildCtx(
    [HEADER, ['line:Ubff9', 'line', 'LINE客', '2026-01-01', 3, '2026-06-01', '', 'pid-L']],
    [fakeEvent({ status: 'confirmed', lineUserId: 'Ubff9' }, daysAgo(30))],
  );
  const token = ctx.hashKey_('line:Ubff9');
  // 削除前は送信先に含まれる。
  assert.ok(ctx.broadcastRecipients_('all').lineUserIds.includes('Ubff9'));
  const res = ctx.adminDeleteContact_({ adminToken: ADMIN, key: token });
  assert.equal(res.archived, true, 'LINE の来店履歴があるのでアーカイブ');
  assert.equal(dataRows(ledger)[0][8], 'archived');
  assert.ok(!ctx.broadcastRecipients_('all').lineUserIds.includes('Ubff9'), 'archived LINE は送信先から外れる');
  // person は一覧に残り count 保持。
  const entry = findByToken(ctx.adminListCustomers_().customers, token);
  assert.ok(entry, 'LINE 客も person は消えない');
  assert.equal(entry.count, 3);
});

// ============================================================
// 観点5: 監査ログ（auditPush_）の付与を behavioral に確認（削除=contactDelete / 編集=contactEdit）
// ============================================================
test('QA-11 観点5: 削除・編集は監査ログを1行ずつ残す（contactDelete / contactEdit）', () => {
  const { ctx, ss } = buildCtx(
    [HEADER, ['phone:09011112222', 'phone', '佐藤', '2026-01-01', 3, '2026-06-01', '', 'pid-A']],
    [fakeEvent({ status: 'confirmed', phone: '09011112222' }, daysAgo(10))],
  );
  const tok = ctx.hashKey_('phone:09011112222');
  ctx.adminDeleteContact_({ adminToken: ADMIN, key: tok });                                   // → archived
  ctx.adminEditContact_({ adminToken: ADMIN, key: tok, contactType: 'email', value: 'x@example.com' }); // → add 新
  const audit = ss.getSheetByName('監査ログ');
  assert.ok(audit, '監査ログシートが作られる');
  const ops = audit.rows.slice(1).map((r) => String(r[2])); // 列3=操作種別
  assert.ok(ops.includes('contactDelete'), '削除は contactDelete を記録');
  assert.ok(ops.includes('contactEdit'), '編集は contactEdit を記録');
  // 監査 target はマスク済み（生の突合トークン全体を残さない）。
  const delRow = audit.rows.slice(1).find((r) => r[2] === 'contactDelete');
  assert.ok(String(delRow[3]).startsWith('****'), '対象はマスクされる（生トークンを残さない）');
});

// ============================================================
// 観点4: 編集の保存性（type をまたぐ差し替えで旧新どちらの履歴にも到達する）
// ============================================================
test('QA-10 観点4: email→phone の差し替えでも、旧 email と新 phone 双方の来店履歴に person から到達する', () => {
  const { ctx } = buildCtx(
    [HEADER, ['email:multi@example.com', 'email', '複数媒体', '2026-01-01', 1, '2026-06-01', '', 'pid-M']],
    [
      fakeEvent({ status: 'confirmed', email: 'multi@example.com' }, daysAgo(40)),
      // 新 phone にも将来の確定来店がある想定（差し替え後の新キーで突合できることの確認）。
      fakeEvent({ status: 'confirmed', phone: '09099990000' }, daysAgo(5)),
    ],
  );
  const oldTok = ctx.hashKey_('email:multi@example.com');
  const res = ctx.adminEditContact_({ adminToken: ADMIN, key: oldTok, contactType: 'phone', value: '090-9999-0000' });
  assert.equal(res.ok, true, 'ハイフン入り電話も normalizePhone_ で正規化して受理');
  const list = ctx.adminListCustomers_().customers;
  const activeEntry = list.find((c) => c.phone === '09099990000');
  assert.ok(activeEntry, '新 phone(正規化済) の active エントリが出る');
  assert.equal(activeEntry.status, 'active');
  // 旧 email の来店(1)＋新 phone の来店(1)＝2件に person 単位で到達。
  assert.equal(ctx.adminListConfirmed_({ matchTokens: activeEntry.matchTokens }).visits.length, 2, '旧 email と新 phone 双方の履歴に到達');
});
