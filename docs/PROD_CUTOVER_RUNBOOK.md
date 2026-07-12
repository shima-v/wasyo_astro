# 本番切替ランブック（Cloudflare 統一移行 ＋ develop→main 丸ごと昇格）

現行 prod（GitHub Pages 静的）を **Cloudflare Worker `wasyo-prod`** へ移し、`develop`（main より 66 コミット先行・P2 大改修＋代理予約/監査ログ等）を**丸ごと本番反映**するための実行手順。**可逆な準備 → 不可逆な切替**の順に並べ、各ステップに【担当】【可逆性】【確認】【ロールバック】を付す。

- 位置づけ: [OWNER_HANDOFF_CLOUDFLARE.md](OWNER_HANDOFF_CLOUDFLARE.md)（本人操作チェックリスト）と [MIGRATION_CLOUDFLARE.md](MIGRATION_CLOUDFLARE.md)（設計）を、**env 登録・GAS prod・deploy.yml 撤去・昇格の順序**まで一本化した実行版。env の全数は [log/2026-07-11-prod-migration-env-audit.md](log/2026-07-11-prod-migration-env-audit.md)。
- 制約（厳守）: **キー名のみ・秘密の実値/PII は書かない**／不可逆操作は必ず本人 GO／clasp は `gas/` 内で実行し prod は `.clasp.prod.json` 経由・`clasp deploy --deploymentId <既存 versioned>`（bare deploy 禁）／`constEq_` 等セキュリティ土台は無改変／外部コンテンツ起点の送信・変更・push は本人確認。

最終更新: 2026-07-11

---

## この移行で判明した「順序を縛る」決定事実

1. **バッチは Worker 必須**: `astro.config.mjs`（develop）は `@astrojs/cloudflare` で `dist/client`(静的)＋`dist/server`(Worker) を出力。管理系は `prerender=false`＝**オンデマンド Worker が要る**。
2. **今の Pages ではバッチを出せない**: `deploy.yml`（develop）は旧 Pages 前提（`upload-pages-artifact path: ./dist`）のまま。ここへバッチを流すと管理系が動かず**現行公開 prod が壊れる**。
   → **バッチの配信路は wasyo-prod(Workers) だけ**。「先に main へマージして Pages に出す」は禁止。
3. **現行 prod に Worker 秘密は 1 つも無い**（Pages 静的だった）。→ **Worker ランタイム secret は全数 prod 新規**。
4. `wrangler.toml` は `[env.production]` name=`wasyo-prod`・route `wwwasyo.com/*` を保持するが、**`@astrojs/cloudflare` 13.7.0 はこの named 環境をビルドで読まない**（実測 2026-07-11）。→ prod デプロイは **`npx wrangler deploy --name wasyo-prod`** で名前上書き・ルートは**ダッシュボードのカスタムドメイン**で付ける（Phase B の「⚙️」参照）。

**したがって基本戦略**: `deploy.yml` を先に撤去 → `develop→main` を昇格（**Pages デプロイは発火しない＝現行 Pages は最後のデプロイ内容で凍結生存＝安全網**）→ wasyo-prod を **main 連携**で立て workers.dev で完全検証 → GAS を prod へ → DNS 切替 → Pages 撤去・private 化。

---

## 全体パイプライン（可逆 → 不可逆・▲ゲート）

```
[可逆・公開影響ゼロ]                                   [不可逆に近い]        [不可逆・順序厳守]
 A. deploy.yml撤去→main昇格 ─┐
 B. wasyo-prod構築+secret/var ┤─▲D. workers.dev 本番相当E2E ──→ E. DNS2段階切替 ──→ F. Pages撤去→private化
 C. GAS prod 切替+Property   ─┘   （GO/NO-GO ゲート）        （B-1無停止/B-2即戻し可）  （F-1→F-2 厳守）
```

