// gas/Code.gs の Phase 4 ③名寄せ（本人同意の引き継ぎ handoverCheck/handoverConfirm ＋ 店主の手動マージ
// adminMergeCustomers_）のユニットテスト。
//
// customer-contact.test.js と同じく、Code.gs（Apps Script の非モジュール・グローバル関数群）を vm サンドボックス
// で評価し、GAS 側グローバル（SpreadsheetApp / LockService / Utilities / PropertiesService / UrlFetchApp）を
// インメモリのフェイクで差し替えて関数を直接呼ぶ。実 GAS・実台帳・実カレンダー・実 LINE には一切触れない。
// ※テストは実装から独立に「仕様側」からケースを起こす（誤統合ゼロ・未署名/改竄トークン拒否・履歴引き継ぎ・
//   冪等・手動マージの count 合算/firstVisit 最小/lastVisit 最大/tombstone・応答の非PII を検証）。
//   ダミーは架空のマッサージ店の一般例のみ（実顧客 PII なし）。
// 置き場所は src/ 配下（既存 test 構成が拾う）。gas/ に置くと .claspignore 不在で clasp push 流出するため置かない。
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

// 台帳（channel）col0..7 = key|type|name|firstVisit|count|lastVisit|note|personId。
const HEADER = ['key', 'type', 'name', 'firstVisit', 'count', 'lastVisit', 'note', 'personId'];
// person シート col0..5 = personId|displayName|firstVisit|count|lastVisit|note。
const PHEADER = ['personId', 'displayName', 'firstVisit', 'count', 'lastVisit', 'note'];

// ---- インメモリ Spreadsheet フェイク（必要最小 API） ----
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
  _ensure(ri, ci) { while (this.rows.length <= ri) this.rows.push([]); const row = this.rows[ri]; while (row.length <= ci) row.push(''); }
}

class FakeSpreadsheet {
  constructor(ledger, person) { this.sheets = [ledger]; if (person) this.sheets.push(person); } // [0]=台帳
  getSheets() { return this.sheets; }
  getSheetByName(name) { return this.sheets.find((s) => s.getName() === name) || null; }
  insertSheet(name, index) {
    const sh = new FakeSheet(name, []);
    if (index == null || index >= this.sheets.length) this.sheets.push(sh);
    else this.sheets.splice(index, 0, sh);
    return sh;
  }
}

// verifyLineIdToken_ のフェイク用：idToken → LINE claims（sub/name/email）。未登録 idToken は「改竄/未署名」扱いで 400。
const ID_TOKENS = {
  'idtok-A-email-aaa': { sub: 'Uline000A', name: '山田', email: 'aaa@example.com' }, // LINE-A（email 取得済み）
  'idtok-A-noemail': { sub: 'Uline000A', name: '山田' },                             // LINE-A（email スコープ未同意）
  'idtok-Z-email-zzz': { sub: 'Uline000Z', name: '別人', email: 'zzz@example.com' }, // LINE-Z（該当なしの email）
};

// 与えた台帳行（＋任意で person 行）から Code.gs を評価した独立コンテキストを作る。
function buildCtx(ledgerRows, personRows) {
  const ledger = new FakeSheet('台帳', ledgerRows);
  const person = personRows ? new FakeSheet('person', personRows) : null;
  const ss = new FakeSpreadsheet(ledger, person);
  const props = { LEDGER_SHEET_ID: 'sheet-id', HMAC_SECRET: 'test-hmac-secret', ADMIN_TOKENS: 'test-admin-token', LINE_LOGIN_CHANNEL_ID: 'test-line-channel' };
  const toSigned = (buf) => Array.from(buf).map((b) => (b > 127 ? b - 256 : b));
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    SpreadsheetApp: { openById: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    // LINE の /verify を模す。payload.id_token を ID_TOKENS で引き、あれば 200＋claims、無ければ 400（改竄/未署名）。
    UrlFetchApp: {
      fetch: (_url, opts) => {
        const tok = opts && opts.payload && opts.payload.id_token;
        const claims = ID_TOKENS[tok];
        if (claims) return { getResponseCode: () => 200, getContentText: () => JSON.stringify(claims) };
        return { getResponseCode: () => 400, getContentText: () => '{}' };
      },
    },
    Utilities: {
      getUuid: () => randomUUID(),
      computeDigest: (_algo, str) => Array.from(createHash('sha256').update(String(str), 'utf8').digest()),
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      computeHmacSha256Signature: (data, keyStr) => toSigned(createHmac('sha256', String(keyStr)).update(String(data)).digest()),
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes.map((b) => b & 0xff)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      formatDate: (d, _tz, pat) => {
        const p = (n) => String(n).padStart(2, '0');
        return String(pat).replace('yyyy', d.getFullYear()).replace('MM', p(d.getMonth() + 1)).replace('dd', p(d.getDate()))
          .replace('HH', p(d.getHours())).replace('mm', p(d.getMinutes())).replace('ss', p(d.getSeconds()));
      },
    },
    CalendarApp: {}, MailApp: {}, ContentService: {}, HtmlService: {},
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SOURCE, ctx, { filename: 'Code.gs' });
  return { ctx, ss, ledger, person };
}

