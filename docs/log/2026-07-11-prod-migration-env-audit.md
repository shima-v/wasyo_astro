# 本番反映 env/secret/Script Property 悉皆監査（Cloudflare 統一移行 + develop→main 昇格）

- 目的: prod（`wasyo-prod` フロント + prod GAS）で「新たに登録・設定しないと動かない／古いままだと壊れる」環境変数・シークレット・Script Property を、面ごとに漏れなく列挙する。
- 根拠: すべて **コードの実参照を grep で採取**（記憶・docs の記述は補助）。関連: `docs/OWNER_HANDOFF_CLOUDFLARE.md` / `docs/MIGRATION_CLOUDFLARE.md` / `docs/adr/0002-cloudflare-unify.md` / `gas/README.md`。
- 制約: **キー名のみ**。秘密の実値・トークン・PII は一切書かない。読み取り専用調査（prod/dev/DNS/コードは不変更）。
- 採取コミット時点: `origin/main`（現行 prod = GitHub Pages 静的）↔ `origin/develop`（昇格対象・main より 66 コミット先行）。

> ⚠️ 最重要の構造的事実: **`origin/main` には Worker ランタイムのサーバコード自体が存在しない**（`src/worker/routes/action.js` は develop で新規。main の env 参照はビルド時 `PUBLIC_*` のみ）。prod は「GitHub Pages 静的配信」で **Cloudflare Worker の秘密が 1 つも無い**状態。→ **面①のランタイム secret は全数が prod 新規**。

---

## サマリ（面ごとの件数）

| 面 | 件数 | prod で新規に要る | 移行後に不要化 |
|----|------|------------------|----------------|
| ① Worker ランタイム secret（`wasyo-prod`・Variables and Secrets） | 5（必須3・任意2） | **5 すべて**（main に Worker 無し） | – |
| ② ビルド時 public 変数（Workers Builds の Build variables） | 6 | 値の載せ替え（GitHub→Cloudflare） | – |
| ③ wrangler.toml で prod に足す binding（KV/Queue/DO 等） | **0** | なし（設計で依存を断つ） | – |
| ④ GAS prod Script Property | 必須7・任意多数・**NEW 3**・アプリ書込5 | 下記④参照 | DEPLOY_* 系 |
| ⑤ GitHub リポシークレット | 6 | – | **6 すべて**（Pages/Actions 廃止で） |

- **NEW（66 コミットで初めて参照が増えた／prod に初めて要る）キーの要点は末尾「NEW ハイライト」節に集約**。

---

## ① Cloudflare Worker ランタイム secret（`wasyo-prod`）

登録先: Cloudflare ダッシュボード Settings ›「**Variables and Secrets**（ランタイム）」または `wrangler secret put --env production`。
⚠️ **「Build variables and secrets」（CIビルド用）に入れると `import { env } from 'cloudflare:workers'` に届かず `server_unconfigured`(500)**（2026-07-08 dev で実際に踏んだ罠・OWNER_HANDOFF A-3）。
採取元: `src/worker/routes/login.js` / `action.js` / `src/middleware.js` / `src/worker/guard.js`。

