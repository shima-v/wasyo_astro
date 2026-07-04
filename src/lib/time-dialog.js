// 開始時刻を選ぶポップアップ（ネイティブ <dialog>）の共有ロジック。
// UI（器）は TimeDialog.astro が描く #timeDialog / #timeDialogTitle / #timeDialogBody。
// index / manage の日時選択で共有。ページ側の state には触れず、選択された時刻を
// onPick(time) で呼び出し元へ返す（状態の反映は呼び出し元の責務）。

/** 時刻ポップアップを開く（本体は先に renderTimeButtons で描いておく）。 */
export function openTimeDialog() {
  const dlg = document.getElementById('timeDialog');
  if (!dlg) return;
  try {
    dlg.showModal();
  } catch (_) {
    dlg.setAttribute('open', '');
  }
}

/** 時刻ポップアップを閉じる（開いていなければ何もしない）。 */
export function closeTimeDialog() {
  const dlg = document.getElementById('timeDialog');
  if (dlg && dlg.open) dlg.close();
}

/**
 * 時刻ボタン群を #timeDialogBody に描画し、クリックで onPick(time) を呼ぶ。
 * クリック時はボタンの選択強調（active）を付け替え、ポップアップを閉じてから onPick する。
 * @param {string[]} times 選べる開始時刻の配列
 * @param {(time: string) => void} onPick 選択された時刻を受け取るコールバック
 * @param {{title?: string, selected?: string|null}} [opts]
 *        title: 見出し（#timeDialogTitle）に出す文言 / selected: 初期選択中の時刻
 */
export function renderTimeButtons(times, onPick, { title, selected } = {}) {
  const body = document.getElementById('timeDialogBody');
  if (!body) return;
  if (title != null) {
    const t = document.getElementById('timeDialogTitle');
    if (t) t.textContent = title;
  }
  body.innerHTML = (times || [])
    .map(
      (t) =>
        `<button type="button" class="time-btn${t === selected ? ' active' : ''}" data-time="${t}">${t}</button>`,
    )
    .join('');
  body.querySelectorAll('.time-btn').forEach((b) => {
    b.addEventListener('click', () => {
      body.querySelectorAll('.time-btn').forEach((x) => x.classList.toggle('active', x === b));
      closeTimeDialog();
      if (typeof onPick === 'function') onPick(b.dataset.time);
    });
  });
}
