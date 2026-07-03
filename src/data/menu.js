// 予約・料金で共有するメニュー定義。
// index.astro の表示および予約ページの「所要時間→空き枠計算／料金表示」で使用する。
//
// 時間は2系統に分かれる点に注意:
//   ・durationMin（＋firstTime） … お客様に見せる「施術時間」。料金表示・予約完了/確認の表示に使う。
//   ・slotMin                      … Google カレンダー上で確保（ブロック）する「占有時間」＝施術＋待機。
//                                    空き枠計算とカレンダーイベント長に使う。新規/常連に関係なくメニュー固定。
//
// firstTime を持つメニューは「新規(初回)のお客様」の場合に所要時間・料金を上書きする。
//   例: 全身もみほぐし30分 → 初回は40分（料金は据え置き）。占有(slotMin)は初回でも変えない。
// 新規/常連の判定は GAS(顧客台帳) 側で行い、フロントは判定結果を受けて表示・送信する。

/**
 * @typedef {Object} MenuItem
 * @property {string} id           一意ID（予約データのキー）
 * @property {string} name         表示名
 * @property {('double'|'simple'|'petit')} group  コース区分
 * @property {string} [subtitle]   補足
 * @property {number} durationMin  通常の施術時間（分・お客様表示用）
 * @property {number} slotMin      カレンダー占有時間（分・施術＋待機。空き枠計算とイベント長に使用）
 * @property {number} price        通常料金（円）
 * @property {{durationMin:number, price:number, label:string}} [firstTime] 初回時の上書き
 * @property {string} [note]       注記
 */

/** コース区分の表示ラベル */
export const MENU_GROUPS = {
  double: { label: 'ダブルコース', desc: '全身もみほぐし＋オイルケアを一度に体験' },
  simple: { label: 'シンプルコース', desc: '' },
  petit: { label: 'プチコース', desc: '1部位重点ケア' },
};

/** @type {MenuItem[]} */
export const MENU = [
  // ① ダブルコース（おすすめ）
  {
    id: 'double-momi-part-oil-70',
    name: '全身もみほぐし＋部位オイルケア',
    group: 'double',
    durationMin: 70,
    slotMin: 150,
    price: 4300,
    note: 'オイルケアは臀部・腹部・鼠蹊部は致しません',
  },
  {
    id: 'double-momi-full-oil-90',
    name: '全身もみほぐし＋全身オイルケア',
    group: 'double',
    durationMin: 90,
    slotMin: 180,
    price: 5500,
    note: 'オイルケアは臀部・腹部・鼠蹊部は致しません',
  },

  // ② シンプルコース
  {
    id: 'simple-momi-30',
    name: '全身もみほぐし 30分',
    group: 'simple',
    durationMin: 30,
    slotMin: 90,
    price: 3300,
    firstTime: { durationMin: 40, price: 3300, label: '初回40分' },
  },
  {
    id: 'simple-momi-50',
    name: '全身もみほぐし 50分',
    group: 'simple',
    durationMin: 50,
    slotMin: 150,
    price: 4000,
    firstTime: { durationMin: 60, price: 4000, label: '初回60分' },
  },
  {
    id: 'simple-momi-70',
    name: '全身もみほぐし 70分',
    group: 'simple',
    durationMin: 70,
    slotMin: 150,
    price: 4400,
  },
  {
    id: 'simple-momi-100',
    name: '全身もみほぐし 100分',
    group: 'simple',
    durationMin: 100,
    slotMin: 180,
    price: 5500,
  },
  {
    id: 'simple-oil-80',
    name: '全身オイルケア',
    group: 'simple',
    durationMin: 80,
    slotMin: 180,
    price: 6600,
  },

  // ③ プチコース
  { id: 'petit-foot-30', name: 'フットケア', group: 'petit', durationMin: 30, slotMin: 60, price: 3300 },
  { id: 'petit-hand-30', name: 'ハンドケア', group: 'petit', durationMin: 30, slotMin: 60, price: 3300 },
  {
    id: 'petit-head-30',
    name: 'ヘッド&リフトアップ（顎ほぐし）',
    group: 'petit',
    durationMin: 30,
    slotMin: 60,
    price: 3500,
  },
];

/** id からメニューを取得 */
export function getMenuById(id) {
  return MENU.find((m) => m.id === id) ?? null;
}

/**
 * 新規(初回)かどうかで、実際に適用される所要時間・料金を返す。
 * @param {MenuItem} menu
 * @param {boolean} isFirstTime
 * @returns {{durationMin:number, price:number, isFirstTime:boolean}}
 */
export function getEffectiveMenu(menu, isFirstTime) {
  if (isFirstTime && menu.firstTime) {
    return { durationMin: menu.firstTime.durationMin, price: menu.firstTime.price, isFirstTime: true };
  }
  return { durationMin: menu.durationMin, price: menu.price, isFirstTime: false };
}

/** 円表示ヘルパ（¥4,300 形式） */
export function formatYen(n) {
  return '¥' + n.toLocaleString('ja-JP');
}