| キー名 | 用途 | 設定場所 | prod でのアクション | 未設定時の症状 |
|--------|------|----------|--------------------|----------------|
| `SESSION_SECRET` | 管理セッション Cookie の HMAC 署名鍵（login 発行・action/middleware 検証） | Variables and Secrets（ランタイム） | **新規登録・強ランダム・dev と別値** | login/middleware が `server_unconfigured`(500)＝管理に一切ログイン不可 |
| `ADMIN_TOKEN` | Worker が保持する管理トークン。GAS `ADMIN_TOKENS` の1つと一致必須（ブラウザには渡さない） | 同上 | **新規登録・dev と別値推奨・強ランダム** | login/action が 500（トークン欠落）。GAS 側と不一致なら 401 |
| `RESERVE_API` | 管理系転送先＝prod GAS の `/exec` URL。`action.js` は `env.RESERVE_API || env.PUBLIC_RESERVE_API` | 同上 | **新規登録・prod GAS の /exec 値** | action が 500（`server_unconfigured`）＝管理操作すべて不能（PUBLIC_RESERVE_API も無い場合） |
| `ADMIN_PIN` | 任意の追加 PIN。設定すると login で必須化・未設定ならトークンのみ | 同上（任意） | 任意（使うなら新規・dev と別値） | 未設定でも正常（PIN 無効）。設定時に空だと 500 相当の設定ミス |
| `ALLOWED_ORIGIN` | オリジン許可リスト（カンマ区切り）。`guard.js`。未設定なら「同一オリジンのみ許可」 | 同上（任意） | 通常は未設定で可（wwwasyo.com 同一オリジン運用） | 未設定でも正常。誤設定すると管理 API が全 403 |

---

## ② ビルド時 public 変数（`PUBLIC_*`・Workers Builds の Build variables）

ビルド時に静的 HTML/クライアント JS に **inline** される値（ランタイム secret とは別枠。ここは build 側が正しい）。
現行 prod は GitHub Actions `deploy.yml` の `env` で注入していた → 移行後は **Cloudflare Workers Builds の Build variables** に載せ替える。
採取元: `src/data/config.js` / `astro.config.mjs`（+ クライアント fetch `src/pages/reserve/index.astro`・`admin/reservations.astro`）。

| キー名 | 用途 | 設定場所 | prod でのアクション | 未設定時の症状 |
|--------|------|----------|--------------------|----------------|
| `PUBLIC_RESERVE_API` | フロント（クライアント fetch）と action フォールバックが使う GAS `/exec` URL | Workers Builds Build variables | **新規登録・prod GAS 値** | 予約フォーム・管理フロントの fetch 先が空＝予約/管理が動かない |
| `PUBLIC_ENV` | 環境ラベル分岐 `IS_DEV = (=== 'development')`。dev バッジ/【開発】/タブ表示 | 同上 | **`production`（または未設定）**＝ dev と値が違う | prod に `development` を入れると本番に【開発】バッジ/ラベルが出る |
| `PUBLIC_SITE_URL` | `site`（canonical/OGP）。既定 `https://wwwasyo.com` | 同上 | **未設定推奨**（既定で prod URL）。dev のみ workers.dev を設定 | prod は未設定で正常。dev の workers.dev 値を prod に残すと canonical が壊れる |
| `PUBLIC_LINE_LOGIN_CHANNEL_ID` | LINE Login 有効化（任意・両方揃うと有効） | 同上（任意） | 使うなら新規（prod チャネル） | 未設定なら LINE 連携ボタン非表示（正常） |
| `PUBLIC_LINE_LOGIN_REDIRECT` | LINE Login コールバック URL（LINE コンソールと完全一致） | 同上（任意） | 使うなら新規・**www有無/末尾スラッシュまで一致** | 不一致だと LINE Login が redirect_uri エラー |
| `PUBLIC_LIFF_ID` | LIFF アプリ内予約（任意） | 同上（任意） | 使うなら新規（prod LIFF） | 未設定なら LIFF 自動入力なし（正常） |

> dev の `wasyo-dev` は既にこれらを Build variables に持つ（dev が動作している＝設定済み）。**prod 用は改めて登録が要る**（dev の設定は prod に引き継がれない）。dev の実設定値は Cloudflare コンソールでしか確認できない＝**コードからは不明**。

---

## ③ wrangler.toml で prod に足す binding（KV / Queue / Durable Object 等）

結論: **wasyo-prod 本体に追加すべき binding は無し（0）**。

