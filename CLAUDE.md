# CLAUDE.md

このファイルは、リポジトリ内のコードを扱う Claude Code (claude.ai/code) 向けのガイダンスを提供します。

## 設計・進捗ドキュメント

- 予約機能の設計プラン: ./docs/RESERVATION_PLAN.md
- 予約機能の WBS（進捗管理）: ./docs/WBS.md
- 外部サービスの初期設定手順: ./docs/SETUP.md
- 開発メモ・既知のハマりどころ（備忘録）: ./docs/DEV_NOTES.md
- GAS バックエンド（予約システム）: ./gas/README.md

## コマンド

```bash
pnpm dev        # ローカル開発サーバー起動 (http://localhost:4321/)
pnpm build      # 本番ビルド → dist/ に出力
pnpm preview    # 本番ビルドをローカルでプレビュー
```

パッケージマネージャーは **pnpm**（`packageManager: pnpm@11.7.0`）。テストランナーは未設定。

## デプロイ（本番 / 開発で分離）

- **本番(prod)**: `main` ブランチへのプッシュで GitHub Actions（`.github/workflows/deploy.yml`）が起動し、GitHub Pages → カスタムドメイン `https://wwwasyo.com/` へ自動デプロイ。
- **開発(dev)**: `develop` ブランチを Cloudflare Workers(Builds) が自動ビルド/デプロイ（`wasyo-dev.<account>.workers.dev`）。

`base` は `astro.config.mjs` で `'/'`（カスタムドメイン移行済み。旧 GitHub Pages サブパス `wasyo_astro` は廃止）。サイト内パスは移植性のため `import.meta.env.BASE_URL` を使い、`index.astro` 冒頭で末尾スラッシュを正規化した `const base` として定義済み。`site` は環境変数 `PUBLIC_SITE_URL` で切替（既定=prod）。環境分離の全体像は README.md「環境分離」節と docs/RESERVATION_PLAN.md を参照。

## アーキテクチャ

トップLP（`src/pages/index.astro`）は**単一ファイル構成**（コンテンツ・スタイル・ロジックを集約、独立 CSS なし）。これに**サイト内予約システム**（Astro 複数ページ＋GAS バックエンド）が加わった構成。

### フロント（`src/`）

- `src/pages/index.astro` — トップLP：フロントマター変数、HTML、`<style>` ブロック
- `src/pages/reserve/index.astro` — 予約UI（メニュー→日時→フォーム送信。LINE Login／LIFF 対応）
- `src/pages/reserve/manage.astro` — お客様の予約変更・キャンセル（トークン受取）
- `src/pages/privacy/index.astro` — プライバシーポリシー
- `src/data/config.js` — 環境設定（`PUBLIC_*` を読む。`IS_DEV`/`ENV_LABEL`/`RESERVE_API`/`LIFF_ID` 等）
- `src/data/menu.js` — メニュー定義（`MENU`／通常・初回の料金・所要時間）。GAS 側の `MENU` と二重管理
- `src/components/EnvBadge.astro` — **dev のときだけ**画面右上に斜めリボン「🚧 開発環境」を表示（prod は DOM も CSS も非出力。スタイルはインライン指定で prod を完全無変更に保つ）。`config.js` の `IS_DEV`（=`PUBLIC_ENV==='development'`）で切替。GAS 管理画面（`gas/admin.html`）にも同じリボンをインラインで設置済み。タブの `【開発】` は各ページ `<title>` 冒頭の `{ENV_LABEL}` で付与
- `src/pages/assets/images/` — 元画像ファイル（`logo.jpg`、`naisou.jpg`）
- `public/` — ルートで配信される静的アセット（favicon・画像）
  - `public/favicon.jpg` — favicon として使用
  - `public/images/naisou.jpg` — コンセプトセクションの内装写真
  - `public/images/logo.jpg` — アクセスセクションの看板写真

### バックエンド（`gas/`）

