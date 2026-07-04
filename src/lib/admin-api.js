// 予約管理画面（/reserve/admin）の共有ロジック。
// 管理 API 呼び出し（POST）・認証（ログイン/ログアウト）・認証ゲートの出し入れを集約する。
// admin.astro から import して使う。
//
// 【P1 セキュリティ】認証方式を環境で切り替える:
//   - dev（IS_DEV）    : **セッション Cookie 方式**。ログイン時に管理トークンを Worker の
//                        /reserve/admin/api/login へ送り、短命の署名付き httpOnly Cookie を発行してもらう。
//                        以降の管理 API は /reserve/admin/api/action（Cookie 前提）を叩き、ブラウザは
//                        管理トークンを一切保持しない（＝長寿命トークンを持たせない）。
//   - prod            : 従来の **localStorage トークン方式**（GAS へ直接 adminToken を添えて送る）。
//                        prod は Worker が無い（GitHub Pages）ため。prod の Worker 化は別途（スコープ外）。

import { runExclusive } from './submit-overlay.js';
import { IS_DEV } from '../data/config.js';

const SESSION_MODE = IS_DEV;
const API_BASE = '/reserve/admin/api';

const TOKEN_KEY = 'wasyoAdminToken';

/** 保存済みの管理トークンを取得（無ければ空文字）。localStorage 不可でも安全に空を返す。※レガシー方式のみ。 */
export function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } }
/** 管理トークンを保存（localStorage 不可でも例外を握りつぶす）。※レガシー方式のみ。 */
export function setToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch (_) {} }
/** 管理トークンを消去（localStorage 不可でも例外を握りつぶす）。※レガシー方式のみ。 */
export function clearToken() { try { localStorage.removeItem(TOKEN_KEY); } catch (_) {} }

/**
 * 管理 API 呼び出し（apiPost）・認証（login/logout）・認証ゲート（showGate/showPanel/handleForbidden）・
 * 起動時の出し分け（startup）を束ねたインスタンスを作る。
 * DOM 参照は cfg.el（document.getElementById 相当）越しに遅延解決する。
 * @param {{reserveApi: string, el: (id: string) => HTMLElement}} cfg
 */
export function createAdminApi(cfg) {
  const reserveApi = cfg.reserveApi;
  const el = cfg.el;

  // ---- 管理 API（送信中は全面オーバーレイ＋二重送信ガード。silent で素通し） ----
  async function apiPost(action, extra, opts = {}) {
    const send = SESSION_MODE
      ? async () => {
          // セッション方式: Cookie 前提で Worker の /action を叩く（管理トークンは送らない）。
          const res = await fetch(API_BASE + '/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(Object.assign({ action }, extra || {})),
          });
          return res.json();
        }
      : async () => {
          // レガシー方式: GAS へ直接。text/plain で CORS プリフライト回避・adminToken を毎回添付。
          const payload = Object.assign({ action, adminToken: getToken() }, extra || {});
          const res = await fetch(reserveApi, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload),
          });
          return res.json();
        };
    if (opts.silent) return send();
    return runExclusive(send, { message: '送信しています…' });
  }

  // ---- ログイン / ログアウト ----
  /**
   * ログイン。セッション方式は Worker の /login でトークン(＋PIN)を検証し Cookie を発行してもらう。
   * レガシー方式はトークンを localStorage に保存するだけ（従来挙動）。
   * @returns {Promise<boolean>} 成功可否
   */
  async function login(token, pin) {
    if (SESSION_MODE) {
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
    setToken(token);
    return true;
  }

  /** ログアウト。セッション方式は Cookie 失効、レガシー方式は localStorage 消去。 */
  async function logout() {
    if (SESSION_MODE) {
      try {
        await fetch(API_BASE + '/logout', { method: 'POST', credentials: 'same-origin' });
      } catch (_) {}
      return;
    }
    clearToken();
  }

  // ---- 認証ゲートの出し入れ ----
  function showGate(errMsg) {
    el('panel').hidden = true;
    el('gate').hidden = false;
    const e = el('gateErr');
    if (errMsg) { e.textContent = errMsg; e.hidden = false; } else { e.hidden = true; }
    el('tokenInput').focus();
  }
  function showPanel() {
    el('gate').hidden = true;
    el('panel').hidden = false;
  }

  // forbidden（未認証/セッション切れ/トークン不正）を検知したらゲートへ戻す。
  function handleForbidden() {
    if (SESSION_MODE) {
      showGate('セッションが無効です。再度ログインしてください。');
    } else {
      clearToken();
      showGate('管理トークンが無効です。正しいトークンを入力してください。');
    }
  }

  /**
   * 起動時の出し分け。
   *   - セッション方式: パネルを開いて listPending を試行し、Cookie 無効なら
   *     apiPost の forbidden 経由で handleForbidden がゲートへ戻す（既存の forbidden 処理を再利用）。
   *   - レガシー方式: 保存済みトークンの有無でゲート/パネルを出し分ける（従来どおり）。
   */
  function startup(onAuthed, onGate) {
    if (SESSION_MODE) { onAuthed(); return; }
    if (getToken()) onAuthed(); else onGate();
  }

  return { apiPost, login, logout, showGate, showPanel, handleForbidden, startup };
}
