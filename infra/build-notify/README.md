# wasyo-build-notify — Workers Builds → Discord 通知（Consumer Worker）

本番 Worker（`wasyo-prod`）の **Cloudflare Workers Builds** が発行するビルドイベントを、
**Cloudflare Queue** 経由で受け取り **Discord** に通知するための独立した Consumer Worker。

- 発火するイベント: `build.started` / `build.succeeded` / `build.failed` / `build.canceled`
- 経路: Workers Builds（`wasyo-prod`）→ **Event Subscriptions** → **Queue（`wasyo-build-events`）** → **本 Worker（`wasyo-build-notify`）** → **Discord Webhook（ネイティブ embeds）**
- 設計の正本: [`docs/MIGRATION_CLOUDFLARE.md` §2](../../docs/MIGRATION_CLOUDFLARE.md) / [`docs/PROD_CUTOVER_RUNBOOK.md` Phase B-4](../../docs/PROD_CUTOVER_RUNBOOK.md)
- この Worker は `wasyo-prod`（astro 本体）とは**完全に独立**。`infra/build-notify/` 配下だけで自己完結し、`pnpm run build`（astro）はこのディレクトリを拾わない。

## なぜこの方式か

Event Subscriptions は「ビルドコンテナ内のコマンド実行」に依存せず `build.failed` を発火するため、
**ビルドが途中でクラッシュしても失敗通知が飛ぶ**。curl をビルドコマンドに仕込む方式は途中で落ちると
通知コマンドまで到達しないため不採用（`MIGRATION_CLOUDFLARE.md` §2）。

## ファイル

| ファイル | 役割 |
|----------|------|
| `wrangler.toml` | Worker 名 `wasyo-build-notify`／`[[queues.consumers]]` で `wasyo-build-events` を bind。routes・カスタムドメインは付けない。 |
| `index.mjs` | Queue コンシューマ本体（ESM `export default { async queue(batch, env) {} }`）。 |
| `.dev.vars.example` | 秘密のキー名テンプレート（実値なし）。 |

---

## セットアップ手順（アカウント所有者＝本人が実行）

> `wrangler` はグローバル未インストール＆未認証（＝本人アカウントでの操作）。以下は**本人**が実行する。
> **すべてリポジトリ内で `npx wrangler`** を使う（`devDependencies` に固定版 wrangler があるため／`~/projects/wasyo_astro` から実行）。素の `wrangler ...` は「コマンドが見つかりません」になる。

### 1. ログイン（リポジトリ root から）

```bash
cd ~/projects/wasyo_astro
npx wrangler login
```

### 2. Queue を作成

```bash
npx wrangler queues create wasyo-build-events
```

### 3. Consumer Worker をデプロイ

```bash
cd infra/build-notify && npx wrangler deploy -c wrangler.toml
```

> ⚠️ **`-c wrangler.toml` を必ず付ける**: リポジトリ root には astro の Cloudflare アダプタが
> `pnpm run build` 時に生成する `.wrangler/deploy/config.json`（`wasyo-prod` 用の redirect）がある。
> `infra/build-notify/` から素の `npx wrangler deploy` を叩くと wrangler が上位のこの redirect を拾い、
> 「どの設定を使うか不明」エラーで止まる（ローカル実測 2026-07-11）。`-c wrangler.toml` で本ディレクトリの
> 設定を明示すると解決する（dry-run でバンドル成功を確認済み）。

### 4. Discord Webhook URL を secret として登録

値はここに書かず、プロンプトに貼り付ける（**キー名のみ**記載）。
**素の Discord Webhook URL**（末尾に `/slack` は付けない）を渡すこと。本 Worker は Discord ネイティブの `embeds` 形式で送るため。

```bash
cd infra/build-notify && npx wrangler secret put DISCORD_WEBHOOK_URL -c wrangler.toml
# プロンプトに例: https://discord.com/api/webhooks/<id>/<token> を貼る
```

### 5. Event Subscriptions を設定（Cloudflare ダッシュボード）

Workers Builds プロジェクト **`wasyo-prod`** → **Settings** → **Event Subscriptions** で、
`build.*`（`build.started` / `build.succeeded` / `build.failed` / `build.canceled`）を
Queue **`wasyo-build-events`** に発行するサブスクリプションを追加する。

