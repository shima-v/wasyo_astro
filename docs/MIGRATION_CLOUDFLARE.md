# 移行計画書: prod を GitHub Pages → Cloudflare へ統一する

- 位置づけ: [ADR-0002](adr/0002-cloudflare-unify.md)（意思決定＝なぜ統一するか）に対する**実行手順書**（どう移すか）。
- ステータス: **計画（全論点確定・本人承認済み 2026-07-06）**。本書は設計・計画まで。**本番切替・DNS 変更・private 化は別セッションで刻む**（コード実装・切替はまだ行わない）。
- 起票日: 2026-07-06
- 制約: 本書に秘密の実値・個人情報は書かない（キー名のみ）。

---

## 0. 現状 → 目標（対比）

| 項目 | 現状 | 目標 |
|------|------|------|
| prod 配信 | GitHub Pages（`deploy.yml`：main push → 静的ビルド → Pages） | Cloudflare Worker `wasyo-prod`（Workers Builds：main push → 自動デプロイ） |
| dev 配信 | Cloudflare Workers Builds（`wrangler.toml` = `wasyo-dev`） | 変更なし（`wasyo-dev`） |
| デプロイ通知 | GitHub Actions notify job → GAS → Discord | Workers Builds の Event Subscriptions（Queue→Consumer Worker→Discord Webhook） |
| 公開ページ | プリレンダ静的（GitHub Pages 配信） | プリレンダ静的（Cloudflare が静的アセット配信） |
| 管理ゲート | dev=サーバ／**prod=クライアント（静的＋localStorage）** | dev/prod とも**サーバゲート**（middleware） |
| prod の Worker 秘密 | **無し**（Pages=静的のため） | **有り**（SESSION_SECRET 等を Cloudflare secret に登録・本人操作） |
| ドメイン | wwwasyo.com → GitHub Pages | wwwasyo.com → Cloudflare Worker（カスタムドメイン） |
| リポジトリ | public | 移行完了後に **private** |

---

## 1. astro.config 変更方針

現行は `isWorkerBuild`（`WORKER_BUILD=1` or `PUBLIC_ENV=development`）で adapter と `injectRoute` を**dev 時だけ**有効化している。統一後はこの分岐を撤廃する。

- **adapter を常時有効化**: `@astrojs/cloudflare` を `PUBLIC_ENV` に依らず常に付ける（`isWorkerBuild ? {adapter} : {}` の三項を撤廃）。
- **`injectRoute` を常時実行**: `'astro:config:setup'` の `if (!isWorkerBuild) return;` ガードを撤廃し、管理ページ（`/reserve/admin`）・管理 API（login/logout/action）を**dev/prod とも `prerender:false`** で注入。ADR-0001 決定2 由来の `prerender: !isWorkerBuild`（二態）は不要になる。
- **`output` 戦略**: `output: 'static'` は**維持**してよい。Cloudflare adapter は「プリレンダ静的ページは `dist/client` に静的アセットとして出し、`prerender:false` ルートだけ Worker（`dist/server/entry.mjs`）で処理」する hybrid 構成になる。公開ページ（LP・予約フォーム・privacy）は**静的アセットのまま** Cloudflare が配信でき、見た目・機能は不変。
- **`PUBLIC_ENV` の残置**: 配信構造の分岐からは外すが、**開発バッジ/【開発】ラベル等の表示切替**には引き続き使う（prod=production／dev=development）。`site`（`PUBLIC_SITE_URL` 既定 wwwasyo.com）の環境切替も継続。
- **middleware の単純化**: `src/middleware.js` の prod passthrough（fail-open）分岐を撤廃し、`readCookie`+`verifySession(env.SESSION_SECRET, token)` の**常時サーバゲート**に収束（env は dev/prod とも Worker で取得可能になるため `cloudflare:workers` の動的 import ガードも不要化できる）。

> ※温存中の PR-2 Step1-3（`src/admin-pages/` への移動・`injectRoute`・middleware 雛形）は骨格を再利用し、二態向けの分岐だけをこの方針で作り直す。

---

## 2. デプロイ方針（Workers Builds 統一＋Event Subscriptions 通知）【確定】

