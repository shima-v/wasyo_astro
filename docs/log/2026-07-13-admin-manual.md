# 2026-07-13 管理者向けマニュアルページ

## 背景（なぜ）
予約管理画面を実運用するのは非エンジニアの店主。操作手順・顧客情報の扱い・安全のしくみ・
システム構成を、画面の中でいつでも読める「手引き」として用意する。口頭・記憶に頼らず、
店主が自分で調べて解決できる状態にする。作業ブランチ: `develop`（dev のみ・prod は触らない）。
**未 push・未 clasp（本人GO事項）**。

## 採用した方式（静的ページ）
- 公開プライバシーポリシー（`src/pages/privacy/index.astro`）と同じ**純静的の長文ページ**流儀を
  ミラー：`.astro` 直書き＋`<section class="card">` 積み＋末尾 `<style is:global>`。**API・`<script>` は
  持たない**（読み物なので動的処理不要＝回帰面が最小・保守が楽）。
- ただし中身は運用情報なので**閲覧に認証を必須**にする。公開ポリシーとの唯一かつ最重要の差分＝
  **`export const prerender = false;`（リテラル）**。これが無いと static 配信され middleware の
  サーバゲートを通らず、誰でも読めてしまう（ADR-0002・見本 `settings.astro:13`）。
- 共通部品を流用：`AdminHeader`（title/back/backLabel）・`EnvBadge`・`ENV_LABEL`・`styles/admin.css`
  （`.wrap`/`.card`/`.card>h2`）。棚ビジュアル `admin-cabinet.css` は読み物には不要なので import しない。

## 変更ファイル
- **新規** `src/pages/reserve/admin/manual.astro`（URL `/reserve/admin/manual`・相対 `../../../`）
  - `prerender = false`（リテラル）＋ head に `<meta name="robots" content="noindex">`。
  - 本文は目次順に `<section class="card">` を積む。ページ固有スタイル（目次・手順・スクショ枠・
    定義リスト）だけを末尾 `<style is:global>` に `.manual` 配下限定で足す（他ページ非干渉）。
    基本トークン・`.wrap`・`.card` は admin.css を流用（`* { margin:0 }` リセットでリスト余白が
    潰れる分は `.manual .card ul/ol` で復活させる）。
- **改修** `src/pages/reserve/admin.astro`：管理トップの棚に「マニュアル」カードを1枚追加
  （設定カード `.chart settings` を複製・`href=/reserve/admin/manual`・固定文言・本のアイコン）。
  **動的ステータスは持たないため `<script>` は無改変**（要対応の朱印ロジックにも触れない）。区分色は
  設定を流用（新色を足さない）。
- **新規** `docs/log/2026-07-13-admin-manual.md`（本ファイル）。
- **改修** `docs/DEV_NOTES.md`：保守ルール「機能を改修したら manual.astro の該当節と更新履歴
  （lastUpdated）を更新する」を追記（wasyo に working-agreement.md が無いため、改修時に参照する
  標準メモ＝DEV_NOTES を追記先に選定）。

## 目次と構成（承認済み計画の①〜⑥を、店主が読みやすい通し番号1〜6で表示）
読者が「1,2,3,5,6,4」と飛ぶ違和感を避けるため、**読む順に通し番号を振り直した**（内容の対応は下記）。
- **1. 操作** ＝計画①。A. やりたいこと別の手順（承認/辞退・メッセージ・代理予約・連絡先確認・
  メモ・臨時営業/休業・一斉送信の7ユースケースを番号付きステップ＋各figure枠）／B. 画面ごとの早見。
- **2. 顧客情報の扱い方** ＝計画②（既定マスクの理由・20秒自動再マスク・メモの可否・共有端末・
  目的外利用の禁止・開示/訂正/削除依頼の流れ→公開ポリシー §9）。
- **3. 安全管理のしくみ** ＝計画③（保存先はサロン所有 Google＋LINE のみ・独自DB無し／ブラウザに
  生連絡先を渡さずハッシュ突合／認証本人だけ／監査ログ〔本文・生トークンは残さない〕）。
- **4. システム構成** ＝計画⑤（各コンポーネント1行＋構成図の差し込み位置）。
- **5. 通知の受け取り方** ＝計画⑥（Discord 参加／Google カレンダー共有。招待URL・共有先メールは
  本文に書かず「管理者から個別に案内」）。
