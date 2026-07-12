# 2026-07-12 顧客台帳メモ（顧客ごとの恒久メモ）

## 背景（なぜ）
顧客管理画面（`/reserve/admin/customers`）の各顧客に、店主が自由記述の**恒久メモ**
（アレルギー・好み・注意点など）を残せるようにする。常連対応の質を上げ、申し送りを
記憶・口頭に頼らないため（本人指示）。

**調査で判明した肝**: 顧客台帳（`LEDGER_SHEET` の先頭シート）は **1 顧客＝1 行**で実在し、
**7 列目に `note` 列が既に確保されて常に空**（`ledgerUpsert_` が appendRow で 7 列目に `''`
を確保済み・来店更新でも 5/6 列目のみ触り 7 列目は上書きしない）。→ **新シート・アーキ変更は
不要。既存 note 列に読み書きするだけ**で済む。作業ブランチ: `develop`。**未 push（本人GO事項）・
dev のみ／prod は一切触らない**。

## 本人確定（2 方針）
1. **1 顧客 1 つの恒久メモ（上書き）**。来店タイムライン型ではなく単一メモ。
2. **一覧の各行に「メモあり」マーク**を出す（本文は一覧に出さない＝のぞき見耐性）。本文の
   表示・編集は顧客詳細パネル内。

## 変更ファイル（4 コミット）
- **コミット1** `feat(gas): …`（`gas/Code.gs` +48 行・**追加のみ／削除 0**）
  - `adminListCustomers_` の顧客オブジェクトに `note: String(row[6]||'')` を**純追加**
    （既存フィールド・挙動は不変）。一覧レスポンスに本文も載せる。
  - `adminSetCustomerNote_(body)` を新設（`ledgerUpsert_` の隣＝台帳 writer を隣接）。
    body `{action, adminToken, key:<hash>, note:<string>}`。検証は
    `bad_request`（key 欠落）／`too_long`（>`CUSTOMER_NOTE_MAX`=2000）／`ledger_unconfigured`／
    `not_found`／`ok`。`LockService.getScriptLock().waitLock(15000)`＋`try/finally` 区間で全行を
    `hashKey_(row[0])===key` 突合し、該当行の**列 7 に `setValue`**。`r=0`（ヘッダ）スキップ・
    空文字 note＝クリア許可。
  - doPost switch に `case 'adminSetCustomerNote'`（`adminListConfirmed` の隣・`requireAdminToken_`
    保護）。定数 `CUSTOMER_NOTE_MAX = 2000`。
- **コミット2** `feat(worker): …`（`src/worker/routes/action.js` +1/-1）
  - `ALLOWED_ACTIONS`（Set）に `'adminSetCustomerNote'` を 1 語追加。GAS の case 名と一致。他は不変。
- **コミット3** `feat(reserve): …`（`customers.astro` +48/-1・`admin-cabinet.css` +13）
  - `renderList`: メモ有りの行に ✎ マーク（`.clist__memo`）。**本文は一覧に描画しない**。
  - `detailHtml`: krt と来店履歴の間にメモ欄。`<textarea maxlength="2000">` に `esc(c.note||'')`
    （`</textarea>` ブレイクアウト防止）＋保存ボタン `#memoSave`＋状態表示 `#memoStatus`。
    **line 型（連絡先なし）でも表示**。
  - `openDetail` から `wireMemo(c)` を呼ぶ。`wireDetail` は line 型で早期 return するため、
    メモ配線を別関数に分離して**全 type で動かす**。
  - `wireMemo`: 保存で `apiPost('adminSetCustomerNote', {key:c.key, note:ta.value}, {silent:true})`。
    `forbidden`→`handleForbidden()`、成功時は同一オブジェクト参照の `c.note` を更新して
    `applySortAndRender`（一覧の ✎ が即反映・並び順は note 非依存で不変）＋トースト。
  - CSS: `.clist__memo`／`.memo` 系（`.hist` を踏襲）を `admin-cabinet.css` 末尾に追記。
    `admin.css` は無改変。`prerender=false` リテラルも維持。
- **コミット4** `docs(log): …`（本ファイル）。

## 設計判断（選択肢・理由）
- **既存 note 列（列 7）を再利用＝アーキ変更なし**: 台帳は 1 顧客 1 行で列 7 が空確保済みのため、
  新シートや別ストアを起こさず読み書きだけで完結する。実装が軽く回帰面も小さい。
- **ハッシュ突合（`hashKey_(row[0])===key`）で行を特定**: フロントには生キー
  （`line:`/`phone:`/`email:`）が無く、来店履歴で導入済みの SHA-256 ハッシュ `key` のみが渡る
  （PII 最小化の帰結）。生キー前提の `ledgerLookup_` は流用できないため、全行をハッシュ化して突合する。
  キーは顧客ごとに一意なので初回一致で break。
