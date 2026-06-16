# 予約システム 外部セットアップ手順（dev / prod 完全分離）

予約機能で使う外部サービス（Google / LINE / GAS / Cloudflare / GitHub）の設定手順。
**開発(dev)** と **本番(prod)** で資源をすべて分けます。設計は [`../RESERVATION_PLAN.md`](../RESERVATION_PLAN.md)、進捗は [`../WBS.md`](../WBS.md)。

> このドキュメントの作業は基本「👤 ユーザーが手動」で行います。各ステップで取得した ID/トークンは末尾の[チェックリスト](#値の控え一覧チェックリスト)に控えてください。

## 前提

- Google アカウント（サロン運用用）/ LINE アカウント / Cloudflare アカウント / GitHub（本リポジトリ）へのアクセス
- ローカルに Node.js 22+ と pnpm、`clasp`（`npm i -g @google/clasp`）

## dev / prod 資源対応表

| 資源 | dev | prod |
|------|-----|------|
| フロント | **Cloudflare Workers**(Builds・`develop`) → `wasyo-dev.<account>.workers.dev` | GitHub Pages → wwwasyo.com（`main`） |
| GAS プロジェクト | `wasyo-reserve-dev` | `wasyo-reserve-prod` |
| Web App URL | dev `/exec` | prod `/exec` |
| Google カレンダー | 予約-dev | 予約-prod |
| 顧客台帳シート | 台帳-dev | 台帳-prod |
| **LINE Messaging API** | **dev/prod 共有（同一チャネル・同一トークン）** | ← 同左（1公式アカウント=1チャネル制約） |
| LINE Login | dev チャネル | prod チャネル |

---

## A. Google カレンダー（dev / prod 各1）

1. [Google カレンダー](https://calendar.google.com/) → 左「他のカレンダー」＋ →「新しいカレンダーを作成」。
2. 名前: `予約-dev`（本番用は `予約-prod`）を作成。
3. 作成後、そのカレンダーの「設定と共有」→「カレンダーの統合」→ **カレンダー ID** をコピー（`xxxxx@group.calendar.google.com`）。
4. dev・prod の2つ分繰り返す。 → **CALENDAR_ID**(dev/prod) を控える。

## B. 顧客台帳スプレッドシート（dev / prod 各1）

1. [Google スプレッドシート](https://sheets.google.com/)で新規作成。名前 `台帳-dev` / `台帳-prod`。
2. 1行目にヘッダを作成（列）:
   `key | type | displayName | firstVisit | visitCount | lastVisit | note`
   - `key`: LINE userId / 電話 / メール のいずれか（判定キー）
   - `type`: `line` | `phone` | `email`
3. URL の `/d/` と `/edit` の間が **スプレッドシート ID**。 → **LEDGER_SHEET_ID**(dev/prod) を控える。

## C. GAS プロジェクト（dev / prod 各1・clasp）

> コードは本リポジトリの `gas/` で管理し、clasp で各プロジェクトへ push します（`gas/` は Phase 1 で実装）。

1. `clasp login`（ブラウザ認証）。※このセッションで実行する場合は `! clasp login`。
2. dev 用に作成: `clasp create --type standalone --title "wasyo-reserve-dev"` → 生成された **scriptId** を控える。
3. 同様に prod 用 `wasyo-reserve-prod` を作成 → scriptId を控える。
4. それぞれの scriptId を `gas/.clasp.dev.json` / `gas/.clasp.prod.json` に設定（Phase 1 でテンプレ用意）。
5. タイムゾーンは `appsscript.json` で `Asia/Tokyo`。

## D. LINE Messaging API チャネル（**dev / prod 共有・1つ**）— 店への通知用

> ⚠️ **LINE の仕様で「1公式アカウント＝Messaging API チャネル1つ」**。本サロンは公式アカウントが1つ（`lin.ee/7ZvbqEb`）のため、**dev/prod で別チャネルは作れず1つを共有**する。dev/prod の GAS は同じ `LINE_CHANNEL_ACCESS_TOKEN`・同じ `LINE_OWNER_USER_ID` を使い、**同じ LINE にオーナー通知が届く**。

1. [LINE Developers](https://developers.line.biz/) にログイン → 該当プロバイダー。
2. 既存の公式アカウント（`lin.ee/7ZvbqEb`）に紐づく「Messaging API」チャネルを使用。
3. 「Messaging API設定」→ **チャネルアクセストークン（長期）** を発行してコピー → **LINE_CHANNEL_ACCESS_TOKEN**（dev/prod 共通で同じ値を両 GAS に設定）。
4. 通知先（店オーナー）の **userId** を取得:
   - 公式アカウントを、オーナーのLINEで友だち追加。
   - 一時的に Webhook で取得するか、応答メッセージ等で `userId` を確認 → **LINE_OWNER_USER_ID**（dev/prod 共通）。
   - （グループ通知にする場合はグループの `groupId` でも可）
5. **dev/prod の区別**: 同じ LINE に届くため、dev の GAS には Script Property `ENV_LABEL` に `【開発】` を登録し、店向け通知の先頭に付けて見分ける。**prod は `ENV_LABEL` キーを登録しない**（GAS は空文字を保存できず、未登録なら自動でラベルなしになる）。承認/辞退リンクは各 GAS の URL を指すので、dev リンクは dev、prod リンクは prod に作用し誤承認はしない。

## E. LINE Login チャネル（dev / prod 各1）— お客様の userId 取得用（任意）

> MVP では「メール既定・LINE連携は任意」。LINE 通知をお客様にも自動送信したい場合に設定。

1. LINE Developers → 同プロバイダーに「LINEログイン」チャネルを作成（dev / prod 別）。
2. **チャネルID / チャネルシークレット** を控える → **LINE_LOGIN_CHANNEL_ID / LINE_LOGIN_CHANNEL_SECRET**(dev/prod)。
3. 「LINEログイン設定」→ コールバックURLに予約ページURLを登録:
   - dev: `https://<dev>.pages.dev/reserve/`（ローカル確認用に `http://localhost:4321/reserve/` も）
   - prod: `https://wwwasyo.com/reserve/`

## F. GAS Script Properties（dev / prod それぞれに設定）

GAS エディタ →「プロジェクトの設定」→「スクリプト プロパティ」に以下を登録（dev プロジェクトには dev 値、prod には prod 値）:

| キー | 内容 |
|------|------|
| `CALENDAR_ID` | A で取得した予約カレンダーID |
| `LEDGER_SHEET_ID` | B で取得した顧客台帳シートID |
| `LINE_CHANNEL_ACCESS_TOKEN` | D の Messaging API トークン |
| `LINE_OWNER_USER_ID` | D の通知先 userId（or groupId） |
| `LINE_LOGIN_CHANNEL_ID` | E のチャネルID（任意） |
| `LINE_LOGIN_CHANNEL_SECRET` | E のチャネルシークレット（任意） |
| `ADMIN_EMAILS` | 管理画面を使える Google アカウントのメール（カンマ区切り） |
| `HMAC_SECRET` | 署名用のランダム長文字列（**dev/prod で別の値**。発番方法は下記） |
| `FRONT_BASE_URL` | フロントのベースURL（通知/管理リンク生成用）。dev=`https://wasyo-dev.<account>.workers.dev`、prod=`https://wwwasyo.com` |
| `ENV_LABEL` | 店向け LINE 通知の先頭ラベル。**dev のみ** `【開発】` を登録。**prod はこのキー自体を登録しない**（GAS は空文字を保存できないため、未登録＝ラベルなしで運用）。LINE Messaging API が dev/prod 共有のため通知を区別する |

### HMAC_SECRET の発番方法

予約管理リンクの改ざん防止に使う署名鍵。**推測困難な十分長いランダム文字列**を生成し、dev/prod で**別々の値**を設定する（漏洩時の影響範囲を分けるため）。以下のいずれかで生成:

```bash
# macOS / Linux（openssl）
openssl rand -base64 48

# Node.js（base64url）
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

生成した文字列をそのまま各 GAS の Script Property `HMAC_SECRET` に貼り付ける（**リポジトリやこの文書には保存しない**）。一度設定したら変更しない（変更すると発行済みの承認/管理リンクが無効化される）。

## G. GAS デプロイ（dev / prod）

1. `clasp push`（対象プロジェクトに応じて `.clasp.json` を切替。Phase 1 の `gas/README.md` にコマンド整備）。
2. GAS エディタ →「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」:
   - 実行ユーザー: **自分**
   - アクセスできるユーザー: **全員**
3. 発行された **ウェブアプリ URL（`.../exec`）** を控える → **PUBLIC_RESERVE_API**(dev/prod)。
4. 管理画面用に別途デプロイする場合はアクセス「自分のみ」に設定（Phase 1 で整理）。

## H. フロント環境変数

### dev（ローカル）
`.env.development.example` を `.env.development` にコピーして実値を設定:
```
PUBLIC_RESERVE_API="<dev /exec URL>"
PUBLIC_LINE_LOGIN_CHANNEL_ID="<dev login channel id 任意>"
PUBLIC_LINE_LOGIN_REDIRECT="http://localhost:4321/reserve/"
```

### dev（Cloudflare Workers）
I のプロジェクト環境変数に上記 `PUBLIC_*`（redirect は `*.workers.dev` のURL）を設定。

### prod（GitHub Actions）
J のリポジトリ Secrets に prod 値を登録。

## I. Cloudflare Workers（dev フロント / `develop`）

> dev フロントは **Cloudflare Workers（Builds）** で配信する（Pages ではない）。Astro は `output: "static"` なので、ビルド成果物 `dist/` を **Workers の静的アセット**として配信する。本番(prod)は GitHub Pages 側なので Cloudflare は dev 専用。

### リポジトリ側（コミット済み・🤖）
- `wrangler.toml` … `name = "wasyo-dev"`（ダッシュボードの Worker 名と一致必須）、`[assets] directory = "./dist"`、`workers_dev = true` / `preview_urls = true`、`compatibility_date`。
- `.nvmrc` … `22`（Astro6/pnpm は Node ≥22.12 必須。Cloudflare/ローカル共通で固定）。
- `pnpm-workspace.yaml` … `allowBuilds`(esbuild/sharp: true)。pnpm の「Ignored build scripts」警告とローカル `pnpm build` 失敗を解消。

### ダッシュボード側（👤）
1. Cloudflare → Workers & Pages → **「Workers」** で Git 連携（本リポジトリを接続）。Worker 名は **`wasyo-dev`**（`wrangler.toml` の `name` と一致させる）。
2. 連携ブランチ（プロダクション）を **`develop`** に設定（本番 `main` は GitHub Pages 側なので Cloudflare では使わない）。
3. **ビルド構成**:
   - ビルドコマンド: `pnpm build`
   - デプロイコマンド: `npx wrangler deploy`（`wrangler.toml` を読み `dist/` を配信）
   - 非本番ブランチのデプロイコマンド: `npx wrangler versions upload`（プレビュー版）
   - パス（ルートディレクトリ）: `/`
4. 環境変数に H（dev）の `PUBLIC_*` を設定（`PUBLIC_LINE_LOGIN_REDIRECT` は `*.workers.dev` の `/reserve/`）。
5. デプロイ後の **`https://wasyo-dev.<account>.workers.dev`** を、LINE Login のコールバック（E）と `FRONT_BASE_URL`（F dev）に反映。
6. Node バージョンは `.nvmrc`(22) を自動参照（環境変数 `NODE_VERSION` の設定は不要）。

> 補足: この画面に「出力ディレクトリ」欄は無い。`wrangler deploy` は **`wrangler.toml` の `[assets] directory`** で配信元を決めるため、出力先の指定は `wrangler.toml` 側で行う。

## J. GitHub Actions（prod フロント / `main`）

1. リポジトリ → Settings → Secrets and variables → Actions → 「New repository secret」で prod 値を登録:
   - **`PROD_RESERVE_API`**（prod GAS の `/exec` URL）← **必須**。`deploy.yml` が env `PUBLIC_RESERVE_API` に注入する。
   - （任意・LINE Login 導入時のみ）`PROD_LINE_LOGIN_CHANNEL_ID` / `PROD_LINE_LOGIN_REDIRECT`。導入時に `deploy.yml` の Build env に追記する。
2. `deploy.yml` の Build ステップで env 注入済み🤖：`PUBLIC_RESERVE_API: ${{ secrets.PROD_RESERVE_API }}` と `PUBLIC_SITE_URL: https://www.wwwasyo.com`（prod ドメインは secret ではなく直書き）。

> secret 未登録でも `PUBLIC_RESERVE_API` は空文字になりビルドは通る（予約API未接続の状態でデプロイされるだけ）。prod 公開前に必ず登録する。

---

## 値の控え一覧（チェックリスト）

dev / prod それぞれ:
- [×] `CALENDAR_ID`
- [×] `LEDGER_SHEET_ID`
- [×] GAS `scriptId`
- [×] `PUBLIC_RESERVE_API`（Web App `/exec`）
- [×] `LINE_CHANNEL_ACCESS_TOKEN`（**dev/prod 共有**・実値は GAS の Script Properties のみに保存。**この文書には貼らない**）
- [×] `LINE_OWNER_USER_ID`（dev/prod 共有）
- [×] `LINE_LOGIN_CHANNEL_ID` / `LINE_LOGIN_CHANNEL_SECRET`（任意・dev/prod 別）
- [×] `ADMIN_EMAILS`
- [x] `HMAC_SECRET`（dev/prod で別の値。発番方法は F 参照）
- [×] `FRONT_BASE_URL`
- [x] `ENV_LABEL`（**dev のみ** `【開発】` を登録／**prod は登録しない**。LINE 共有チャネルの通知区別用）

## 動作確認（最小）

1. `.env.development` を設定し `pnpm dev` → `/reserve` を開く。
2. 空き枠が dev カレンダーの状態を反映して表示される。
3. 仮予約送信 → dev カレンダーに「【仮】」イベント＋台帳に行が追加され、オーナー LINE に通知が届く（共有チャネルのため `ENV_LABEL`=`【開発】` 表示で dev と判別）。
4. 通知の承認ボタン → 「【確定】」化、お客様へ確定通知。
5. 管理URLからキャンセル/変更 → カレンダー・空き枠に反映。

> 詳細な検証項目は WBS の Phase 4 を参照。
