// 予約管理画面（/reserve/admin）の共有ロジック。
// トークン保管（localStorage）・管理 API 呼び出し（POST）・認証ゲートの出し入れを集約する。
// admin.astro から import して使う。この段階ではトークン方式（localStorage）は現行のまま
// （Worker セッション化は後続フェーズ）＝挙動不変の純粋な抽出。

import { runExclusive } from './submit-overlay.js';

const TOKEN_KEY = 'wasyoAdminToken';

/** 保存済みの管理トークンを取得（無ければ空文字）。localStorage 不可でも安全に空を返す。 */
export function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } }
/** 管理トークンを保存（localStorage 不可でも例外を握りつぶす）。 */
export function setToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch (_) {} }
/** 管理トークンを消去（localStorage 不可でも例外を握りつぶす）。 */
export function clearToken() { try { localStorage.removeItem(TOKEN_KEY); } catch (_) {} }

/**
 * 管理 API 呼び出し（apiPost）と認証ゲート（showGate / showPanel / handleForbidden）を
 * 束ねたインスタンスを作る。DOM 参照は cfg.el（document.getElementById 相当）越しに
 * 遅延解決するため、抽出前の admin.astro と同じ都度ルックアップ挙動を保つ。
 * @param {{reserveApi: string, el: (id: string) => HTMLElement}} cfg
 * @returns {{apiPost: Function, showGate: Function, showPanel: Function, handleForbidden: Function}}
 */
export function createAdminApi(cfg) {
  const reserveApi = cfg.reserveApi;
  const el = cfg.el;

  // 管理 API は全て POST（text/plain で CORS プリフライト回避）。adminToken を毎回添付。
  // 既定では送信中の全面オーバーレイ＋二重送信ガード（共有 runExclusive）を通す。
  // 一覧・設定の自動読み込み（listPending / getQuota / getSlotConfig）は opts.silent で素通し。
  async function apiPost(action, extra, opts = {}) {
    const send = async () => {
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

  // forbidden（トークン不正）を検知したら token を消してゲートへ戻す
  function handleForbidden() {
    clearToken();
    showGate('管理トークンが無効です。正しいトークンを入力してください。');
  }

  return { apiPost, showGate, showPanel, handleForbidden };
}
