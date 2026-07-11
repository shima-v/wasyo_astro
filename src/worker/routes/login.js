// POST /reserve/admin/api/login （Cloudflare Worker 上・dev 限定で injectRoute される）
// 管理トークン（＋任意 PIN）を検証し、短命の署名付き httpOnly セッション Cookie を発行する。
// ブラウザに長寿命トークンを持たせないための入口。
import { env } from 'cloudflare:workers';
import { issueSession, sessionCookie, secretMatches } from '../session.js';
import { rateLimited, originAllowed, jsonNoStore } from '../guard.js';

export const prerender = false;

export async function POST(context) {
  const request = context.request;
  // Astro v6 で Astro.locals.runtime.env は廃止。Worker の環境は cloudflare:workers の env を使う。
  if (!originAllowed(request, env)) return jsonNoStore({ ok: false, error: 'forbidden_origin' }, 403);
  if (rateLimited(request, 'login', 20)) return jsonNoStore({ ok: false, error: 'rate_limited' }, 429);

  const secret = env.SESSION_SECRET || '';
  const adminToken = env.ADMIN_TOKEN || '';
  const adminPin = env.ADMIN_PIN || ''; // 未設定なら PIN 無効（トークンのみ）。設定ありなら必須。
  if (!secret || !adminToken) return jsonNoStore({ ok: false, error: 'server_unconfigured' }, 500);

  let body = {};
  try { body = await request.json(); } catch (_) {}
  const token = (body && body.token) || '';
  const pin = (body && body.pin) || '';

  const okToken = await secretMatches(secret, adminToken, token);
  const okPin = adminPin ? await secretMatches(secret, adminPin, pin) : true;
  if (!okToken || !okPin) return jsonNoStore({ ok: false, error: 'invalid_credentials' }, 401);

  // 新規セッション（iat=seen=now）。Cookie の Max-Age はアイドル（30分・sessionCookie 既定）。
  // 絶対上限（12時間）はサーバ側の iat で担保する。
  const session = await issueSession(secret);
  return jsonNoStore({ ok: true }, 200, { 'Set-Cookie': sessionCookie(session) });
}
