# 開発メモ・既知のハマりどころ（備忘録）

サロン和笑〜Violane〜 予約システム開発で実際に踏んだ落とし穴と対策の記録。
同種の事故を繰り返さないために、原因が非自明だったものをここに蓄積する。

- 設計: [`RESERVATION_PLAN.md`](./RESERVATION_PLAN.md) ／ 進捗: [`WBS.md`](./WBS.md) ／ GAS: [`../gas/README.md`](../gas/README.md)

---

## 保守の約束（改修時に守ること）

- 管理画面の機能を改修したら、店主向けマニュアル（[`../src/pages/reserve/admin/manual.astro`](../src/pages/reserve/admin/manual.astro)）の該当節と更新履歴（frontmatter の `lastUpdated` 定数＋「6. 運用サポート」の更新履歴リスト）も更新する。

---

## 2026-06-17 — 仮予約が「作成直後に勝手に消える」／承認リンクが not_found

### 症状
- フロント・curl どちらから `createBooking` しても `ok:true`＋token が返るのに、
  **数十秒後にはカレンダーからイベントが消え**、`?action=booking&token=...` が `not_found` になる。
- 店LINEの承認リンクをクリックすると `エラー: not_found`。
- ある予約では、作成直後の GET で一瞬 `status:"confirmed"` を返し、その後消滅、という挙動も観測。
- 空き枠（availability）でも、消滅後はその枠が**空きに戻る**（＝実際に削除されている）。

### 切り分け（重要・ここが学び）
1. `diagCal()`（GASエディタ実行＝オーナー権限）で作成→検索→削除は**同一実行内では正常**。
2. `diagTriggers()` で計測：
   - **プロジェクトの時間トリガーは 0 件**（自動クリーンアップ処理は存在しない）。
   - **エディタで作ったイベントは 75 秒後も生存（ALIVE / FOUND）**。
3. デプロイ経由（`createBooking`）で作ったイベントだけが**作成 ~40 秒後に消滅**（複数回再現）。
4. エディタ作成（生存）とデプロイ作成（消滅）の**唯一の差は「LINE通知を送っているか否か」**。

→ カレンダー層（getEvents/getTag/createEvent）は正常。犯人は通知側にある、と特定できた。

### 真因
**LINE のリンクプレビュー（OGP取得）用クローラが、店通知メッセージ内の
承認/辞退リンク（GET・有効なHMAC署名つき URL）を自動で取得（先読み）し、
`?action=decline` を実行 → `deleteEvent` していた。**

- 承認リンクも先読みされるため「一瞬 `confirmed` 化 → 直後に辞退で削除」という順序も起きる。
- ユーザーがクリックした時点では**すでにクローラが辞退・削除済み**なので `not_found`。
- これは「**GET なのに副作用（状態変更）がある**」という設計上の問題。メール・チャット・
  LINE・Slack・アンチウイルス・企業プロキシなどは**リンクを勝手に先読みする**のが普通。

### 対策（実装済み）
- **GET は状態変更しない**。承認(`?action=approve`)/辞退(`?action=decline`)は
  署名検証のうえ**確認ページ（HTML）を表示するだけ**にした（`renderDecisionPage_`）。
- 実際の確定/辞退は**ボタン押下 → `google.script.run.decideBySig(token, sig, approve)`**
  で実行（クローラはJSのクリックを実行しないため誤発火しない）。
- 店通知は **confirm テンプレートのボタン（✅承認する / ❌辞退する）** で送る
  （長いURLを本文に直接置かない＝先読み対象を減らす・UIも明快）。
- リンク基底は `ScriptApp.getService().getUrl()`（複数デプロイ環境で別デプロイの
  URLを返し不安定）をやめ、Script Property **`PUBLIC_EXEC_URL`（環境別）** に固定。

### 検証
- 再デプロイ後、`createBooking` したイベントは **60 秒経っても生存**。
- 承認URLを（不正・正当問わず）GET しても **`status` は `pending` のまま**＝状態不変。

### 一般教訓
- **通知・共有するURLは「第三者に勝手にGETされる」前提で設計する。**
  状態を変える操作（承認・辞退・削除・購読解除など）は**絶対にGET単独で完了させない**。
  確認ページ＋ボタン（POST / `google.script.run` 相当）に分離する。冪等性を守る。
- 「作成したはずのリソースが少し経つと消える」系は、トリガーや外部同期だけでなく
  **通知に載せたリンクの先読み**も疑う。
