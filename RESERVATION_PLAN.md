# 予約機能の追加プラン（サロン和笑〜Violane〜）

> 進捗管理は [`WBS.md`](./WBS.md) を参照。

## Context（なぜ作るか）

現在のサイト（`src/pages/index.astro` 単一ファイル / Astro 静的サイト / GitHub Pages → `wwwasyo.com`）の予約は、外部サービス **RESERVA**（`https://reserva.be/wasyou258`）への外部リンクで完結している。今回、**サイト内に独自の本格予約システム**を追加する。あわせて **本番/開発の環境分離** を整備する。

ヒアリングで固まった要件:

| 項目 | 決定 |
|------|------|
| 方向性 | リアルタイム空き枠表示＋仮予約→承認の本格予約 |
| 構成 | **静的サイト維持＋Google Apps Script(GAS)バックエンド** |
| 空き枠管理 | オーナーが**専用管理画面**で空き枠を設定 |
| 確定フロー | 全員「**仮予約**」→ 店が**承認**して確定 |
| サロンへの通知 | **LINE Messaging API** |
| 男性紹介制 | **フォームで制御**（性別／男性は紹介者必須＋承認制） |
| お客様への通知 | **LINE自動通知**＋ LINE非ユーザー向けに**メール枠**も用意 |
| キャンセル・変更 | **オンラインで可能**に |
| 予約枠 | **メニュー連動＋30分刻み開始**、施術者1名（重複不可） |
| 受付期間 | **当日は電話のまま**・オンラインは**翌日以降** |
| RESERVA | **当面は併存**（移行期間） |
| 個人情報 | **開発者管理の独自DBは作らない**。保存先は**サロン所有の Google（カレンダー＋顧客台帳シート）と LINE のみ** |
| 新規/常連判定 | **顧客台帳で判定し、メニューの「初回40分/初回60分」料金を自動適用** |
| 管理・承認 | **Googleアカウントログイン**＋ LINE通知のボタンからも承認 |
| 予約ルール | 推奨デフォルト：2ヶ月先まで・前日まで受付・前日までキャンセル可 |
| 環境管理 | **本番/開発を分離**（ブランチ・デプロイ先・GAS・カレンダー・LINE Login・台帳は別）。ただし **LINE Messaging API は「1公式アカウント＝1チャネル」制約のため dev/prod 共有** |

**重要な前提**: 「リアルタイム空き枠＋承認＋通知＋オンライン変更」は静的サイト単体では不可能。サーバー処理（GAS）と保存先（サロンの Google）が必須。

### 個人情報（PII）の正確な扱い
- GAS は**フォーム送信のPIIをコードとして受け取り処理する**（＝GASを通る）。隠さず明記する。
- **永続保存先はサロン所有の Google（カレンダーのイベント＋顧客台帳シート）と LINE のみ**。開発者/第三者が管理する独立DBや解析基盤は作らない。
- フロント（Astro静的）・GitHub・Cloudflare には PII を保存しない（通信の中継のみ）。
- **LINE userId** はお客様通知と新規/常連判定のため**顧客台帳（サロンGoogle内）に保持**する。
- 取得時はフォームに**取扱い注意書き＋同意チェック必須**。保存先・利用目的（予約管理・連絡・初回判定）を明記。

---

## 推奨アーキテクチャ

```
[お客様ブラウザ]                         [オーナー]
  Astro静的サイト                         Googleアカウントでログイン
  /reserve（予約UI）  ──fetch──┐         ＋ LINE通知の承認ボタン
  /reserve/manage（変更/取消）  │              │
                                ▼              ▼
                       ┌──────────────────────────────┐
                       │  Google Apps Script Web App   │  ← バックエンド（無料・サロンのGoogle配下）
                       │  空き枠計算/仮予約/承認/取消   │
                       │  /変更/通知/新規判定/管理画面  │
                       └───┬──────────┬──────────┬────┘
                  予約=ｲﾍﾞﾝﾄ │   顧客台帳 │   通知   │
                            ▼          ▼          ▼
                   Googleカレンダー  顧客台帳ｼｰﾄ   LINE Messaging API
                  （サロン所有＝保存先）（新規/常連） （店へpush・承認ボタン）
                                                   ＋ メール / LINE（客へ）
```