**prod も dev と同じ Cloudflare Workers Builds（Git 連携）に一本化する**（本人要望「統一するけど通知は維持」）。GitHub Actions によるビルド/デプロイ（`deploy.yml`）は廃止し、Pages 撤去（PR-D）で退場させる。

- **ビルド/デプロイ**: main push → Cloudflare Workers Builds が `wasyo-prod` を自動ビルド・デプロイ（dev の `wasyo-dev` と同じ仕組み）。adapter 有効ビルドで `dist/client`＋`dist/server/entry.mjs` を生成。`PUBLIC_ENV=production` など公開値は Workers Builds のビルド変数で注入。
- **prod Worker のサーバ秘密**（SESSION_SECRET 等）は Cloudflare 側 secret に登録（§4・ビルド時公開値と実行時秘密を分離）。
- **Discord 通知は Workers Builds の「Event Subscriptions」で維持**（現行の GAS 経由 Discord 通知から**載せ替え**）。
  - 仕組み: Workers Builds が `build.started` / `build.succeeded` / `build.failed` / `build.canceled` の4イベントを **Cloudflare Queue** に発行 → **Consumer Worker** が読み **Discord Webhook** へ転送。Discord は Webhook URL 末尾に `/slack` を付けて Slack 互換ペイロードで受信。公式テンプレート `cloudflare/templates/workers-builds-notifications-template` あり。
  - **失敗も確実に通知**: `build.failed`（`buildOutcome:"failure"`）はビルドコンテナ内のコマンド実行に依存しない構造で発火するため、**途中クラッシュでも失敗通知が飛ぶ**。
  - **不採用**: curl をビルドコマンドに仕込む方式は「ビルドが途中で落ちると通知コマンドまで到達せず失敗通知が飛ばない」弱点があるため採らない。
  - 出典（確認日 2026-07-06）: `https://developers.cloudflare.com/workers/ci-cd/builds/event-subscriptions/`／`https://developers.cloudflare.com/changelog/post/2025-12-11-builds-event-subscriptions/`。
- **repo secret**: GitHub Actions を廃止するので `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` を GitHub 側に置く必要はない（Workers Builds は Cloudflare↔Git 連携で完結）。ただし GAS 通知の repo secret（`GAS_DEPLOY_ENDPOINT`/`DEPLOY_NOTIFY_TOKEN`）は Event Subscriptions 移行後は不要になる。
- **ブランチ↔Worker 対応**: main→`wasyo-prod`／develop→`wasyo-dev`（Workers Builds のブランチ設定で振り分け）。

---

## 3. wrangler.toml 方針（dev/prod の環境分け）

- **共通**: `compatibility_date` / `compatibility_flags = ["nodejs_compat"]` は共通。
- **dev**: 現行 `name = "wasyo-dev"`・`workers_dev = true`・`preview_urls = true` を**トップレベル（既定環境）**に維持。
- **prod【確定】**: wrangler の環境機能 **`[env.production]`** で **1ファイル分離**する。prod 用 `name = "wasyo-prod"` と `routes`（`wwwasyo.com/*`）を `[env.production]` 配下に定義（別ファイルには分けない）。
- **カスタムドメイン**: `wasyo-prod` に **wwwasyo.com のカスタムドメイン**を割り当て（Cloudflare 側でルート／カスタムドメイン設定・証明書は自動発行）。
- **秘密**: dev/prod とも実値はリポジトリに書かない。キー名の一覧は `.dev.vars.example` を正とする（SESSION_SECRET／ADMIN_TOKEN／ADMIN_PIN(任意)／RESERVE_API／ALLOWED_ORIGIN(任意)）。prod は `wrangler secret put --env production` かダッシュボードで登録。

---

## 4. ★本人操作項目（クロコ／CTO では代行できない・独立管理）

以下は権限・所有物の都合で**本人しか実施できない**。移行はこれらが揃ってから本番切替に進む。

