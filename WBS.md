# 予約機能 WBS（作業分解構成）／進捗管理

> サロン和笑〜Violane〜 予約システム開発の進捗管理ドキュメント。
> 設計の詳細は [`RESERVATION_PLAN.md`](./RESERVATION_PLAN.md) を参照。

- **最終更新**: 2026-06-20（**LIFF予約機能を実装**〔LINEアプリ内予約・IDトークンをGASで検証・前日リマインド/来店後フォロー・Messaging API無料枠監視〕。コードは🤖実装・ビルド確認済み、残=👤 LINEコンソール/トリガー/secret。詳細は下記「Phase 5」参照／2026-06-17＝LINE Login＋管理画面レスポンシブ対応）
- **作業ブランチ**: `develop`（本番=`main`）
- **凡例**: `[ ]`未着手 / `[~]`進行中 / `[x]`完了 ／ 担当 🤖=Claude実装 / 👤=ユーザー手動作業

## 進捗サマリ

| フェーズ | 内容 | 状態 | 進捗 |
|---------|------|------|------|
| Phase 0 | 基盤・環境準備 | 完了 | 19 / 19 |
| Phase 1 | GAS バックエンド | 完了（dev デプロイ・単体確認済み） | 21 / 21 |
| Phase 2 | フロント（予約UI） | 完了（LINE Login連携＋管理画面レスポンシブ実装・dev反映済み） | 16 / 16 |
| Phase 3 | 既存サイト統合・環境切替 | ほぼ完了（残=👤 repo secret 登録） | 5 / 6 |
| Phase 4 | 検証・リリース | 進行中（e2e ほぼ合格・残=店LINE宛先修正/UI/リリース） | 4 / 8 |
| Phase 5 | LIFF化（LINEアプリ内予約・リマインド・無料枠監視） | コード実装・ビルド確認済み（残=👤 LINEコンソール/トリガー/secret/e2e） | 5 / 11 |

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

### 2.4 LINE Login 連携（任意）🤖
- [x] 2.4.1 LINE Login フロー（Web OAuth リダイレクト方式で userId・表示名を取得→フォームに連携）
- [x] 2.4.2 GAS `lineLogin_`（`code`→token交換→`id_token` 検証→`{lineUserId, displayName}`）＋ `doPost` ルート
- [x] 2.4.3 同端末 localStorage 保存による自動連携（再訪時は LINE 認可スキップ・既知項目折りたたみ・解除導線）

### 2.5 管理画面レスポンシブ（スマホ対応）🤖
- [x] 2.5.1 `gas/admin.html` に `@media (max-width:600px)` を追加（入力欄の幅・行の縦並び・ボタンのタップ領域。配色/トークンは維持）

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
- [~] 4.1.3 e2e: 仮予約→【仮】→店LINE通知→承認→【確定】＋確定通知。**仮予約🤖✓・お客様メール✓（迷惑メール振分け／ENV_LABEL付与済）・予約イベントの永続性🤖✓（@9で作成→60秒後も生存・誤削除なし）**。👤残=①ブラウザで承認/辞退ボタン押下→確定/削除（`google.script.run`）②`PUBLIC_EXEC_URL` を Script Properties に登録③店通知の宛先（グループID）確定
  - 🐞**重大バグ修正🤖**: 承認/辞退リンクが**作成後数十秒で勝手に削除**される事象の真因＝**LINEのリンクプレビュー用クローラが通知内URL(GET)を先読みし辞退を誤実行**。対策＝**GETは状態変更しない確認ページ化**＋ボタン→`google.script.run.decideBySig`、店通知は**confirmテンプレのボタン**化、リンク基底を`PUBLIC_EXEC_URL`に固定（`ScriptApp.getService().getUrl()`の不安定回避）。検証済み（GET先読みしても`status`はpendingのまま）。
