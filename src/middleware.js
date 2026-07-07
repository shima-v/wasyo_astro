// 予約管理（/reserve/admin 配下）のサーバゲート。dev/prod とも Cloudflare 配信へ統一した（ADR-0002）ため、
// 以前の「二態（dev=サーバ／prod=クライアント）」向けの prod passthrough（fail-open）・環境分岐は持たない。
// 常時サーバゲートの単純形: 管理ページへのアクセスをセッション Cookie でサーバ側検証し、
// 未認証者には管理ページの HTML を一切返さず、公開のログイン導線（/reserve/admin/login）へ 302 する。
//
// このミドルウェアが実際にゲートするのは「オンデマンド（prerender:false）の管理ページ」だけ。
// 公開ページ・静的アセット（ログインページを含む）は Cloudflare が ASSETS から直接配信するため、
// 実行時にはここを通らない（＝ゲート対象外で正しい）。
import { verifySession, readCookie } from './worker/session.js';

const ADMIN_PREFIX = '/reserve/admin';
const LOGIN_PATH = '/reserve/admin/login';
// リダイレクト先は末尾スラッシュ付き（静的アセットの canonical 形）。無しだと Cloudflare の
// ASSETS 層が /login → /login/ の 307 を挟むため、最初から canonical に合わせて1ホップ省く。
const LOGIN_REDIRECT = '/reserve/admin/login/';

export async function onRequest(context, next) {
  const path = context.url.pathname;

  // 管理系（/reserve/admin 本体・配下）以外は素通し。/reserve/administrator 等の
  // 前方一致の取り違えを避けるため「完全一致 or '/' 直後」で判定する。
  if (!(path === ADMIN_PREFIX || path.startsWith(ADMIN_PREFIX + '/'))) return next();

  // 公開のログイン導線はゲート対象外（未認証者がログインするための入口）。
  if (path === LOGIN_PATH || path.startsWith(LOGIN_PATH + '/')) return next();

  // 管理 API は各ルートが自前で認可する（login=公開／logout・action=セッション検証）。
  // ここで二重にゲートすると login に到達できずログイン不能になるため、素通しに委ねる。
  if (path.startsWith(ADMIN_PREFIX + '/api/')) return next();

  // ここに到達するのはオンデマンドの管理ページ本体のみ（＝Cloudflare Worker ランタイムでのみ実行）。
  // Worker 専用の cloudflare:workers を、静的ページのプリレンダ（ビルド時に走る middleware）で
  // 読み込まないよう、動的 import で実行時にだけ解決する。
  const { env } = await import('cloudflare:workers');
  const secret = (env && env.SESSION_SECRET) || '';
  const valid = await verifySession(secret, readCookie(context.request));
  if (valid) return next();

  // 未認証 → 管理ページの HTML は返さず、ログイン導線へリダイレクト。
  return context.redirect(LOGIN_REDIRECT, 302);
}