- `wrangler.toml` の `[env.production]` は現在 `name` + `routes` のみ。`[vars]`/secret/binding の宣言なし（secret は toml に書かず①の手順で登録）。
- 生成物 `dist/server/wrangler.json` の binding は **すべて空**（実測）: `kv_namespaces:[]` / `queues:{producers:[],consumers:[]}` / `durable_objects:{bindings:[]}` / `d1_databases:[]` / `r2_buckets:[]` / `services:[]` / `vars:{}`。
- 依存を断っている設計（`astro.config.mjs`）: セッション = `sessionDrivers.memory()` で **SESSION KV を不要化**／`imageService:'passthrough'` で **IMAGES バインディング不要化**。レート制限は isolate 内メモリのベストエフォート＝binding 不要。
- **Queue は wasyo-prod 用ではない**: OWNER_HANDOFF A-4 の Queue は「デプロイ通知の別 Consumer Worker」用（`cloudflare/templates/workers-builds-notifications-template`）。wasyo-prod のランタイムには無関係。
- `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` も不要（MIGRATION §2 明記・Workers Builds は Git 連携で完結）。

---

## ④ GAS prod Script Property

prod script（`1lpqka7tIvSe3W7f3ZeoE207kF3AOx5LDk0Lw9qbDLzezHNwJc_QwtDdz`）へ push+deploy 後、**prod の Script Properties** に登録する。
採取元: `gas/Code.gs` の `prop_('KEY')` 全呼び出し（helper: 63行 `prop_`）。dev/prod で値を別にする（README §管理トークン）。

### ④-a 必須（オーナーが prod に登録・未設定だと基幹機能が壊れる）

| キー名 | 用途 | prod でのアクション | 未設定時の症状 |
|--------|------|--------------------|----------------|
| `ADMIN_TOKENS` | 管理 bearer（カンマ区切り）。Worker `ADMIN_TOKEN` と照合（`requireAdminToken_`） | **新規・dev と別値・強ランダム・Worker と一致** | 管理操作すべて `forbidden` |
| `CALENDAR_ID` | prod 予約カレンダー | **新規・dev と別（別カレンダー）** | 空き取得/予約作成/承認が失敗 |
| `LEDGER_SHEET_ID` | prod 顧客台帳シート | **新規・dev と別** | 台帳/顧客管理/監査が no-op |
| `HMAC_SECRET` | decision/message リンク署名鍵（`verifySig_`） | **新規・強ランダム・dev と別** | 承認/辞退・顧客メッセージのリンクが検証不可 |
| `FRONT_BASE_URL` | 通知に載せるフロント基底（`/reserve/decision` 等） | **`https://wwwasyo.com`**＝dev と別値 | 店通知の承認/辞退リンクが壊れる |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging push（店/客通知） | prod 用（LINE が dev/prod 共有なら同値のことも＝要確認） | LINE 通知が全て不達 |
| `LINE_OWNER_USER_ID` | オーナー通知先（`U…`/グループ `C…`） | prod 用 | オーナーへの新規予約/枠警告通知が届かない |

### ④-b 任意・条件付き（機能を使うときだけ）

| キー名 | 用途 | prod での扱い |
|--------|------|--------------|
| `ENV_LABEL` | 通知/件名の環境ラベル | **dev のみ `【開発】`。prod はキー自体を登録しない**（GAS は空文字保存不可＝未登録＝ラベル無し）。prod に登録すると本番通知に【開発】が付く |
| `PUBLIC_EXEC_URL` | `diag()` ログ用の①/exec 固定 | 任意 |
| `LINE_LOGIN_CHANNEL_ID` / `LINE_LOGIN_CHANNEL_SECRET` | LINE Login（サーバ側） | 任意（②の PUBLIC_LINE_LOGIN_* と対） |
| `MAIL_FROM` / `MAIL_REPLY_TO` | 客メール差出人/返信先 | 任意（要 Gmail「名前を指定して送信」登録・未登録だと fallback） |
| `OWNER_DISCORD_WEBHOOK_URL` | オーナー通知を Discord に | 任意（未設定なら LINE に落ちる） |
| `HOLIDAY_CALENDAR_ID` | 休業日カレンダー | 任意 |
| `MONTHLY_FREE_QUOTA` / `REGULAR_MIN_VISITS` | 枠上限/常連判定の閾値 | 任意（未設定＝既定） |
| `DEPLOY_DISCORD_WEBHOOK_URL` / `DEPLOY_MAIL_TO` / `DEPLOY_NOTIFY_TOKEN` | GAS `deployNotify` のデプロイ通知 | **移行後は不要化**（デプロイ通知は Cloudflare Event Subscriptions に載せ替え＝MIGRATION §2） |

