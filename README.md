# サロン和笑〜Violane〜 公式サイト

富山県高岡市のリラクゼーションサロン **サロン和笑〜Violane〜** の公式 Web サイトです。

**公開 URL:** https://wwwasyo.com/

---

## プロジェクト概要

| 項目 | 内容 |
|------|------|
| サロン名 | サロン和笑〜Violane〜（わしょう・ヴィオラン） |
| 所在地 | 富山県高岡市野村 1180-1 |
| コンセプト | 和とアジアンテイストが融合したラグジュアリーな癒やし空間 |
| 対象 | 主に女性（男性はご紹介のみ） |
| 予約 | サイト内予約システム（`/reserve`・GAS バックエンド）。移行期間は RESERVA（https://reserva.be/wasyou258）も併存 |

---

## 技術スタック

| 技術 | バージョン | 用途 |
|------|-----------|------|
| [Astro](https://astro.build/) | ^6.1.1 | 静的サイトジェネレーター |
| Node.js | >=22.12.0 | ランタイム |
| pnpm | — | パッケージマネージャー |
| GitHub Pages | — | ホスティング |
| GitHub Actions | — | CI/CD（main push → 自動デプロイ） |

### 開発支援

**[Claude Code](https://claude.ai/code)** (Anthropic claude-sonnet-4-6) を使用し、デザイン構成の立案・CSS 実装・メニューデータ反映・OGP 設定などをすべて対話形式で進めました。

---

## アーキテクチャ

**シングルファイル構成**。コンテンツ・スタイル・ロジックはすべて `src/pages/index.astro` に集約しています。独立したコンポーネント・レイアウトファイル・外部 CSS は持ちません。

```
wasyo/
├── src/
│   └── pages/
│       └── index.astro        # サイト全体（HTML + <style> + <script>）
├── public/
│   ├── favicon.jpg
│   ├── CNAME                  # カスタムドメイン設定
│   └── images/
│       ├── naisou.jpg         # 内装写真（コンセプトセクション）
│       └── logo.jpg           # 看板写真（アクセスセクション）
├── astro.config.mjs
├── package.json
└── CLAUDE.md                  # Claude Code 向け開発ガイド
```

---

## デザインテーマ

「**和×アジアンラグジュアリー**」をコンセプトに統一しています。

- **カラー:** ロゴ紫 `#8B6080` とゴールド `#C9A84C` を基調に、ダークブラウン `#4A3728` をフッター・区切りに使用
- **背景:** 和紙テクスチャ（縦罫線）＋四隅オリエンタルグロー（CSS のみ、画像不使用）
- **タイポグラフィ:** Noto Serif JP（明朝体）を全体に適用。ヒーローに縦書き巨大透過テキストを左右両端から見切れる形で配置
- **セクション区切り:** ゴールドドット付きルーバーライン（格子デザイン）
- **アニメーション:** Intersection Observer によるスクロール時間差浮上エフェクト

---

## 開発コマンド

```bash
pnpm install    # 依存関係のインストール
pnpm dev        # 開発サーバー起動 (http://localhost:4321/)
pnpm build      # 本番ビルド → dist/ に出力
pnpm preview    # ビルド済みをローカルでプレビュー
```

---

## デプロイ

`main` ブランチへの push で GitHub Actions が自動起動し、GitHub Pages へデプロイされます。カスタムドメイン（`wwwasyo.com`）は `public/CNAME` で設定しています。

---

## 環境分離（本番 / 開発）

サイト内予約システム（GAS バックエンド）の開発にあたり、**本番(prod) と 開発(dev) を完全分離**しています。見た目がほぼ同一なため、取り違え防止に **dev のときだけ画面右上に斜めリボン「🚧 開発環境」＋ブラウザのタブに `【開発】`** を表示します（GAS 管理画面にも同じリボンを表示。prod では一切表示しません）。

| 資源 | 本番(prod) | 開発(dev) |
|------|-----------|-----------|
| ブランチ | `main` | `develop` |
| フロント | GitHub Pages → `wwwasyo.com` | Cloudflare Workers（`wasyo-dev`） |
| GAS Web App | prod プロジェクトの `/exec` | dev プロジェクトの `/exec` |
| 予約カレンダー・顧客台帳 | prod 用 | dev 用 |
| LINE Messaging API | dev/prod 共有（ラベル無し） | dev/prod 共有（通知に `【開発】`） |

### 設定の持ち場

- **フロント**: 公開設定は `PUBLIC_*` 環境変数で注入（`src/data/config.js` が読む）。
  - dev: ローカルは `.env.development`（gitignore 済）、Cloudflare はプロジェクトのビルド環境変数。
  - prod: GitHub Actions の env（GAS URL は repo secret）。
  - 環境の切替フラグは **`PUBLIC_ENV`**（dev=`development` / prod=`production`）。`config.js` の `IS_DEV` / `ENV_LABEL` がこれを参照し、上記の開発バッジ・タブ表示を切り替えます。
- **秘密情報**（LINE チャネルトークン・HMAC secret 等）はフロント/リポジトリに置かず、**GAS の Script Properties にのみ**保管します。`.env*` は gitignore 済み。

> 詳細は [`RESERVATION_PLAN.md`](./RESERVATION_PLAN.md)（設計）・[`docs/SETUP.md`](./docs/SETUP.md)（外部サービス初期設定）・[`gas/README.md`](./gas/README.md)（バックエンド）を参照。

---

## ロードマップ

- [x] 環境セットアップ（pnpm, Astro 初期化）
- [x] 基本セクション実装（ヒーロー・コンセプト・施術の特徴・メニュー・アクセス）
- [x] GitHub Pages へのデプロイ設定
- [x] SEO 対応（title, description, 構造化データ, OGP）
- [x] 和×アジアンラグジュアリーへの全面リデザイン
- [x] お品書きスタイルのメニュー刷新（最新料金・初回バッジ）
- [x] スマホ追従ナビ（電話予約・ネット予約の固定2ボタン）
- [x] カスタムドメイン（wwwasyo.com）への移行
