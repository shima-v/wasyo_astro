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
| フロント | Cloudflare Pages（`develop`） | GitHub Pages → wwwasyo.com（`main`） |
| GAS プロジェクト | `wasyo-reserve-dev` | `wasyo-reserve-prod` |
| Web App URL | dev `/exec` | prod `/exec` |
| Google カレンダー | 予約-dev | 予約-prod |
| 顧客台帳シート | 台帳-dev | 台帳-prod |
| LINE Messaging API | dev チャネル | prod チャネル |
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

## D. LINE Messaging API チャネル（dev / prod 各1）— 店への通知用

1. [LINE Developers](https://developers.line.biz/) にログイン → プロバイダー作成（無ければ）。
2. 新規チャネル →「Messaging API」を作成（dev / prod で別チャネル）。
3. 「Messaging API設定」→ **チャネルアクセストークン（長期）** を発行してコピー → **LINE_CHANNEL_ACCESS_TOKEN**(dev/prod)。
4. 通知先（店オーナー）の **userId** を取得:
   - 作成したチャネルの公式アカウントを、オーナーのLINEで友だち追加。
   - 一時的に Webhook で取得するか、応答メッセージ等で `userId` を確認 → **LINE_OWNER_USER_ID**(dev/prod)。
   - （グループ通知にする場合はグループの `groupId` でも可）
5. 既存の公式アカウント（`lin.ee/7ZvbqEb`）を prod に使う場合は、その公式アカウントに紐づくチャネルのトークンを利用。dev は必ず別チャネルにする。

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
| `HMAC_SECRET` | 署名用のランダム長文字列（dev/prod で別の値） |
| `FRONT_BASE_URL` | フロントのベースURL（通知/管理リンク生成用）。dev=pages.dev、prod=`https://wwwasyo.com` |

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

### dev（Cloudflare Pages）
I のプロジェクト環境変数に上記 `PUBLIC_*`（redirect は pages.dev のURL）を設定。

### prod（GitHub Actions）
J のリポジトリ Secrets に prod 値を登録。

## I. Cloudflare Pages（dev フロント / `develop`）

1. Cloudflare → Workers & Pages → 「Pages」→ Git 連携で本リポジトリを接続。
2. プロダクションブランチに **`develop`** を指定（本番 `main` は GitHub Pages 側なので Cloudflare では使わない）。
3. ビルド設定: フレームワーク `Astro` / ビルドコマンド `pnpm build` / 出力ディレクトリ `dist`。
4. 環境変数に H（dev）の `PUBLIC_*` を設定。
5. デプロイ後の `*.pages.dev` URL を、LINE Login のコールバック（E）と `FRONT_BASE_URL`（F dev）に反映。

## J. GitHub Actions（prod フロント / `main`）

1. リポジトリ → Settings → Secrets and variables → Actions → 「New repository secret」で prod 値を登録:
   - `PUBLIC_RESERVE_API`（prod `/exec`）
   - `PUBLIC_LINE_LOGIN_CHANNEL_ID` / `PUBLIC_LINE_LOGIN_REDIRECT`
2. `deploy.yml` のビルドステップでこれらを env として渡す（Phase 3 で対応）。

---

## 値の控え一覧（チェックリスト）

dev / prod それぞれ:
- [×] `CALENDAR_ID`
- [×] `LEDGER_SHEET_ID`
- [×] GAS `scriptId`
- [×] `PUBLIC_RESERVE_API`（Web App `/exec`）
- [×] `LINE_CHANNEL_ACCESS_TOKEN`（実値は GAS の Script Properties のみに保存。**この文書には貼らない**）
- [×] `LINE_OWNER_USER_ID`
- [×] `LINE_LOGIN_CHANNEL_ID` / `LINE_LOGIN_CHANNEL_SECRET`（任意）
- [×] `ADMIN_EMAILS`
- [ ] `HMAC_SECRET`
- [ ] `FRONT_BASE_URL`

## 動作確認（最小）

1. `.env.development` を設定し `pnpm dev` → `/reserve` を開く。
2. 空き枠が dev カレンダーの状態を反映して表示される。
3. 仮予約送信 → dev カレンダーに「【仮】」イベント＋台帳に行が追加され、dev LINE に通知が届く。
4. 通知の承認ボタン → 「【確定】」化、お客様へ確定通知。
5. 管理URLからキャンセル/変更 → カレンダー・空き枠に反映。

> 詳細な検証項目は WBS の Phase 4 を参照。
