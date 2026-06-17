# 開発メモ・既知のハマりどころ（備忘録）

サロン和笑〜Violane〜 予約システム開発で実際に踏んだ落とし穴と対策の記録。
同種の事故を繰り返さないために、原因が非自明だったものをここに蓄積する。

- 設計: [`../RESERVATION_PLAN.md`](../RESERVATION_PLAN.md) ／ 進捗: [`../WBS.md`](../WBS.md) ／ GAS: [`../gas/README.md`](../gas/README.md)

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