- **A/B/C は公開 prod に触れない**（wasyo-prod は workers.dev、Pages は旧内容で凍結生存、GAS は後方互換前提）。
- **D が GO/NO-GO ゲート**。ここを通るまで DNS(E) に進まない。
- **E-1(NS移行)は無停止・E-2(レコード切替)は Cloudflare 内で即ロールバック可**。
- **F(撤去)は不可逆・順序厳守**（F-1 Pages 無効化 → F-2 private 化）。

---

## Phase 0 — 事前確認（本人がコンソールで・作話しない材料集め）

コードからは読めない環境状態。**登録前に現状を把握**して差分だけ埋める。

- [ ] **0-1** prod GAS（`.clasp.prod.json` の scriptId）の **現在の Script Properties 実体**を GAS ダッシュボードで確認（dev から自動コピーされない）。
- [ ] **0-2** `wasyo-prod` Worker が未作成であること（これから作る）。
- [ ] **0-3** LINE の設定方針（本人確定 2026-07-11・下記「env 登録チェックリスト」に反映済み）を LINE Developers 側と突き合わせ。
- [ ] **0-4** 有効化する optional 機能（**全部 ON**：LINE Login / LIFF / Discord 通知 / 休業日カレンダー / メール差出人）の prod 用リソース（チャネル・LIFF アプリ・Webhook・カレンダーID・送信エイリアス）を用意。

---

## Phase A — `deploy.yml` 撤去 → `develop→main` 昇格（可逆・公開影響ゼロ）

> ねらい: これ以降 `main` push で**壊れた Pages デプロイを発火させない**。撤去後は現行 Pages が最後のデプロイ内容で**凍結生存**＝移行中の安全網。

- [ ] **A-1** 【CTO】`develop` で **`.github/workflows/deploy.yml` を削除**するコミット（Pages/Actions 経路を撤去。デプロイ通知は Phase B-4 の Cloudflare 側へ載せ替えるため不要）。
  - 可逆: git revert 可。確認: `git ls-tree develop .github/workflows/` に無いこと。
- [ ] **A-2** 【クロコ】push 前点検（**PII・secret 実値の混入なし**＝§3/§10）。
- [ ] **A-3** 【本人 GO】`develop→main` マージ＆`main` push。
  - **公開影響ゼロ**: deploy.yml 撤去済み＝Pages デプロイ発火せず。現行公開サイトは旧内容のまま健全。
  - ロールバック: `main` を revert（公開影響が無いので低リスク）。

---

## Phase B — `wasyo-prod` 構築＋secret/var 登録（workers.dev・公開影響ゼロ）

> DNS はまだ Pages 向き。検証は **workers.dev** で行う。

> ⚙️ **ビルド/デプロイ コマンド【ローカル実測で確定 2026-07-11】**
> - ビルド コマンド: `pnpm run build`（`PUBLIC_ENV=production`・`PUBLIC_RESERVE_API` 等の公開値は**コマンドに足さず「ビルド変数」欄**へ＝面B）。
> - デプロイ コマンド: **`npx wrangler deploy --name wasyo-prod`**。
> - ⚠️ **なぜ `--name` が要るか**: `@astrojs/cloudflare` 13.7.0 は **named 環境（`[env.production]`）のビルドに非対応**。ビルドが吐く `dist/server/wrangler.json` は常にトップレベル `name=wasyo-dev` を焼き込み、redirect 設定経由の `npx wrangler deploy` は **`--env production` を付けても無効**（plain と dry-run 出力が完全一致・ルートも付かない）。素のコマンドだと **dev Worker(wasyo-dev) を上書きしかねない**ので `--name wasyo-prod` で明示上書きする。
> - ⚠️ **ルート（`wwwasyo.com`）は `wrangler.toml` では付かない**（アダプタが `[env.production].routes` を読まない）。**B-5 のダッシュボード「カスタムドメイン」**で wasyo-prod に紐付ける。
> - 初回ビルド後、ログで **「wasyo-prod として deploy された」**（wasyo-dev を上書きしていない）ことを確認。

