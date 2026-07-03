# gas/ — 予約システム バックエンド（Google Apps Script）

サロン和笑〜Violane〜 予約システムのサーバー処理。空き枠計算 / 仮予約 / 承認・辞退 / キャンセル・変更 / 新規・常連判定 / 通知を担う。

- 設計: [`../docs/RESERVATION_PLAN.md`](../docs/RESERVATION_PLAN.md) ／ 進捗: [`../docs/WBS.md`](../docs/WBS.md)
- 外部サービスの初期設定（Google / LINE / Script Properties）: [`../docs/SETUP.md`](../docs/SETUP.md)
- 保存先はサロン所有の Google（予約カレンダー＋顧客台帳シート）と LINE のみ。**独自DBは持たない。**

## ファイル構成

| ファイル | 役割 |
|---------|------|
| `Code.gs` | 本体。`doGet`/`doPost` ルーター、空き枠、予約、承認、通知、台帳、HMAC 等 |
| `appsscript.json` | マニフェスト（TZ=Asia/Tokyo・Web App 設定・V8） |
| `.clasp.dev.json.example` / `.clasp.prod.json.example` | clasp ターゲットのテンプレ（scriptId を入れて使う） |

> メニュー定義（`MENU`）と営業ルール（`RULES`）はフロントの `src/data/menu.js` / `src/data/config.js` と**二重管理**。変更時は両方そろえる。

## 前提

- Node.js 22+ / pnpm
- clasp: `npm i -g @google/clasp` → `clasp login`（このセッションで実行するなら `! clasp login`）
- GAS プロジェクト（dev / prod）と各 Script Properties は [`../docs/SETUP.md`](../docs/SETUP.md) C・F の通り作成済みであること

## clasp ターゲットの切り替え（dev / prod）

`clasp` はカレントに置かれた `.clasp.json` を見る。dev/prod を取り違えないよう、**操作直前に対象の設定をコピーして使う**運用にする。

1. 初回のみ、テンプレから scriptId 入りの設定を用意（gitignore 済み・コミットしない）:
   ```bash
   cp gas/.clasp.dev.json.example  gas/.clasp.dev.json    # scriptId に dev の値
   cp gas/.clasp.prod.json.example gas/.clasp.prod.json   # scriptId に prod の値
   ```
2. dev に向ける / prod に向ける:
   ```bash
   cp gas/.clasp.dev.json  gas/.clasp.json    # → 以降の push/deploy は dev
   cp gas/.clasp.prod.json gas/.clasp.json    # → 以降の push/deploy は prod
   ```

> `rootDir` は `.` なので、`gas/` ディレクトリ内で clasp コマンドを実行する（`cd gas`）。

## push / deploy

```bash
cd gas

# 1) 対象を選ぶ（例: dev）
cp .clasp.dev.json .clasp.json

# 2) コードを反映
clasp push

# 3) 動作確認は GAS エディタで（clasp open）
clasp open

# 4) Web App として公開（バージョン付きデプロイ）
clasp deploy --description "yyyy-mm-dd 変更概要"
```

prod へ反映するときは手順1で `cp .clasp.prod.json .clasp.json` に変えて同じ流れ。

## デプロイは単一（公開ウェブアプリ①のみ・重要）

デプロイは **公開ウェブアプリ①の1つだけ**。`appsscript.json` の既定（`executeAs: USER_DEPLOYING` ＝オーナー実行 / `access: ANYONE_ANONYMOUS` ＝匿名到達可）どおりに `clasp deploy` で作る or GAS エディタ「デプロイ」→「ウェブアプリ」:

- 実行ユーザー: **自分**（オーナー権限でカレンダー/LINE/メールを操作するため）
- アクセスできるユーザー: **全員（匿名を含む）**
- 用途:
  - `GET ?action=availability`（空き枠）/ `GET ?action=booking`（front `/reserve/manage` の予約内容取得）
  - `POST createBooking` / `cancelBooking` / `changeBooking`（お客様）
  - `POST decide`（承認/辞退・front `/reserve/decision` から・'decision:' 署名）
  - `POST messageInfo` / `messageSend`（顧客メッセージ・front `/reserve/message` から・'message:' 署名）
  - `POST 管理系`（front `/reserve/admin` から・bearer `ADMIN_TOKENS`。`getSlotConfig`/`setSlotConfig`/`listPending`/`getQuota`/`adminDecision`/`broadcast*`/`setTempSchedule`/`ownerChannelTest`）
  - `POST deployNotify`（デプロイ通知・`DEPLOY_NOTIFY_TOKEN`）
- 発行 URL（`.../exec`）→ フロントの `PUBLIC_RESERVE_API` と GAS の `FRONT_BASE_URL` に使う