Google Apps Script の予約システム（空き枠計算／仮予約／承認・辞退／変更・取消／新規・常連判定／LINE・メール通知）。保存先はサロン所有の Google（カレンダー＋顧客台帳シート）と LINE のみで独自DBなし。詳細は ./gas/README.md と ./docs/RESERVATION_PLAN.md を参照。

### 主要なフロントマター変数（`index.astro` 冒頭）

| 変数 | 用途 |
|------|------|
| `salonName` | `<title>` とヘッダーに表示 |
| `base` | `import.meta.env.BASE_URL`（末尾スラッシュ正規化）— サイト内パスのプレフィックス |
| `reservePath` | サイト内予約システム `/reserve/`（メインCTA） |
| `reservaUrl` | RESERVA（移行期間のフォールバックCTA） |
| `tel` | アクセスセクションの `tel:` リンクに使用 |

### CSS デザイントークン（`<style>` 内の `:root`）

テーマは「和×アジアンラグジュアリー」（ゴールド × ダークブラウン × モーヴ紫）。ロゴ（サロン和笑〜Violane〜）の色調に統一している。

| 変数 | 値 | 用途 |
|------|----|------|
| `--c-bg` | `#FDF2F5` | サイト全体の地色（ロゴ背景の淡いピンク） |
| `--c-surface` | `#FFFFFF` | カード・テーブルの白 |
| `--c-ink` | `#2C1F3A` | 本文テキスト（濃紫がかった黒） |
| `--c-muted` | `#7A6080` | 補助テキスト（紫みグレー） |
| `--c-border` | `#E2D0D8` | 罫線（ピンクがかった） |
| `--c-purple` | `#8B6080` | **メインモーヴ**（ベージュ+マゼンタを薄く混ぜた温かみのある紫） |
| `--c-purple-lt` | `#B09AB0` | 中間モーヴ |
| `--c-purple-dk` | `#3E2B4A` | 濃いモーヴ（ホバー・セカンダリ） |
| `--c-purple-pale` | `#C8A8C4` | 薄モーヴ（装飾・補助） |
| `--c-reserve` | `#8B6080` | 予約ボタン色（= `--c-purple` 同値） |
| `--c-reserve-hv` | `#3E2B4A` | 予約ボタンホバー |
| `--c-accent` | `#C9A84C` | **ゴールド**（アクセント・ドット装飾・フッター上ライン） |
| `--c-brown` | `#4A3728` | ダークブラウン（区切り・フッター） |
| `--c-brown-lt` | `#8B6A50` | ミディアムブラウン（ルーバーライン） |
| `--c-glow` | `rgba(201,168,76,.12)` | ゴールドグロー（四隅装飾） |

フォントは `--f-serif`（Noto Serif JP / 游明朝）を `body` に適用済み。`--f-sans` は一部ナビ等に残存。レスポンシブブレークポイントは `700px`。

### セクション装飾パターン

- **区切り線**: `border-top: double 5px var(--c-purple)`（紫の二重線）
- **見出しドット**: `section-heading-en::before/::after` に `--c-accent`（ゴールド）の円（6px）
- **見出し下線**: `--c-purple` → `--c-accent` のグラデーション
- **ボタン**: `border-radius: 24px`（ピル型）、`min-height: 44px`（モバイルタップ対応）
- **カード・マップ**: `border-radius: 12px`
- **フッター**: 背景 `#2A1A0E → #1A0F24` のグラデ（深紫黒）、上ボーダー `--c-accent`（ゴールド）、LINEボタン（`#06C755`）あり

### 主要セクション

| セクション | id | 概要 |
|-----------|----|------|
| ヒーロー | — | 渐変背景、ruby ふりがな付きh1、スクロール誘導 |
| コンセプト | `#concept` | 女性専用ポリシー記載、内装写真（naisou.jpg） |
| 施術の特徴 | `#features` | 4サービスを2×2グリッドで表示 |
| メニュー | `#menu` | セット（1番人気）→もみほぐし→オイル/フット/ハンド3列 |
| アクセス | `#access` | 看板写真（logo.jpg）、営業時間テーブル、Googleマップ |
| フッター | — | 予約ボタン、LINEボタン（https://lin.ee/7ZvbqEb） |
