// 空き枠ヒートマップの共有ロジック（予約フロント）。
// 枠数から記号（◎/○）と濃淡クラス（heat-hi/heat-mid）を導く純関数。
// index（メニュー→日時）と manage（日時変更）の両方のカレンダーで使う。
// hiMin は「空き多い（◎）」と見なす下限。define:vars の値に依存せず引数で受ける。

/**
 * @param {number} count 当日の空き枠数
 * @param {{hiMin?: number}} [opts] hiMin: ◎ の下限（既定 8）
 * @returns {{mark: string, cls: string}} mark=◎/○、cls=heat-hi/heat-mid
 */
export function heatMark(count, { hiMin = 8 } = {}) {
  const hi = Number(count) >= hiMin;
  return { mark: hi ? '◎' : '○', cls: hi ? 'heat-hi' : 'heat-mid' };
}
