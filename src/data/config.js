// サイト全体で使う「公開設定」。値は環境変数 (import.meta.env.PUBLIC_*) から注入する。
//   ・ローカル/dev : .env.development（dev値） / Cloudflare Pages の環境変数
//   ・本番(prod)   : GitHub Actions の env（repo secret の prod値）
// 秘密情報（LINEチャネルトークン等）はここに置かない。それらは GAS の Script Properties 側で管理する。

/**
 * 実行環境の判定。dev のみ true。
 * `=== 'development'` の厳密一致なので、prod で PUBLIC_ENV を付け忘れても安全に false（＝開発表示は出ない）。
 */
export const IS_DEV = import.meta.env.PUBLIC_ENV === 'development';

/** タブ(title)や通知に付ける環境ラベル。dev のみ '【開発】'、prod は ''。 */
export const ENV_LABEL = IS_DEV ? '【開発】' : '';

/** GAS Web App の /exec エンドポイント URL（環境ごとに切替） */
export const RESERVE_API = import.meta.env.PUBLIC_RESERVE_API ?? '';

/** LINE Login チャネルID（任意。LINE連携を使う場合のみ） */
export const LINE_LOGIN_CHANNEL_ID = import.meta.env.PUBLIC_LINE_LOGIN_CHANNEL_ID ?? '';

/** LINE Login のリダイレクト先（予約ページURL） */
export const LINE_LOGIN_REDIRECT = import.meta.env.PUBLIC_LINE_LOGIN_REDIRECT ?? '';

/**
 * 予約ルール（フロント表示・即時バリデーション用）。
 * ※サーバー(GAS)側でも同じ値で必ず再検証する。フロントの値は信用しない。
 */
export const BOOKING_RULES = {
  leadTimeDays: 1,       // 当日不可・翌日以降のみオンライン受付
  maxAdvanceDays: 30,    // 受付上限（約1ヶ月先まで）
  slotStepMin: 30,       // 開始時刻は30分刻み
  cleanupBufferMin: 0,   // 施術前後の確保バッファ（必要に応じて調整）
  cancelDeadlineDays: 1, // 前日までキャンセル/変更可
};

/** 性別の選択肢（男性は紹介者必須・承認制） */
export const GENDERS = [
  { value: 'female', label: '女性' },
  { value: 'male', label: '男性（ご紹介制）' },
];

/** 連絡方法 */
export const CONTACT_METHODS = [
  { value: 'line', label: 'LINEで連絡を受け取る' },
  { value: 'email', label: 'メールで連絡を受け取る' },
];
