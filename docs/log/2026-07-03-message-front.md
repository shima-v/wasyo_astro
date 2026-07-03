# 2026-07-03 改修⑤ 顧客メッセージ送信の front 化

## 目的（なぜ）
予約客への任意メッセージ送信を、GAS 管理デプロイ②（executeAs=アクセスユーザー・要Googleログイン）依存から、
承認/辞退で採用済みの「front（非 Google ドメイン）経由＋HMAC sig capability」モデルへ寄せる。
これは後続「GAS 単一デプロイ化（②撤去）」（工程⑥）の前提。承認/辞退の front 化（`/reserve/decision` + doPost `decide`）と同じモデル。

## 実装（追加のみ・既存挙動は非破壊）

### GAS `gas/Code.gs`
- 新関数 `messageInfoBySig_(token, sig)`: `verifySig_('message:'+token, sig)` 検証 → OK なら `getBookingByToken_(token)`（連絡先を含まない概要）をそのまま返す。読み取り専用。
- 新関数 `messageSendBySig_(token, sig, message)`: `sendCustomerMessageBySig` から `requireAdmin_` ラップを外した版。挙動（bad_signature / empty_message / not_found / no_channel / 送信）は旧関数と同一。保護は 'message:' sig capability のみ。
- doPost に2ケース追加（`decide` の直後）: `case 'messageInfo'` / `case 'messageSend'`。
- `adminEventDescription_(token)`: メッセージリンク基底を `adminExecUrl_()`（②の /exec）から **front** `FRONT_BASE_URL.replace(/\/$/,'') + '/reserve/message/?token=...&sig=...'` に張替。文言（【管理者用】✉️ お客様へメッセージを送る:）は踏襲。
- **後方互換**: 旧 `renderMessagePage_` / `sendCustomerMessageBySig` / `doGet('message')` は消していない（撤去は工程⑥）。

### フロント（新規）`src/pages/reserve/message.astro`
- `decision.astro` を雛形に、`RESERVE_API`（config.js 経由）を `text/plain` POST で叩く完全静的ページ。
- 読み込み時に `messageInfo` をプリフェッチし、概要（お名前＋新規/常連・メニュー・日時＋durationMin分・あれば要望）＋ステータス（確定/仮予約）を表示。連絡先は表示しない（返らない）。
- テキストエリア＋送信ボタン。送信で `messageSend` を POST。ok=「送信しました」、error は日本語表示（empty_message / no_channel / bad_signature / not_found）。
- `EnvBadge`・共有スタイル・noindex を付与。入力は 1rem 以上で iOS 自動ズーム抑止（旧 renderMessagePage_ の配慮を踏襲）。

## 設計上の判断・経緯
- **概要取得を GET `?action=booking` ではなく POST `messageInfo` にした理由**: decision.astro は概要取得に GET booking（sig 不要）を使うが、message では「概要表示にも 'message:' sig の正当性を要求」したいため、sig 検証込みの専用 action を新設。bad_signature を概要段階でも日本語表示できる。
- **adminEventDescription_ の基底組み立て**: 既存の `manageUrl_` / `decisionBaseUrl_` と同じ `FRONT_BASE_URL.replace(/\/$/,'')` パターンで統一（指示どおり）。`ADMIN_EXEC_URL`（②）はメッセージ導線からは不要になった（②撤去=工程⑥まで Property 自体は残置）。
- **フロント側の空チェック**: サーバー往復を省くため message.astro でも空を弾くが、サーバー（messageSendBySig_）でも empty_message を再検証する二重防御。

## 実体確認
- `pnpm run build` 成功。`/reserve/message/index.html` 生成、`messageInfo`/`messageSend`/`noindex` が HTML に埋め込み済み。
- `node --check`（Code.gs を .js コピーで）構文 OK。
- git 差分は `gas/Code.gs`（+37/-3・追加のみ）と `src/pages/reserve/message.astro`（新規）の2件。`dist/` は .gitignore 対象。
- 個人情報・秘密（token/sig 実値・メール）の混入なし。tel はサロン公表番号で既存全ページと同一。

## 未了（本工程外・別途）
- コミット / push / clasp push / デプロイは未実施（クロコが実体確認のうえ実施）。
- 工程⑥: 旧 `renderMessagePage_` / `sendCustomerMessageBySig` / `doGet('message')` / 管理デプロイ② の撤去。
- SETUP.md の `ADMIN_EXEC_URL`（②）に関する記述は、②撤去（工程⑥）時に併せて整理する。
