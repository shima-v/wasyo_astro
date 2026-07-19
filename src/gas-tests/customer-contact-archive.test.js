// gas/Code.gs の連絡手段(channel)の「削除／編集」（A案＝過去のご来店履歴を絶対に切らさない）のユニットテスト。
//
// gas/Code.gs は Apps Script の非モジュール（export 無しのグローバル関数群）なので、ソースを読み込んで vm
// サンドボックス上で評価し、GAS 側グローバル（SpreadsheetApp / LockService / Utilities / PropertiesService /
// CalendarApp）をインメモリのフェイクで差し替えて関数を直接呼ぶ。実 GAS・実台帳・実カレンダーには一切触れない。
// ※テストは実装から独立に「仕様側」からケースを起こす（A案の不変条件＝削除・編集で来店履歴の紐づけを切らさない
//   ／来店回数が減らない／カレンダー原本は read-only ／col0〜7 不変・アーカイブは col8 に append のみ）。
// ダミーは架空の一般例のみ（実顧客 PII なし。電話=09012345678 系・メール=name@example.com 系）。
//
// 置き場所は src/ 配下（既存 test 構成 `node --test "src/**/*.test.js"` が拾う）。gas/ に置くと .claspignore が
// 無いため clasp push で Apps Script 側へ流出してしまうので置かない。
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

// 台帳（channel）の列見出し。col0..8 = key|type|name|firstVisit|count|lastVisit|note|personId|status。
// status（col8）は A案の追加列（append-only・非破壊）。空/未設定=active、'archived'=無効化。
const HEADER = ['key', 'type', 'name', 'firstVisit', 'count', 'lastVisit', 'note', 'personId', 'status'];

// ---- インメモリの Spreadsheet フェイク（GAS の Sheet/Spreadsheet の必要最小 API だけ実装） ----
class FakeSheet {
  constructor(name, rows) { this.name = name; this.rows = rows.map((r) => r.slice()); }
  getName() { return this.name; }
  getDataRange() {
    const rows = this.rows;
    return { getValues: () => rows.map((r) => r.slice()) };
  }
  getRange(row, col, numRows, numCols) {
    const sheet = this;
    if (numRows == null && numCols == null) {
      return {
        getValue: () => { const r = sheet.rows[row - 1]; return r && r[col - 1] != null ? r[col - 1] : ''; },
        setValue: (v) => { sheet._ensure(row - 1, col - 1); sheet.rows[row - 1][col - 1] = v; },
        getValues: () => [[(sheet.rows[row - 1] || [])[col - 1]]],
      };
    }
    const nr = numRows || 1;
    const nc = numCols || 1;
    return {
      getValues: () => {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const src = sheet.rows[row - 1 + i] || [];
          const line = [];
          for (let j = 0; j < nc; j++) line.push(src[col - 1 + j] != null ? src[col - 1 + j] : '');
          out.push(line);
        }
        return out;
      },
      setValue: (v) => {
        for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) { sheet._ensure(row - 1 + i, col - 1 + j); sheet.rows[row - 1 + i][col - 1 + j] = v; }
      },
    };
  }
  appendRow(arr) { this.rows.push(arr.slice()); }
  deleteRow(rowPosition) { this.rows.splice(rowPosition - 1, 1); } // 物理削除（履歴の無い channel のみ呼ぶ）
  _ensure(ri, ci) {
    while (this.rows.length <= ri) this.rows.push([]);
    const row = this.rows[ri];
    while (row.length <= ci) row.push('');
  }
}

class FakeSpreadsheet {
  constructor(ledger) { this.sheets = [ledger]; } // getSheets()[0] が台帳になるよう先頭に置く
  getSheets() { return this.sheets; }
  getSheetByName(name) { return this.sheets.find((s) => s.getName() === name) || null; }
  insertSheet(name, index) {
    const sh = new FakeSheet(name, []);
    if (index == null || index >= this.sheets.length) this.sheets.push(sh);
    else this.sheets.splice(index, 0, sh);
    return sh;
  }
}

// カレンダーの確定イベント（来店履歴の原本）のフェイク。getTag(tags) と getStartTime() だけ実装。
// tags は { status:'confirmed', phone:'...', email:'...' } 等。getEventProps_ が拾う。
function fakeEvent(tags, start) {
  return { getTag: (k) => (k in tags ? tags[k] : ''), getStartTime: () => start };
}