- [ ] **B-1** 【本人】Cloudflare で Worker **`wasyo-prod`** を **Workers Builds・連携ブランチ=`main`** で作成。main はバッチ済み（Phase A で昇格）＝Worker がビルドされる。**ビルド/デプロイ コマンドは上記「⚙️」を厳守**（`[env.production]` はこの配信路では読まれないため名前上書きが要る）。
- [ ] **B-2** 【本人】**ランタイム secret**（下記 面A）を **Settings ›「Variables and Secrets」**に登録。⚠️ **「Build variables」側に入れない**（`import { env }` に届かず 500 `server_unconfigured`＝2026-07-08 dev で踏んだ罠）。
- [ ] **B-3** 【本人】**Build variables**（下記 面B・optional 全 ON）を登録。
- [ ] **B-4** 【本人】デプロイ通知を Cloudflare 側へ：Consumer Worker＋Queue で Event Subscriptions `build.*` → Discord（Queue 無料枠は確認済み）。**実装は済み**＝[`infra/build-notify/`](../infra/build-notify/README.md)（`wasyo-build-notify`／Queue `wasyo-build-events`／Discord `/slack` 転送）。本人 account 側手順（`wrangler login`／`wrangler queues create`／`wrangler deploy -c wrangler.toml`／`wrangler secret put DISCORD_WEBHOOK_URL`／ダッシュボードで Event Subscriptions）は同 README に集約。
> **旧 B-5（`wwwasyo.com` カスタムドメイン紐付け）は Phase E へ移動**（2026-07-12 訂正）。Worker の Custom Domain は **wwwasyo.com が Cloudflare のゾーンである＝NS 移行後**が前提で、Phase B 単体では張れない（dig 実測 2026-07-12: NS はまだ `ns-cloud-*.googledomains.com`＝Google 系）。→ **Phase E-1b** で実施する。
> - 可逆: Phase B はすべて公開 prod 未接触（wasyo-prod は workers.dev のみ・Pages は旧内容で凍結生存）。ロールバック: wasyo-prod を消すだけ。

---

## Phase C — GAS を prod へ（バックエンド切替・半可逆）

> prod GAS の /exec URL は不変（versioned deploy）。旧 Pages(公開) は今も prod GAS を叩くので**後方互換**前提で進める。

- [ ] **C-1** 【CTO/クロコ】push 前点検（PII/secret 混入なし・`constEq_`/配信コア/必須通知/`decide_` 無改変）。
- [ ] **C-2** 【本人 GO】`gas/` 内で prod へ反映（**取り違え防止で対象を切替→終わったら dev に戻す**）:
  ```bash
  cd gas
  cp .clasp.prod.json .clasp.json          # 対象を prod に
  clasp push                               # Code.gs + appsscript.json
  clasp deployments                        # ← prod の versioned deploymentId を確認（実体）
  clasp deploy --deploymentId <上で確認したprodのversioned id>   # /exec URL 維持・bare deploy 禁
  cp .clasp.dev.json .clasp.json           # dev に戻す（誤爆防止・重要）
  ```
  - ⚠️ **prod の versioned deploymentId はリポに無い**（dev の `AKfycbz…` とは別物）。**必ず `clasp deployments` の実体で確認**してから使う。デプロイ数は既存構成を維持（増やさない）。
- [ ] **C-3** 【本人】prod **Script Properties** を登録（下記 面C・②回答反映・**`ENV_LABEL` は入れない**）。
- [ ] **C-4** 【本人】prod script で **`authorize` 関数を1回実行**しスコープ同意（Calendar/Sheets/Mail/外部通信）。未認可だと匿名 API が権限エラー。
- [ ] **C-5** 【クロコ】後方互換スモーク：**旧 Pages(公開) × 新 GAS** で空き取得・予約が壊れていないこと。
  - 半可逆: 問題時は prod GAS を**直前 version へ再 deploy**して戻す（version は保持されている）。

