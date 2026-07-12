# 2026-07-12 Cloudflare 統一移行 完走ログ（Phase A〜E・本番切替まで）

- 位置づけ: `docs/adr/0002-cloudflare-unify.md`（Accepted）／`docs/MIGRATION_CLOUDFLARE.md`／`docs/OWNER_HANDOFF_CLOUDFLARE.md`／`docs/PROD_CUTOVER_RUNBOOK.md` を実行し、**本番を GitHub Pages → Cloudflare Workers（`wasyo-prod`）へ切替**。これで本番配信が dev/prod とも Cloudflare に統一された。
- **`docs/PROD_CUTOVER_RUNBOOK.md` は本ログでクローズ**（残る Phase F を除く）。可逆（A/B/C/D）→ 無停止フリップ（E）→ 不可逆撤去（F）のうち、E-2 まで完走。
- 制約（記録も匿名化）: **キー名・仕組み・手順のみ**。secret 実値・トークン・PII・scriptId/deploymentId 等の識別子は一切書かない（既存 docs の匿名化方針を踏襲）。
- 結果: 本人ブラウザ目視で prod 稼働を確認。apex → Cloudflare エッジ配信・管理ゲート有効・メール（MX/SPF）無傷。

---

## 全体パイプライン（本ログの範囲）

```
A 撤去→昇格 ✅ ─ B wasyo-prod ✅ ─ C prod GAS ✅ ─ D E2E ✅ ─ E DNS2段階 ✅ ─▲ ─ F 撤去/private化 ⬜
   (可逆)          (公開影響ゼロ)     (半可逆)      (GO/NO-GO)   (無停止フリップ)      (不可逆・7/15予定)
```
- ▲ いまここ: 本番切替（E-2）完了。RUNBOOK クローズ。Phase F のみ残（数日の安定を見て別日）。

---

## Phase A — `deploy.yml` 撤去 → `develop→main` 昇格（可逆・公開影響ゼロ）

- `.github/workflows/deploy.yml`（GitHub Pages の build/deploy/notify ジョブ）を**先に削除してから** `develop→main` へマージ。
- **順序の理由**: 昇格で main の中身が Astro/Worker 構成に変わると、Pages workflow が壊れたデプロイを発火させかねない。workflow を先に消せば、昇格しても **Pages デプロイのトリガー自体が無い**＝壊れた本番デプロイが走らない安全順。
- 検証: 昇格後に**新規 Actions run がゼロ**であることを確認＝公開影響ゼロ（現行 prod = GitHub Pages 静的はそのまま生存）。

## Phase B — `wasyo-prod` 構築＋ビルド通知 Worker（workers.dev・公開影響ゼロ）

- 本番 Worker `wasyo-prod` を **Workers Builds（main 連携）** で作成。この時点ではカスタムドメイン未接続＝ `*.workers.dev` のみで公開影響ゼロ。
- **本番デプロイコマンド ＝ `npx wrangler deploy --name wasyo-prod`**（`--env production` ではない）。
  - 理由: `@astrojs/cloudflare` 13.7.0 は **named wrangler environment 非対応**。adapter は生成物 `dist/server/wrangler.json` に **top-level `name = wasyo-dev` を焼き込む**ため、`--env production` は効かない（env セクションが解決されない）。デプロイ名を `--name wasyo-prod` で**上書き**するのが正。
  - 実証: ローカル build ＋**二重 dry-run**（`--env production` では wasyo-dev 名のまま／`--name wasyo-prod` で正しく上書きされる）で確認。
- **ルートは `wrangler.toml` ではなくダッシュボードの Custom Domain** で管理（toml の routes は使わない）。→ カスタムドメイン付与は Phase E-2 で実施。
- **ビルド通知は独立 Consumer Worker** `infra/build-notify/` に分離（`wasyo-prod` 本体のランタイムとは無関係）:
  - 経路: Workers Builds **Event Subscriptions** →  Cloudflare **Queue `wasyo-build-events`** → Consumer Worker → Discord **ネイティブ embeds**。
  - `build.*` の **4イベント**を購読＝成功だけでなく**ビルド失敗も通知**される（旧 GAS `deployNotify` の代替。MIGRATION §2 の載せ替え）。

## Phase C — prod GAS を新コードへ切替（バックエンド切替・半可逆）

- 症状: prod で顧客一覧が取得できない＝ **prod GAS が旧コードのまま**（dev GAS は先行して新コード）。
- 手順:
  1. `clasp push` で prod script の **HEAD を更新**（この時点では **versioned デプロイは不変＝ライブに無影響**）。
  2. 既存の versioned デプロイを **`clasp redeploy <既存デプロイID> -V 25`**（update-deployment）で **v25 に更新**。**`/exec` URL を維持したまま**ライブ反映される。
