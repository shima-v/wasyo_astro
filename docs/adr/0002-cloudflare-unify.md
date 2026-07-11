# ADR 0002: 配信基盤を dev/prod とも Cloudflare へ統一し、管理ゲートをサーバ側に一本化する

- ステータス: **Accepted**（本人が全論点を承認・2026-07-06）。これをもって ADR-0001 決定2 を正式に Superseded とする。
- 日付: 2026-07-06
- 対象: 配信構成（`astro.config.mjs`／`.github/workflows/deploy.yml`／`wrangler.toml`）と管理画面（`/reserve/admin` 配下）のゲート方式
- 関係: **ADR-0001 の「決定2（技術構造：配信とゲート）」を Supersede**する。ADR-0001 の**決定1（IA）・決定3（ビジュアル）は有効なまま**。
- 実行手順は別紙 `docs/MIGRATION_CLOUDFLARE.md`（本 ADR は「なぜ統一するか」の意思決定記録、別紙は「どう移すか」の手順書）。

---

## Context（なぜ今、配信構成を見直すのか）

ADR-0001 決定2 は「**二態**」を採った。すなわち **dev は Cloudflare Worker 配信でサーバゲート／prod は GitHub Pages の静的配信でクライアントゲート**。これは「本番 wwwasyo.com を壊さない」ことを最優先にした安全策であり、PR-1 までは正しく機能した。

しかし P2 の本丸は **顧客管理（全顧客の PII）と代理予約** を管理画面へ載せることにある（ADR-0001 決定1）。ここで二態の弱点が構造的な足かせになることが、PR-2 の実装検討で明確になった。あわせて本人が **git リポジトリの private 化**（公開リポの縮小）に舵を切ることを決めたため、「prod=GitHub Pages（無料枠は public リポ前提）」という土台自体が方針と衝突する。

そこで「二態を維持するか、Cloudflare へ統一するか」を意思決定事項として起票する。

---

## 決定

**dev/prod とも Cloudflare で配信し、管理画面のゲートを `src/middleware.js` によるサーバ側検証へ一本化する。prod のクライアントゲート（静的 HTML＋localStorage トークンで JS が隠す方式）は廃止する。**

- 公開ページ（LP・予約フォーム・privacy）は従来どおりプリレンダ静的のまま、Cloudflare が静的アセットとして配信する（見た目・機能は不変）。
- 管理ページ（`/reserve/admin` 配下）は dev/prod とも **オンデマンド（prerender=false）**にし、middleware がセッション Cookie をサーバ側で検証してから中身を返す。**未認証者には HTML 自体を返さない**。
- prod の配信を GitHub Pages → Cloudflare Worker（`wasyo-prod`）へ移し、**dev と同じ Cloudflare Workers Builds（Git 連携）に一本化**する（main push→自動デプロイ）。GitHub Actions のビルド/デプロイは廃止する。
- 移行完了・動作確認の**後に** GitHub Pages を撤去し、**その後**リポジトリを private 化する（順序は別紙で厳密化）。

---

## 弁証法（二態 → 統一の判断）

### テーゼ（二態を維持すべき）
prod を GitHub Pages の静的配信に保つのは、**本番 wwwasyo.com の可用性を守る最小変更**である。予約フォームは既に本番稼働中で、配信基盤を触ることは即・本番リスクになる。GitHub Pages は無料・枯れており、DNS もドメインもいじらずに済む。「動いているものを触らない」という保守の第一原則に忠実で、dev だけ Cloudflare の Worker ゲートを使えば PII 管理の要求も dev 上では満たせる。

### アンチテーゼ（二態は本質的な弱点と複雑さを抱える）
- **セキュリティの穴**: prod のクライアントゲートは「HTML は誰でも取得でき、JS で隠すだけ」。**顧客管理の PII は、この方式では prod で守れない**（一覧 HTML を直接叩けば中身が漏れる設計になりかねない）。PII を載せる P2 の目的と根本的に噛み合わない。
- **複雑さの累積**: 二態を成立させるには、`injectRoute` で `prerender` を環境で切替え・middleware に prod passthrough（fail-open）分岐を持たせ・prod 静的出力の sha256 回帰照合で無回帰を担保する——という**環境分岐が配信・ゲート・検証の三層に伸びる**。ページが増える PR-3 以降、この分岐は保守コストとして雪だるま式に増える。
- **public リポ縛りとの衝突**: GitHub Pages の無料運用は実質 public リポを前提とする。本人が決めた private 化と両立しにくく、「二態のために public を続ける」のは本末転倒になる。

### ジンテーゼ（prod も Cloudflare 化すれば、弱点と複雑さが同時に解ける）
prod を Cloudflare 配信へ寄せると、**アンチテーゼの3点が一度に消える**:
- prod でも Worker のサーバゲートが効くので、**PII は「未認証には HTML を返さない」で守れる**（セキュリティの穴が塞がる）。
- 配信が dev/prod で同一になり、`isWorkerBuild` 分岐・prerender 切替・prod passthrough・静的 sha256 回帰という**環境分岐が丸ごと不要**になる（middleware は常時サーバゲートの単純形に収束）。
- GitHub Pages を撤去できるので **private 化と整合**する。

