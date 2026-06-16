# 予約機能 WBS（作業分解構成）／進捗管理

> サロン和笑〜Violane〜 予約システム開発の進捗管理ドキュメント。
> 設計の詳細は [`RESERVATION_PLAN.md`](./RESERVATION_PLAN.md) を参照。

- **最終更新**: 2026-06-17（Phase 3 統合＋Phase 1.6 dev GAS 2系統デプロイ）
- **作業ブランチ**: `develop`（本番=`main`）
- **凡例**: `[ ]`未着手 / `[~]`進行中 / `[x]`完了 ／ 担当 🤖=Claude実装 / 👤=ユーザー手動作業

## 進捗サマリ

| フェーズ | 内容 | 状態 | 進捗 |
|---------|------|------|------|
| Phase 0 | 基盤・環境準備 | 完了 | 19 / 19 |
| Phase 1 | GAS バックエンド | 完了（dev デプロイ・単体確認済み） | 21 / 21 |
| Phase 2 | フロント（予約UI） | 実装ほぼ完了（残=LINE Login任意） | 13 / 14 |
| Phase 3 | 既存サイト統合・環境切替 | ほぼ完了（残=👤 repo secret 登録） | 5 / 6 |
| Phase 4 | 検証・リリース | 進行中（e2e ほぼ合格・残=店LINE宛先修正/UI/リリース） | 4 / 8 |

---

## Phase 0: 基盤・環境準備

### 0.1 リポジトリ基盤 🤖
- [x] 0.1.1 `develop` ブランチ作成
- [x] 0.1.2 `WBS.md` 作成（本ドキュメント）
- [x] 0.1.3 `RESERVATION_PLAN.md` をリポ直下に保存
- [x] 0.1.4 `CLAUDE.md` に平文リンク追記（PLAN / WBS）
- [x] 0.1.5 `.gitignore` に `.env.development` 追加＋`.env.development.example` を作成

### 0.2 外部サービス準備（dev/prod 分離。※LINE Messaging API のみ共有）👤 ※手順書(Phase 0.3.1)に従う
- [x] 0.2.1 Google: **dev** 予約カレンダー作成（カレンダーID控え）
- [x] 0.2.2 Google: **prod** 予約カレンダー作成（カレンダーID控え）
- [x] 0.2.3 Google: **dev** 顧客台帳スプレッドシート作成（ID控え）
- [x] 0.2.4 Google: **prod** 顧客台帳スプレッドシート作成（ID控え）
- [x] 0.2.5 GAS: **dev** プロジェクト作成（clasp 紐付け→scriptId 控え）
- [x] 0.2.6 GAS: **prod** プロジェクト作成（clasp 紐付け→scriptId 控え）
- [x] 0.2.7 LINE: Messaging API チャネル作成＋channel access token 取得（**dev/prod 共有**：1公式アカウント=1チャネル制約のため新規2つは作成不可）
- [x] 0.2.8 ~~LINE: prod 用 Messaging API チャネル~~ → **0.2.7 と共有**（新規作成不要。dev/prod とも同一チャネル・同一トークン。区別は `ENV_LABEL` で対応）
- [x] 0.2.9 LINE: **dev** LINE Login チャネル作成（channel ID/secret）
- [x] 0.2.10 LINE: **prod** LINE Login チャネル作成（channel ID/secret）
- [x] 0.2.11 Cloudflare Workers(Builds): プロジェクト作成・`develop` 連携・環境変数設定（`wrangler.toml`/`.nvmrc`/`pnpm-workspace.yaml` はリポジトリ管理）
- [x] 0.2.12 各 GAS の Script Properties 設定（カレンダーID / 台帳ID / LINEトークン / 管理者メール許可リスト / HMAC secret / FRONT_BASE_URL✔ / ENV_LABEL）

### 0.3 ローカル開発準備
- [x] 0.3.1 外部セットアップ手順書 `docs/SETUP.md` 作成 🤖
- [x] 0.3.2 clasp インストール・ログイン（手順は SETUP.md）👤

---

## Phase 1: GAS バックエンド 🤖（dev で構築）