- 複数デプロイがある GAS で `ScriptApp.getService().getUrl()` は当てにしない。
  公開する `/exec` は Script Property に固定する。

参考実装: [`../gas/Code.gs`](../gas/Code.gs)（`renderDecisionPage_` / `decideBySig` / `notifyOwnerNewBooking_` / `publicExecUrl_`）

---

## 2026-06-17 — 管理画面が「このGoogleアカウントには管理権限がありません」になる

### 症状
- `ADMIN_EMAILS` に自分のメール（例: `…@gmail.com`）を登録済みなのに、管理画面(`?action=admin`)で
  **「このGoogleアカウントには管理権限がありません（ADMIN_EMAILS を確認）。」** と出て操作できない。
- 管理ページ自体は開ける（HTMLは表示される）が、`google.script.run.adminApi*` が `forbidden` を返す。

### 真因
- 管理判定 `requireAdmin_` は `Session.getActiveUser().getEmail()` を `ADMIN_EMAILS` と照合している。
- 開いていたデプロイが **`executeAs: USER_DEPLOYING`（＝オーナー実行）** で、**オーナー(`…@wwwasyo.com`)と
  閲覧者(`…@gmail.com`)のドメインが異なる**と、Google のプライバシー仕様で
  **`getActiveUser().getEmail()` が空文字を返す** → 照合は必ず失敗。ADMIN_EMAILS の中身は無関係。
- そもそも「管理専用デプロイ（実行ユーザー＝アクセスしているユーザー）」が未作成で、全デプロイが
  マニフェスト既定の `USER_DEPLOYING` を継承していた。

### 対策
- 管理画面は **必ず別デプロイで「実行ユーザー: ウェブアプリにアクセスしているユーザー」** にする
  （こうすると `getActiveUser()` がアクセス中の管理者本人を確実に返す）。
- アクセス範囲は用途で選ぶ（オーナーのみ=「自分のみ」／組織内=「サロン和笑 内の全員」／外部gmail可=「Googleアカウントを持つ全員」）。
  いずれも実ガードは `ADMIN_EMAILS`。**「全員（匿名）」は不可**（ログイン必須でないと email が空）。
- `getEffectiveUser()` を判定に使ってはいけない：公開デプロイ(オーナー実行)で `?action=admin` を開かれると
  effective=オーナー=ADMIN_EMAILS該当となり、**誰でも管理者になれてしまう**。判定は必ず `getActiveUser()`。
- 設定手順・運用パターン（オーナー1人／gmail／組織内複数）と費用は
  [`../gas/README.md`](../gas/README.md)「管理者ユーザーの登録・管理」に集約。

### 一般教訓
- `Session.getActiveUser().getEmail()` は **「オーナー実行 × 別ドメイン閲覧者」だと空**になる。
  Web アプリでログインユーザーを識別したいなら **「アクセスしているユーザーとして実行」** にする。
- 「ページは開けるのに API だけ権限エラー」は、ページ表示の可否（access設定）と
  実行ユーザー識別（executeAs）が**別物**であることを思い出す。

参考実装: [`../gas/Code.gs`](../gas/Code.gs)（`requireAdmin_`）。

---

## 2026-06-17 — Astro `<title>` に「式＋生テキスト」を混在させると描画が壊れる

### 症状
- dev 環境表示のため `<title>{ENV_LABEL}高岡市の…</title>` のように **`<title>` 先頭に式 `{…}` を置き、続けて生テキスト**を書いたところ、
  ビルド出力で **`<title></title>`（空）になり、タイトル文字列が `</head>` の外（本文先頭）に漏れ出した**。3ページとも同症状。

### 真因
- `<title>` は HTML の **RCDATA 要素**。Astro コンパイラはこの中の「式＋生テキストの混在」をうまく扱えず、
  特に**先頭が式**だと要素境界の解釈が崩れて中身が脱落する。

### 対策（実装済み）
- タイトルは**フロントマターで単一の式として組み立て**、`<title>{pageTitle}</title>` の形にする。
  ```js
  const pageTitle = `${ENV_LABEL}ご予約 | ${salonName}`;   // 単一式
  ```
- 一般則: **`<title>` の中身は「単一の式」か「純粋な生テキスト」のどちらかにする**。混在させない。

参考実装: [`../src/pages/index.astro`](../src/pages/index.astro) ほか各ページの `pageTitle` ／ 環境フラグは [`../src/data/config.js`](../src/data/config.js)（`IS_DEV` / `ENV_LABEL`）。