// 与えた台帳行＋カレンダーイベントから Code.gs を評価した独立コンテキストを作る（テストごとに新規）。
function buildCtx(ledgerRows, events) {
  events = events || [];
  const ledger = new FakeSheet('台帳', ledgerRows);
  const ss = new FakeSpreadsheet(ledger);
  const props = {
    LEDGER_SHEET_ID: 'sheet-id', HMAC_SECRET: 'test-hmac-secret', ADMIN_TOKENS: 'test-admin-token',
    CALENDAR_ID: 'cal-id', REGULAR_MIN_VISITS: '2',
  };
  const toSigned = (buf) => Array.from(buf).map((b) => (b > 127 ? b - 256 : b));
  const cal = { getEvents: (from, to) => events.filter((e) => e.getStartTime() >= from && e.getStartTime() < to) };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    SpreadsheetApp: { openById: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CalendarApp: { getCalendarById: () => cal },
    Utilities: {
      getUuid: () => randomUUID(),
      computeDigest: (_algo, str) => Array.from(createHash('sha256').update(String(str), 'utf8').digest()),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeHmacSha256Signature: (data, keyStr) => toSigned(createHmac('sha256', String(keyStr)).update(String(data)).digest()),
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes.map((b) => b & 0xff)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      formatDate: (d, _tz, pat) => {
        const p = (n) => String(n).padStart(2, '0');
        return String(pat).replace('yyyy', d.getFullYear()).replace('MM', p(d.getMonth() + 1)).replace('dd', p(d.getDate()))
          .replace('HH', p(d.getHours())).replace('mm', p(d.getMinutes())).replace('ss', p(d.getSeconds()));
      },
    },
    UrlFetchApp: {}, MailApp: {}, ContentService: {}, HtmlService: {},
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SOURCE, ctx, { filename: 'Code.gs' });
  return { ctx, ss, ledger };
}

// 台帳のデータ行（ヘッダ除き・キーのある行）だけを返す。
function dataRows(ledger) { return ledger.rows.slice(1).filter((r) => r[0]); }
// 窓内の確定来店イベントを作る（12ヶ月遡り〜+60日の内側になるよう「昨日」を使う）。
function daysAgo(n) { const d = new Date(); d.setHours(10, 0, 0, 0); d.setDate(d.getDate() - n); return d; }

const ADMIN = 'test-admin-token';

// ① 削除（履歴あり）: 履歴が背後にある channel は物理削除せずアーカイブ。matchTokens に旧キーが残り、
//    来店回数が減らない＝過去の来店履歴が引き続き引ける。かつ送信先(recipients)からは外れる。
test('削除: 履歴のある連絡先はアーカイブされ、履歴(count)は残り・送信先からは外れる', () => {
  const { ctx, ledger } = buildCtx(
    [
      HEADER,
      ['email:aaa@example.com', 'email', '山田', '2026-01-01', 3, '2026-06-01', '', 'pid-A'],
    ],
    // aaa@example.com の確定来店3回（原本＝カレンダー）
    [
      fakeEvent({ status: 'confirmed', email: 'aaa@example.com' }, daysAgo(90)),
      fakeEvent({ status: 'confirmed', email: 'aaa@example.com' }, daysAgo(45)),
      fakeEvent({ status: 'confirmed', email: 'aaa@example.com' }, daysAgo(10)),
    ],
  );
  const token = ctx.hashKey_('email:aaa@example.com');

  // 削除前: 送信先(all)に含まれる／matchTokens で3件引ける。
  assert.ok(ctx.broadcastRecipients_('all').emails.includes('aaa@example.com'), '削除前は送信先に含まれる');
  assert.equal(ctx.adminListConfirmed_({ matchTokens: [token] }).visits.length, 3, '削除前は来店3件');

  const res = ctx.adminDeleteContact_({ adminToken: ADMIN, key: token });
  assert.equal(res.ok, true);
  assert.equal(res.archived, true, '履歴があるので物理削除でなくアーカイブ');

  // 台帳: 行は残り（物理削除されない）、col8 が 'archived'。col0〜7 は不変。
  const rows = dataRows(ledger);
  assert.equal(rows.length, 1, 'アーカイブは行を消さない（履歴照合キーを残す）');
  assert.equal(rows[0][8], 'archived', 'col8 に archived が append される');
  assert.equal(rows[0][0], 'email:aaa@example.com', 'col0（キー）は不変');
  assert.equal(rows[0][7], 'pid-A', 'col7（personId）は不変');

  // ★A案の不変条件: matchTokens に旧キーが残り、来店履歴が減らない。
  const list = ctx.adminListCustomers_();
  const entry = list.customers.find((c) => (c.matchTokens || []).includes(token));
  assert.ok(entry, 'アーカイブしても person は一覧から消えない');
  assert.equal(entry.status, 'archived', '有効一覧では archived 状態で返る');
  assert.equal(entry.email, undefined, '有効な連絡先としては値を出さない（active のみ表示）');
  assert.equal(entry.count, 3, '来店回数(count)は減らない');
  assert.ok(entry.matchTokens.includes(token), 'matchTokens に旧キーが残る（履歴照合が切れない）');
  assert.equal(ctx.adminListConfirmed_({ matchTokens: entry.matchTokens }).visits.length, 3, '削除後も来店3件のまま');

  // 送信先(recipients)からは外れる。
  assert.ok(!ctx.broadcastRecipients_('all').emails.includes('aaa@example.com'), 'アーカイブは送信先から外れる');
});