### 1.1 基盤
- [x] 1.1.1 `gas/` 構成（`appsscript.json`✔ / `.clasp.*.json.example`✔ / `gas/README.md`✔）
- [x] 1.1.2 `doGet`/`doPost` ルーター・CORS対応（POSTは`text/plain`）・JSON レスポンスヘルパ
- [x] 1.1.3 設定読込（Script Properties ラッパ）
- [x] 1.1.4 HMAC 署名/検証ユーティリティ

### 1.2 空き枠
- [x] 1.2.1 営業時間ルール定義（月〜金 10–20 / 第2・第4土 / 日祝・第1/3/5土 休）
- [x] 1.2.2 手動開閉設定の読み書き（`getSlotConfig` / `setSlotConfig`）
- [x] 1.2.3 `getAvailability`（リードタイム=翌日以降・上限1ヶ月・メニュー所要時間・既存予約除外・30分刻み）

### 1.3 予約作成
- [x] 1.3.1 顧客台帳照合（新規/常連判定：userId→電話→メール）
- [x] 1.3.2 初回料金・初回所要時間の確定ロジック
- [x] 1.3.3 `createBooking`（LockService・空き再検証・仮イベント作成・トークン発行）
- [x] 1.3.4 店へ LINE push（承認/辞退 署名リンク付き）
- [x] 1.3.5 客へ受付通知（LINE userId 有→LINE / 無→メール）

### 1.4 承認・変更・取消
- [x] 1.4.1 `approveBooking` / `declineBooking`（確定/削除＋客通知）
- [x] 1.4.2 `cancelBooking`（前日まで検証）
- [x] 1.4.3 `changeBooking`（再空き枠検証）
- [x] 1.4.4 顧客台帳更新（確定時に来店回数）

### 1.5 管理画面（GAS HTML Service）
- [x] 1.5.1 `admin.html` 空き枠開閉 UI（臨時休業/臨時営業/時間枠クローズ）
- [x] 1.5.2 `admin.html` 仮予約一覧・承認/辞退（`adminApi*` ラッパ経由）
- [x] 1.5.3 Google アカウント認証（管理者メール許可リスト照合）

### 1.6 デプロイ
- [x] 1.6.1 dev へ `clasp push` ＋ 2系統デプロイ🤖（①公開API=実行自分/全員＝既存`@1`を再デプロイ ②管理=実行アクセスユーザー/自分のみ＝新規）。clasp の deploy はマニフェスト設定で実行ユーザーが決まるため、マニフェストを差し替えて2系統作成→公開設定へ復元
- [x] 1.6.2 dev 単体動作確認：公開API `?action=availability` が `ok:true`＋営業ルール（翌日以降・日祝休・第3土休/第4土営業・30分刻み10:00-19:30）を実カレンダーで検証🤖。初回認可済み。**管理パネル（`?action=admin`）もオーナーログインで表示・承認/辞退の動作を確認済み👤**（access=自分のみ＝オーナーアカウントで開く）

---

## Phase 2: フロント（予約UI）🤖

### 2.1 共有モジュール
- [x] 2.1.1 `src/data/menu.js`（通常＋初回の所要時間・料金）
- [x] 2.1.2 `src/data/config.js`（`import.meta.env.PUBLIC_*` から GAS URL 等）

### 2.2 予約ページ `src/pages/reserve/index.astro`
- [x] 2.2.1 レイアウト・既存デザイントークン適用
- [x] 2.2.2 メニュー選択 UI
- [x] 2.2.3 日付選択＋空き枠取得・表示（リアルタイム）
- [x] 2.2.4 フォーム（氏名・電話・連絡方法 LINE/メール・性別・男性時 紹介者必須・要望）
- [x] 2.2.5 同意チェック＋取扱い注意書き
- [x] 2.2.6 送信処理（二重送信防止・ローディング・エラー表示）
- [x] 2.2.7 受付完了画面（管理URL案内）
- [x] 2.2.8 新規判定時の初回料金表示（完了画面で適用結果を表示／初回候補は長い所要で空き枠取得）

### 2.3 管理ページ（客）`src/pages/reserve/manage.astro`
- [x] 2.3.1 `?token=` 受取・予約内容表示
- [x] 2.3.2 キャンセル UI
- [x] 2.3.3 変更（再空き枠選択）UI

