# gas/ — 予約システム バックエンド（Google Apps Script）

サロン和笑〜Violane〜 予約システムのサーバー処理。空き枠計算 / 仮予約 / 承認・辞退 / キャンセル・変更 / 新規・常連判定 / 通知を担う。

- 設計: [`../docs/RESERVATION_PLAN.md`](../docs/RESERVATION_PLAN.md) ／ 進捗: [`../docs/WBS.md`](../docs/WBS.md)
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

## 管理者ユーザーの登録・管理（重要）

権限は **2段** で守る:
1. **デプロイの「アクセスできるユーザー」** … 管理ページ(`?action=admin`)を開ける人（外側のゲート）。
2. **`ADMIN_EMAILS`（カンマ区切り）** … 実際に管理操作できる人。`requireAdmin_` が `Session.getActiveUser().getEmail()` を照合（内側＝本当のゲート。大小・前後空白は登録時にそろえる）。

**必ず守る前提**:
- 管理デプロイは **必ず「実行ユーザー: ウェブアプリにアクセスしているユーザー」**。`USER_DEPLOYING`（＝オーナー実行）だと、**オーナーと別ドメインの閲覧者（例: gmail.com）では `getActiveUser().getEmail()` が空文字になり必ず弾かれる**（経緯は [`../docs/DEV_NOTES.md`](../docs/DEV_NOTES.md)）。
- アクセスに「**全員（匿名含む）**」は使わない。ログイン必須でないと `getActiveUser` が空になる。「Google アカウントを持つ全員」か「組織内の全員」を使う。
- `ADMIN_EMAILS` は dev / prod それぞれの Script Properties に設定する。

**運用パターン（用途で選ぶ）**:

| 誰が管理するか | デプロイのアクセス設定 | `ADMIN_EMAILS` | 追加で必要なこと | 備考 |
|---|---|---|---|---|
| オーナー1人（wwwasyo.com） | 自分のみ | wwwasyo.com のアドレス | なし（カレンダー/台帳の所有者） | **最も安全・シンプル＝現行構成** |
| 普段の gmail.com で管理 | Google アカウントを持つ全員 | gmail.com を追加 | カレンダー/台帳を gmail.com に編集共有。お客様メールは gmail 発（or `info@` を gmail の send-as に登録） | 手軽だが共有・差出人の手当てが要る |
| 組織内の複数スタッフ（wwwasyo.com） | サロン和笑 内の全員 | 管理させる各 wwwasyo.com アドレス | カレンダー/台帳を各管理者に編集共有。差出人統一は各人に `info@` を send-as 登録 | 同一ドメインなので getActiveUser が確実。**新規ログイン席の追加は有料（¥800〜/人・月・税抜）／エイリアスは無料** |

**管理者を追加・変更する手順**:
1. （別ドメイン/組織内に広げる場合のみ）管理デプロイの「アクセスできるユーザー」を上表に合わせて変更（GASエディタ →「デプロイを管理」→ 編集。**実行ユーザーは「アクセスしているユーザー」のまま**）。
2. Script Property `ADMIN_EMAILS` に対象メールをカンマ区切りで追記（例: `a@wwwasyo.com,b@wwwasyo.com`）。
3. execute-as-accessing-user では **各管理者の操作はその人の権限で実行**されるため、予約カレンダー（`CALENDAR_ID`）と顧客台帳（`LEDGER_SHEET_ID`）を**その管理者に編集権限で共有**する（オーナー本人だけなら不要）。
4. 初回アクセス時にスコープ同意が必要（下記「初回認可」。未確認アプリ警告は自作のため続行可）。

> 実際のガードは `ADMIN_EMAILS` なので、アクセス設定を広めにしても未登録者は操作不可（「管理権限がありません」表示）。とはいえ最小権限の観点で、用途に合わせて絞るのが望ましい。

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

`CALENDAR_ID` / `LEDGER_SHEET_ID` / `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_OWNER_USER_ID` / `ADMIN_EMAILS` / `HMAC_SECRET` / `FRONT_BASE_URL` / `PUBLIC_EXEC_URL`（任意: `LINE_LOGIN_*` / `SLOT_CONFIG` / `ENV_LABEL` / `MAIL_FROM` / `MAIL_REPLY_TO`）。

> **`MAIL_FROM`（任意）**: お客様メールの差出人アドレス（例: 通知専用 `notify@wwwasyo.com`）。**スクリプト実行アカウントの「名前を指定して送信（Send mail as）」に登録・確認済みのエイリアス**であること（未登録だと送信時に例外→`from` を外して再送するフォールバックあり）。未設定なら実行アカウントの既定アドレスで送信。`MAIL_REPLY_TO` は返信先（未設定時は `MAIL_FROM` と同値）。受付メール（公開API＝オーナー実行）・承認/辞退メール（管理画面をオーナーでアクセス）の両方に効く。

> **`PUBLIC_EXEC_URL`**: 公開API（①）の `/exec` URL を登録する。店への LINE 通知に載せる承認/辞退リンクの基底に使う。`ScriptApp.getService().getUrl()` は**複数デプロイ環境で別デプロイ（HEAD等）のURLを返すことがあり不安定**なため固定する。未設定時のみ `getUrl()` にフォールバック。`diag()` のログ「承認リンクbase(実際に使う値)」で確認できる。
詳細と取得方法は [`../docs/SETUP.md`](../docs/SETUP.md) F を参照。`SLOT_CONFIG` は管理パネルから保存されるため手動設定は不要。`ENV_LABEL` は LINE Messaging API が dev/prod 共有のため、**dev のみ** `【開発】` を登録して**店へのLINE通知とお客様メール（件名・本文の先頭）**を区別する（**prod はキー自体を登録しない**。GAS は空文字保存不可のため未登録＝ラベルなし）。

## 承認/辞退リンクは「GETで状態変更しない」設計（重要）

店への LINE 通知に載せる承認(`?action=approve`)/辞退(`?action=decline`)リンクは **GET では予約状態を変更しない**。GET は署名検証のうえ**確認ページ（HTML）を表示するだけ**で、実際の確定/辞退はページ内ボタン押下 → `google.script.run.decideBySig(token, sig, approve)` で行う。

> 理由: メール/LINE/チャットのリンクプレビュー用クローラが通知内URLを先読みし、GET の辞退を誤実行して**仮予約が作成直後に勝手に消える**事故を踏んだため。状態変更は必ず POST 相当（`google.script.run`）に分離する。詳しい調査経緯と一般教訓（GET の冪等性）は [`../docs/DEV_NOTES.md`](../docs/DEV_NOTES.md) を参照。

- 通知は confirm テンプレート（✅承認する / ❌辞退する のボタン）で送る。長いURLを直接見せない。
- `decideBySig` は `verifySig_` で HMAC を検証してから `decide_` を呼ぶ（公開関数だが署名必須）。

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

1. （上記「初回認可」を済ませてから）② の管理デプロイ URL に `?action=admin` を付けて開く → 自分のGoogleアカウントで承認 → 管理パネル表示。
2. フロント or curl で `?action=availability&menuId=simple-momi-30` → 空き枠 JSON が返る。
3. 仮予約 → dev カレンダーに「【仮】」イベント＋台帳に行、dev LINE へ通知 → 管理パネルで承認 → 「【確定】」化。

詳細な e2e は WBS の Phase 4 を参照。
