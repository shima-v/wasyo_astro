# gas/ — 予約システム バックエンド（Google Apps Script）

サロン和笑〜Violane〜 予約システムのサーバー処理。空き枠計算 / 仮予約 / 承認・辞退 / キャンセル・変更 / 新規・常連判定 / 通知を担う。

- 設計: [`../RESERVATION_PLAN.md`](../RESERVATION_PLAN.md) ／ 進捗: [`../WBS.md`](../WBS.md)
- 外部サービスの初期設定（Google / LINE / Script Properties）: [`../docs/SETUP.md`](../docs/SETUP.md)
- 保存先はサロン所有の Google（予約カレンダー＋顧客台帳シート）と LINE のみ。**独自DBは持たない。**

## ファイル構成

| ファイル | 役割 |
|---------|------|
| `Code.gs` | 本体。`doGet`/`doPost` ルーター、空き枠、予約、承認、通知、台帳、HMAC 等 |
| `admin.html` | 管理パネル（仮予約の承認／空き枠の開閉設定）。`google.script.run` でサーバ関数を呼ぶ |
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

## デプロイは2系統（重要）

実行ユーザー設定が異なるため、**公開API用**と**管理パネル用**で別デプロイにする。

### ① 公開API（お客様・LINE承認リンク）
`appsscript.json` の既定どおり。`clasp deploy` で作る or GAS エディタ「デプロイ」→「ウェブアプリ」:
- 実行ユーザー: **自分**（オーナー権限でカレンダー/LINE/メールを操作するため）
- アクセスできるユーザー: **全員**
- 用途: `?action=availability` / `createBooking` / `cancelBooking` / `changeBooking`（POST）、`?action=approve|decline`（LINE署名リンク）
- 発行 URL（`.../exec`）→ フロントの `PUBLIC_RESERVE_API` と GAS の `FRONT_BASE_URL` に使う

### ② 管理パネル（オーナーのみ）
GAS エディタ「デプロイ」→「新しいデプロイ」→「ウェブアプリ」で**もう1つ**作る:
- 実行ユーザー: **ウェブアプリにアクセスしているユーザー**（＝ログイン中のオーナー本人）
- アクセスできるユーザー: **自分のみ**
- 開く URL: 発行された URL に `?action=admin` を付けてアクセス → `admin.html` が表示される
- なぜ別設定か: 管理操作は `Session.getActiveUser()` でログイン中の管理者を判定（`ADMIN_EMAILS` 照合）するため、実行ユーザーを「アクセスしているユーザー」にする必要がある。公開APIは匿名アクセスをオーナー権限で動かすため「自分」固定で、両立できないので分ける。

> 管理パネルからの呼び出しは末尾アンダースコアを避けた公開ラッパ（`adminApiListPending` / `adminApiDecision` / `adminApiGetConfig` / `adminApiSetConfig`）を経由する。`google.script.run` は末尾 `_` の関数を呼べないため。

## エンドポイント早見

| メソッド | action | 認証 | 用途 |
|---------|--------|------|------|
| GET | `availability` | なし | 空き枠取得（`menuId`,`from?`,`to?`,`isFirstTime?`） |
| GET | `booking` | トークン | 予約内容取得（`token`） |
| GET | `approve` / `decline` | HMAC署名 | LINE通知リンクから承認/辞退（`token`,`sig`） |
| GET | `admin` | Googleログイン | 管理パネル（`admin.html`）表示 |
| POST | `createBooking` | なし | 仮予約作成 |
| POST | `cancelBooking` / `changeBooking` | トークン | キャンセル / 変更 |
| (run) | `adminApi*` | Googleログイン | 管理パネルからの一覧/承認/枠設定 |

> POST は CORS プリフライト回避のため `Content-Type: text/plain` で送る（フロント側で対応）。

## Script Properties（必須キー）

`CALENDAR_ID` / `LEDGER_SHEET_ID` / `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_OWNER_USER_ID` / `ADMIN_EMAILS` / `HMAC_SECRET` / `FRONT_BASE_URL`（任意: `LINE_LOGIN_*` / `SLOT_CONFIG` / `ENV_LABEL`）。
詳細と取得方法は [`../docs/SETUP.md`](../docs/SETUP.md) F を参照。`SLOT_CONFIG` は管理パネルから保存されるため手動設定は不要。`ENV_LABEL` は LINE Messaging API が dev/prod 共有のため、**dev のみ** `【開発】` を登録して**店へのLINE通知とお客様メール（件名・本文の先頭）**を区別する（**prod はキー自体を登録しない**。GAS は空文字保存不可のため未登録＝ラベルなし）。

## 初回認可（重要・一度だけ）

公開API は「実行ユーザー=自分（オーナー）」なので、**オーナーが事前に各 Google サービスのスコープを認可**しておかないと、匿名アクセスのAPIが `The script does not have permission...` で失敗する。

1. `clasp open-script`（または GAS エディタを開く）。
2. 関数選択で **`authorize`** を選び「実行」。
3. 同意画面で **Calendar / スプレッドシート / メール送信 / 外部通信(LINE)** を許可。
4. 以後、`?action=availability` 等が匿名でも動作する。認可はアカウント×スクリプト単位なので、公開デプロイを作り直しても再認可は不要。

## 動作確認（dev）

1. （上記「初回認可」を済ませてから）② の管理デプロイ URL に `?action=admin` を付けて開く → 自分のGoogleアカウントで承認 → 管理パネル表示。
2. フロント or curl で `?action=availability&menuId=simple-momi-30` → 空き枠 JSON が返る。
3. 仮予約 → dev カレンダーに「【仮】」イベント＋台帳に行、dev LINE へ通知 → 管理パネルで承認 → 「【確定】」化。

詳細な e2e は WBS の Phase 4 を参照。
