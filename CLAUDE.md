# CLAUDE.md

このファイルは、リポジトリ内のコードを扱う Claude Code (claude.ai/code) 向けのガイダンスを提供します。

## コマンド

```bash
pnpm dev        # ローカル開発サーバー起動 (http://localhost:4321/wasyo_astro/)
pnpm build      # 本番ビルド → dist/ に出力
pnpm preview    # 本番ビルドをローカルでプレビュー
```

パッケージマネージャーは **pnpm**。テストランナーは未設定。

## デプロイ

`main` ブランチへのプッシュで GitHub Actions が起動し、`https://shima-v.github.io/wasyo_astro/` へ自動デプロイされる。

`base` パス（`wasyo_astro`）は `astro.config.mjs` で設定。サイト内のアセットパスはすべて `import.meta.env.BASE_URL` を使う必要があり、`index.astro` 冒頭で `const base` として定義済み。

## アーキテクチャ

**単一ファイル構成の Astro サイト**。コンテンツ・スタイル・ロジックはすべて `src/pages/index.astro` に集約されており、コンポーネント・レイアウト・独立した CSS ファイルは存在しない。

- `src/pages/index.astro` — サイト全体：フロントマター変数、HTML、`<style>` ブロック
- `src/pages/assets/images/` — 元画像ファイル（`logo.jpg`、`naisou.jpg`）
- `public/` — ルートで配信される静的アセット（favicon・画像）
  - `public/favicon.jpg` — favicon として使用
  - `public/images/naisou.jpg` — コンセプトセクションの内装写真
  - `public/images/logo.jpg` — アクセスセクションの看板写真

### 主要なフロントマター変数（`index.astro` 行 1〜6）

| 変数 | 用途 |
|------|------|
| `salonName` | `<title>` とヘッダーに表示 |
| `tel` | アクセスセクションの `tel:` リンクに使用 |
| `reserveUrl` | 外部予約URL。全CTAボタンで共通使用 |
| `base` | `import.meta.env.BASE_URL` — ローカルアセットパスのプレフィックス |

### CSS デザイントークン（`<style>` 内の `:root`）

テーマは「和モダン・エレガント」。ロゴ（サロン和笑〜Violane〜）の色調に統一している。

| 変数 | 値 | 用途 |
|------|----|------|
| `--c-bg` | `#FDF2F5` | サイト全体の地色（ロゴ背景の淡いピンク） |
| `--c-surface` | `#FFFFFF` | カード・テーブルの白 |
| `--c-ink` | `#2C1F3A` | 本文テキスト（濃紫がかった黒） |
| `--c-muted` | `#7A6080` | 補助テキスト（紫みグレー） |
| `--c-border` | `#E2D0D8` | 罫線（ピンクがかった） |
| `--c-purple` | `#8B6080` | **メインモーヴ**（ベージュ+マゼンタを薄く混ぜた温かみのある紫） |
| `--c-purple-lt` | `#B09AB0` | 中間モーヴ |
| `--c-purple-dk` | `#6B4860` | 濃いモーヴ（ホバー・セカンダリ） |
| `--c-purple-pale` | `#C8A8C4` | 薄モーヴ（装飾・補助） |
| `--c-accent` | `#F7E58E` | イエロー（ドット装飾・ホバー・フッターライン） |
| `--c-reserve` | `#8B6080` | 予約ボタン色（= `--c-purple` 同値） |

フォントは `--f-serif`（Noto Serif JP / 游明朝）を `body` に適用済み。`--f-sans` は一部ナビ等に残存。レスポンシブブレークポイントは `700px`。

### セクション装飾パターン

- **区切り線**: `border-top: double 5px var(--c-purple)`（紫の二重線）
- **見出しドット**: `section-heading-en::before/::after` に `--c-accent`（イエロー）の円（6px）
- **見出し下線**: `--c-purple` → `--c-accent` のグラデーション
- **ボタン**: `border-radius: 24px`（ピル型）、`min-height: 44px`（モバイルタップ対応）
- **カード・マップ**: `border-radius: 12px`
- **フッター**: 背景 `#1A0F24`（深紫黒）、上ボーダー `--c-accent`（イエロー）、LINEボタン（`#06C755`）あり

### 主要セクション

| セクション | id | 概要 |
|-----------|----|------|
| ヒーロー | — | 渐変背景、ruby ふりがな付きh1、スクロール誘導 |
| コンセプト | `#concept` | 女性専用ポリシー記載、内装写真（naisou.jpg） |
| 施術の特徴 | `#features` | 4サービスを2×2グリッドで表示 |
| メニュー | `#menu` | セット（1番人気）→もみほぐし→オイル/フット/ハンド3列 |
| アクセス | `#access` | 看板写真（logo.jpg）、営業時間テーブル、Googleマップ |
| フッター | — | 予約ボタン、LINEボタン（https://lin.ee/7ZvbqEb） |