> **管理・承認/辞退・顧客メッセージはすべて front（非 Google ドメインの自社サイト `/reserve/…`）→ この単一 `/exec` への POST** で完結する。要 Google ログインの GET 管理ページ（旧 `?action=admin`/`?action=message`/`?action=approve|decline`）と管理デプロイ②は撤去済み。管理の認可は front `/reserve/admin` から送る bearer トークン `ADMIN_TOKENS`（`requireAdminToken_`）で行う。

## 管理トークンの発行・運用（重要）

管理操作（front `/reserve/admin`）は **bearer トークン `ADMIN_TOKENS`** で認可する（Google ログイン不要）。front が POST body の `adminToken` として送り、GAS の `requireAdminToken_` が Script Property `ADMIN_TOKENS`（カンマ区切り）に含まれるかを照合する。含まれなければ `forbidden`。

**必ず守る前提**:
- `ADMIN_TOKENS` の実値は **各 GAS の Script Properties のみ**に置く。**リポジトリ・フロント（配布物）・この文書には書かない**。
- dev / prod それぞれの Script Properties に設定する（値は別々にするのが望ましい）。
- トークンは **推測困難な強ランダム**にする（発番は `HMAC_SECRET` と同じ `openssl rand -base64 48` などでよい）。

**運用**:
1. トークンを1つ以上生成し、`ADMIN_TOKENS` にカンマ区切りで登録（例: 複数管理者に別々のトークンを配れば、1人分だけ失効させることも可能）。
2. 管理者は front `/reserve/admin` を開き、自分のトークンを入力して管理する（トークンはブラウザ側に保持され、POST 時に `adminToken` として送られる）。
3. 失効させたいトークンを `ADMIN_TOKENS` から外して保存すれば即時無効化できる。
4. **カレンダー/台帳の権限**: 全操作はオーナー実行（`executeAs=USER_DEPLOYING`）なので、管理者ごとにカレンダー（`CALENDAR_ID`）・台帳（`LEDGER_SHEET_ID`）を個別共有する必要はない（②の execute-as-accessing-user 時に必要だった手当ては不要になった）。

## エンドポイント早見

| メソッド | action | 認証 | 用途 |
|---------|--------|------|------|
| GET | `availability` | なし | 空き枠取得（`menuId`,`from?`,`to?`,`isFirstTime?`） |
| GET | `booking` | トークン | 予約内容取得（`token`。front `/reserve/manage`） |
| POST | `createBooking` | なし | 仮予約作成 |
| POST | `cancelBooking` / `changeBooking` | トークン | キャンセル / 変更 |
| POST | `decide` | HMAC署名（`decision:`） | 承認/辞退（front `/reserve/decision` から。`token`,`sig`,`approve`,`message?`） |
| POST | `messageInfo` / `messageSend` | HMAC署名（`message:`） | 顧客メッセージ 概要取得 / 送信（front `/reserve/message` から） |
| POST | `getSlotConfig`/`setSlotConfig`/`listPending`/`getQuota`/`adminDecision`/`broadcast*`/`setTempSchedule`/`ownerChannelTest` | bearer `ADMIN_TOKENS` | 管理操作（front `/reserve/admin` から。body に `adminToken`） |
| POST | `deployNotify` | `DEPLOY_NOTIFY_TOKEN` | デプロイ通知（`gas/deploy.sh` / `deploy.yml`） |

> POST は CORS プリフライト回避のため `Content-Type: text/plain` で送る（フロント側で対応）。GET は `availability`/`booking` のみ（状態変更しない読み取り専用）。承認/辞退・顧客メッセージ・管理はすべて POST（front 経由）で、要 Google ログインの GET レンダリングは撤去済み。

## Script Properties（必須キー）

`CALENDAR_ID` / `LEDGER_SHEET_ID` / `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_OWNER_USER_ID` / `ADMIN_TOKENS` / `HMAC_SECRET` / `FRONT_BASE_URL`（任意: `PUBLIC_EXEC_URL` / `LINE_LOGIN_*` / `SLOT_CONFIG` / `ENV_LABEL` / `MAIL_FROM` / `MAIL_REPLY_TO` / `OWNER_DISCORD_WEBHOOK_URL` / `DEPLOY_*`）。

> **`ADMIN_TOKENS`**: 管理画面（front `/reserve/admin`）の bearer 認証トークン（カンマ区切りの強ランダム）。front が POST body の `adminToken` として送り、`requireAdminToken_` が照合する。**実値は Script Properties のみ・リポ/フロント/文書には置かない**。発行・運用は上記「管理トークンの発行・運用」を参照。

> **`MAIL_FROM`（任意）**: お客様メールの差出人アドレス（例: 通知専用 `notify@wwwasyo.com`）。**スクリプト実行アカウントの「名前を指定して送信（Send mail as）」に登録・確認済みのエイリアス**であること（未登録だと送信時に例外→`from` を外して再送するフォールバックあり）。未設定なら実行アカウントの既定アドレスで送信。`MAIL_REPLY_TO` は返信先（未設定時は `MAIL_FROM` と同値）。全メールは公開API①＝オーナー実行で送られる（受付・承認/辞退・顧客メッセージいずれも）。