### ④-c NEW（develop で新規参照・prod script に初めて要る／挙動注意）

| キー名 | 用途 | prod での扱い | 未設定時の症状 |
|--------|------|--------------|----------------|
| `LINE_CHANNEL_SECRET` **NEW** | LINE Webhook 署名検証（`handleLineWebhook_`・**fail-closed**） | LINE Webhook（グループID捕捉等）を使うなら **新規登録** | 未設定なら webhook は `skipped:'unverified'` で無処理（予約本体は無影響・グループ捕捉は動かない） |
| `GAS_ADMIN_SECRET` **NEW** | Worker 共有秘密の検証（`requireWorkerSecret_`） | **現状は不要**（定義のみ・呼び出し 0 件＝未配線の将来足場 P4/P5） | 未設定でも現状無害。将来配線時に必要 |
| `NOTIFY_CONFIG` **NEW** | 通知種別 ON/OFF トグルのストア | **オーナー手動設定 不要**（管理設定ページから `setProperty` で書かれるアプリ状態） | 未設定＝既定（全通知 ON） |

### ④-d アプリが書き込む状態値（オーナー設定 不要・移行時アクション無し）

`SLOT_CONFIG`（枠設定・管理から保存）／`NOTIFY_CONFIG`（上記）／`LINE_LAST_SOURCE`／`QUOTA_WARNED_YYYYMM`／`OWNER_DISCORD_RETRY_QUEUE`。いずれも `setProperty` でアプリが生成する。prod で手動登録は不要。

---

## ⑤ GitHub リポシークレット

採取元: `.github/workflows/deploy.yml`。**移行後（Pages 撤去・Actions 廃止）に全て不要化**する系統。

| キー名 | 用途（現行） | 移行後のアクション |
|--------|-------------|-------------------|
| `PROD_RESERVE_API` | Pages build の `PUBLIC_RESERVE_API` 注入 | **値を Cloudflare Build variables へ載せ替え**。deploy.yml 削除で GitHub secret は不要 |
| `PROD_LINE_LOGIN_CHANNEL_ID` | 同（`PUBLIC_LINE_LOGIN_CHANNEL_ID`） | 同上（使う場合のみ） |
| `PROD_LINE_LOGIN_REDIRECT` | 同（`PUBLIC_LINE_LOGIN_REDIRECT`） | 同上（使う場合のみ） |
| `PROD_LIFF_ID` | 同（`PUBLIC_LIFF_ID`） | 同上（使う場合のみ） |
| `GAS_DEPLOY_ENDPOINT` | notify job → GAS `deployNotify` | **不要化**（Event Subscriptions へ・MIGRATION §2） |
| `DEPLOY_NOTIFY_TOKEN` | notify job のトークン（GAS `DEPLOY_NOTIFY_TOKEN` と一致） | **不要化**（同上） |

> `deploy.yml` は現在 develop にも存在（GitHub Pages ワークフロー）。OWNER_HANDOFF C-1 は「deploy.yml の Pages ジョブは削除済みであること」を前提とする＝**Pages 撤去（C-1）の前に deploy.yml を削除する作業が別途要る**（本監査の範囲外・要別タスク）。

---

## NEW ハイライト（今回の昇格で prod に初めて要る／障害に直結するキー）

「1個抜けると本番障害」の観点で、**prod に新規登録が要る**ものを危険度順に:

