// gas/Code.gs の adminSetCustomerContact_（Phase 3・連絡先の変更/追加）のユニットテスト。
//
// gas/Code.gs は Apps Script の非モジュール（export 無しのグローバル関数群）なので、ソースを読み込んで
// vm サンドボックス上で評価し、GAS 側グローバル（SpreadsheetApp / LockService / Utilities / PropertiesService）
// をインメモリのフェイクで差し替えて関数を直接呼ぶ。実 GAS・実台帳・実カレンダーには一切触れない。
// ※テストは実装から独立に「仕様側」からケースを起こす（連絡先＝channel／不変の person／旧キーは履歴
//   エイリアスとして matchTokens に残す、という Phase 3 の仕様を検証）。ダミーは架空の一般例のみ（実顧客 PII なし）。
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

// 台帳（channel）の列見出し。col0..7 = key|type|name|firstVisit|count|lastVisit|note|personId。
const HEADER = ['key', 'type', 'name', 'firstVisit', 'count', 'lastVisit', 'note', 'personId'];

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
      // 単一セル
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

// 与えた台帳行から Code.gs を評価した独立コンテキストを作る（テストごとに新規）。
function buildCtx(ledgerRows) {
  const ledger = new FakeSheet('台帳', ledgerRows);
  const ss = new FakeSpreadsheet(ledger);
  const props = { LEDGER_SHEET_ID: 'sheet-id', HMAC_SECRET: 'test-hmac-secret', ADMIN_TOKENS: 'test-admin-token' };
  const toSigned = (buf) => Array.from(buf).map((b) => (b > 127 ? b - 256 : b));
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    SpreadsheetApp: { openById: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      getUuid: () => randomUUID(),
      // hashKey_ は返り値を (b & 0xff) で使うので符号なしバイト列でよい。
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
    // 本テストで呼ぶ関数は参照しないが、読み込み時の保険として空スタブを置く。
    CalendarApp: {}, UrlFetchApp: {}, MailApp: {}, ContentService: {}, HtmlService: {},
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SOURCE, ctx, { filename: 'Code.gs' });
  return { ctx, ss, ledger };
}

// 台帳のデータ行（ヘッダ除き・キーのある行）だけを返す。
function dataRows(ledger) { return ledger.rows.slice(1).filter((r) => r[0]); }

const ADMIN = 'test-admin-token';

// ① 正常系＋旧キー保持: phone 客の連絡先を email へ変更すると、新 channel が追加され、旧キーは
//    matchTokens に残り続ける（過去カレンダー履歴の突合が切れない）。
test('連絡先変更で新 channel が追加され、旧キーが matchTokens に残る', () => {
  const { ctx, ledger } = buildCtx([
    HEADER,
    ['phone:09011112222', 'phone', '山田', '2026-01-01', 3, '2026-06-01', '', 'pid-A'],
  ]);
  const oldToken = ctx.hashKey_('phone:09011112222');
  const newToken = ctx.hashKey_('email:aaa@example.com');

  const res = ctx.adminSetCustomerContact_({ adminToken: ADMIN, key: oldToken, contactType: 'email', value: 'aaa@example.com' });
  assert.equal(res.ok, true);

  const rows = dataRows(ledger);
  assert.equal(rows.length, 2, '旧 channel は残り、新 channel が1つ増える');
  const newRow = rows.find((r) => r[0] === 'email:aaa@example.com');
  assert.ok(newRow, '新しい連絡先の channel 行が追加される');
  assert.equal(newRow[1], 'email');
  assert.equal(newRow[7], 'pid-A', '新 channel は同じ person にぶら下がる');
  assert.ok(rows.find((r) => r[0] === 'phone:09011112222'), '旧 channel は削除されず残る（履歴エイリアス）');

  // adminListCustomers_ の matchTokens に新旧の両方が含まれる＝OR 突合で新旧履歴を引ける。
  const list = ctx.adminListCustomers_();
  const entry = list.customers.find((c) => (c.matchTokens || []).includes(oldToken));
  assert.ok(entry, 'person A の行が一覧に出る');
  assert.ok(entry.matchTokens.includes(oldToken), 'matchTokens に旧キーが残る');
  assert.ok(entry.matchTokens.includes(newToken), 'matchTokens に新キーも入る');
});

