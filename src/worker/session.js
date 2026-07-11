// Worker 側のセッション（署名付き httpOnly Cookie・サーバ側ストア不要のステートレス方式）。
// 長寿命の管理トークンをブラウザに持たせず、短命の署名済みセッションだけを Cookie に載せるための土台。
// Cloudflare Worker（Web Crypto）で動く。localStorage トークン方式を置き換える。

export const SESSION_COOKIE = 'wasyo_admin_session';

// 管理セッションの複合タイムアウト（2026-07-04 本人確定）。
// 単一の絶対 TTL ではなく「アイドル（無活動）＋絶対（発行からの上限）」の二段構え。
// - アイドル 30分: 最終アクティビティから 30分 無操作で失効（席を離れた端末の乗っ取り窓を狭める）。
//   根拠: OWASP Session Management（低リスク業務のアイドルは 15–30分）。活動ごとに再発行して延長。
// - 絶対 12時間: ログイン時刻（iat）から 12時間で必ず失効（再発行でも延びない硬い上限）。
//   根拠: NIST SP 800-63B-4 AAL2（再認証は「アイドル ≤ 1h」かつ「絶対 ≤ 24h」を SHOULD）。
//   小規模サロン運用に合わせ、SHOULD の範囲内でより短い 30分/12時間に寄せた。値は定数。
export const SESSION_IDLE_SEC = 30 * 60;        // アイドル: 最終活動から 30分
export const SESSION_ABSOLUTE_SEC = 12 * 60 * 60; // 絶対: 発行（iat）から 12時間

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes) {
  const arr = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
// HMAC-SHA256(secret, data) の base64url。
async function sign(secret, data) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return b64urlEncode(sig);
}

// 定数時間比較（同一長の base64url 同士を想定）。早期 return しない。
function constEq(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 現在時刻（epoch秒）。発行・検証系の nowSec 既定値に使う。
// これらの関数は nowSec を引数で受け取り既定値としてのみ使うため、テストで任意の時刻を注入して
// 境界（アイドル/絶対の失効タイミング）を決定的に検証できる。
function nowSecDefault() {
  return Math.floor(Date.now() / 1000);
}

// payload {iat, seen} を署名して `<body>.<sig>` 形式のトークンにする（内部ヘルパ）。
async function signToken(secret, payload) {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await sign(secret, body);
  return body + '.' + sig;
}

// 新規セッションを発行。iat=seen=now（ログイン直後・絶対上限のアンカーを now に置く）。
export async function issueSession(secret, nowSec = nowSecDefault()) {
  return signToken(secret, { iat: nowSec, seen: nowSec });
}

// 既存セッションのスライド再発行。iat は据置（絶対上限は動かさない）・seen のみ now に更新。
export async function reissueSession(secret, iat, nowSec = nowSecDefault()) {
  return signToken(secret, { iat, seen: nowSec });
}

// 署名を検証し payload {iat, seen} を返す（内部ヘルパ）。時刻（失効）判定はしない。
// 署名不一致・形式不正・旧 exp 形式（iat/seen を持たない）は null（＝無効扱い、後方互換は持たない）。
async function verifiedPayload(secret, token) {
  if (!secret || !token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const body = parts[0];
  const sig = parts[1];
  const expected = await sign(secret, body);
  if (!constEq(expected, sig)) return null; // 定数時間比較（改ざん検出）
  try {
    const payload = JSON.parse(dec.decode(b64urlToBytes(body)));
    if (!payload || typeof payload.iat !== 'number' || typeof payload.seen !== 'number') return null;
    return payload;
  } catch (_) {
    return null;
  }
}

// 検証＋スライド再発行を1経路に集約する。呼び側はこの1関数で「通す/拒否」と「延長トークン」を得る。
//   戻り値: 有効なら「iat 据置・seen=now で再署名した新トークン文字列」／無効・期限切れなら '' (falsy)。
// 判定順: ①署名一致（verifiedPayload） ②絶対上限（iat から SESSION_ABSOLUTE_SEC 経過で失効・再発行でも延びない）
//   ③アイドル（最終活動 seen から SESSION_IDLE_SEC 無活動で失効）。全て通れば seen を now に進めて再署名。
// 呼び側は truthy なら next()/成功レスポンスに sessionCookie(fresh) を付けてアイドル窓をスライドし、
// falsy なら 302/401 で拒否する（Cookie は付けない）。
export async function refreshSession(secret, token, nowSec = nowSecDefault()) {
  const payload = await verifiedPayload(secret, token);
  if (!payload) return '';
  if (nowSec >= payload.iat + SESSION_ABSOLUTE_SEC) return ''; // 絶対上限（硬い上限・延長不可）
  if (nowSec >= payload.seen + SESSION_IDLE_SEC) return '';     // アイドル（無活動で失効）
  return reissueSession(secret, payload.iat, nowSec);           // 通過 → iat 据置・seen=now で延長
}

// Set-Cookie 文字列。httpOnly / Secure / SameSite=Strict / Path は管理系に限定。
// Max-Age はアイドル（30分）を既定にする＝活動ごとに再発行して延長するため、ブラウザ側 Cookie も
// アイドルで失効し、サーバ側 iat による絶対上限と併せて多層防御になる（絶対上限はサーバで担保）。
export function sessionCookie(token, maxAgeSec = SESSION_IDLE_SEC) {
  return SESSION_COOKIE + '=' + token + '; Max-Age=' + maxAgeSec + '; Path=/reserve/admin; HttpOnly; Secure; SameSite=Strict';
}
export function clearCookie() {
  return SESSION_COOKIE + '=; Max-Age=0; Path=/reserve/admin; HttpOnly; Secure; SameSite=Strict';
}
export function readCookie(request) {
  const raw = request.headers.get('cookie') || '';
  const m = raw.match(new RegExp('(?:^|; )' + SESSION_COOKIE + '=([^;]+)'));
  return m ? m[1] : '';
}

// 管理トークン/PIN の照合（定数時間）。生の秘密を直接比較せず、双方を HMAC(secret) に通した
// 固定長ダイジェスト同士で比べる（先頭一致長による処理時間差を秘匿）。
export async function secretMatches(secret, expected, given) {
  if (!expected || !given) return false;
  const a = await sign(secret, 'x:' + expected);
  const b = await sign(secret, 'x:' + given);
  return constEq(a, b);
}
