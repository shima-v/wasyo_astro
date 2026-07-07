# 本人操作ハンドオフ: 和笑 Cloudflare 統一移行

- 位置づけ: [MIGRATION_CLOUDFLARE.md](MIGRATION_CLOUDFLARE.md) §4/§6 の「本人しかできない操作」を、**実行順のチェックリスト**にしたもの。設計の理由・詳細は MIGRATION 本体を参照。
- ⚠️ **不可逆操作を含む**。各ステップが実際に効くのは **PR-C（本番切替）以降**。今日時点はコード（PR-A 完了）とこの手順書まで。**本番切替はまだ実行しない**。
- 制約: 本書に秘密の実値は書かない（キー名のみ）。

---

## 全体の流れ（どの操作が・どの工程で効くか）

```
[今できる準備]                 [PR-C: 本番切替]                    [PR-D: 撤去]
 A-1 prod Worker作成 ─┐
 A-3 secret登録      ─┤
 A-4 デプロイ通知     ─┼─→ B-1 NS移行(無停止) → B-2 レコード切替 → 並走確認 → C-1 Pages撤去 → C-2 private化
 A-5 workers.dev確認 ─┘        （§6・即ロールバック可）                （§5・順序厳守）
 B-0 NS変更準備 ───────────────────↑
```

- **可逆**: A（準備）は本番に触れない。B-1（NS移行）は配信先を GitHub Pages のまま保つので無停止。B-2（レコード切替）は Cloudflare 内で即ロールバック可。
- **不可逆に近い**: C-2（private 化）は Pages 停止後に行う最終段。順序を絶対に守る。

---

## A. 事前準備（PR-A/B 完了後・本番 DNS 切替の前）

- [ ] **A-1. prod Worker `wasyo-prod` を作成** — Cloudflare ダッシュボードで Git 連携の Workers Builds を設定。main ブランチ連携（dev の `wasyo-dev` と同じ仕組み）。
- [ ] **A-3. prod Worker secret を登録** — `wrangler secret put --env production` かダッシュボードで。キー名: `SESSION_SECRET`（強ランダム）／`ADMIN_TOKEN`（GAS `ADMIN_TOKENS` の1つと一致）／`ADMIN_PIN`（任意）／`RESERVE_API`（prod GAS `/exec`）。**実値はここで直接入れる（リポには書かない）**。※現状 prod には Worker 秘密が存在しない（Pages=静的だったため）→ 新規に必要。
- [ ] **A-4. デプロイ通知の準備** — Discord Webhook URL（末尾 `/slack`）を用意し、Consumer Worker＋Queue を公式テンプレート `cloudflare/templates/workers-builds-notifications-template` でデプロイ。ビルド成功/失敗イベント（`build.*`）が Event Subscriptions 経由で Discord に飛ぶ構成。**Queue 無料枠は確認済み（10,000 オペレーション/日・デプロイ通知の頻度なら十分）**。
- [ ] **A-5. workers.dev で prod Worker を完全動作確認** — 公開ページ・予約フロー・管理サーバゲート（§7）。あわせて Cloudflare でカスタムドメイン設定・**証明書発行まで**完了させておく。

---

## B. DNS 切替（§6・2段階・無停止）

- [ ] **B-1. 段階①（NS 移行・配信先は GitHub Pages のまま＝無停止）**
  - Cloudflare にゾーン `wwwasyo.com` を作成し、**まず現行と同じレコード**を登録（A=`185.199.108-111.153`／`www`→`shima-v.github.io`）。
  - **Google Domains（現 Squarespace）の管理画面**で、ネームサーバを Cloudflare の割当 NS に変更。
  - `dig NS wwwasyo.com` / `dig A wwwasyo.com` で伝播確認。この間、閲覧者から見て**無停止**。
- [ ] **B-2. 段階②（レコード切替・Cloudflare 内で即反映＆即ロールバック可）**
  - Cloudflare 上で A/CNAME を `wasyo-prod` のカスタムドメインへ変更。NS は既に Cloudflare なので即時反映。
  - `dig`（複数リゾルバ）＋ブラウザで公開ページ・予約フォームを確認。

**ロールバック**: 異常時は Cloudflare 上でレコードを段階①の GitHub Pages 向け値（控えた A/CNAME）に戻すだけで即復旧（NS は戻さない）。→ **GitHub Pages は段階②の後も一定期間は撤去しない（並走期間）**。

---

## C. 撤去・private 化（§5・順序厳守・Cloudflare の安定を見届けてから）

- [ ] **C-1. GitHub Pages を撤去** — リポの Pages 設定を無効化。`deploy.yml` の Pages ジョブは削除済みであること。
- [ ] **C-2. private 化** — `gh repo edit shima-v/wasyo_astro --visibility private`。**必ず Pages 撤去（C-1）の後**（Pages 稼働中に private 化すると prod が止まる）。

---

## 補足: 通知の系統（混同しやすいので明記）

| 通知 | 何を | 実装 | 本移行での扱い |
|------|------|------|----------------|
| **デプロイ通知** | ビルド成功/失敗 | 現行=GAS `notifyDeploy_`（deploy.yml 経由）→ 移行後=Cloudflare Event Subscriptions（Workers Builds `build.*` → Queue → Consumer Worker → Discord） | **載せ替える**（A-4） |
| **予約通知** | 予約受付・確定をオーナー/お客様へ | GAS `notifyOwnerNewBooking_` / `notifyCustomer_`（LINE・Discord） | **変更しない**（ドメイン不変で無影響） |

> Event Subscriptions が扱うのは Cloudflare 自社サービスのイベント（Workers Builds 等）。予約のような**アプリ独自イベント**は対象外だが、予約通知はそもそも GAS 側で完結しており本移行の対象外なので問題ない。

---

## 参照
- 全体設計・理由: [MIGRATION_CLOUDFLARE.md](MIGRATION_CLOUDFLARE.md)（§4=本人操作／§6=DNS 2段階／§7=動作確認／§8=PR 分割）
- 意思決定: [adr/0002-cloudflare-unify.md](adr/0002-cloudflare-unify.md)
- Queue 無料枠の実測根拠: researcher 調査 2026-07-07（Cloudflare 公式 Queues Pricing/Limits・Free plan changelog）