// ② 削除（台帳に来店実績あり・Calendar 窓外）: count>0（または firstVisit あり）なら履歴の証跡ありとして
//    アーカイブし、物理削除しない＝person も来店回数も失わない（A案・F-1 修正で穴を塞ぐ）。
test('削除: count>0（窓外の常連）はアーカイブされ person と来店回数が残る', () => {
  const { ctx, ledger } = buildCtx(
    [
      HEADER,
      ['phone:09099998888', 'phone', '常連田中', '2023-05-01', 8, '2025-04-01', '', 'pid-C'],
    ],
    [], // Calendar 窓（直近約12ヶ月）に一致イベント無し（最終来店が窓外）
  );
  const token = ctx.hashKey_('phone:09099998888');

  const res = ctx.adminDeleteContact_({ adminToken: ADMIN, key: token });
  assert.equal(res.ok, true);
  assert.equal(res.archived, true, 'count>0＝履歴の証跡ありとしてアーカイブ（物理削除しない）');
  const rows = dataRows(ledger);
  assert.equal(rows.length, 1, '行は残る（person を一覧から消さない）');
  assert.equal(rows[0][8], 'archived');
  const entry = ctx.adminListCustomers_().customers.find((c) => (c.matchTokens || []).includes(token));
  assert.ok(entry, 'person は一覧に残る');
  assert.equal(entry.count, 8, '来店回数は失われない');
});

// ②b 削除（全ゼロ＝純粋な打ち間違い）: count==0・firstVisit 空・カレンダー一致なし のときだけ物理削除。
//    切れる履歴が台帳にもカレンダーにも無いので安全に消す。
test('削除: 全ゼロ（count0・firstVisit空・カレンダー一致なし）の打ち間違いは物理削除', () => {
  const { ctx, ledger } = buildCtx(
    [
      HEADER,
      ['phone:09099998888', 'phone', '', '', 0, '', '', 'pid-C'],
    ],
    [], // カレンダー一致なし
  );
  const token = ctx.hashKey_('phone:09099998888');

  const res = ctx.adminDeleteContact_({ adminToken: ADMIN, key: token });
  assert.equal(res.ok, true);
  assert.equal(res.archived, false, '証跡が台帳にもカレンダーにも無い→物理削除');
  assert.equal(dataRows(ledger).length, 0, '行が台帳から消える（失う履歴が無いので安全）');
});

// ③ 削除の冪等: 既にアーカイブ済みの channel を再度削除しても unchanged で無操作（二重操作に安全）。
test('削除: 既にアーカイブ済みなら unchanged（冪等）', () => {
  const { ctx, ledger } = buildCtx(
    [
      HEADER,
      ['email:aaa@example.com', 'email', '山田', '2026-01-01', 3, '2026-06-01', '', 'pid-A', 'archived'],
    ],
    [fakeEvent({ status: 'confirmed', email: 'aaa@example.com' }, daysAgo(10))],
  );
  const token = ctx.hashKey_('email:aaa@example.com');
  const res = ctx.adminDeleteContact_({ adminToken: ADMIN, key: token });
  assert.equal(res.ok, true);
  assert.equal(res.unchanged, true, '既に archived＝無操作');
  assert.equal(dataRows(ledger).length, 1, '行は消さない');
});