- **一覧はマークのみ・本文は詳細**: のぞき見耐性（本人確定 2）。一覧レスポンスには本文も含める
  （phone/email 実値と同レベルの管理ゲート内扱い）が、描画は詳細パネルに限る。
- **メモ配線を `wireMemo` に分離**: `wireDetail` は連絡先の段階開示 UI を配線し line 型で早期
  return するため、メモを同居させると line 客で配線されない。別関数にして全 type で動かす。
- **保存成功時は同一オブジェクト参照を更新**: `c` は `viewData[i]`＝`customersData` と同じオブジェクト
  参照。`c.note` を書き換えて `applySortAndRender` すれば一覧の ✎ が即反映される（並び順は
  lastVisit/count 依存で note 非依存＝不変）。
- **switch case は既存流儀の `function(){}` でミラー**: ランタイムは V8（アロー可）だが、既存
  switch は全て `function(){}` 形式のためスタイルを揃えた（ロジックは同一）。

## セキュリティ判断（監査・PII）
- **監査 `auditPush_` に本文・生トークンを渡さない**: ロック解放後に
  `auditPush_(tokenFp_(body.adminToken), 'karteEdit', body.key, res.ok?'ok':'ng')` を 1 回だけ呼ぶ。
  操作者は `tokenFp_`（HMAC 指紋）、対象 target は**生の `body.key`（ハッシュ）**を渡し、末尾 4 桁への
  マスクは `auditPush_` 内の `maskId_` に一任する（**呼び出し側で事前マスクしない＝二重マスク回避**）。
  **note 本文はどの列にも残さない**。
- **textarea の XSS 対策**: 初期値は `esc()` でエスケープ（`</textarea>` ブレイクアウト防止）。
  `maxlength` は GAS の `CUSTOMER_NOTE_MAX`（2000）と一致させ、超過はサーバ側で `too_long` 拒否。
- **無改変厳守**: `ledgerUpsert_`／`decide_`／`constEq_`／配信コア／必須通知発火点／
  `adminListCustomers_` の既存返却（note フィールドの追加のみ）は 1 バイトも触らない。

## 検証（ローカル・push 不要・GAS は叩いていない）
- **GAS 構文**: `cp gas/Code.gs /tmp/x.js && node --check` → OK。
- **`pnpm build` 成功**: `/reserve/admin/customers` は prerender 一覧に**現れない**（＝オンデマンド＝
  ゲート対象）。`prerender = false`（リテラル）維持。
- **`pnpm test` 全 green**: 23 tests / 0 fail（`unknown_action` テストは固定文字列ゆえ許可追加の
  影響なし・回帰ゼロ）。GAS `.gs` は node テスト対象外＝ロジックはコードで担保。
- **差分の実体**: コミット1 gas は 48 insertions・0 deletions（`adminListCustomers_` は note 追加のみ・
  `adminSetCustomerNote_`/case/定数は新規）。コミット2 worker は +1/-1（Set に 1 語）。コミット3 UI は
  +60/-1。
- **PII・secret 混入なし**: 追加行にダミー名・secret 実値・実電話番号・識別子（scriptId/deploymentId/
  トークン）の混入なし。顧客 PII・メモ本文はランタイムで GAS から取得しリポに残さない。
- **未 push / 未 clasp**: コミットはローカル `develop` のみ。`git push`・`clasp push`・`clasp deploy`・
  `clasp redeploy` は未実施（本人GO事項）。

## 次 PL／残した事項
- **本人GO事項（不可逆）**: `develop` の push（Workers Builds が dev 自動デプロイ）・GAS の
  `clasp push`＋既存 versioned デプロイの `clasp redeploy`（`/exec` URL 維持・bare `clasp deploy`/create 禁）。
  prod GAS（wwwasyo.com）は一切触らない・dev のみ。
- **dev E2E（push 後）**: ①未設定客＝textarea 空・マーク無し ②入力→保存→「保存しました」／戻ると
  一覧に ✎ 即反映 ③全リロードでメモ永続（列 7）＋マーク残る ④空にして保存→マーク消滅・リロードで空
  ⑤LINE 型客でもメモ保存可 ⑥「監査ログ」シートに `karteEdit` 行が 1 つだけ増加（操作者＝`fp:…`指紋・
  対象＝末尾 4 桁マスク・結果＝ok・**本文がどの列にも無い**）⑦回帰ゼロ（一覧/並替/電話マスク段階開示/
  来店履歴/代理予約/承認待ち不変・確定予約 1 件作り `ledgerUpsert_` 更新後もメモが残る＝列 7 非改変）。