1. **面①の Worker ランタイム secret 全数（prod に Worker が初めて載る）**
   - `SESSION_SECRET`（無→管理ログイン 500）／`ADMIN_TOKEN`（無→login/action 500・GAS と要一致）／`RESERVE_API`（無→管理操作 500）＝**必須3**。`ADMIN_PIN`・`ALLOWED_ORIGIN` は任意。
   - コード根拠: `origin/main` に `src/worker/routes/action.js` 自体が無く、`env.SESSION_SECRET`/`ADMIN_TOKEN`/`ADMIN_PIN`/`RESERVE_API`/`ALLOWED_ORIGIN` は **develop で新規**（`git` の env 参照 set 差分で確認）。
2. **面②ビルド時 `PUBLIC_RESERVE_API`（Build variable）** — 無いと予約フォーム/管理フロントの fetch 先が空＝予約不可。GitHub secret から Cloudflare Build var への「載せ替え漏れ」に注意。
3. **面④ GAS の基幹7キー**（`ADMIN_TOKENS`/`CALENDAR_ID`/`LEDGER_SHEET_ID`/`HMAC_SECRET`/`FRONT_BASE_URL`/`LINE_CHANNEL_ACCESS_TOKEN`/`LINE_OWNER_USER_ID`）— prod script は別プロジェクト＝**dev の値は入っていない前提で新規登録**。
4. **面④ NEW 3キー**（`LINE_CHANNEL_SECRET`＝Webhook 使うなら要／`GAS_ADMIN_SECRET`＝未配線で現状不要／`NOTIFY_CONFIG`＝アプリ書込で手動不要）。
   - コード根拠: `origin/main` ↔ `origin/develop` の `prop_('KEY')` set 差分＝新規は `GAS_ADMIN_SECRET`・`LINE_CHANNEL_SECRET`・`NOTIFY_CONFIG` の3件のみ（削除は0）。

### dev と prod で値を変えるべきキー

- **prod では登録しない**: `ENV_LABEL`（dev のみ `【開発】`）。
- **値が違う（環境固有リソース/URL）**: `PUBLIC_ENV`（dev=development / prod=production か未設定）・`PUBLIC_SITE_URL`（dev=workers.dev / prod=未設定=wwwasyo.com）・`FRONT_BASE_URL`・`RESERVE_API`・`PUBLIC_RESERVE_API`・`CALENDAR_ID`・`LEDGER_SHEET_ID`。
- **別の強ランダムにすべき秘密**: `SESSION_SECRET`・`ADMIN_TOKEN`↔`ADMIN_TOKENS`（Worker↔GAS で一致・dev/prod 間では別）・`HMAC_SECRET`・`GAS_ADMIN_SECRET`・`ADMIN_PIN`。
- **dev/prod 共有の可能性（要本人確認）**: `LINE_CHANNEL_ACCESS_TOKEN`/`LINE_CHANNEL_SECRET`/`LINE_OWNER_USER_ID`（LINE Messaging API が dev/prod 共有チャネルなら同値。だからこそ `ENV_LABEL` で通知の見分けをする設計）。

---

## コードからは読めない＝本人が Cloudflare/GAS コンソールで要確認（作話しない）

- `wasyo-prod` Worker はまだ未作成（OWNER_HANDOFF A-1）＝現状 prod 側の Worker secret/build var は **ゼロ**。上表は「これから入れる」対象。
- `wasyo-dev` の Build variables / runtime secrets の**実際の設定値**（dev が動く＝設定済みだが値は不明）。
- prod GAS script（`1lpqka…`）に**現在入っている Script Property の実体**（clasp では読めない・GAS ダッシュボードでのみ確認）。dev から prod へ property は自動コピーされない。
- LINE チャネルが dev/prod **共有か別か**の実体（共有なら Access Token 等は同値でよい）。
- 各 optional 機能（LINE Login / LIFF / Discord / Holiday カレンダー / メール差出人）を **prod で有効化するか**の運用判断。
- `deploy.yml` の削除タイミング（C-1 前提だが未実施＝別タスク）。