function dataRows(sheet) { return sheet.rows.slice(1).filter((r) => r[0]); }
const ADMIN = 'test-admin-token';

// ============================================================
// 本人同意の引き継ぎ（handoverConfirm / handoverCheck）
// ============================================================

// ① 正しい同意で過去 person に結合し、履歴（matchTokens）が引き継がれる。
//   メール登録（email:aaa＝person A・3回）→ 後日 LINE-A で予約（line:UlineA・person L）→ 引き継ぎ同意。
test('正しい同意で今のLINEが過去personに結合し、matchTokensが新旧を束ねる', () => {
  const { ctx, ledger } = buildCtx(
    [
      HEADER,
      ['email:aaa@example.com', 'email', '山田', '2026-01-01', 3, '2026-06-01', '', 'pid-A'],
      ['line:Uline000A', 'line', '山田', '2026-06-05', 1, '2026-06-05', '', 'pid-L'],
    ],
    [
      PHEADER,
      ['pid-A', '山田', '2026-01-01', 3, '2026-06-01', ''],
      ['pid-L', '山田', '2026-06-05', 1, '2026-06-05', ''],
    ],
  );
  const emailToken = ctx.hashKey_('email:aaa@example.com');
  const lineToken = ctx.hashKey_('line:Uline000A');

  const res = ctx.handoverConfirm({ action: 'handoverConfirm', idToken: 'idtok-A-email-aaa' });
  assert.equal(res.ok, true);
  assert.equal(res.linked, true);

  // 今の LINE channel 行の personId が過去 person（pid-A）へ付け替わる（col0〜6 不変）。
  const lineRow = dataRows(ledger).find((r) => r[0] === 'line:Uline000A');
  assert.equal(lineRow[7], 'pid-A', '今のLINEが過去personに結合される');
  assert.equal(lineRow[2], '山田'); // col2〜6 は不変

  // adminListCustomers_ の matchTokens で新旧の履歴が OR 突合で引ける＝履歴が引き継がれる。
  const list = ctx.adminListCustomers_();
  const entry = list.customers.find((c) => (c.matchTokens || []).includes(emailToken));
  assert.ok(entry.matchTokens.includes(emailToken), 'matchTokens に過去(メール)キーが入る');
  assert.ok(entry.matchTokens.includes(lineToken), 'matchTokens に今の(LINE)キーも入る');
});

// ② 別人（不一致）は結合しない＝誤統合ゼロ。verified email が誰にも一致しなければ何も束ねない。
test('照合材料が一致しなければ結合しない（誤統合ゼロ）', () => {
  const { ctx, ledger } = buildCtx(
    [
      HEADER,
      ['email:bbb@example.com', 'email', '佐藤', '2026-02-01', 4, '2026-05-01', '', 'pid-B'],
      ['line:Uline000Z', 'line', '別人', '2026-06-05', 1, '2026-06-05', '', 'pid-Z'],
    ],
    [
      PHEADER,
      ['pid-B', '佐藤', '2026-02-01', 4, '2026-05-01', ''],
      ['pid-Z', '別人', '2026-06-05', 1, '2026-06-05', ''],
    ],
  );
  // idtok-Z-email-zzz の email=zzz は台帳のどの channel にも一致しない。
  const res = ctx.handoverConfirm({ action: 'handoverConfirm', idToken: 'idtok-Z-email-zzz' });
  assert.equal(res.ok, true);
  assert.equal(res.found, false, '過去personが無い＝結合対象なし');

  // 別人 B は一切変更されず、今の LINE-Z も pid-Z のまま（誤って B に寄せない）。
  const bRow = dataRows(ledger).find((r) => r[0] === 'email:bbb@example.com');
  const zRow = dataRows(ledger).find((r) => r[0] === 'line:Uline000Z');
  assert.equal(bRow[7], 'pid-B', '別人Bのpersonは不変');
  assert.equal(zRow[7], 'pid-Z', '今のLINE-Zは結合されない');
});