// ④ 編集（差し替え）: 旧をアーカイブ＋新を追加（同一 person）。旧値の来店履歴が新レコードに保持される。
test('編集: 旧をアーカイブ＋新を追加し、旧値の履歴が新レコードに引き継がれる', () => {
  const { ctx, ledger } = buildCtx(
    [
      HEADER,
      ['phone:09011112222', 'phone', '佐藤', '2026-01-01', 3, '2026-06-01', '', 'pid-A'],
    ],
    // 旧値 phone の確定来店2回（原本）
    [
      fakeEvent({ status: 'confirmed', phone: '09011112222' }, daysAgo(60)),
      fakeEvent({ status: 'confirmed', phone: '09011112222' }, daysAgo(20)),
    ],
  );
  const oldToken = ctx.hashKey_('phone:09011112222');
  const newToken = ctx.hashKey_('email:new@example.com');

  const res = ctx.adminEditContact_({ adminToken: ADMIN, key: oldToken, contactType: 'email', value: 'new@example.com' });
  assert.equal(res.ok, true);

  // 台帳: 旧 phone 行はアーカイブ（残る）、新 email 行が active で追加。どちらも同じ personId。
  const rows = dataRows(ledger);
  assert.equal(rows.length, 2, '旧をアーカイブして残し、新を追加＝2行');
  const oldRow = rows.find((r) => r[0] === 'phone:09011112222');
  const newRow = rows.find((r) => r[0] === 'email:new@example.com');
  assert.equal(oldRow[8], 'archived', '旧 channel はアーカイブされる');
  assert.equal(newRow[1], 'email');
  assert.ok(!newRow[8], '新 channel は active（col8 なし）');
  assert.equal(newRow[7], 'pid-A', '新旧とも同じ person にぶら下がる');

  // ★A案の不変条件: 有効な新レコード（active・email=new）の matchTokens に旧新の両キーが並び、
  //   旧値の来店履歴が引き続き引ける。※adminListCustomers_ は channel 単位で返す（person への畳み込みは
  //   フロントの mergePersonRows）ため、有効(active)な新エントリを名指しで取る。
  const list = ctx.adminListCustomers_().customers;
  const entry = list.find((c) => c.email === 'new@example.com');
  assert.ok(entry, '有効な新エントリ（email=new）が一覧に出る');
  assert.equal(entry.status, 'active', '新エントリは active');
  assert.ok(entry.matchTokens.includes(oldToken), 'matchTokens に旧キーが残る');
  assert.ok(entry.matchTokens.includes(newToken), 'matchTokens に新キーも入る');
  assert.equal(entry.count, 3, '来店回数は減らない');
  assert.equal(ctx.adminListConfirmed_({ matchTokens: entry.matchTokens }).visits.length, 2, '旧値の来店履歴が新レコードに保持される');
  // 旧 phone エントリはアーカイブ状態・連絡先値は出さない（active のみ表示）。
  const oldEntry = list.find((c) => c.status === 'archived');
  assert.ok(oldEntry, '旧 phone は archived エントリとして残る（person も履歴も消えない）');
  assert.equal(oldEntry.phone, undefined, 'archived の連絡先値は出さない');
});

// ⑤ 編集のキー衝突: 変更先キーを別 person が使っていたら key_conflict で拒否し、旧をアーカイブしない・新を作らない。
test('編集: 他 person が使うキーへの変更は key_conflict で拒否（旧はアーカイブしない）', () => {
  const { ctx, ledger } = buildCtx(
    [
      HEADER,
      ['phone:09011112222', 'phone', '佐藤', '2026-01-01', 3, '2026-06-01', '', 'pid-A'],
      ['email:bbb@example.com', 'email', '鈴木', '2026-02-01', 2, '2026-05-01', '', 'pid-B'],
    ],
    [],
  );
  const aToken = ctx.hashKey_('phone:09011112222');

  const res = ctx.adminEditContact_({ adminToken: ADMIN, key: aToken, contactType: 'email', value: 'bbb@example.com' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'key_conflict');

  const rows = dataRows(ledger);
  assert.equal(rows.length, 2, '拒否時は新 channel を作らない');
  const oldRow = rows.find((r) => r[0] === 'phone:09011112222');
  assert.ok(!oldRow[8], '拒否時は旧 channel をアーカイブしない（連絡先を失わない）');
});

// ⑥ 編集の形式検証: 桁不足の電話は invalid_phone で弾き、旧をアーカイブしない・新を作らない。
test('編集: 電話番号の形式不正は invalid_phone で拒否（旧はアーカイブしない）', () => {
  const { ctx, ledger } = buildCtx(
    [
      HEADER,
      ['email:aaa@example.com', 'email', '山田', '2026-01-01', 3, '2026-06-01', '', 'pid-A'],
    ],
    [],
  );
  const token = ctx.hashKey_('email:aaa@example.com');
  const res = ctx.adminEditContact_({ adminToken: ADMIN, key: token, contactType: 'phone', value: '12345' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_phone');
  const rows = dataRows(ledger);
  assert.equal(rows.length, 1, '不正入力では新 channel を作らない');
  assert.ok(!rows[0][8], '不正入力では旧をアーカイブしない');
});