> **`PUBLIC_EXEC_URL`（任意）**: 公開API（①）の `/exec` URL。承認/辞退・顧客メッセージ・管理はすべて `FRONT_BASE_URL` 経由に移行済みのため、現在は `diag()` のログ表示でのみ参照する（`ScriptApp.getService().getUrl()` が複数デプロイ環境で別デプロイの URL を返す挙動を避けたい場合に①の `/exec` を固定する用途。未設定なら `getUrl()` にフォールバック）。
詳細と取得方法は [`../docs/SETUP.md`](../docs/SETUP.md) F を参照。`SLOT_CONFIG` は管理パネルから保存されるため手動設定は不要。`ENV_LABEL` は LINE Messaging API が dev/prod 共有のため、**dev のみ** `【開発】` を登録して**店へのLINE通知とお客様メール（件名・本文の先頭）**を区別する（**prod はキー自体を登録しない**。GAS は空文字保存不可のため未登録＝ラベルなし）。

## 承認/辞退は front `/reserve/decision` ＋ POST で状態変更（重要）

店への通知（Discord/LINE）に載せる承認/辞退リンクは、**非 Google ドメインの自社サイト `/reserve/decision`**（`FRONT_BASE_URL` 基底）を指す。オーナーが複数 Google アカウントにログイン中に `/exec` が `/u/N/` へ回りエラーになる Google 側の癖を回避するため。front のボタン押下で GAS の `POST decide`（`token`,`sig`,`approve`,`message?`）を叩き、`decideBySig` が `verifySig_`（`decision:` 署名）で検証してから `decide_` を実行する。

> **状態変更は必ず POST**。GET では予約状態を変更しない。理由: メール/LINE/チャットのリンクプレビュー用クローラが通知内URLを先読みし、GET の辞退を誤実行して**仮予約が作成直後に勝手に消える**事故を踏んだため（GET の冪等性）。詳しい調査経緯は [`../docs/DEV_NOTES.md`](../docs/DEV_NOTES.md) を参照。旧 GET 確認ページ（`?action=approve|decline` の HTML レンダリング）は front 化により撤去済み。

## 初回認可（重要・一度だけ）

公開API は「実行ユーザー=自分（オーナー）」なので、**オーナーが事前に各 Google サービスのスコープを認可**しておかないと、匿名アクセスのAPIが `The script does not have permission...` で失敗する。

1. `clasp open-script`（または GAS エディタを開く）。
2. 関数選択で **`authorize`** を選び「実行」。
3. 同意画面で **Calendar / スプレッドシート / メール送信 / 外部通信(LINE)** を許可。
4. 以後、`?action=availability` 等が匿名でも動作する。認可はアカウント×スクリプト単位なので、公開デプロイを作り直しても再認可は不要。

## 店通知をグループに送る場合（任意）

`notifyOwner_` の宛先は `LINE_OWNER_USER_ID`。ここには**ユーザーID(`U`…)だけでなくグループID(`C`…)も指定できる**（push API の `to` は同じ扱い）。ただしグループIDは **Webhook の `source.groupId` からしか取得できない**ため、捕捉用の手順を用意している。

1. **LINE Official Account Manager**（manager.line.biz）→ 設定 → 応答設定 →「**グループ・複数人トークへの参加**」を**許可**。
2. **LINE Developers Console** → Messaging API設定 → **Webhook URL** に公開API `/exec` を設定し「**Webhookの利用**」をON（応答メッセージはOFFでよい）。
3. 対象グループにこの**公式アカウントを招待**。
4. そのグループで誰かが発言 → `handleLineWebhook_` が `source` を捕捉し Script Property `LINE_LAST_SOURCE`（例: `group:Cxxxx`）に保存。
5. `diag()` 実行 → ログの `LINE_LAST_SOURCE` を確認。
6. その `Cxxxx`（グループID）を `LINE_OWNER_USER_ID` に設定。
7. `diag()` 再実行 → `LINE push status: 200`＆グループに「【開発】diag テスト通知」が届けば完了。

> ボットが対象グループに参加していない／グループ参加が未許可だと push は `400 Failed to send messages` になる。

## 動作確認（dev）

1. （上記「初回認可」を済ませてから）front `/reserve/admin`（dev）を開く → `ADMIN_TOKENS` のトークンを入力 → 管理パネル表示（未確定一覧など）。
2. フロント or curl で `?action=availability&menuId=simple-momi-30` → 空き枠 JSON が返る。
3. 仮予約 → dev カレンダーに「【仮】」イベント＋台帳に行、dev LINE へ通知 → 管理パネル（front `/reserve/admin`）で承認 → 「【確定】」化。

詳細な e2e は WBS の Phase 4 を参照。