---

## Phase D — workers.dev 本番相当 E2E（GO/NO-GO ゲート・公開影響ゼロ）

wasyo-prod(workers.dev) × prod GAS で**全機能**を通す。ここを通るまで DNS(E) へ進まない。

- [ ] **D-1** 公開ページ（LP・予約フォーム・privacy）の表示・OGP（canonical＝wwwasyo.com）。
- [ ] **D-2** お客様予約フロー（空き取得→仮予約→prod カレンダー「【仮】」＋台帳行→承認で「【確定】」）。
- [ ] **D-3** 管理ログイン：誤トークンで `POST /reserve/admin/api/login` が **401**（＝secret が env に到達＝500 でない）。正トークンで管理表示。
- [ ] **D-4** **代理予約ピッカー**（今回の新機能）：一覧は電話伏字→選択で氏名/電話(実値)注入／LINE 客は電話空＋手入力促し／登録で台帳「**監査ログ**」に `proxyBook:picked` 行（手入力のみ=`proxyBook:manual`）。
- [ ] **D-5** 通知トグル・一斉通知・設定ページ・顧客管理（来店履歴/今日の件数）が prod データで動作。
- [ ] **D-6** optional：LINE Login（redirect 一致）・LIFF 自動入力・Discord 通知・休業日反映・お客様メール（差出人＝登録エイリアス）。
- [ ] **D-7** 必須通知（新規予約→オーナー、確定→お客様）が回帰なし。
  - **GO/NO-GO**: 全項目 green で E へ。1つでも NG なら DNS を切らずに是正。

---

## Phase E — DNS 2段階切替（§6・無停止／即ロールバック可）

- [ ] **E-1（段階①・NS 移行・無停止）** Cloudflare にゾーン `wwwasyo.com` を作成し、**まず現行と同じレコード**（A=`185.199.108-111.153`／`www`→`shima-v.github.io`）を登録 → レジストラ側で NS を Cloudflare の割当 NS へ変更。`dig NS/A` で伝播確認。**配信先は GitHub Pages のまま＝無停止**。
- [ ] **E-1b（旧 B-5・カスタムドメイン紐付け）** NS が Cloudflare で有効化されたら、`wasyo-prod` → Settings → Domains & Routes で **`wwwasyo.com`（＋`www`）を Custom Domain 追加**＋**証明書発行**まで完了。⚠️ Custom Domain 追加は当該ホストの proxied DNS レコードを作る＝**実質 E-2 の切替と同義**なので、**Phase D が GO 済み・本番トラフィックを移す覚悟ができてから**行う（先に workers.dev で全機能を確認しておく）。
- [ ] **E-2（段階②・レコード切替・即反映）** Cloudflare 上で A/CNAME を **wasyo-prod のカスタムドメイン**へ変更（NS は既に Cloudflare＝即時）。`dig`（複数リゾルバ）＋ブラウザで公開ページ・予約フォーム・管理を確認。
  - **ロールバック**: 異常時は Cloudflare 上でレコードを段階①の Pages 向け値（控えた A/CNAME）へ戻すだけで即復旧（NS は戻さない）。**Pages は E-2 後も並走期間は撤去しない**。

---

## Phase F — 撤去・private 化（不可逆・順序厳守・Cloudflare の安定を見届けてから）

- [ ] **F-1** GitHub **Pages を無効化**（リポの Pages 設定 OFF）。`deploy.yml` は Phase A で撤去済み。
- [ ] **F-2** `gh repo edit shima-v/wasyo_astro --visibility private`。**必ず F-1 の後**（Pages 稼働中に private 化すると prod が止まる）。
  - 不可逆: private 化・Pages 撤去。**F-1 → F-2 の順を絶対に守る**。

---

## env 登録チェックリスト（本人回答 2026-07-11 反映・キー名のみ）

> 値の実体はコンソールで直接入力。**リポ/文書に実値を書かない**。全数の根拠は env 監査ドキュメント参照。