- [x] 4.1.4 新規/常連判定・初回料金の自動適用 🤖（新規=`isFirstTime:true`、初回40分・¥3,300 が自動適用）
- [x] 4.1.5 取消/変更がカレンダー・空き枠に反映 🤖：変更✓（15:00→16:30・再承認のため pending 復帰）＋取消✓（確定済みを cancelBooking→`not_found` で削除確認）
- [x] 4.1.6 バリデーション（紹介者必須=`referrer_required`／当日不可=`too_soon`／1ヶ月超=`too_far`／重複不可=`slot_taken`）🤖

### 4.2 リリース
- [ ] 4.2.1 `develop`→`main` マージ 👤
- [ ] 4.2.2 prod 反映確認（wwwasyo.com）👤

---

## Phase 5: LIFF化（LINEアプリ内予約・リマインド・無料枠監視）※2026-06-20 実装

> 既存の Web 予約（外部ブラウザ＝LINE未使用客）は併存維持。LINEアプリ内では LIFF で
> ログイン操作なしに予約完結。設計の詳細は [`RESERVATION_PLAN.md`](./RESERVATION_PLAN.md) の「LIFF構成」節を参照。

### 5.1 GAS バックエンド 🤖
- [x] 5.1.1 `verifyLineIdToken_(idToken)` を抽出（`lineLogin_` の verify 部を共通化・email クレームも返す）
- [x] 5.1.2 `liffVerify_(b)` 新規＋`doPost` に `case 'liffVerify'`（id_token をサーバ検証して userId 確定＝なりすまし防止）
- [x] 5.1.3 `sendReminders_()`（前日・確定予約へ LINE/メール・`reminded` タグで多重防止）/ `sendFollowUps_()`（来店翌日・`followedUp` タグ）
- [x] 5.1.4 無料枠監視：`getQuotaConsumption_`/`adminGetQuota_`/`case 'getQuota'`/`checkQuota_`（80%でオーナー警告・月単位ガード `QUOTA_WARNED_YYYYMM`）
- [x] 5.1.5 送信ログ：`linePushMessages_` に `kind` 引数＋`logPush_`（台帳の「送信ログ」シートへ日時/種別/宛先マスク/成否を記録）

### 5.2 フロント 🤖
- [x] 5.2.1 `src/data/config.js` に `LIFF_ID`（trim）追加・SDK 読込（`LIFF_ID` 設定時のみ head に挿入）
- [x] 5.2.2 `reserve/index.astro`：`initLiff()`（`liff.init`→`isInClient` 分岐→`getIDToken`→`liffVerify`→氏名/メール自動入力）。外部ブラウザは既存 OAuth/手入力にフォールバック
- [x] 5.2.3 完了時アクション：`liffAfterBooking()`（`sendMessages`/`getFriendship` で友だち追加案内/`shareTargetPicker`、各 `isApiAvailable` ガード）
- [x] 5.2.4 `gas/admin.html` に「LINE無料枠（当月）◯/200通」表示＋再読込

### 5.3 env / CI 🤖
- [x] 5.3.1 `.env.development(.example)` と `deploy.yml` に `PUBLIC_LIFF_ID` 追加
- [ ] 5.3.2 repo secret `PROD_LIFF_ID` 登録 👤

### 5.4 LINEコンソール / トリガー / 検証 👤
- [ ] 5.4.1 dev/prod の LINE Login チャネルに LIFF アプリ追加（エンドポイント=各 `/reserve/`・サイズ Full・スコープ `profile openid email` `chat_message.write`・`bot_prompt=normal`）→ `LIFF_ID` 控え
- [ ] 5.4.2 LINE Login チャネルに公式アカウント（Messaging API）を連携（`getFriendship`/友だち追加の前提）＋ email 取得申請
- [ ] 5.4.3 リッチメニュー/トークカード/プロフィールに LIFF URL（`https://liff.line.me/{LIFF_ID}`）設定
- [ ] 5.4.4 GAS 時間トリガー登録：`sendReminders_`/`sendFollowUps_`/`checkQuota_` を日次（毎朝）＋ Script Property `MONTHLY_FREE_QUOTA`（既定200）
- [ ] 5.4.5 e2e：dev Workers URL→LINEアプリで LIFF 起動→自動入力→予約→`liffVerify` 検証・リマインド/フォロー多重防止・無料枠表示・警告

---

