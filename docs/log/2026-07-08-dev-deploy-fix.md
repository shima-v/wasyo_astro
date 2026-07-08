# 2026-07-08 dev の Cloudflare Workers Builds デプロイ失敗の修正

## 背景（なぜ）
PR-B（サーバゲート一本化）を push したが、dev URL に反映されなかった。調査の結果、`wasyo-dev` の
Cloudflare Workers Builds が**デプロイ段階で失敗**し続けており、PR-B どころか P1 の Worker 層すら
dev に載っていなかった（dev は adapter 導入前の旧・静的デプロイのまま）。

## 真因（ビルドログ＋履歴で確定）
本人がダッシュボードから取得したビルドログ:
```
[build] Complete!               ← astro build 自体は成功（PR-B のコードは正しい）
Success: Build command completed
Executing user deploy command: npx wrangler deploy
sh: 1: wrangler: not found      ← ここで失敗
Failed: error occurred while running deploy command
```
- `astro build` は成功し、prerender で `/reserve/admin/login/index.html` も生成されていた。
- **真因＝`npx wrangler deploy` の `wrangler: not found`**。`@astrojs/cloudflare` 13.7.0 を導入した際、
  wrangler はその **peerDependency（^4.83.0）**として `node_modules` には入るが、**pnpm は peer 依存の
  bin を `node_modules/.bin` に張らない**ため、CI コンテナで `npx wrangler` が実行ファイルを解決できなかった。
  ローカルは別経路で `.bin/wrangler` が存在したため気づけなかった。
- **裏取り（GitHub Checks 履歴）**: Workers Builds は **adapter 導入前（`0837a2e`・`astro ^6.1.1` の純静的）
  まで success**、**adapter 導入（`@astrojs/cloudflare` を deps に追加した `0a138d9` 以降）から failure**。
  ⇒「adapter を入れてから壊れた」で確定。純静的時代は `npx wrangler` が（ローカル wrangler 不在ゆえ）
  その場で取得され deploy できていたが、adapter が wrangler を peer として持ち込んだことで
  「node_modules にあるが .bin に無い」状態になり npx が解決できなくなった。

## 修正（repo 側・push は本人GO）
1. **`build(deps)`（`50766a3`）**: `wrangler` を **devDependencies に追加**（`^4.107.0`＝lockfile 既存の
   解決版・バージョン変更なし）。直接依存化で `.bin/wrangler` が確実に張られ、`npx wrangler deploy` が解決できる。
2. **`fix(build)`（`ee28b6d`）**: **未使用の Session(KV)/Image(Images) バインディングを無効化**。
   wrangler 解決後の「次の失敗要因」を先回りで断つ。
   - 使用実態を grep で確認: **Astro Session（`Astro.session` 等）未使用**（管理セッションは自前 HMAC Cookie
     ＝ `src/worker/session.js`）／**Astro Image・`astro:assets` 未使用**（画像は生 `<img>` のみ）。
   - `session.driver` に非 KV の `sessionDrivers.memory()` を指定 → SESSION KV binding を止める。
   - `imageService: 'passthrough'` → Cloudflare Images の IMAGES binding を止める。
   - 結果、生成 `wrangler.json` の bindings は **ASSETS のみ**（`kv_namespaces:[]`・`images:null`）。本人の
     KV 名前空間作成は不要で deploy が通る。

## 検証（ローカル・実体）
- `pnpm build`（環境変数なし＝CI 模擬）成功。ビルドログから `Enabling sessions with Cloudflare KV`／
  `Enabling image processing with Cloudflare Images` が**消滅**、`session.driver` の deprecation 警告も無し。
- 生成 `dist/server/wrangler.json`: `kv_namespaces: []`・`images: null`。
- `npx wrangler deploy --dry-run`: 認証要求なく成功。bindings は `env.ASSETS` のみ（KV/Images 消滅）。
- PR-B の構造は不変: `dist/client/reserve/admin/index.html` 不在（オンデマンド）・`.../admin/login/index.html`
  存在（静的）・公開ページ静的。

## 本人操作（この後・push で dev 再ビルドが走る）
1. **push（本人GO）** → `wasyo-dev` の Workers Builds が再実行され、今度は deploy まで通る想定。
   反映後に PR-B のサーバゲート E2E（未認証302-no-HTML／ログイン／認証済みパネル／ログアウト／回帰）を dev で実施。
2. **dev Worker の secret 登録**（現状 `SESSION_SECRET`／`ADMIN_TOKEN` は**未設定**・E2E の前提）:
   - `wrangler secret put SESSION_SECRET`（強ランダム。例: `openssl rand -base64 48`）
   - `wrangler secret put ADMIN_TOKEN`（**GAS Script Properties の `ADMIN_TOKENS` の1つと一致**させる）
   - 任意: `wrangler secret put ADMIN_PIN` / `RESERVE_API`（dev GAS `/exec`）
   - ※ dev Worker は wrangler.toml トップレベル（`wasyo-dev`）なので `--env` は付けない。ダッシュボードの
     Variables and Secrets からの登録でも可。**登録は本人操作**（CTO/クロコは secret を触らない）。キー名の正は `.dev.vars.example`。

## 申し送り
- push はしていない（本人GO 待ち）。stash@{0}（PR-2 仮コード）は温存。
- Event Subscriptions（ビルド通知）は本移行の別項（MIGRATION §2/§4）。本修正はデプロイ成否そのものの回復。