1. **Cloudflare 本番 Worker プロジェクトの作成**（ダッシュボードで Git 連携の Workers Builds を設定）。Worker 名＝`wasyo-prod`・main ブランチ連携（§2/§3 と一致）。
2. **wwwasyo.com のネームサーバを Cloudflare へ変更**（レジストラ移管は不要・**NS 変更のみ**）。現行 NS＝`ns-cloud-*.googledomains.com`（Google 系）。本人操作＝**Google Domains（現 Squarespace）の管理画面**。※本番稼働中ドメインのため §6 の2段階手順で。
3. **prod の Worker 秘密の登録**（`wrangler secret put --env production` かダッシュボード）:
   - `SESSION_SECRET`（強ランダム）／`ADMIN_TOKEN`（GAS `ADMIN_TOKENS` の1つと一致）／`ADMIN_PIN`（任意）／`RESERVE_API`（prod GAS `/exec`）。
   - ※現状 prod にはこれらの Worker 秘密が**存在しない**（Pages=静的だったため）。統一で**新規に必要**になる点に注意。
   - LINE 系（`PUBLIC_LINE_LOGIN_*`／`PUBLIC_LIFF_ID`）はドメイン不変ゆえ **REDIRECT/LIFF 再設定は不要**・継続（Workers Builds のビルド変数で注入）。
4. **Event Subscriptions 通知の準備**: Discord Webhook URL（末尾 `/slack`）の用意と、Consumer Worker＋Queue のデプロイ（公式テンプレート `cloudflare/templates/workers-builds-notifications-template`）。**Queue の無料枠は未確認のため、移行前に実測で確認**（§9-④）。
5. **（GitHub Actions 廃止に伴う後片付け）**: 旧 GAS 通知の repo secret（`GAS_DEPLOY_ENDPOINT`/`DEPLOY_NOTIFY_TOKEN`）は Event Subscriptions 移行後に不要。Pages 撤去（PR-D）で `deploy.yml` ごと退場。

---

## 5. private 化の順序依存【厳守】

GitHub Pages の無料運用は実質 public リポ前提。**Pages 稼働中に private 化すると Pages が止まり prod が停止するリスク**がある。したがって順序を厳守する:

1. Cloudflare への移行を完了（§1-4）。
2. wwwasyo.com が **Cloudflare 配信で正常動作**することを確認（公開ページ＋予約フロー＋管理サーバゲート・§7）。
3. **GitHub Pages を撤去**（リポの Pages 設定を無効化・`deploy.yml` から Pages ジョブ削除済みであること）。
4. **その後**にリポジトリを private 化: `gh repo edit shima-v/wasyo_astro --visibility private`。
   - ※リポ名は実体が `wasyo_astro`（アンダースコア）。

---

## 6. DNS 切替のダウンタイム最小化とロールバック（NS移行とレコード切替の2段階）

本番 wwwasyo.com は予約フォーム稼働中。**NS 移行そのものを無停止にし、配信先の切替は Cloudflare 内で即時ロールバック可能にする**ため、次の2段階に分ける。

**現行実体（dig 確認・2026-07-06）**: NS=`ns-cloud-*.googledomains.com`（Google 系）／A=`185.199.108-111.153`（GitHub Pages）／`www`→`shima-v.github.io`。

### 段階①: NS を Cloudflare へ移行（配信先は GitHub Pages のまま＝無停止）
- Cloudflare にゾーン（wwwasyo.com）を作成し、**まず現行と同じレコード**を登録する（A=`185.199.108-111.153`・`www`→`shima-v.github.io`）。
- Google Domains（現 Squarespace）側で**ネームサーバを Cloudflare の割当 NS に変更**（本人操作）。
- 伝播を確認（`dig NS` / `dig A`）。この時点では**配信先は依然 GitHub Pages**なので、閲覧者から見て無停止。
- 段階①の間、事前準備として prod Worker を **workers.dev URL で完全動作確認**（§7）＋Cloudflare でカスタムドメイン設定・**証明書発行まで完了**させておく。

### 段階②: レコードを prod Worker のカスタムドメインへ切替（Cloudflare 内・即ロールバック可）
- Cloudflare 上で A/CNAME を **`wasyo-prod` のカスタムドメイン**へ変更。NS は既に Cloudflare なので**この切替は Cloudflare 内で即時反映**。
- 伝播/実アクセス確認（`dig` / 複数リゾルバ・ブラウザで公開ページと予約フォーム）。

**ロールバック**
- 異常時は Cloudflare 上でレコードを**段階①の GitHub Pages 向け値（控えておいた A/CNAME）に戻すだけ**で即復旧（NS を戻す必要はない）。
- そのため **GitHub Pages は段階② の後も一定期間は撤去しない（並走期間）**。§5 の Pages 撤去・private 化は、Cloudflare 側の安定を見届けてから。