### 2.4 LINE Login 連携（任意・段階導入可）
- [ ] 2.4.1 LINE Login フロー（userId 取得→フォームに連携）※MVPは「メール既定」で先送り

---

## Phase 3: 既存サイト統合・環境切替 🤖

### 3.1 既存サイト `src/pages/index.astro`
- [x] 3.1.1 主要CTA（ヒーロー/スマホ追従ナビ/メニュー下）を `/reserve` へ（内部リンク化・`target="_blank"`除去）
- [x] 3.1.2 RESERVA をフッターフォールバックに（`.reserve-btn--footer` で小さく残置）
- [x] 3.1.3 「当日予約は電話で」案内の維持確認（アクセス節「当日予約・休日受付」は現状維持）

### 3.2 環境切替
- [x] 3.2.1 `astro.config.mjs` の `site` を環境切替（既定=prod wwwasyo.com / dev=`PUBLIC_SITE_URL`で`*.workers.dev`上書き）
- [~] 3.2.2 GitHub Actions に prod env 追加（`deploy.yml` の Build に `PUBLIC_RESERVE_API`/`PUBLIC_SITE_URL` 注入済み🤖。👤残=repo secret `PROD_RESERVE_API` に prod GAS の `/exec` URL を登録）
- [x] 3.2.3 Cloudflare Workers(Builds) の dev ビルド設定（`wrangler.toml`・`.nvmrc`・環境変数）👤/🤖

---

## Phase 4: 検証・リリース

### 4.1 検証
- [x] 4.1.1 `pnpm build` 成功 🤖（dev フロント Cloudflare デプロイ確認済み）
- [~] 4.1.2 `/reserve` 動作（dev GAS 接続）：API層は curl で疎通確認済み🤖（availability/createBooking/booking/changeBooking）。👤残=ブラウザでUI操作確認
- [~] 4.1.3 e2e: 仮予約→【仮】→店LINE通知→承認→【確定】＋確定通知。**仮予約🤖✓・承認で確定化👤✓（管理パネル）・お客様メール✓（迷惑メール振分け／ENV_LABEL付与済）**。👤残=**店LINE通知のみ**（`LINE_OWNER_USER_ID` が誤設定＝`C`始まりのグループID。`U`始まりユーザーIDへ修正＋ボット友だち追加が必要）
- [x] 4.1.4 新規/常連判定・初回料金の自動適用 🤖（新規=`isFirstTime:true`、初回40分・¥3,300 が自動適用）
- [x] 4.1.5 取消/変更がカレンダー・空き枠に反映 🤖：変更✓（15:00→16:30・再承認のため pending 復帰）＋取消✓（確定済みを cancelBooking→`not_found` で削除確認）
- [x] 4.1.6 バリデーション（紹介者必須=`referrer_required`／当日不可=`too_soon`／1ヶ月超=`too_far`／重複不可=`slot_taken`）🤖

### 4.2 リリース
- [ ] 4.2.1 `develop`→`main` マージ 👤
- [ ] 4.2.2 prod 反映確認（wwwasyo.com）👤

---

## メモ・課題
- GAS の CORS で問題が出たら Cloudflare Workers プロキシへ退避（プラン「既知のリスク」参照）。
- LINE Login は MVP では任意。初期は「メール既定・LINE連携は任意」で段階導入可。
- 新規/常連判定は別端末/別連絡先で取りこぼし得る → 承認時に店が補正。
- **LINE Messaging API は dev/prod 共有**（1公式アカウント=1チャネル制約）。dev テスト通知が本番と同じ LINE に届くため、Script Property `ENV_LABEL`（dev=`【開発】`／**prod は未登録**＝GASは空文字保存不可のためキーごと作らない）で**店へのLINE通知とお客様メール（件名・本文）**の先頭を区別する。承認/辞退リンクは各環境の GAS URL を指すため誤承認はしない。
- dev フロントは **Cloudflare Workers(Builds)**。`wrangler deploy` が `wrangler.toml`（`[assets] directory="./dist"`）で `dist/` を静的配信。Node は `.nvmrc`=22 固定。