## LINE連携・管理画面レスポンシブ（確定仕様）※2026-06-17 実装・dev反映完了

> 実装・dev デプロイ済み（公開API `@16` / 管理デプロイ `@15` をエディタUIで更新）。本節は実装と一致した確定仕様。

### ① お客様 LINE userID 取得（LINE Login＋同端末 自動連携）

**目的**: お客様の LINE userId を取得し、(a) お客様への LINE 自動通知、(b) 新規/常連の照合（`line:<userId>` 優先）に使う。GAS 側は受領・通知・照合とも実装済みで、不足は**フロントの取得導線**のみ（WBS 2.4.1 の積み残し）。

**取得できる情報の制約**: LINE Login で取れるのは **userId・表示名（・任意設定でメール）のみ**。**電話番号・性別は取得不可**。

**確定要件**:
- LINE 連携は**任意**。
- **氏名** = LINE 表示名で自動補完（編集可）。**電話番号・性別**は手入力で**必須のまま**。男性は紹介者必須を維持。
- **メール**は連携時のみ**任意**（未連携は従来どおり必須）。
- **再連携・再入力不要（同一端末）**: 連携情報を端末（localStorage）に保存し、次回訪問時は自動で「連携済み」扱い（LINE 認可をスキップ）。既知項目は折りたたみ表示にし、実質「ご要望＋同意チェックのみ」で予約完了できる。

**表示状態（3種）**:
1. **未連携**: 従来の全項目＋「LINEで連携（任意）」ボタン。
2. **連携直後（保存値なし）**: 「連携済み: 〇〇さん」。氏名自動補完・メール任意化・電話/性別は入力（必須）。送信成功時に連携情報を端末保存。
3. **再訪（localStorage に連携情報あり）**: 自動で連携済み。氏名/電話/性別/紹介者は保存値を流用し折りたたみ表示。アクティブ入力は「ご要望＋同意」のみ。「修正」で編集展開、「連携を解除/別の人として予約」で保存クリア＆未連携へ。

**フロント** [`src/pages/reserve/index.astro`](src/pages/reserve/index.astro):
- 連携開始: 乱数 `state`/`nonce`＋入力中フォーム状態を `localStorage`（キー `wasyo_line_oauth`・復帰時に必ず削除）へ退避 → `https://access.line.me/oauth2/v2.1/authorize`（`response_type=code` / `client_id` / `redirect_uri` / `state` / `scope=profile%20openid` / `nonce`）へ遷移。※`sessionStorage` だと「認可開始タブ」と「LINEから戻るタブ/アプリ内ブラウザ」が別だと失われ `state` 照合に失敗するため `localStorage`（同一オリジンでタブ共有）を使う。
- 連携復帰: 読込時に `?code`&`?state` 検知 → `state` 照合（不一致は中断＝CSRF対策）→ フォーム復元 → GAS へ `POST {action:'lineLogin', code, redirectUri}` → `{lineUserId, displayName}` 保持 → 状態② → `history.replaceState` で URL から `code/state` 除去。
- 端末保存: localStorage キー `wasyo_line_profile` に `{lineUserId, displayName, name, phone, gender, referrer}`（**同意チェックは保存しない**＝予約毎に再取得）。読込時 `lineUserId` あれば認可せず状態③で開始。
- バリデーション/送信: `lineUserId` ありならメール必須チェックをスキップ（電話・性別は必須維持）。payload に `lineUserId` 追加。同意文に LINE userID・表示名（連携時）の取得/保存目的を追記。
- 設定読込: [`src/data/config.js`](src/data/config.js) の `LINE_LOGIN_CHANNEL_ID`・`LINE_LOGIN_REDIRECT`（既存エクスポート）。

