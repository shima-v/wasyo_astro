// 管理セッションの複合タイムアウト（アイドル30分＋絶対12時間）の境界テスト。
// 実装(session.js)から「独立に」仕様側からケースを起こす:
//   - 判定順は ①署名一致 ②絶対上限(iat+43200) ③アイドル(seen+1800) の順で失効させる。
//   - refreshSession は 有効なら新トークン(truthy) / 無効・期限切れなら '' (falsy) を返す。
//     consumers(middleware.js / action.js)は falsy→拒否 / truthy→sessionCookie(fresh)でスライド。
// nowSec を注入して実時間に依存しない決定的検証を行う。secret はダミー固定値（実 secret は使わない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  issueSession,
  reissueSession,
  refreshSession,
  sessionCookie,
  SESSION_IDLE_SEC,
  SESSION_ABSOLUTE_SEC,
  SESSION_COOKIE,
} from './session.js';

const SECRET = 'test-secret-not-a-real-credential';
const t0 = 1_700_000_000; // 固定の epoch アンカー（実時間から切り離す）
const IDLE = 1800; // 30分（仕様値・定数の別名としてではなくリテラルで境界を明示）
const ABS = 43200; // 12時間

// --- 独立ユーティリティ（実装の内部関数には依存しない） ---

// トークン body 部（`<body>.<sig>`）を base64url デコードして payload を読む。
function decodePayload(token) {
  const body = String(token).split('.')[0];
  const b64 = body.replace(/-/g, '+').replace(/_/g, '/');
  const json = Buffer.from(b64, 'base64').toString('utf8');
  return JSON.parse(json);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// 実装と同じ方式(HMAC-SHA256 + base64url)で「正当署名だが任意 payload」のトークンを独立生成する。
// 旧 {exp} 形式が「署名は正当・payload 形状で弾かれる」ことを担保するのに使う。
function makeToken(secret, payload) {
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return body + '.' + sig;
}

// --- 前提: 独立署名ヘルパが実装の署名と一致すること（後段テストの土台） ---
test('独立署名ヘルパが実装(issueSession)の署名と一致する', async () => {
  const mine = makeToken(SECRET, { iat: t0, seen: t0 });
  const impl = await issueSession(SECRET, t0);
  assert.strictEqual(mine, impl, '独立生成トークンが実装のトークンと完全一致（＝以降の makeToken は正当署名）');
});

// --- 定数の不変条件（仕様値の固定） ---
test('定数の不変条件: アイドル=1800秒・絶対=43200秒', () => {
  assert.strictEqual(SESSION_IDLE_SEC, IDLE, 'アイドル30分');
  assert.strictEqual(SESSION_ABSOLUTE_SEC, ABS, '絶対12時間');
  assert.strictEqual(SESSION_COOKIE, 'wasyo_admin_session', 'Cookie 名');
});

// --- ケース1: 発行直後は有効 ---
test('ケース1 発行直後(now=iat=seen=t0)は有効', async () => {
  const tok = await issueSession(SECRET, t0);
  assert.ok(await refreshSession(SECRET, tok, t0), '発行直後は refreshSession が truthy');
});

// --- ケース2: アイドル境界（seen=t0） ---
test('ケース2 アイドル境界: t0+1799 は有効 / t0+1800 ちょうどで失効', async () => {
  const tok = await issueSession(SECRET, t0); // seen=t0
  assert.ok(await refreshSession(SECRET, tok, t0 + IDLE - 1), 'アイドル30分-1秒は有効');
  assert.strictEqual(await refreshSession(SECRET, tok, t0 + IDLE), '', 'ちょうど30分無活動で失効');
});

// --- ケース3: 絶対境界（iat=t0、seen は直近に保ちアイドルを先に発火させない） ---
test('ケース3 絶対境界: iat=t0で t0+43199 は有効 / t0+43200 ちょうどで失効', async () => {
  const seenRecent = t0 + 43000; // アイドルは通る位置に seen を置く
  const tok = await reissueSession(SECRET, t0, seenRecent); // iat=t0, seen=t0+43000
  assert.ok(await refreshSession(SECRET, tok, t0 + ABS - 1), '絶対12時間-1秒は有効');
  assert.strictEqual(await refreshSession(SECRET, tok, t0 + ABS), '', 'ちょうど12時間で失効');
});

// --- ケース4: 絶対がアイドルより優先（スライドで絶対は延びない） ---
test('ケース4 絶対はアイドルより優先: seenが直近でも iat+43200 なら失効', async () => {
  const tok = await reissueSession(SECRET, t0, t0 + ABS - 1); // seen=t0+43199（ほぼ now）
  // now=t0+43200: アイドル的には now-seen=1秒で本来通るが、絶対上限が先に失効させる
  assert.strictEqual(await refreshSession(SECRET, tok, t0 + ABS), '', '絶対上限が優先して失効（延長不可）');
});

// --- ケース5: スライド（iat据置・seen=now更新／窓が延びる／絶対は不変） ---
test('ケース5 スライド: iat据置・seen=now更新でアイドル窓が延びる（絶対上限は延びない）', async () => {
  const tok = await issueSession(SECRET, t0); // iat=seen=t0
  const activity = t0 + 1000; // アイドル窓内で活動
  const fresh = await refreshSession(SECRET, tok, activity);
  assert.ok(fresh, '活動時は延長トークン(truthy)が返る');

  const p = decodePayload(fresh);
  assert.strictEqual(p.iat, t0, 'iatは据置（絶対上限のアンカーは動かない）');
  assert.strictEqual(p.seen, activity, 'seenはnow(活動時刻)に更新される');

  const oldIdleBoundary = t0 + IDLE; // 元トークンの旧アイドル境界
  assert.strictEqual(await refreshSession(SECRET, tok, oldIdleBoundary), '', '元トークンは旧境界で失効');
  assert.ok(await refreshSession(SECRET, fresh, oldIdleBoundary), '延長トークンは旧境界を越えても有効（窓が延びた）');
  assert.ok(await refreshSession(SECRET, fresh, activity + IDLE - 1), '新アイドル窓 activity+1800未満は有効');
  assert.strictEqual(await refreshSession(SECRET, fresh, activity + IDLE), '', '新アイドル境界(activity+1800)で失効');

  // スライドを重ねても iat+43200 では必ず失効（絶対上限は不変）
  const keptAlive = await reissueSession(SECRET, t0, t0 + 43000); // seen直近だが iat=t0
  assert.strictEqual(await refreshSession(SECRET, keptAlive, t0 + ABS), '', 'スライドしても絶対12時間で失効');
});

// --- ケース6: 署名改ざん ---
test('ケース6 署名改ざん: sigを1文字変えると失効', async () => {
  const tok = await issueSession(SECRET, t0);
  const [body, sig] = tok.split('.');
  const last = sig[sig.length - 1];
  const flipped = sig.slice(0, -1) + (last === 'A' ? 'B' : 'A');
  assert.notStrictEqual(flipped, sig, '改ざん後sigは元と異なること');
  const tampered = body + '.' + flipped;
  assert.strictEqual(await refreshSession(SECRET, tampered, t0), '', '署名不一致は失効');
});

// --- ケース7: 旧 {exp} 形式（署名は正当・iat/seen 無し）は後方互換なし ---
test('ケース7 後方互換なし: 旧{exp}形式（正当署名・iat/seen無し）は失効', async () => {
  const legacy = makeToken(SECRET, { exp: t0 + 3600 }); // 署名は正当
  assert.strictEqual(await refreshSession(SECRET, legacy, t0), '', '旧exp形式は payload 形状で無効');
});

// --- ケース8: Cookie 属性 ---
test('ケース8 Cookie属性: Max-Age=1800（アイドル既定）とPath/HttpOnly/Secure/SameSite', async () => {
  const tok = await issueSession(SECRET, t0);
  const cookie = sessionCookie(tok);
  assert.ok(cookie.includes('Max-Age=1800'), 'Max-Age=1800（アイドル30分）を含む');
  assert.ok(
    cookie.includes('Path=/reserve/admin; HttpOnly; Secure; SameSite=Strict'),
    'Path/HttpOnly/Secure/SameSite=Strict の属性一式を含む',
  );
  assert.ok(cookie.startsWith(SESSION_COOKIE + '=' + tok), 'Cookie名とトークンで始まる');
});
