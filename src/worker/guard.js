// 管理系 API（Worker 上）の共通防御。
// - オリジン制限: 許可オリジン以外の Origin/Referer を拒否（クロスサイトからの利用を弾く）。
// - レート制限: ログイン総当たり等を緩和する簡易な per-IP スライディングウィンドウ。
//   ※Worker はリクエストごとに別 isolate になり得るため、このカウンタは**ベストエフォート**（同一 isolate 内のみ）。
//     厳密な制限は Cloudflare の Rate Limiting ルール / KV / Durable Object を使う（本番導入時に検討）。
// - no-store: 管理レスポンスはキャッシュさせない。

const WINDOW_MS = 60 * 1000;
const DEFAULT_MAX = 20;
const hits = new Map();

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
}

// true を返したら「上限超過」。bucket でログイン/操作を分けて数える。
export function rateLimited(request, bucket = 'default', max = DEFAULT_MAX) {
  const ip = clientIp(request);
  const key = bucket + ':' + ip;
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(key, arr);
  // 素朴なメモリ肥大対策: 溜まりすぎたら期限切れキーを掃除する。
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (!v.length || now - v[v.length - 1] > WINDOW_MS) hits.delete(k);
    }
  }
  return arr.length > max;
}

// オリジン制限。env.ALLOWED_ORIGIN（カンマ区切り）で許可元を明示できる。
// 未設定なら「リクエスト先と同一オリジン」のみ許可。Origin/Referer が無いリクエスト（同一オリジンの
// fetch は Origin を付けないことがある）は安全側で通し、セッション検証など他の防御に委ねる。
export function originAllowed(request, env) {
  const origin = request.headers.get('Origin') || '';
  const referer = request.headers.get('Referer') || '';
  const src = origin || referer;
  if (!src) return true;
  let host = '';
  try { host = new URL(request.url).origin; } catch (_) { host = ''; }
  const allow = String((env && env.ALLOWED_ORIGIN) || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allow.length === 0) return !!host && src.startsWith(host);
  return allow.some((a) => src.startsWith(a));
}

// no-store な JSON レスポンス。管理系は常にキャッシュ禁止で返す。
export function jsonNoStore(obj, status = 200, extraHeaders = {}) {
  const headers = Object.assign({
    'Content-Type': 'application/json;charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  }, extraHeaders);
  return new Response(JSON.stringify(obj), { status, headers });
}
