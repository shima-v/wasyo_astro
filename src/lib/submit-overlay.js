// 送信中の全面オーバーレイ（二重送信防止＋送信中の強調）の共有ロジック。
// UI（見た目・aria）は SubmitOverlay.astro が描く #submitOverlay を操作する。
// index / manage / admin で共有。define:vars の値には依存しない（メッセージは引数で渡す）。

/** 送信中オーバーレイを表示する。message を渡すとカード内の本文を差し替える。 */
export function showSubmitOverlay(message) {
  const el = document.getElementById('submitOverlay');
  if (!el) return;
  if (message != null) {
    const msgEl = el.querySelector('.submit-overlay-msg');
    if (msgEl) msgEl.textContent = message;
  }
  el.hidden = false;
}

/** 送信中オーバーレイを隠す（既に隠れていても安全＝冪等）。 */
export function hideSubmitOverlay() {
  const el = document.getElementById('submitOverlay');
  if (el) el.hidden = true;
}

// 二重送信ガード用の単一フライトフラグ（このモジュールを共有する画面内で1本）。
let busy = false;

/**
 * fn の実行中は再入を弾き（＝二重送信防止）、実行中は全面オーバーレイを出す。
 * 実行が終われば必ずオーバーレイを閉じる。既に実行中なら何もせず undefined を返す。
 * @param {() => Promise<any>|any} fn 送信処理
 * @param {{message?: string}} [opts] message: オーバーレイに出す文言
 */
export async function runExclusive(fn, { message } = {}) {
  if (busy) return undefined;
  busy = true;
  showSubmitOverlay(message);
  try {
    return await fn();
  } finally {
    busy = false;
    hideSubmitOverlay();
  }
}
