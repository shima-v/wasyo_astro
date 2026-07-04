// Worker 側のセッション（署名付き httpOnly Cookie・サーバ側ストア不要のステートレス方式）。
// 長寿命の管理トークンをブラウザに持たせず、短命の署名済みセッションだけを Cookie に載せるための土台。
// Cloudflare Worker（Web Crypto）で動く。localStorage トークン方式を置き換える。

export const SESSION_COOKIE = 'wasyo_admin_session';
// セッション有効期間（秒）。**仮 60分**。後で本人と確定するため定数として切り出しておく。
export const SESSION_TTL_SEC = 60 * 60;

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

// セッショントークンを発行。payload に exp（epoch秒）を入れて署名する。形式: `<body>.<sig>`。
export async function issueSession(secret, ttlSec = SESSION_TTL_SEC) {
  const payload = { exp: Math.floor(Date.now() / 1000) + ttlSec };
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await sign(secret, body);
  return body + '.' + sig;
}

// セッショントークンを検証。改ざん（署名不一致）・期限切れは false。
export async function verifySession(secret, token) {
  if (!secret || !token) return false;
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  const body = parts[0];
  const sig = parts[1];
  const expected = await sign(secret, body);
  if (!constEq(expected, sig)) return false;
  try {
    const payload = JSON.parse(dec.decode(b64urlToBytes(body)));
    if (!payload || typeof payload.exp !== 'number') return false;
    if (Math.floor(Date.now() / 1000) >= payload.exp) return false;
    return true;
  } catch (_) {
    return false;
  }
}

// Set-Cookie 文字列。httpOnly / Secure / SameSite=Strict / Path は管理系に限定。
export function sessionCookie(token, maxAgeSec = SESSION_TTL_SEC) {
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