---

## 7. 公開ページの表示回帰・動作確認方法

- **静的出力レベルの回帰**: adapter 有効ビルドの `dist/client` にある公開ページ（index／reserve／manage／decision／message／privacy）と `_astro/*` を、**現行 prod dist と sha256 比較**（PR-1 と同じ正規化＝HTMLコメント／空白／ハッシュ化 JS 名の正規化）で無回帰を確認。
- **workers.dev 目視**: LP・予約フォーム・privacy をプレビュー URL で目視（レイアウト・画像・CSS 崩れ・favicon）。
- **予約フロー E2E**: 空き取得 → 仮予約 → 確認（メール・GAS 連携）まで通す。
- **管理サーバゲート**: 未認証で `/reserve/admin` を叩き **HTML が返らない（サーバゲートが効く）** ことを確認。ログイン後に各セクションが動くこと。
- **静的アセット配信**: `_astro/*.css`／`*.js`／`images/*` が Cloudflare ASSETS 経由で 200 配信されること。

---

## 8. PR 分割案（小さく刻む）

| PR | 内容 | 本番影響 | 前提 |
|----|------|----------|------|
| **PR-A（基盤移行）** | `astro.config` 常時 adapter 化＋`injectRoute` 常時化／`wrangler.toml` に `[env.production]`（`wasyo-prod`）追加／**Workers Builds（prod）＋Event Subscriptions 通知（Queue＋Consumer Worker）**のセットアップ。**workers.dev で検証まで。本番 DNS は触らない** | 無（切替前） | 本人操作1（prod Worker/Builds）・4（通知・Queue 実測） |
| **PR-B（統一版ゲート／旧 PR-2 相当）** | middleware を prod passthrough 撤廃の**常時サーバゲート**へ。クライアントゲート（`#gate`＋localStorage トークン）を撤去・整理。`injectRoute` を prod でも `prerender:false`。温存中の Step1-3 を本方針で作り直し | 無（切替前） | PR-A |
| **PR-C（本番切替）** | prod secret 登録（本人操作3）→ DNS 段階①NS移行→段階②レコード切替（§6）→ 並走で安定確認 | **有**（本番） | PR-A/B・本人操作1-3 |
| **PR-D（撤去＋private 化）** | GitHub Pages 撤去 → `deploy.yml` 退場 → private 化（§5・本人操作） | 有（Pages 停止） | PR-C の安定確認後 |

---

## 9. 確定した論点（本人承認済み・2026-07-06／ADR-0002 と共通）

1. **① prod Worker 名／環境分け**: `wasyo-prod`。wrangler `[env.production]` で dev（`wasyo-dev`）と1ファイル分離（§3）。
2. **② デプロイ／通知**: prod も Workers Builds に統一（GitHub Actions 廃止）。Discord 通知は Event Subscriptions（Queue→Consumer Worker→Discord Webhook）で維持・失敗も確実に通知（§2）。ブランチ↔Worker＝main→`wasyo-prod`／develop→`wasyo-dev`。
3. **③ DNS**: NS を Google 系→Cloudflare へ変更するフル移行（レジストラ移管不要）。NS 移行とレコード切替を2段階に分けて無停止化（§6）。
4. **④ Cloudflare 無料枠**: Workers＋カスタムドメインは適合見込み。ただし **Event Subscriptions 用 Queue の無料枠は未確認 → 移行前に実測で確認**（researcher 未確認。作話しない）。
5. **⑤ LINE 系 `PUBLIC_*`**: ドメイン不変ゆえ REDIRECT/LIFF 再設定不要・継続。

---

## 参照
- 意思決定（なぜ統一するか・弁証法）: `docs/adr/0002-cloudflare-unify.md`
- Superseded 元（決定1・3は有効）: `docs/adr/0001-p2-admin-restructure.md`
- 現行 prod デプロイ: `.github/workflows/deploy.yml`／現行 dev 配信: `wrangler.toml`／秘密キー名: `.dev.vars.example`
- PR-1 の sha256 回帰照合手順: `docs/log/2026-07-04-p2-pr1.md`