### 面A: `wasyo-prod` ランタイム secret（Variables and Secrets）
| キー | 要否 | 値の方針 |
|---|---|---|
| `SESSION_SECRET` | **必須** | 新規・強ランダム・dev と別 |
| `ADMIN_TOKEN` | **必須** | 新規・強ランダム・**GAS `ADMIN_TOKENS` の1つと一致** |
| `RESERVE_API` | **必須** | prod GAS の `/exec` URL |
| `ADMIN_PIN` | 任意 | 使うなら新規 |
| `ALLOWED_ORIGIN` | 任意 | 通常未設定（wwwasyo.com 同一オリジン） |

### 面B: Build variables（`PUBLIC_*`・ビルド時 inline）
| キー | 値の方針 |
|---|---|
| `PUBLIC_RESERVE_API` | **必須**・prod GAS `/exec` |
| `PUBLIC_ENV` | `production`（か未設定） |
| `PUBLIC_SITE_URL` | 未設定推奨（既定＝wwwasyo.com） |
| `PUBLIC_LINE_LOGIN_CHANNEL_ID` | **有効化**・**共有（dev と同値）** |
| `PUBLIC_LINE_LOGIN_REDIRECT` | **有効化**・**prod コールバック URL**（www有無/末尾スラッシュまで LINE コンソールと完全一致・環境固有＝別値） |
| `PUBLIC_LIFF_ID` | **有効化**・prod LIFF アプリ ID（endpoint=wwwasyo.com） |

### 面C: prod GAS Script Properties
**基幹（必須）**: `ADMIN_TOKENS`（Worker と一致・dev と別）／`CALENDAR_ID`（prod カレンダー）／`LEDGER_SHEET_ID`（prod 台帳）／`HMAC_SECRET`（新規・強ランダム・dev と別）／`FRONT_BASE_URL`=`https://wwwasyo.com`

**LINE（本人確定：`LINE_LOGIN_CHANNEL_SECRET` のみ別値・他は共有）**:
| キー | 値の方針 |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | **共有（dev と同値）** |
| `LINE_CHANNEL_SECRET` | **共有（dev と同値）**（Webhook 署名検証・fail-closed） |
| `LINE_OWNER_USER_ID` | **共有（dev と同値）** |
| `LINE_LOGIN_CHANNEL_ID` | **有効化**・**共有（dev と同値）** |
| `LINE_LOGIN_CHANNEL_SECRET` | **有効化**・**別値（prod 用）** ← 本人指定 |

> ⚠️ 軽い整合確認: `LINE_LOGIN_CHANNEL_ID` を共有のまま `LINE_LOGIN_CHANNEL_SECRET` だけ別値にする場合、LINE Developers 側で**同一 Login チャネルのシークレット再発行**か**別チャネル**かを本人が突き合わせる（ID とシークレットは対）。

**optional（全部有効化）**: `OWNER_DISCORD_WEBHOOK_URL`（prod Webhook）／`HOLIDAY_CALENDAR_ID`（prod 休業日カレンダー）／`MAIL_FROM`＋`MAIL_REPLY_TO`（**Gmail「名前を指定して送信」に登録済みのエイリアス**であること）

**入れない/不要**: `ENV_LABEL`（dev のみ `【開発】`。prod に入れると本番通知に【開発】が付く）／`GAS_ADMIN_SECRET`（未配線＝現状不要）／`NOTIFY_CONFIG`・`SLOT_CONFIG` 等アプリ書込系（手動登録不要）／`DEPLOY_*`（Cloudflare 通知へ載せ替えで不要）

---

## 台帳の引き継ぎ・新規/常連判定（移行作業＝不要・コード実体で検証済み 2026-07-11）

本人の懸念「台帳の更新は不要か／登録済み顧客が再予約したとき `key` の違いで新規判定されないか」への結論（`gas/Code.gs` と `origin/main..origin/develop` の実差分で裏取り）:

- **台帳シートの移行・更新作業は不要**。`LEDGER_SHEET_ID` が**既存の稼働 prod シートを指す限りデータは不変**で引き継がれる。GAS の push はコードのみ更新し、Script Property もシート内容も触らない。台帳書き込みは `ledgerUpsert_` 一本で、台帳5関数（`ledgerKey_`/`ledgerLookup_`/`ledgerUpsert_`/`ledgerSheet_`/`normalizePhone_`）は **main↔develop でバイト同一**。
- **既存顧客の再予約が「新規」に誤判定されることはない**。新規/常連は**生キー突合**で決まる：`ledgerKey_`＝`line:<lineUserId>`／`phone:<正規化>`／`email:<小文字>`（`gas/Code.gs:935-940`）、`ledgerLookup_` が台帳 col0 の生値と `===`（`:949-955`）、`isFirst = !ledgerLookup_(ledgerKey)`（`:554`）。
- **`c6a698d`（来店履歴の opaque ハッシュ化）は無害**。`hashKey_`（無鍵の素 SHA-256・`:1050-1058`）は `adminListCustomers_` の**返り値**と `adminListConfirmed_` の**来店履歴突合**の両側を同じ関数に通すだけで、**台帳保存値にも新規/常連判定にも噛まない**（コミット本文「`ledgerUpsert_` 等は1バイト不変」）。無鍵ゆえ環境非依存。`HMAC_SECRET` は URL 署名・監査指紋専用で台帳キーとは無関係。
- **設計本来の特性（回帰ではない）**: 初回と**別の識別子種別**で予約すると別行＝新規扱い（例: 初回 LINE 経由→今回は電話のみ）。これは移行前から同じ挙動で、今回の反映が新たに壊すものではない。
- **本人がコンソールで要確認（コードから読めない）**: ①prod の `LEDGER_SHEET_ID` が既存稼働シートを指すか（新規/空を指していないか）／②`.clasp.prod.json` の scriptId が正しい prod プロジェクトか（push 先取り違えなし）／③push 後も prod の Script Property が消えず残るか（clasp push は Property を消さないが現物確認は本人領域）。

## ロールバック早見

| フェーズ | 異常時の戻し方 | 備考 |
|---|---|---|
| A（main 昇格） | `main` を revert | Pages 未発火＝公開影響なし |
| B（wasyo-prod） | Worker を削除／再設定 | 公開 prod 未接触 |
| C（GAS prod） | prod GAS を直前 version へ再 deploy | version 保持・/exec 不変 |
| E-2（レコード切替） | Cloudflare で Pages 向け A/CNAME へ即戻し | NS は戻さない・Pages 並走中 |
| F（撤去） | **不可逆**（Pages 復活・public 化は手作業） | F-1→F-2 順守で事故を防ぐ |

---

## 担当の割当（窓口はクロコ一本化）

- **本人 GO / 本人操作（不可逆・コンソール）**: A-3 昇格 push／B 全般（Cloudflare）／C-2 clasp push・deploy／C-3 Property 登録／C-4 認可／E DNS／F 撤去・private 化。
- **クロコ**: 采配・push 前点検・実体裏取り（各「完了」報告を現物確認してから本人へ）・進捗図。
- **CTO**: A-1 deploy.yml 撤去コミット・C-1 GAS 点検・技術判断の整理。

## 参照
- env 全数: [log/2026-07-11-prod-migration-env-audit.md](log/2026-07-11-prod-migration-env-audit.md)
- 本人操作の原典: [OWNER_HANDOFF_CLOUDFLARE.md](OWNER_HANDOFF_CLOUDFLARE.md) ／ 設計: [MIGRATION_CLOUDFLARE.md](MIGRATION_CLOUDFLARE.md) ／ 決定: [adr/0002-cloudflare-unify.md](adr/0002-cloudflare-unify.md)
- GAS 反映手順: [../gas/README.md](../gas/README.md)