---

## 2026-06-17 — お客様 LINE 連携の落とし穴

> LINE Login（userId 取得）＋同端末自動連携の実装に伴うハマりどころ（実装・dev 反映済み）。

### Login userId を Messaging API の push に使うには「同一プロバイダー」必須
- LINE の userId は**チャネルではなくプロバイダー単位で同一**。**LINE Login チャネル**で取得した userId を、**Messaging API チャネル**の push（`linePush_`）に渡して通知するには、**両チャネルが同一プロバイダー**でなければならない。
- 別プロバイダーだと同じ人でも userId が変わり、取得した userId 宛に push しても届かない（無効）。dev/prod それぞれで Login チャネルを Messaging API と同じプロバイダーに作る。

### LINE Login で取れない情報
- LINE Login（`profile`＋`openid`）で取得できるのは **userId（`sub`）・表示名（`name`）** のみ。**電話番号・性別は取得不可**。メールは「メール取得権限」申請時のみ。
- → 予約フォームは**氏名は LINE 表示名で自動補完**するが、**電話・性別は手入力で必須のまま**。メールは連携時のみ任意化。

### 再訪自動連携は localStorage（端末内）— 開発者DBではない
- 「再連携・再入力不要」は **同一端末の localStorage**（`wasyo_line_profile`）に `{lineUserId, displayName, name, phone, gender, referrer}` を保存して実現（**同意チェックは保存しない**＝予約毎に再取得）。
- これは**お客様自身の端末内**のデータで、開発者が管理するDBに PII を貯めるものではない。必ず**「連携を解除/別の人として予約」**で即削除できる導線を用意する。
- 再訪時は OAuth を省略し localStorage の `lineUserId` を信頼する設計（userId は推測不能なため許容）。気になる場合は送信時の再検証を将来追加できる形にしておく。

### CSRF: `state` 照合は必須
- 認可リダイレクトの戻りで `?code`&`?state` を受けたら、開始時に退避した `state` と**必ず照合**し、不一致なら連携を中断する。処理後は `history.replaceState` で URL から `code/state` を消す。

### 実際に踏んだ 2 つの落とし穴（dev で発生・解決済み）

**(1) `Invalid redirect_uri value`** — authorize に渡す `redirect_uri` が LINE Login チャネル登録のコールバックURLと**完全一致**していないと出る。**スキーム・ホスト・ポート・パス・末尾スラッシュまで** exact match。
- 実例: `PUBLIC_LINE_LOGIN_REDIRECT` を**末尾スラッシュ無し**で登録 → 予約ページは `/reserve/`（base=`/`・末尾スラッシュ有り）なので不一致。末尾 `/` を付けて解決。
- コールバックURL欄は**複数URLを別行**で（1行に並べると1つの不正値扱い）。`http://localhost` は dev で可。

**(2) `連携の確認に失敗（state照合）`** — 戻った先で退避データ（`state`）が読めない。
- 真因: **`sessionStorage` はタブ/アプリ内ブラウザをまたぐと共有されない**。スマホの LINE アプリ内ブラウザ→外部ブラウザ復帰や別タブ復帰で消える。→ **`localStorage`（同一オリジンでタブ共有）** に退避し、復帰時に必ず削除する方式へ変更（キー `wasyo_line_oauth`）。
- 注意: `localStorage` も**オリジン（scheme+host+port）単位**。**プレビューURL**（版別 `*-wasyo-dev.<account>.workers.dev`）で開始し正規URLへ戻ると別オリジンで共有されず再発する。**開始ホスト＝redirect_uri のホスト**（正規 workers.dev）で操作すること。

参考: 仕様は [`WBS.md`](./WBS.md)「LINE連携・管理画面レスポンシブ（確定仕様）」、設定は [`SETUP.md`](./SETUP.md) E、実装は [`../gas/Code.gs`](../gas/Code.gs)（`lineLogin_`）・[`../src/pages/reserve/index.astro`](../src/pages/reserve/index.astro)。

---

## 2026-06-18 — LINE連携ボタンで `400 Bad Request`（developing status）

### 症状
- お客様が「LINEで連携」を押すと `access.line.me` で **400 Bad Request**。
- メッセージ: `This channel is now developing status. User need to have developer role.`
- 開発者本人（チャネルに紐づくLINEアカウント）では連携できるのに、一般のお客様だけ失敗する。

