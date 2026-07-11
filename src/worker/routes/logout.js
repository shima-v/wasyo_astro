// POST /reserve/admin/api/logout （Cloudflare Worker 上・dev 限定で injectRoute される）
// セッション Cookie を失効させる。
import { clearCookie } from '../session.js';
import { jsonNoStore } from '../guard.js';

export const prerender = false;

export async function POST() {
  return jsonNoStore({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}
