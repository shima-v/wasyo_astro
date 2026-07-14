# person/channel identity層 — Phase 1（土台づくり）2026-07-13

顧客一覧の改修（①氏名編集・②電話編集(LINE客も)・③媒体をまたいだ名寄せ＝本人同意の引き継ぎ）の**Phase 1**。本ログは土台の実装と、クロコによる実体裏取りの記録。作業ブランチ `develop`。

## なぜ（根本原因）

3つの困りごとは1つの原因＝**「連絡先＝主キー」の癒着**から派生する。`ledgerKey_`（`gas/Code.gs`）が主キーを `lineUserId>phone>email` の優先で"1つの連絡先そのもの"から作るため:

- 電話を変えると主キーが変わり、過去のカレンダー履歴との突合が切れる（②が難しい）。
- 同一人物でも媒体が違えば別キー＝別人扱いで、引き継げない（③ができない）。

→ **編集可能な「連絡先(channel)」と、不変の「同定キー(person)」を分離**する。Phase 1 はその土台だけを、既存の見た目・挙動を変えずに（非破壊・追加のみ・冪等）入れる。

## 何を（実装・`gas/Code.gs`）

- **改修 `ledgerUpsert_`**: person対応化。既存の col0〜6 は**同順・同値で無改変**、personId を col7 へ純追加。予約ごとに person 集約（回数・最終来店・氏名）を channel と同期。
- **新規 person系5関数**:
  - `personSheet_()` — 名前付きシート `person` を**末尾**に作成（`personId|displayName|firstVisit|count|lastVisit|note`）。位置0の台帳 `getSheets()[0]` を動かさない。台帳未設定なら null。
  - `personLookup_(personId)` — person行番号の解決。
  - `personRowSync_(personId, agg)` — person行の集約 upsert（空フィールドは保全・冪等）。
  - `personResolve_(keyOrProps)` — キー/props→personId 解決（無ければ採番して col7 backfill・冪等）。
  - `migrateToPersonModel_(dryRun)` — 既存全行に person 割当。**dry-run 既定**（省略/true は集計のみ・書き込まない）・**冪等**（personId済みは再採番せず）・**非破壊**（書くのは col7 と person シートのみ／col0〜6・カレンダー不変）。同名は自動統合せず `nameCollisions` に**報告のみ**。どの doGet/doPost にも配線せず、オーナー手動/`clasp run` 実行前提。

## 安全設計（Phase 1 の約束）

- **カレンダー（来店履歴の原本）には一切書き込まない。**
- 既存 col0〜6・既存の表示/挙動を変えない（回帰ゼロ）。
- 名寄せ（媒体またぎ統合）はまだしない（1 channel行 = 1 person の 1:1）。
- 匿名化: scriptId/deploymentId/secret/token/PII をコード・ログに書かない。

## クロコによる実体裏取り（自己申告を鵜呑みにしない）

- git: `M gas/Code.gs` の1ファイルのみ・172挿入/1削除・**HEAD不動**。
- 非破壊: `ledgerUpsert_` の新規 appendRow は7要素同順・同値＋personId純追加を diff で目視。
- カレンダー保護: person系に書込系（CalendarApp/createEvent/deleteEvent 等）なし（grep CLEAN）。
- 移行の安全: `migrateToPersonModel_` は `dryRun=(dryRun!==false)` で dry-run 既定、書込は col7 と person シートのみを実体で確認。
- 匿名化: diff の追加行に scriptId/token/電話番号パターンの混入なし（grep CLEAN）。
- 回帰: `pnpm build` EXIT=0・`pnpm test` **23 pass / 0 fail**（クロコが自分で EXIT を確認）。

## 未実施（本人GO事項・立会い）

- **dev の clasp push・`migrateToPersonModel_` の実行**は本ログ時点で段階的に実施（dev→dry-run→冪等確認）。**prod の台帳スキーマ変更＋移行は不可逆＝バックアップ必須・別途本人GO**。

## 次

dev で dry-run（件数・同名衝突を目視）→ 冪等性を二度流しで確認 → 問題なければ Phase 2（履歴の person 紐づけ・①氏名編集）へ。