- **clasp v3 の落とし穴**（正しく使い分ける）:
  - `clasp deploy` ＝ **create-deployment**（新規デプロイを作る）→ **`/exec` URL がずれる＝禁**（Worker の `RESERVE_API`/`PUBLIC_RESERVE_API` が指す先が変わってしまう）。
  - `clasp redeploy` ＝ **update-deployment**（既存デプロイを新バージョンで差し替え）→ **`/exec` URL 維持＝正**。
- C-5 後方互換確認: prod `/exec` の `availabilityRaw` が**有効な JSON を返す**ことを確認（フロントの日時ピッカーが直接叩く契約が生きている）。

## Phase D — workers.dev 本番相当 E2E（GO/NO-GO ゲート・公開影響ゼロ）

- `wasyo-prod` の `*.workers.dev` に対し、**未認証ゲート／認証ゲート**が期待どおり効くことを確認（本番ドメイン接続前の GO/NO-GO 判定）。
- **`PUBLIC_RESERVE_API` は Build 変数**（ランタイム secret とは別枠）。クライアント JS に **inline** され、**日時ピッカーがブラウザから GAS の空きを直取得**する契約。
  - → **設定後は再ビルド必須**。Build 変数は既にビルド済みのバンドルに焼かれているため、値を入れただけでは反映されない（ここを取り違えると「設定したのに空きが取れない」を踏む）。この差（Build 変数＝ビルド時 inline／runtime secret＝実行時 env）は 07-11 監査 面①/面② の区別と一致。
- テスト予約を入れて疎通確認 → 掃除は本人対応済（後述）。

## Phase E — DNS 2段階切替（無停止・即ロールバック可）

無停止のため **NS 移行（E-1）と Worker フリップ（E-2）を分離**。E-1 で DNS の主導権だけ Cloudflare に移し、その間も **Pages を据え置き**、E-2 で初めてトラフィックを Worker に向ける。

### E-1 — NS を Cloudflare へ移行（トラフィックは Pages 据置）

- レジストラ **Squarespace（旧 Google Domains）** → Cloudflare へ **NS を委譲**。
- 移行前に現行ゾーンのレコードを **Cloudflare ゾーンへ複製**: apex `A × 4` ／ `MX = smtp.google.com` ／ `SPF` ／ `DKIM google._domainkey` ／ `www CNAME` ／ `_domainconnect`。
- **`A`・`www`・`_domainconnect` は DNS-only（グレー雲）で複製**＝この段階では **Pages にそのまま向く**（Worker には触れない）。
- 結果: NS 変更は**無停止・伝播は即完了**。**メール3点（MX / SPF / DKIM）の生存を `dig` で裏取り**。

### E-2 — `wasyo-prod` にカスタムドメイン付与＝ライブフリップ

- `wasyo-prod` に **カスタムドメイン `wwwasyo.com` ＋ `www`** を追加。
- **競合の解消**: 既存の externally managed な apex `A` レコードと Custom Domain が競合するため、**apex `A` 4本を削除してから**カスタムドメインを追加。これで apex が **Worker proxied 化＝ライブフリップ**（トラフィックが Pages → Worker へ切替わる瞬間）。
- 検証（`dig` / `curl` ＋ 本人ブラウザ目視）:
  - apex `A` → **Cloudflare エッジ**を指す・レスポンス `server: cloudflare`。
  - 管理ゲート `/reserve/admin/` → **302 → login**（未認証は管理 HTML を返さない＝PR-B のサーバゲートが本番で有効）。
  - **`MX` / `SPF` 無傷**（メール配送に影響なし）。
  - 本人ブラウザで公開ページ・予約フォームの表示 OK。

## ロールバック（E 実施中の退避手順・Pages 生存が前提）

- **Cloudflare DNS で戻すだけ**（レジストラ操作不要・即時）:
  - apex `A` を GitHub Pages の 4 IP（`185.199.108.153` / `.109.153` / `.110.153` / `.111.153`）に、`www CNAME` を `shima-v.github.io` に、**いずれも DNS-only（グレー雲）**で復元。
- 成立条件: **Pages は Phase F まで生存**させておくこと。撤去（F）を先に走らせるとこの退避が効かなくなる＝F を分離して後回しにする理由。

---

## 残（Phase F・本ログ範囲外・不可逆）

- **GitHub Pages 撤去 → git リポの private 化**。
  - **順序厳守**: **Pages が稼働中のまま private 化すると Pages が止まり本番が落ちる**（private リポの Pages は停止するため）。必ず **Pages 撤去 → その後 private 化**。不可逆。
  - **数日の安定運用を見届けてから**日程を握る（**7/15 予定**）。ロールバックの退避先を失う工程なので、Cloudflare 側の安定確認が前提。
- **掃除**: Phase D で投入したテスト予約は**本人対応済**（prod にテストデータを残さない）。

---

## コミット（未 push・develop）

push はしない（`develop` の ahead はクロコが後でまとめて push）。
- （本コミット）`docs(log): Cloudflare 統一移行の Phase A〜E 完走を記録`