- **6. 運用サポート** ＝計画④（更新履歴〔lastUpdated 定数＋履歴リスト初回1行〕・よくあるトラブルと
  対処・用語集・問い合わせ先）。

## 機能説明は実コードに裏取り（作話しない）
本文の挙動は下記の実装事実に基づく（推測で書かない）:
- 20秒自動再マスク＝`customers.astro` の `REMASK_MS = 20000`。
- 新規/常連タグ・並び替え（最終来店/来店回数）・メモ「✎」マーク・「店主用・お客様には表示されません」
  ＝`customers.astro`。
- 承認して確定/辞退・お客様へのメッセージ欄・代理予約（空き枠駆動）＝`reservations.astro`。
- 一斉送信の「対象と残枠を確認」・残枠80%警告・枠不足で送信不可＝`broadcast.astro`。
- 必須通知（予約確定/却下）は切れない＝`settings.astro`（`checked disabled`・「常に送信され、OFFにできません」）。
- ログイン＝管理トークン（＋任意PIN）＝`login.astro`。
- 公開ポリシーのリンク＝`${base}privacy/`（base='/'・既存流儀 `index.astro`/`reserve/index.astro` と同形）。

## 構成図と figure 枠の作り
- **構成図**は別コンポーネント `src/components/ArchDiagram.astro`（design が並行作成）を差し込む設計。
  - 着手時点では**未作成**だったため、いったん frontmatter の `import ArchDiagram ...` と本文の
    `<ArchDiagram />` を**コメントアウト**し、差し込み枠を置いて 1 回目の build を通した。
  - **作業中に design の完成版が入った**ため、コンポーネントの実体（自己完結・`<style>` を持たず
    全 inline style・props 不要・PII クリーン）を確認のうえ**差し込みを有効化**した（import 1行と
    `<ArchDiagram />` の有効化）。プレースホルダ枠は撤去し、余白のみの容器 `.arch-figure` にした。
    有効化後に build/test を**再検証**して green を確認（下記）。import 行は ArchDiagram の内部
    マークアップが今後変わっても影響しない（差し替え自由）。
- **figure 枠**（各ユースケースのスクショ）は画像未用意のため、`<img>` の src を実在させず
  **プレースホルダ**にした：
  `<figure class="shot"><div class="shot__ph">画面イメージは後日追加</div><figcaption>…</figcaption></figure>`。
  画像が用意できたら figure 先頭に `<img>` を差し込むだけで済む構造（`.manual .shot img` のスタイルは
  準備済み）。各ユースケースに1枠。

## スクショの後日差し替え（PII 非写り込み厳守）
- スクショは後日、店主・クロコが用意して差し替える。**撮影時に顧客の実名・実電話・実メール・
  LINE 表示名などの PII が写り込まないダミー環境で撮る**こと。実データ画面のキャプチャは載せない。

## 匿名化の自己点検
- 顧客 PII 実値・secret・scriptId・deploymentId・生トークン・実メール/電話番号は**テキストに一切
  書いていない**。ドメイン `wwwasyo.com` のみ記載（公開情報・可）。電話 `090-…` は footer の店舗連絡先
  （既存の privacy/admin ページと同一の公開値）。
- 機能説明は上記のとおり実コードに裏取りした事実のみ。挙動が確認できない事項は断定していない。

## 検証（ローカル・push 不要）
- `pnpm build` 成功（ArchDiagram **統合後**の最終版で確認）。プリレンダ一覧に `/reserve/admin/manual`
  が**現れない**＝オンデマンド（`prerender=false`）＝ゲート対象で正しい。manual ルートは
  `dist/server/chunks/manual_*.mjs`（サーバ側）に出力される＝Worker 実行のオンデマンドで整合。
- `pnpm test` 全 green（23 pass / 0 fail・session 系のみ・回帰ゼロ）。
- ArchDiagram は差し込み**有効**（コメントアウトは解消済み）。

## 次PL／残した事項
- **本人GO事項（不可逆）**: `develop` の push（Workers Builds が dev 自動デプロイ）。dev で実機目視
  （認証必須で開けるか・未認証は login へ 302 か・リンク/リンク先が正しいか・スマホ表示）。
- スクショ差し替え（PII 非写り込みのダミー環境で撮影）。
