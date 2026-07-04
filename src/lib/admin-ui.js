// 予約管理画面（/reserve/admin 配下）共通の純 DOM / 文字列ヘルパ。
// P2 でページを分割しても各ページの <script> から再利用できるよう、admin.astro の
// インライン定義から一字一句同じ出力になる形で抽出した（挙動不変）。
//
// 収録:
//   esc(s)                     … HTML エスケープ（& < > " の4文字）
//   createToast(el)            … #toast へ短時間メッセージを出す toast 関数を作る
//   loadingHtml(text)          … 「読み込み中スピナー」行の HTML 文字列
//   emptyHtml(msg, {warn})     … 「.empty（灰の情報ボックス）」の HTML 文字列
//
// ※ loadingHtml / emptyHtml に渡す text は「安全なプレーンテキストのラベル」を前提とする
//   （呼び出し側は固定文言のみを渡す）。ユーザー入力を混ぜる箇所では使わず esc() を明示的に使う。

/** HTML エスケープ。null/undefined は空文字に。& < > " の4文字のみ変換（元 admin.astro と同一）。 */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * トースト（画面下の短時間メッセージ）関数を作る。
 * #toast 要素を el 越しに都度解決し、2.6 秒後に自動で消す。タイマは closure で保持
 * （元コードの toast._t と等価）。
 * @param {(id: string) => HTMLElement} el document.getElementById 相当
 * @returns {(msg: string) => void}
 */
export function createToast(el) {
  let timer;
  return function toast(msg) {
    const t = el('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(timer);
    timer = setTimeout(() => t.classList.remove('show'), 2600);
  };
}

/** 読み込み中スピナー行の HTML（元 admin.astro のインライン文字列と同一）。 */
export function loadingHtml(text = '読み込んでいます…') {
  return '<div class="status loading"><span class="spinner" aria-hidden="true"></span><span>' + text + '</span></div>';
}

/** .empty（灰の情報ボックス）の HTML。warn:true で警告色クラスを付ける。 */
export function emptyHtml(msg, opts = {}) {
  return '<div class="empty' + (opts.warn ? ' warn' : '') + '">' + msg + '</div>';
}