### 真因
- **LINEログインチャネルのステータスが「Developing（開発中）」**のままだった。Developing 中は、チャネル/プロバイダーに **開発者ロール（Admin / Member / Tester）** を持つLINEユーザーしか認可（ログイン）できない仕様。一般ユーザーは 400 になる。
- フロントの authorize URL 生成（`startLineLink`）・スコープ `profile openid`・`redirect_uri` は正常。**コード側の不具合ではない**。

### 対策（運用・LINE Developers コンソール）
- 該当の **LINEログインチャネル** を開き、チャネル名の下の **ステータス トグルを「Developing」→「Published（公開）」** に切り替える。
- 公開前に「LINEログイン設定」の**コールバックURLが exact match**（末尾スラッシュまで）・スコープが `profile`＋`openid` かを確認（[`SETUP.md`](./SETUP.md) E）。
- dev/prod で**別のログインチャネル**を使うため、**それぞれ公開状態を確認**する。
- dev だけ先に検証したい段階では、チャネルの「ロール」に検証者を **Tester** 追加すれば Developing のまま連携可。ただし本番のお客様向けには **Publish 必須**。

### 一般教訓
- LINE Login は **「Developing＝開発者ロール限定」「Published＝一般公開」**。連携が「自分だけ通る／お客様だけ 400」のときは、まずチャネルの**公開ステータス**を疑う（コード以前の設定）。

## 2026-06-19 — 本番初リリースで踏んだ2件（CIビルド失敗 / LINE redirect malformed）

### ① GitHub Actions ビルド失敗：pnpm 8 が lockfileVersion 9.0 を読めない
- **症状**: `develop`→`main` 初マージで Actions の `build` が exit 1（`pnpm install` 段）。ローカルでは成功。
- **真因**: `deploy.yml` が `pnpm/action-setup@v3` で **`version: 8` 固定**。`pnpm-lock.yaml` は **`lockfileVersion: '9.0'`**（pnpm 9/10/11 形式）で、CIの frozen-lockfile で読めず失敗。`pnpm-workspace.yaml` の `allowBuilds`（esbuild/sharp 許可）も pnpm 10+ 機能。
- **対策**: `package.json` に **`"packageManager": "pnpm@11.7.0"`**（ローカルの corepack と同一）を追加し、`action-setup` は version 指定を外して **packageManager を参照**。CI＝ローカルに統一。
- **教訓**: CIの pnpm は **lockfileVersion とローカル版に必ず合わせる**。`packageManager` を単一の真実にするのが安全（version 二重指定は action がエラーにするので併記不可）。

### ② LINE連携「失敗しました」：redirect_uri is malformed（secretの先頭スペース）
- **症状**: 認可・同意画面までは成功して戻るのに、戻った後に「LINE連携に失敗しました」。`lineLogin_` のトークン交換が `400 {"error":"invalid_request","error_description":"the redirect_uri is malformed"}`。
- **真因**: GitHub secret **`PROD_LINE_LOGIN_REDIRECT` の値に先頭スペース**が混入（` https://wwwasyo.com/reserve/`）。ビルド時にフロントへ焼き込まれ、`redirect_uri` が malformed に。**authorize は寛容に通り、token 交換は厳格に弾く**ため「同意画面までは出るのに最後で失敗」になった。
- **切り分け**: `lineLogin_` は throw せず `{ok:false}` を返す→ Executions は「完了」表示で見落としやすい。**一時診断で失敗内容を Script Property `LINE_LAST_ERROR` に記録**して特定した（確認後に撤去）。
- **対策**: `src/data/config.js` で `RESERVE_API` / `LINE_LOGIN_*` を **必ず `.trim()`**（secret由来のコピペ空白に耐性）。secret 側も前後空白なしに直すのが正本。
- **教訓**: 環境変数/secret 由来の値は**前後空白で壊れうる**。URL・ID 系は source で trim。`redirect_uri` 系のエラーは **malformed（書式不正＝空白等）と does not match（登録ズレ）を区別**して読む。

---

## 2026-06-20 — LIFF（LINEアプリ内予約）導入のハマりどころ

> LINEアプリ内で予約を完結させる LIFF 化に伴う注意点。設計は [`RESERVATION_PLAN.md`](./RESERVATION_PLAN.md)「LIFF構成」、進捗は [`WBS.md`](./WBS.md) Phase 5、実装は [`../gas/Code.gs`](../gas/Code.gs)（`verifyLineIdToken_`/`liffVerify_`/`sendReminders`/`checkQuota`）・[`../src/pages/reserve/index.astro`](../src/pages/reserve/index.astro)（`initLiff`/`liffAfterBooking`）。