- **フロント**: 現状の Astro 静的サイトのまま。新ページが GAS エンドポイントを `fetch` で呼ぶ。
- **バックエンド**: GAS Web App（`doGet`/`doPost` のアクション分岐）。サロンの Google アカウント配下にデプロイ。
- **保存先**: サロンの **Google カレンダー**（仮予約/確定イベント。PIIは説明欄・非公開 extendedProperties）＋ **顧客台帳シート**（新規/常連判定用）。
- **匿名トークン**: オンライン変更/取消・通知用の乱数トークンをイベントに保存。トークン→イベントはカレンダー検索で解決。

### なぜ GAS か
無料・常時稼働・オーナーの Google で認証/カレンダー/メールが完結。「Googleログイン」「データはサロン所有」「独自DB無し」を自然に満たす。LINE 通知内の HMAC 署名付きリンクでログイン無し承認も可能。
> 将来 CORS/機能が窮屈になれば **Cloudflare Workers + KV** に退避可能（本プランでは採用せず記載のみ）。

---

## データモデル（独自DBなし・サロンGoogle内）

- **空き枠設定**（PIIなし / Script Properties or 設定シート）
  - 営業時間ルール: 月〜金 10:00–20:00、土は第2・第4のみ 10:00–20:00、日祝・第1/3/5土は休（現サイト記載に準拠）。
  - 例外開閉: 特定日時の手動オープン/クローズ（管理画面で設定）。
- **予約**（Google カレンダーのイベント＝サロン所有）
  - タイトル: `【仮】メニュー / お名前` → 承認で `【確定】…`。
  - 時間: 開始（30分刻み）〜 開始＋メニュー所要時間（＋前後バッファ任意）。施術者1名→**同時間帯の重複不可**（`LockService`＋作成直前再検証）。
  - 非公開プロパティ/説明: 氏名・電話・メール・性別・紹介者・LINE userId・メニュー・初回フラグ・トークン・ステータス。
- **顧客台帳シート**（サロン所有 / 新規/常連判定）
  - 列: キー（LINE userId／電話／メール）・初回日・来店回数・最終来店・表示名。
  - createBooking 時にキー照合 → 既存なし＝**新規**。確定時に来店回数を更新。

---

## 新規/常連判定と初回料金（自動適用）

- キー: **LINE userId**（LINE連携時）。非LINEは**電話/メール**で照合。
- `src/data/menu.js` に各メニューの **通常＋初回** を定義（例: 全身もみほぐし 通常30分¥3,300 → 初回40分¥3,300 / 通常50分¥4,000 → 初回60分¥4,000）。
- フロント: 判定結果（新規）なら初回料金・初回時間を表示。**GAS 側でも再判定**して確定（フロント値は信用しない）。
- 限界: 別端末/別連絡先は新規扱いになり得る → 店が承認時に補正可能（運用で許容）。

---

## 環境管理（本番/開発を分離）

### ブランチ戦略
- `main` → **本番(production)**。既存 GitHub Actions → GitHub Pages → `wwwasyo.com`。
- `develop` → **開発(development)**。Cloudflare Workers(Builds) が自動ビルド/デプロイ（`wasyo-dev.<account>.workers.dev`）。
- 作業は feature ブランチ → `develop` に PR → 検証後 `main` へ。

### デプロイ先
| 資源 | dev | prod |
|------|-----|------|
| フロント | **Cloudflare Workers**(Builds・`develop`) → `wasyo-dev.<account>.workers.dev` | GitHub Pages → `wwwasyo.com`（`main`） |
| GASプロジェクト | `wasyo-reserve-dev` | `wasyo-reserve-prod` |
| Web App URL | dev exec URL | prod exec URL |
| Googleカレンダー | 予約-dev | 予約-prod |
| **LINE Messaging API** | **dev/prod 共有**（同一チャネル・同一トークン） | **← 同左**（1公式アカウント=1チャネル制約） |
| LINE Login | devチャネル | prodチャネル |
| 顧客台帳シート | dev sheet | prod sheet |
| 設定の持ち場 | `.env.development` / Cloudflare 環境変数 | GitHub Actions env / repo secret |

