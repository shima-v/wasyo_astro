// 予約管理画面（/reserve/admin）の共有ロジック。
// 配信基盤を dev/prod とも Cloudflare へ統一し（ADR-0002）、認証を **サーバゲート一本** にした。
// 以前あった環境分岐（dev=セッションCookie / prod=localStorage トークン）は撤去済み。
// ブラウザは長寿命の管理トークンを一切保持せず、Worker が発行する短命の署名付き httpOnly
// セッション Cookie だけで認可される。
//   - ログインページ  : adminLogin() が /reserve/admin/api/login にトークン(＋PIN)を送り Cookie を発行させる。
//   - 管理画面本体    : createAdminApi() の apiPost が /reserve/admin/api/action（Cookie 前提）を叩く。
//   - セッション切れ  : handleForbidden() が公開のログイン導線（/reserve/admin/login）へ戻す。
//   - 未認証者        : そもそも middleware が管理ページ本体の HTML を返さずログイン導線へ 302 する。

import { runExclusive } from './submit-overlay.js';

const API_BASE = '/reserve/admin/api';
// 末尾スラッシュ付き（静的アセットの canonical 形。無しだと ASSETS 層で 307 が挟まる）。
const LOGIN_PATH = '/reserve/admin/login/';

/**
 * ログイン。管理トークン(＋任意 PIN)を Worker の /login へ送り、短命の署名付き httpOnly
 * セッション Cookie を発行してもらう。ログインページから使う。
 * @returns {Promise<boolean>} 成功可否
 */
export async function adminLogin(token, pin) {
  try {
    const res = await runExclusive(async () => {
      const r = await fetch(API_BASE + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ token, pin: pin || '' }),
      });
      return r.json();
    }, { message: 'ログインしています…' });
    return !!(res && res.ok);
  } catch (_) {
    return false;
  }
}

/**
 * 管理画面本体で使う API クライアント（apiPost / logout / handleForbidden）を作る。
 * すべて Cookie 前提で Worker（/reserve/admin/api/*）を叩く。管理トークンはブラウザに持たせない。
 */
export function createAdminApi() {
  // ---- 管理 API（送信中は全面オーバーレイ＋二重送信ガード。silent で素通し） ----
  async function apiPost(action, extra, opts = {}) {
    const send = async () => {
      // Cookie 前提で Worker の /action を叩く（管理トークンは送らない）。
      const res = await fetch(API_BASE + '/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(Object.assign({ action }, extra || {})),
      });
      return res.json();
    };
    if (opts.silent) return send();
    return runExclusive(send, { message: '送信しています…' });
  }

  /** ログアウト。Worker がセッション Cookie を失効させる。 */
  async function logout() {
    try {
      await fetch(API_BASE + '/logout', { method: 'POST', credentials: 'same-origin' });
    } catch (_) {}
  }

  // forbidden（未認証／セッション切れ）を検知したらログイン導線へ戻す（サーバゲートと一貫）。
  function handleForbidden() {
    location.href = LOGIN_PATH;
  }

  return { apiPost, logout, handleForbidden };
}
