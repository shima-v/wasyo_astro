// 予約の空き枠まわりの共有ロジック。
// GAS からの「素材」取得（menuId 非依存の availabilityRaw）と、素材＋slotMin からの
// 予約可能日時の導出（純粋関数）を提供する。DOM や画面固有の state には依存しない。
// 現状は reserve/index.astro の予約ウィザードが利用。後続の代理予約フォームも
// この2関数（fetch + compute）を再利用できるよう汎用形で切り出している。

/**
 * 空き枠の「素材」を GAS から取得する（menuId 非依存の availabilityRaw）。
 * 返り値は { days:[{date, candidates, busy}], holidays:{ 'yyyy-MM-dd': 祝日名 } }。
 * 取得失敗・data.ok!==true のときは例外を投げる（呼び出し側でリトライ可否を判断）。
 * @param {string} reserveApi GAS Web App の URL
 * @returns {Promise<{days: Array, holidays: Object}>}
 */
export async function fetchAvailabilityRaw(reserveApi) {
  const res = await fetch(`${reserveApi}?action=availabilityRaw`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'error');
  return { days: data.days || [], holidays: data.holidays || {} };
}

/**
 * 先読み素材(raw)から slotMin を当てはめて予約可能な日時を導出する（純粋関数・fetch なし）。
 * 各日の candidate 開始 t について [tMin, tMin+slotMin] が busy レンジと重ならなければ空き。
 * 重なり判定は tStart < bEnd && bStart < tEnd（半開区間）。
 * @param {{days: Array, holidays: Object}|null} raw fetchAvailabilityRaw の結果
 * @param {number} slotMin メニューの占有時間（分）
 * @returns {{days: Array<{date: string, times: string[]}>, holidays: Object}}
 */
export function computeDaysForSlot(raw, slotMin) {
  if (!raw) return { days: [], holidays: {} };
  const days = [];
  for (const d of raw.days) {
    const times = [];
    for (const hhmm of d.candidates) {
      const [hh, mm] = hhmm.split(':').map(Number);
      const tStart = hh * 60 + mm;
      const tEnd = tStart + slotMin;
      // 重なり判定: tStart < bEnd && bStart < tEnd（半開区間）
      const clash = d.busy.some(([bStart, bEnd]) => tStart < bEnd && bStart < tEnd);
      if (!clash) times.push(hhmm);
    }
    if (times.length) days.push({ date: d.date, times });
  }
  return { days, holidays: raw.holidays || {} };
}