### LIFF エンドポイントは HTTPS 必須 — `localhost` では検証不可
- LIFF アプリのエンドポイントURLは **HTTPS 必須**。`http://localhost:4321/reserve/` は登録できず、`liff.init` 後の `isInClient` 経路を実機で確認できない。
- → dev の LIFF 実機確認は **Cloudflare Workers の dev URL（HTTPS）** で行う。LINE Login(OAuth) 用の localhost コールバック設定とは**別物**なので混同しない。

### userId はクライアントの `getProfile()` を信用しない（なりすまし防止）
- `liff.getProfile().userId` は**クライアントが自由に詐称できる**。予約に使う userId は **`liff.getIDToken()` の id_token を GAS に送り、`oauth2/v2.1/verify` でサーバ検証**して `sub` を確定する（`liffVerify_`）。
- 検証は LINE Login(OAuth) の verify と**同一処理**なので `verifyLineIdToken_` に集約して共用した。これは「通知URLの先読み」教訓（GETの冪等性）と同じく **クライアント入力を信用しない** という原則の適用。

### `liff.sendMessages()` は「トーク文脈からの起動時のみ」有効
- 予約完了時にトークへメッセージを残す `sendMessages` は、**リッチメニュー/トークから起動したとき**は使えるが、**プロフィールや外部ブラウザ起動**では使えないことがある。
- → 必ず `liff.isApiAvailable('sendMessages')` でガードし、失敗は握りつぶす（予約自体は GAS の push 通知で担保）。`shareTargetPicker` も同様に `isApiAvailable` ガード。

### 無料枠（月200通）— `message/quota` は上限を返さないことがある
- LINE Messaging API のコミュニケーション（無料）プランは **push 系が月200通**。だが **`/message/quota` は free プランで上限を返さない**（type:`none` 等）ことがある。
- → 上限は **Script Property `MONTHLY_FREE_QUOTA`（既定200）** に固定で持ち、**消費数は `/message/quota/consumption` の `totalUsage`** を信頼する。`checkQuota` が80%超でオーナー警告（`QUOTA_WARNED_YYYYMM` で月内多重警告を防止）。
- 「200通」はあくまで現行プラン前提。プラン変更時はこの固定値の追従が必要（実態より少なく/多く表示しない）。

### リマインド/フォローの二重送信防止はイベントタグで
- `sendReminders`/`sendFollowUps` は日次トリガーで複数回走り得るため、送信済みイベントに **`reminded`/`followedUp` タグ**を付けて多重送信を防ぐ（`setEventProps_` と同じ `setTag` 機構）。対象は **`status===confirmed`** のみ（仮予約には送らない）。
- 送信は push 枠を消費するため、これらも `checkQuota` の監視対象に含める前提で運用する。

### LIFF SDK の読込タイミング
- SDK は `LIFF_ID` 設定時のみ `<head>` に**同期 script**（`static.line-scdn.net/liff/edge/2/sdk.js`）で読み込む。ページ末尾の `define:vars` スクリプトより先に `window.liff` が定義される。`LIFF_ID` 未設定なら SDK もロードされず、`initLiff` は `!window.liff` で早期 return＝**従来フロー（OAuth/手入力）に無影響**。

### リッチメニューは「本番LIFF専用」／dev検証は直URLで
- 公式アカウント（Messaging API チャネル）は **dev/prod 共通で1つ**。リッチメニューが指せる LIFF URL も**1つだけ**なので、ここに **dev の LIFF URL を載せない**（本番のお客様まで【開発】環境に飛んでしまう）。**リッチメニューは prod LIFF URL 専用**にする。
- **dev 検証にリッチメニューは不要**。LIFF アプリは固有 URL `https://liff.line.me/{LIFF_ID}` で直接起動できるため、**dev LIFF URL を自分の LINE トーク（Keepメモ等）に貼ってタップ**すれば実機検証できる（リッチメニュー＝あくまで入口ショートカット）。dev/prod で LIFF アプリ・LINE Login チャネルは別物なので、リッチメニューを本番用に固定しても dev 検証に支障なし。
- **リッチメニューはこのリポジトリのコード作業ではない**。LINE 公式アカウントマネージャー（or Messaging API）コンソールの**GUI設定**で、ボタンのアクションに LIFF URL を割り当てるだけ。Astro/GAS 側に追加実装・デプロイは不要（Messaging API でプログラム生成も可能だが本件では不要）。
