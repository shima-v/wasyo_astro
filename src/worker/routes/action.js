// POST /reserve/admin/api/action （Cloudflare Worker 上・dev 限定で injectRoute される）
// セッション Cookie を検証したうえで、Worker が保持する管理トークンを添えて GAS /exec へ転送する。
// ブラウザは管理トークンを一切持たない（Cookie のセッションのみ）。既存6機能の載せ替え先。
import { env } from 'cloudflare:workers';
import { verifySession, readCookie } from '../session.js';
import { originAllowed, jsonNoStore, rateLimited } from '../guard.js';

export const prerender = false;

// 転送を許可する管理アクション（GAS doPost の bearer 保護アクションと一致）。
const ALLOWED_ACTIONS = new Set([
  'getSlotConfig', 'setSlotConfig', 'listPending', 'getQuota', 'adminDecision',
  'broadcastPreview', 'broadcast', 'broadcastTest', 'setTempSchedule', 'ownerChannelTest',
  'adminCreateBooking',
]);

export async function POST(context) {
  const request = context.request;
  // Astro v6 で Astro.locals.runtime.env は廃止。Worker の環境は cloudflare:workers の env を使う。
  if (!originAllowed(request, env)) return jsonNoStore({ ok: false, error: 'forbidden_origin' }, 403);
  if (rateLimited(request, 'action', 120)) return jsonNoStore({ ok: false, error: 'rate_limited' }, 429);

  const secret = env.SESSION_SECRET || '';
  const valid = await verifySession(secret, readCookie(request));
  // フロントの handleForbidden が拾えるよう、未認証は既存GASと同じ error:'forbidden' で返す。
  if (!valid) return jsonNoStore({ ok: false, error: 'forbidden' }, 401);

  let body = {};
  try { body = await request.json(); } catch (_) {}
  const action = (body && body.action) || '';
  if (!ALLOWED_ACTIONS.has(action)) return jsonNoStore({ ok: false, error: 'unknown_action' }, 400);

  const reserveApi = env.RESERVE_API || env.PUBLIC_RESERVE_API || '';
  const adminToken = env.ADMIN_TOKEN || '';
  if (!reserveApi || !adminToken) return jsonNoStore({ ok: false, error: 'server_unconfigured' }, 500);

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
    return jsonNoStore(data, 200);
  } catch (_) {
    return jsonNoStore({ ok: false, error: 'upstream_error' }, 502);
  }
}
