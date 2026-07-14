// POST /reserve/admin/api/action （Cloudflare Worker 上・dev 限定で injectRoute される）
// セッション Cookie を検証したうえで、Worker が保持する管理トークンを添えて GAS /exec へ転送する。
// ブラウザは管理トークンを一切持たない（Cookie のセッションのみ）。既存6機能の載せ替え先。
import { env } from 'cloudflare:workers';
import { refreshSession, readCookie, sessionCookie } from '../session.js';
import { originAllowed, jsonNoStore, rateLimited } from '../guard.js';

export const prerender = false;

// 転送を許可する管理アクション（GAS doPost の bearer 保護アクションと一致）。
// ※名寄せの handoverCheck / handoverConfirm は adminToken ではなく検証済み LINE idToken で保護する
//   「公開署名ルート」で、message 系（messageInfo/messageSend）と同じく **ブラウザ→GAS へ直送**（Worker を
//   経由しない）ため、この ALLOWED_ACTIONS には載せない。ここに載せるのは adminToken を要する管理系のみ。
const ALLOWED_ACTIONS = new Set([
  'getSlotConfig', 'setSlotConfig', 'getNotifyConfig', 'setNotifyConfig', 'listPending', 'adminListCustomers', 'adminListConfirmed', 'adminSetCustomerNote', 'adminSetCustomerName', 'adminSetCustomerContact', 'adminMergeCustomers', 'getQuota', 'adminDecision',
  'broadcastPreview', 'broadcast', 'broadcastTest', 'setTempSchedule', 'ownerChannelTest',
  'adminCreateBooking',
]);

export async function POST(context) {
  const request = context.request;
  // Astro v6 で Astro.locals.runtime.env は廃止。Worker の環境は cloudflare:workers の env を使う。
  if (!originAllowed(request, env)) return jsonNoStore({ ok: false, error: 'forbidden_origin' }, 403);
  if (rateLimited(request, 'action', 120)) return jsonNoStore({ ok: false, error: 'rate_limited' }, 429);

  const secret = env.SESSION_SECRET || '';
  // 検証＋スライド再発行。apiPost が管理の主要アクティビティ＝ここでのスライドが肝。
  const fresh = await refreshSession(secret, readCookie(request));
  // フロントの handleForbidden が拾えるよう、未認証は既存GASと同じ error:'forbidden' で返す。
  // 未認証・失敗パスでは Cookie を再発行しない（fresh は falsy）。
  if (!fresh) return jsonNoStore({ ok: false, error: 'forbidden' }, 401);

  // 認証成功 → 以降のレスポンスにアイドル延長 Cookie を付与する（活動でスライド）。
  const slideHeaders = { 'Set-Cookie': sessionCookie(fresh) };

  let body = {};
  try { body = await request.json(); } catch (_) {}
  const action = (body && body.action) || '';
  if (!ALLOWED_ACTIONS.has(action)) return jsonNoStore({ ok: false, error: 'unknown_action' }, 400, slideHeaders);

  const reserveApi = env.RESERVE_API || env.PUBLIC_RESERVE_API || '';
  const adminToken = env.ADMIN_TOKEN || '';
  if (!reserveApi || !adminToken) return jsonNoStore({ ok: false, error: 'server_unconfigured' }, 500, slideHeaders);

  // セッション検証済み → Worker 保持の管理トークンを添えて GAS を叩く。
  // CORS プリフライト回避のため GAS と同じ text/plain で送る。
  const payload = Object.assign({}, body, { adminToken });
  try {
    const res = await fetch(reserveApi, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    return jsonNoStore(data, 200, slideHeaders);
  } catch (_) {
    return jsonNoStore({ ok: false, error: 'upstream_error' }, 502, slideHeaders);
  }
}