// ③ 未署名/改竄 idToken は拒否。要約を一切返さない＝他人PIIが漏れない。mutation も起きない。
test('未署名/改竄トークンは拒否され、要約もPIIも返らない・mutationも起きない', () => {
  const { ctx, ledger } = buildCtx(
    [HEADER, ['email:aaa@example.com', 'email', '山田', '2026-01-01', 3, '2026-06-01', '', 'pid-A']],
    [PHEADER, ['pid-A', '山田', '2026-01-01', 3, '2026-06-01', '']],
  );
  const before = ledger.rows.length;

  const chk = ctx.handoverCheck({ action: 'handoverCheck', idToken: 'tampered-or-forged' });
  assert.equal(chk.ok, false);
  assert.equal(chk.error, 'bad_token');
  assert.equal(chk.found, undefined, 'found を返さない');
  assert.equal(chk.summary, undefined, 'summary を返さない');
  const chkStr = JSON.stringify(chk);
  assert.ok(!chkStr.includes('山田') && !chkStr.includes('aaa@example.com') && !chkStr.includes('pid-A'), '応答に他人PIIが混ざらない');

  const cfm = ctx.handoverConfirm({ action: 'handoverConfirm', idToken: 'tampered-or-forged' });
  assert.equal(cfm.ok, false);
  assert.equal(cfm.error, 'bad_token');
  assert.equal(ledger.rows.length, before, '改竄トークンでは台帳を一切変更しない');
});

// ④ 冪等: 二度確定しても no-op（重複結合・重複行を作らない）。
test('二度目の同意は alreadyLinked の no-op（冪等）', () => {
  const { ctx, ledger } = buildCtx(
    [
      HEADER,
      ['email:aaa@example.com', 'email', '山田', '2026-01-01', 3, '2026-06-01', '', 'pid-A'],
      ['line:Uline000A', 'line', '山田', '2026-06-05', 1, '2026-06-05', '', 'pid-L'],
    ],
    [
      PHEADER,
      ['pid-A', '山田', '2026-01-01', 3, '2026-06-01', ''],
      ['pid-L', '山田', '2026-06-05', 1, '2026-06-05', ''],
    ],
  );
  const first = ctx.handoverConfirm({ action: 'handoverConfirm', idToken: 'idtok-A-email-aaa' });
  assert.equal(first.linked, true);
  const rowsAfterFirst = ledger.rows.length;

  const second = ctx.handoverConfirm({ action: 'handoverConfirm', idToken: 'idtok-A-email-aaa' });
  assert.equal(second.ok, true);
  assert.equal(second.alreadyLinked, true, '二度目は no-op');
  assert.equal(ledger.rows.length, rowsAfterFirst, '重複行を作らない');
  const lineRow = dataRows(ledger).find((r) => r[0] === 'line:Uline000A');
  assert.equal(lineRow[7], 'pid-A');
});

// ⑤ LINE channel 行がまだ無い場合は、過去 person にぶら下がる LINE 行を新設して結合する
//   （メール登録 → LINE 予約前に引き継ぎ）。以後の LINE 予約が同一 person に集約される土台。
test('LINE channel が未作成でも過去personにぶら下がるLINE行を新設して結合する', () => {
  const { ctx, ledger } = buildCtx(
    [HEADER, ['email:aaa@example.com', 'email', '山田', '2026-01-01', 3, '2026-06-01', '', 'pid-A']],
    [PHEADER, ['pid-A', '山田', '2026-01-01', 3, '2026-06-01', '']],
  );
  const res = ctx.handoverConfirm({ action: 'handoverConfirm', idToken: 'idtok-A-email-aaa' });
  assert.equal(res.linked, true);

  const lineRow = dataRows(ledger).find((r) => r[0] === 'line:Uline000A');
  assert.ok(lineRow, 'LINE channel 行が新設される');
  assert.equal(lineRow[1], 'line');
  assert.equal(lineRow[7], 'pid-A', '新設 LINE 行は過去 person にぶら下がる');
});

// ⑥ email 未取得（LINE で email スコープ未同意）は照合材料が無いので no_email（電話は同定に使わない方針）。
test('idToken に email が無ければ no_email（電話では同定しない）', () => {
  const { ctx } = buildCtx(
    [HEADER, ['email:aaa@example.com', 'email', '山田', '2026-01-01', 3, '2026-06-01', '', 'pid-A']],
    [PHEADER, ['pid-A', '山田', '2026-01-01', 3, '2026-06-01', '']],
  );
  const chk = ctx.handoverCheck({ action: 'handoverCheck', idToken: 'idtok-A-noemail' });
  assert.equal(chk.ok, false);
  assert.equal(chk.error, 'no_email');
});