> **LINE Messaging API が dev/prod 共有である影響と対策**
> LINE の仕様上、1つの公式アカウントに紐づく Messaging API チャネルは1つだけ。本サロンは公式アカウントが1つ（`lin.ee/7ZvbqEb`）のため、**dev と prod のオーナー通知は同じチャネル・同じトークンで同じ LINE 宛に届く**。
> - 影響: 開発テストの通知と本番の通知が同じ LINE に混在する。
> - 対策: GAS の Script Property `ENV_LABEL`（dev のみ `【開発】` 等）を**店向け通知の先頭に付与**して区別する（**prod はキーを登録しない**＝GAS は空文字保存不可のため未登録でラベルなし）。承認/辞退リンクは各環境の GAS URL を指すため、誤承認は起きない（dev リンク→dev GAS、prod リンク→prod GAS）。
> - 注意: dev で実際に LINE push すると本番と同じ友だち（オーナー）に届くため、テストは通知本文の `【開発】` 表示で識別する。お客様への LINE 通知も同一チャネル経由（MVP はメール既定のため影響小）。

### 設定の切り替え
- フロント: GAS URL・LINE Login channel 等を `import.meta.env.PUBLIC_*` で注入。`src/data/config.js` が読む。
  - ローカル/dev: `.env.development`（dev値）。Cloudflare Workers はプロジェクト環境変数（dev値）。
  - 本番: GitHub Actions の env（repo secret の prod値）。
- `astro.config.mjs`: `site` を環境で切替（本番=`wwwasyo.com`、dev=Cloudflare の `*.workers.dev`）。`base` は `'/'` 維持。
- GAS: 各プロジェクトの **Script Properties** に LINE トークン・カレンダーID・管理者メール許可リスト・HMAC secret を環境別に格納。
- `gas/` をリポジトリで版管理。**clasp** のターゲット切替（`.clasp.dev.json` / `.clasp.prod.json`）で dev/prod に push/deploy。

### Cloudflare Workers（dev フロント）の実構成
Cloudflare の **Workers Builds**（Git 連携でリポジトリのプッシュをビルド）を使用。
- ビルドコマンド: `pnpm build`（出力 `dist/`）／パス（ルート）: `/`
- デプロイコマンド: `npx wrangler deploy`（`wrangler.toml` を読む）／非本番ブランチ: `npx wrangler versions upload`
- `wrangler.toml`: `name = "wasyo-dev"`（ダッシュボードの Worker 名と一致）、`[assets] directory = "./dist"` で静的配信、`workers_dev = true` / `preview_urls = true`。
- `.nvmrc`（`22`）で Node を固定（Astro6/pnpm は Node ≥22.12 必須）。
- `pnpm-workspace.yaml` の `allowBuilds`（esbuild/sharp: true）で「Ignored build scripts」警告を解消。
- 環境変数（dev値）: `PUBLIC_RESERVE_API` ほか `PUBLIC_*` を Cloudflare プロジェクトに設定。
- 手順の詳細は [`docs/SETUP.md`](./docs/SETUP.md) I を参照。

---

## 作るもの（概要）

1. **GAS バックエンド**（`gas/`）: `getAvailability` / `createBooking` / `approveBooking` / `declineBooking` / `cancelBooking` / `changeBooking` / `getSlotConfig` / `setSlotConfig`、HMAC 署名、HTML 管理画面。
2. **フロント**（Astro 静的）: `src/pages/reserve/index.astro`、`src/pages/reserve/manage.astro`、`src/data/menu.js`、`src/data/config.js`。
3. **管理画面**（GAS HTML Service）: 空き枠開閉＋承認/辞退、Google ログイン。
4. **既存サイト統合**: CTA を `/reserve` へ、RESERVA フォールバック。
5. **外部セットアップ**（手順案内・手動）: LINE Messaging API×**1（dev/prod 共有）**＋ LINE Login×2（dev/prod）、Google カレンダー/台帳×dev/prod、GAS×2、Cloudflare Workers。

詳細タスクは [`WBS.md`](./WBS.md) を参照。

---

## LIFF構成（LINEアプリ内予約）※2026-06-20 追加