**GAS** [`gas/Code.gs`](gas/Code.gs):
- `doPost` switch に `case 'lineLogin': return json_(lineLogin_(body));`（お客様向け区分）。
- 新規 `lineLogin_(b)`: `UrlFetchApp` で `https://api.line.me/oauth2/v2.1/token`（`grant_type=authorization_code` / `code` / `redirect_uri=b.redirectUri` / `client_id=prop_('LINE_LOGIN_CHANNEL_ID')` / `client_secret=prop_('LINE_LOGIN_CHANNEL_SECRET')`）→ `id_token` を `https://api.line.me/oauth2/v2.1/verify` で検証 → `{ok:true, lineUserId:sub, displayName:name||''}`。失敗時 `{ok:false, error:'line_login_failed'}`（詳細 `console.error`）。秘密情報はコード非保持。
- `createBooking_`（連絡先判定）は**変更不要**（`lineUserId` で通る）。

**セキュリティ注記**: 再訪時は OAuth を省略し localStorage の `lineUserId` を信頼する。LINE userId は推測不能（`U`+ランダム）のため第三者の値詐称は非現実的＝許容。気になる場合は将来「送信時に再検証」を足せる設計にする。localStorage は**お客様自身の端末内**（開発者DBではない）・解除導線あり。

**👤 設定**: dev GAS Script Properties に `LINE_LOGIN_CHANNEL_ID`/`LINE_LOGIN_CHANNEL_SECRET`（dev値）。dev Login チャネルのコールバックURLに `http://localhost:4321/reserve/` と `https://wasyo-dev.<account>.workers.dev/reserve/` を登録（exact match）。Cloudflare に `PUBLIC_LINE_LOGIN_REDIRECT`（workers.dev /reserve/）。**重要: push に使うため LINE Login チャネルと Messaging API チャネルは同一プロバイダーであること**（別プロバイダーだと取得 userId で push 不可）。

### ② 管理画面のスマホレスポンシブ [`gas/admin.html`](gas/admin.html)

`<style>` に `@media (max-width:600px)`（必要なら 480px も）を追加（配色/トークン維持）:
- `input[type=date]/[type=time]/textarea` を `width:100%`（または `flex:1 1 100%; min-width:0`）で行内オーバーフロー防止。
- `.row`（日付＋時刻＋ボタン）はスマホで縦並び寄り＋押しやすい幅。
- `.card .actions`（承認/辞退）はスマホで各 `flex:1`。
- `h2`（タイトル＋小ボタン）は `flex-wrap` 許可。`.wrap` 左右 padding 微減。
- タップ領域（既存 `min-height:40px`）維持。viewport は `doGet` で付与済み＝CSS のみ。

---

## メモ・課題
- **教訓（GETの冪等性）**: 通知に載せるリンクは**メール/LINE/チャットのプレビュー用クローラに先読みされる前提**で設計する。状態変更（承認/辞退/削除）を GET で行うと勝手に発火する。必ず確認ページ＋ボタン（POST相当）に分離する。
- **UX改修🤖（2026-06-17）**: 予約日時の選択を**月送り付きカレンダーグリッド**化（●印＝空きあり／土日色分け／受付範囲外の月は前後ボタン無効）。空き取得中は**スピナー＋スケルトン**で明示。完了画面の管理URLは**ボタン**、お客様メール/LINEのURLは見出し付きで簡素表示。空き取得は **getEvents を日数分→範囲一括1回**に削減して高速化。`src/pages/reserve/index.astro` と `manage.astro` の両方に適用。
- GAS の CORS で問題が出たら Cloudflare Workers プロキシへ退避（プラン「既知のリスク」参照）。
- LINE Login は MVP では任意。初期は「メール既定・LINE連携は任意」で段階導入可。
- 新規/常連判定は別端末/別連絡先で取りこぼし得る → 承認時に店が補正。
- **LINE Messaging API は dev/prod 共有**（1公式アカウント=1チャネル制約）。dev テスト通知が本番と同じ LINE に届くため、Script Property `ENV_LABEL`（dev=`【開発】`／**prod は未登録**＝GASは空文字保存不可のためキーごと作らない）で**店へのLINE通知とお客様メール（件名・本文）**の先頭を区別する。承認/辞退リンクは各環境の GAS URL を指すため誤承認はしない。
- dev フロントは **Cloudflare Workers(Builds)**。`wrangler deploy` が `wrangler.toml`（`[assets] directory="./dist"`）で `dist/` を静的配信。Node は `.nvmrc`=22 固定。