// ② 誤統合防止: 変更先キーを別 person が既に使っていたら key_conflict で拒否し、新 channel を作らない。
test('他 person が使うキーへの変更は key_conflict で拒否される', () => {
  const { ctx, ledger } = buildCtx([
    HEADER,
    ['phone:09011112222', 'phone', '山田', '2026-01-01', 3, '2026-06-01', '', 'pid-A'],
    ['email:bbb@example.com', 'email', '佐藤', '2026-02-01', 2, '2026-05-01', '', 'pid-B'],
  ]);
  const aToken = ctx.hashKey_('phone:09011112222');

  const res = ctx.adminSetCustomerContact_({ adminToken: ADMIN, key: aToken, contactType: 'email', value: 'bbb@example.com' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'key_conflict');
  assert.equal(dataRows(ledger).length, 2, '拒否時は新 channel を追加しない');
});

// ③ type 非依存: LINE 連携のお客様（line channel）に電話 channel を足せる（同じ person にぶら下がる）。
test('LINE 客に電話 channel を追加できる（type 非依存）', () => {
  const { ctx, ledger } = buildCtx([
    HEADER,
    ['line:U0000line0001', 'line', '田中', '2026-03-01', 1, '2026-03-01', '', 'pid-L'],
  ]);
  const lToken = ctx.hashKey_('line:U0000line0001');

  const res = ctx.adminSetCustomerContact_({ adminToken: ADMIN, key: lToken, contactType: 'phone', value: '090-3333-4444' });
  assert.equal(res.ok, true);

  const rows = dataRows(ledger);
  const phoneRow = rows.find((r) => r[0] === 'phone:09033334444'); // ハイフンは正規化で除去
  assert.ok(phoneRow, 'LINE 客に電話 channel が追加される');
  assert.equal(phoneRow[1], 'phone');
  assert.equal(phoneRow[7], 'pid-L', '同じ person にぶら下がる');
  assert.ok(rows.find((r) => r[0] === 'line:U0000line0001'), '元の LINE channel も残る');
});

// ④ 未採番 person の解決: personId 未設定の channel でも、採番＋col7 backfill してから新 channel を同じ person に足す。
test('personId 未採番の channel でも解決して新旧を同じ person に束ねる', () => {
  const { ctx, ledger } = buildCtx([
    HEADER,
    ['phone:09055556666', 'phone', '鈴木', '2026-04-01', 5, '2026-06-10', ''], // col7 無し（未採番）
  ]);
  const t = ctx.hashKey_('phone:09055556666');

  const res = ctx.adminSetCustomerContact_({ adminToken: ADMIN, key: t, contactType: 'email', value: 'suzuki@example.com' });
  assert.equal(res.ok, true);

  const rows = dataRows(ledger);
  const oldRow = rows.find((r) => r[0] === 'phone:09055556666');
  const newRow = rows.find((r) => r[0] === 'email:suzuki@example.com');
  assert.ok(oldRow[7], '旧 channel に personId が backfill される');
  assert.equal(newRow[7], oldRow[7], '新旧 channel が同一 person にぶら下がる');
});

// ⑤ 入力バリデーション: 桁不足の電話は invalid_phone で弾く（新 channel を作らない）。
test('電話番号の形式不正は invalid_phone で拒否される', () => {
  const { ctx, ledger } = buildCtx([
    HEADER,
    ['line:U0000line0001', 'line', '田中', '2026-03-01', 1, '2026-03-01', '', 'pid-L'],
  ]);
  const lToken = ctx.hashKey_('line:U0000line0001');

  const res = ctx.adminSetCustomerContact_({ adminToken: ADMIN, key: lToken, contactType: 'phone', value: '12345' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_phone');
  assert.equal(dataRows(ledger).length, 1, '不正入力では channel を追加しない');
});

// ⑥ 冪等: 変更先が既にこの person の channel（＝実質同じ連絡先）なら unchanged で無操作。
test('同一 person が既に持つ連絡先への変更は unchanged（冪等）', () => {
  const { ctx, ledger } = buildCtx([
    HEADER,
    ['phone:09011112222', 'phone', '山田', '2026-01-01', 3, '2026-06-01', '', 'pid-A'],
  ]);
  const aToken = ctx.hashKey_('phone:09011112222');

  const res = ctx.adminSetCustomerContact_({ adminToken: ADMIN, key: aToken, contactType: 'phone', value: '090-1111-2222' });
  assert.equal(res.ok, true);
  assert.equal(res.unchanged, true);
  assert.equal(dataRows(ledger).length, 1, '同一連絡先なら新 channel は増えない');
});

// ⑦ 対象不在: 突合トークンに一致する channel が無ければ not_found。
test('該当 channel が無ければ not_found', () => {
  const { ctx } = buildCtx([
    HEADER,
    ['phone:09011112222', 'phone', '山田', '2026-01-01', 3, '2026-06-01', '', 'pid-A'],
  ]);
  const res = ctx.adminSetCustomerContact_({ adminToken: ADMIN, key: 'deadbeef', contactType: 'email', value: 'zzz@example.com' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_found');
});