既存の Web 予約（外部ブラウザ＝LINE未使用客）は**併存維持**しつつ、LINE公式アカウントの
**リッチメニュー/トーク/プロフィール**から **LINEアプリ内で予約を完結**できるようにする。

- **起動経路**: リッチメニュー・トーク内カード・プロフィールのアクションに LIFF URL（`https://liff.line.me/{LIFF_ID}`）を設定。エンドポイントは各環境の `/reserve/`。
- **認証**: LINEアプリ内では `liff.init`→`isInClient` 判定→`liff.getIDToken()` の id_token を GAS（`liffVerify_`）でサーバ検証して **userId を確定**（クライアントの `getProfile()` は詐称可能なため信用しない）。verify 処理は LINE Login と共通（`verifyLineIdToken_`）。**外部ブラウザは従来の OAuth/手入力にフォールバック**（`/reserve/` 1ページで内外両対応）。
- **自動入力**: 氏名（表示名）・メール（email スコープ許可時）を自動補完。電話・性別は手入力のまま。
- **完了時アクション**（`liffAfterBooking`、各 `isApiAvailable` ガード）: `sendMessages`（本人トークへ控え）/ `getFriendship`（未追加なら友だち追加案内＝push通知の前提作り）/ `shareTargetPicker`（友だちにサロン紹介）。
- **通知（Messaging API push）**: 申込・確定（既存）＋ **前日リマインド**（`sendReminders`）＋ **来店後フォロー**（`sendFollowUps`）。いずれも日次トリガー・`reminded`/`followedUp` タグで多重送信防止・`status===confirmed` のみ対象。
- **無料枠監視**（月200通）: 管理画面に当月送信数表示（`adminGetQuota_`）／80%超でオーナー警告（`checkQuota`）／送信ログ記録（`logPush_`・宛先はマスク）。上限は `MONTHLY_FREE_QUOTA`（固定）、消費は `/message/quota/consumption`。
- **環境分離**: LIFF アプリは dev/prod の **LINE Login チャネル配下に別々に作成**（`LIFF_ID` を環境別に発行＝`PUBLIC_LIFF_ID`）。LINE Login チャネルに公式アカウントを連携して `getFriendship`/友だち追加を機能させる。
- **設定の正確な扱い**: LIFF で扱う userId・表示名・メールも、上記「個人情報（PII）の正確な扱い」の方針どおり、サロン Google（カレンダー/台帳）と LINE 内のみで管理し、独自DBには貯めない。

---

## 既知のリスクと対策
1. **GAS の CORS**: POST は `Content-Type: text/plain`、GET は単純リクエストでプリフライト回避。問題化したら Cloudflare Workers プロキシへ退避。
2. **LINE Login セットアップ負荷**: MVP は「メール既定・LINE連携は任意」で段階導入可。
3. **同時予約競合**: 施術者1名・低トラフィック → `LockService`＋直前再検証で十分。
4. **新規/常連判定の取りこぼし**: 別連絡先は新規扱い → 承認時に店が補正。
5. **LINE Messaging API の dev/prod 共有**: 1公式アカウント=1チャネル制約により同一チャネルを共有。dev テスト通知が本番と同じ LINE に届くため、`ENV_LABEL`（dev=`【開発】`）を店通知の先頭に付けて区別する。

---

## 検証（エンドツーエンド・dev 環境）
1. `pnpm dev` で `/reserve`：メニュー→日付→空き枠（dev GAS 接続）表示を確認。
2. 仮予約送信 → **dev カレンダーに「【仮】」イベント**＋顧客台帳に行追加を確認。
3. **新規/常連判定**：初回は初回料金、2回目以降は通常料金になることを確認。
4. **店の dev LINE に通知**＋承認/辞退ボタンで「【確定】」化/削除を確認。
5. 客への通知（LINE userId 有→LINE、無→メール）受信確認。
6. 管理URL（トークン）から**キャンセル・変更**がカレンダー/空き枠に反映されることを確認。
7. 男性時の**紹介者必須**、当日枠が出ない（翌日以降）、2ヶ月超が出ない、重複枠が塞がることを確認。
8. `pnpm build` 成功＋Cloudflare Workers(dev) で実URL動作確認 → `main` 反映後 prod 動作確認。