// ⑦ handoverCheck の応答は非PIIサマリ（visitCount・lastVisitYm）のみ＝他人PIIを含まない。
test('handoverCheck 応答は visitCount と lastVisitYm だけ（他人PIIを含まない）', () => {
  const { ctx } = buildCtx(
    [HEADER, ['email:aaa@example.com', 'email', '山田', '2026-01-01', 3, '2026-06-01', 'memoA', 'pid-A']],
    [PHEADER, ['pid-A', '山田', '2026-01-01', 3, '2026-06-01', 'memoA']],
  );
  const chk = ctx.handoverCheck({ action: 'handoverCheck', idToken: 'idtok-A-email-aaa' });
  assert.equal(chk.ok, true);
  assert.equal(chk.found, true);
  assert.deepEqual(Object.keys(chk).sort(), ['found', 'ok', 'summary']);
  assert.deepEqual(Object.keys(chk.summary).sort(), ['lastVisitYm', 'visitCount']);
  assert.equal(chk.summary.visitCount, 3);
  assert.equal(chk.summary.lastVisitYm, '2026-06'); // 年月まで（日は落とす）
  const s = JSON.stringify(chk);
  assert.ok(!s.includes('山田'), '氏名を含まない');
  assert.ok(!s.includes('aaa@example.com'), 'メールを含まない');
  assert.ok(!s.includes('memoA'), 'メモを含まない');
  assert.ok(!s.includes('pid-A'), 'personId を含まない');
  assert.ok(!s.includes('2026-06-01'), '日付（来店日）を含まない＝年月のみ');
});

// ============================================================
// 店主の手動マージ（adminMergeCustomers_）
// ============================================================

// ⑧ 手動マージ: count 合算・firstVisit 最小・lastVisit 最大・メモ連結・source を target へ付け替え・source を tombstone 化。
test('手動マージで count合算/firstVisit最小/lastVisit最大/メモ連結/tombstone', () => {
  const { ctx, ledger, person } = buildCtx(
    [
      HEADER,
      ['email:aaa@example.com', 'email', '山田', '2026-01-01', 3, '2026-06-01', 'memoA', 'pid-A'], // target
      ['phone:09011112222', 'phone', '山田T', '2026-03-01', 2, '2026-05-01', 'memoB', 'pid-B'],    // source
    ],
    [
      PHEADER,
      ['pid-A', '山田', '2026-01-01', 3, '2026-06-01', 'memoA'],
      ['pid-B', '山田T', '2026-03-01', 2, '2026-05-01', 'memoB'],
    ],
  );
  const targetKey = ctx.hashKey_('email:aaa@example.com');
  const sourceKey = ctx.hashKey_('phone:09011112222');

  const res = ctx.adminMergeCustomers_({ adminToken: ADMIN, sourceKey: sourceKey, targetKey: targetKey });
  assert.equal(res.ok, true);
  assert.equal(res.merged, true);
  assert.equal(res.count, 5, 'count は合算（3+2）');

  // target person 行に統合結果が反映される。
  const tRow = person.rows.find((r) => r[0] === 'pid-A');
  assert.equal(Number(tRow[3]), 5, 'count 合算');
  assert.equal(tRow[2], '2026-01-01', 'firstVisit は最小');
  assert.equal(tRow[4], '2026-06-01', 'lastVisit は最大');
  assert.ok(tRow[5].includes('memoA') && tRow[5].includes('memoB'), 'メモが連結される');

  // source の channel が target へ付け替わる（col7 のみ・col0〜6 不変）。
  const srcChan = dataRows(ledger).find((r) => r[0] === 'phone:09011112222');
  assert.equal(srcChan[7], 'pid-A', 'source channel が target person に付け替わる');
  assert.equal(srcChan[2], '山田T', 'channel の col0〜6 は不変');

  // source person 行は削除されず tombstone（col7=mergedInto=target）が立つ＝可逆寄り。
  const sRow = person.rows.find((r) => r[0] === 'pid-B');
  assert.ok(sRow, 'source person 行は削除しない');
  assert.equal(sRow[6], 'pid-A', 'source は mergedInto=target で tombstone 化');
  assert.equal(Number(sRow[3]), 2, 'source の元集約 col1〜6 は保持（source 単体は復元可能）');
});

// ⑨ 手動マージの入力ガード: 同一キー・欠落を拒否する。
test('手動マージは同一キー/欠落を拒否する', () => {
  const { ctx } = buildCtx(
    [HEADER, ['email:aaa@example.com', 'email', '山田', '2026-01-01', 3, '2026-06-01', '', 'pid-A']],
    [PHEADER, ['pid-A', '山田', '2026-01-01', 3, '2026-06-01', '']],
  );
  const k = ctx.hashKey_('email:aaa@example.com');
  assert.equal(ctx.adminMergeCustomers_({ adminToken: ADMIN, sourceKey: k, targetKey: k }).error, 'same_customer');
  assert.equal(ctx.adminMergeCustomers_({ adminToken: ADMIN, sourceKey: k }).error, 'bad_request');
  assert.equal(ctx.adminMergeCustomers_({ adminToken: ADMIN, sourceKey: 'deadbeef', targetKey: k }).error, 'not_found');
});