### 6. 動作確認

`main` に空コミット等でビルドを起こし、Discord に通知が来ることを確認する。

```bash
git commit --allow-empty -m "chore: trigger wasyo-prod build (notify test)" && git push origin main
```

`build.started`（🔨）と `build.succeeded`（✅）が Discord に届けば疎通 OK。
失敗を試すなら一時的にビルドを壊して `build.failed`（⚠️）が届くことも確認できる。

---

## Discord メッセージの整形（どのフィールドを使うか）

イベントのペイロードに**実在するフィールドのみ**を載せる（無い項目は出さない）。
フィールド名は公式ドキュメント＋公式テンプレ（`cloudflare/templates/workers-builds-notifications-template`）に準拠。

| 表示 | 参照フィールド |
|------|----------------|
| 見出し（絵文字＋色＋ラベル） | `type`（`...succeeded`/`failed`/`canceled`/`started`）＋補助的に `payload.buildOutcome` |
| Worker 名 | `source.workerName`（無ければ `payload.buildTriggerMetadata.repoName`） |
| ビルドURL（見出しのリンク） | `metadata.accountId` ＋ `payload.buildUuid`（ダッシュボードのビルド詳細 URL） |
| 本文 | `payload.buildTriggerMetadata.commitMessage`（1行目） |
| ブランチ | `payload.buildTriggerMetadata.branch` |
| コミット | `payload.buildTriggerMetadata.commitHash`（先頭7文字） |
| 作者 | `payload.buildTriggerMetadata.author`（メール形式なら @ の手前） |
| タイムスタンプ | `metadata.eventTimestamp`（無ければ `payload.stoppedAt`/`createdAt`） |

**色/絵文字**: success=緑 `0x36a94f`/✅・failure=赤 `0xd13438`/⚠️・canceled=灰 `0x9e9e9e`/⏹️・started=灰 `0x9e9e9e`/🔨・未知=灰/ℹ️。

Discord ネイティブの `embeds` 形式で送る（`title`＋`url` で見出しをリンク化・`description`＝コミット1行目・
`color`＝10進整数・`fields`＝name/value/inline・`footer.text`・`timestamp`＝ISO8601）。素の Webhook URL に POST するだけ（`/slack` 不要）。

## エラー時の挙動（明記）

- **転送失敗**（Discord の非 2xx・一過性エラー・レート制限・ネットワーク）→ `message.retry()` で**再試行に委ねる**（`max_retries=3`）。
- **構造が壊れて解釈できないメッセージ**（イベントでない）→ ログして `message.ack()`（毒メッセージで無限リトライしない）。
- **未知のイベント種別** → 握りつぶさずログし、中立通知（ℹ️）を送ってから `ack`。
- **secret 未設定**（`DISCORD_WEBHOOK_URL` 無し）→ 構成ミスとして全件 `retry`（気づけるように）。
- バッチ内は 1 件ずつ独立に ack/retry するため、1 件の失敗で**バッチ全体を落とさない**。

## 秘密の扱い

- Discord Webhook URL は **wrangler secret**（キー名 `DISCORD_WEBHOOK_URL`）でのみ管理。リポジトリには実値を一切書かない。
- ローカルで `wrangler dev` する場合のみ `.dev.vars.example` を `.dev.vars` にコピーして実値を入れる（`.dev.vars` は `.gitignore` 済み）。

## 要確認・未確定事項

- **ペイロードの実物**: フィールド名は公式ドキュメント／公式テンプレの型定義に基づく。本番で実際に届く JSON の細部（省略される任意フィールド等）は初回の実イベントで最終確認するのが確実。届いた生ペイロードは `console.log` で `wrangler tail wasyo-build-notify` から観測できる。
- **ダッシュボードのビルド URL 形**（`.../workers/services/view/<worker>/production/builds/<buildUuid>`）は公式テンプレ `getDashboardUrl` に準拠。UI 変更で将来変わる可能性あり（リンク切れでも通知本体は成立する）。
- **`build.started` の通知要否**: 現状は開始も通知する（中立）。ノイズに感じる場合は Event Subscriptions で `build.started` を外すか、`index.mjs` で started を ack だけにして送らないよう調整可能。