テーゼの正当な核心（本番を壊さない）は捨てない。**「壊さないための工程管理」**——workers.dev での事前検証、GitHub Pages との並走期間、DNS 切替のロールバック手順、private 化を最後に置く順序依存——として別紙 `MIGRATION_CLOUDFLARE.md` に厳密化することで、可用性を守りながら統一の便益を取る。したがって結論は「折衷（二態の温存）」ではなく、**工程で安全を担保した上での統一**とする。

---

## 影響

- **コード**: `astro.config.mjs` の `isWorkerBuild` 分岐を撤廃し adapter を常時有効化。管理ページの `injectRoute` は dev/prod とも `prerender:false`。`src/middleware.js` は prod passthrough を捨て**常時サーバゲート**の単純形へ（温存中の PR-2 Step1-3 はこの方針で作り直す）。公開ページの prerender 静的は維持。
- **デプロイ**: prod も dev と同じ **Cloudflare Workers Builds（Git 連携）** に一本化（main push→`wasyo-prod` 自動デプロイ）。GitHub Actions のビルド/デプロイ（`deploy.yml`）は廃止（Pages 撤去と合わせて退場）。**Discord 通知は Workers Builds の Event Subscriptions（Queue→Consumer Worker→Discord Webhook）で維持**し、現行の GAS 経由通知から載せ替える。ビルドコンテナ内のコマンド実行に依存しない構造なので、途中クラッシュでも失敗通知が飛ぶ。
- **秘密**: prod は現状 Worker が無く SESSION_SECRET/ADMIN_TOKEN を持たない。統一で **prod にも Worker 秘密の登録が新規に必要**（本人操作・別紙）。
- **ドメイン**: wwwasyo.com の DNS を Cloudflare へ向け替え（本人操作・ダウンタイム最小化とロールバックは別紙）。
- **リポジトリ**: 移行・動作確認・Pages 撤去の後に private 化（順序厳守。Pages 稼働中の private 化は prod 停止リスク）。
- **GAS**: 変更なし（管理 API の転送先・予約バックエンドは不変）。

---

## 確定した論点（本人承認済み・2026-07-06）

1. **① prod Worker 名と環境分け**: prod Worker 名＝**`wasyo-prod`**。dev（`wasyo-dev`）とは wrangler の **`[env.production]`** で**1ファイル分離**する。
2. **② デプロイと通知**: prod も dev と同じ **Cloudflare Workers Builds（Git 連携）に一本化**（main push→自動デプロイ）。GitHub Actions のビルド/デプロイは廃止。通知は **Workers Builds の Event Subscriptions** で維持——Workers Builds が `build.started/succeeded/failed/canceled` の4イベントを **Cloudflare Queue** に発行 → **Consumer Worker** が読み **Discord Webhook** に転送。**失敗（`build.failed`／`buildOutcome:"failure"`）も確実に通知**（ビルドコマンドに依存しない構造）。現行の GAS 経由 Discord 通知から載せ替える。※curl をビルドコマンドに仕込む方式は「失敗時に通知が飛ばない」ため採らない。公式テンプレート `cloudflare/templates/workers-builds-notifications-template`（Discord は Webhook URL 末尾に `/slack` を付けて受信）。出典（確認日 2026-07-06）: `https://developers.cloudflare.com/workers/ci-cd/builds/event-subscriptions/`／`https://developers.cloudflare.com/changelog/post/2025-12-11-builds-event-subscriptions/`。
3. **③ DNS 移行方式**: **ネームサーバを Google 系（`ns-cloud-*.googledomains.com`）→ Cloudflare に変更するフル移行**（レジストラ移管は不要・NS 変更のみ）。現行実体（dig 確認）＝A=`185.199.108-111.153`（GitHub Pages）・`www`→`shima-v.github.io`。安全化のため **NS 移行とレコード切替を2段階に分ける**（手順は別紙 §6）。本人操作＝Google Domains（現 Squarespace）管理画面。
4. **④ Cloudflare 無料枠**: Workers＋カスタムドメインは無料枠適合の見込み。ただし **Event Subscriptions 用の Queue の無料枠は未確認**（researcher 未確認）→**移行前に実測で確認**する（作話しない）。
5. **⑤ LINE 系 PUBLIC_\***: ドメイン不変のため **REDIRECT/LIFF の再設定は不要**・現状のビルド時埋め込みを継続。

---

## 参照
- ADR-0001（決定1・3は有効／決定2を本 ADR が Supersede）: `docs/adr/0001-p2-admin-restructure.md`
- 移行手順書（実行計画・本人操作項目・ロールバック・PR 分割）: `docs/MIGRATION_CLOUDFLARE.md`
- PR-1 記録（二態のスパイク結論＝式による prerender 切替は不可）: `docs/log/2026-07-04-p2-pr1.md`
- 現行 prod デプロイ: `.github/workflows/deploy.yml`／現行 dev 配信: `wrangler.toml`
