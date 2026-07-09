# 2026-07-09 代理登録の日時入力を「空き枠駆動ピッカー」に統一し共有部品化

## 目的（なぜ）
予約管理の「代理登録」フォーム（`/reserve/admin/reservations`）の日時入力は、素の
`<input type="date">`＋`<input type="time" step="1800">` だった。オーナーは休枠・受付制約・
既存予約と無関係に任意の日時を打ててしまい、送信後に GAS 側 `slot_closed` / `slot_taken`
で弾かれて手戻りになる。お客様フロー（`/reserve/index`）は「メニューの slotMin → availabilityRaw →
空き日カレンダー（ヒートマップ）→ 日付タップ → 時刻ポップアップ」で**空いている日時しか選べない**。

本人指示「日付・時間の入力方式をお客様と同様にして。（共通化もしておく）」に沿い、
①この日時ピッカーの組み立てを再利用可能な共有部品へ抽出し、②お客様（index/manage）を回帰ゼロで
その共有部品に載せ替え、③代理フォームの素の入力を同じピッカーへ置換した。

## 設計（何を・どう共通化したか）
新規 `src/lib/datetime-picker.js` に2階建てで集約した。

1. **`renderAvailabilityCalendar(opts)`** … 月グリッド（ヒートマップ＋前月/次月＋日付クリック）の
   "描画だけ" を行う純粋レンダラ。index/manage の既存 `renderCalendar` に**1バイト違わぬ HTML** を
   生成する（挙動不変の抽出＝PR-1 と同じ規律）。state 反映やステップ遷移などページ固有の副作用は
   `onNav` / `onDayClick` コールバックに委ねる。曜日・◎閾値・esc は引数で受け、内部で共有 `heatMark` を使う。
   併せて重複していた `ymIndex` / `stepMonth` もここへ集約（index/manage のローカル定義を削除）。

2. **`createDateTimePicker(opts)`** … 上記レンダラ＋時刻ポップアップ（共有 `time-dialog.js` / `TimeDialog.astro`）
   ＋内部 state を束ねた高水準コントローラ。`setDays(days, holidays)` で空き日を投入すると
   カレンダー描画→日付タップ→時刻ポップアップ→時刻確定までを面倒みて、`onSelect({date,time})` で
   選択を返す。`getSelection()` は `'YYYY-MM-DD'` / `'HH:MM'`（＝GAS 期待形式）。

**採用方針（回帰リスク配慮）**: index/manage は既存の巨大な `state`（LINE OAuth 復帰・ステップ遷移・
送信ペイロード等が `state.date/time/days/availSet/raw` を広範に参照）と密結合のため、
**低水準の `renderAvailabilityCalendar` のみ**を採用し（＝インライン HTML ビルダーを共有呼び出しへ付け替え）、
高水準の `createDateTimePicker`（内部 state を持つ）は**新規呼び出し元＝代理フォームだけ**が採用した。
これで「共通の心臓部（カレンダー描画）は3ページで共有」しつつ、お客様側の挙動を1ミリも変えない。

## 変更ファイル一覧（フルパス）
- 新規 `src/lib/datetime-picker.js` … 上記2関数＋`ymIndex`/`stepMonth`/`CAL_WEEKDAYS`。
- `src/pages/reserve/index.astro` … `renderCalendar` の本体を `renderAvailabilityCalendar` 呼び出しへ置換
  （onDayClick に従来の副作用＝maxReached/updateSummary/refreshNavBars/openTimeDialog をそのまま保持）。
  ローカル `ymIndex`/`stepMonth` 削除、未使用化した `heatMark` の import 削除、`renderAvailabilityCalendar` を import。
- `src/pages/reserve/manage.astro` … 同上（onDayClick は confirmChange 無効化＝従来どおり）。
- `src/pages/reserve/admin/reservations.astro` … 素の date/time input を撤去し、
  `#agentSlotStatus`＋`#agentDateList`＋既存 `#agentDtChip` に置換。`<TimeDialog />` 配置、
  `reserve-calendar.css` import、メニューチップに `data-slot` 追加、frontmatter で `RESERVE_API` を
  `reserve-config` JSON でクライアントへ受け渡し。スクリプトは `createDateTimePicker` を組み、
  `availabilityRaw`（公開 GET）を `PUBLIC_RESERVE_API` 直接取得→`computeDaysForSlot(raw, slotMin)`→
  `picker.setDays`。`agentPayload()`/`resetAgentForm()` はピッカー選択を読む形へ。
- `src/styles/admin-cabinet.css` … 使わなくなった `.dt-row`/`.dt-field` を撤去し、ピッカー状況テキスト用
  `.slot-status`（お客様 index 相当）を追加（`.dt-chip` は維持）。

## availabilityRaw の取得経路（GAS/Worker 改修なしで完結）
- `availabilityRaw` は GAS の**公開 `doGet` アクション**（`gas/Code.gs` doGet :127-128、adminToken 不要）。
  お客様 index が既に `${RESERVE_API}?action=availabilityRaw` を直接 GET しており**秘密ではない**。
- admin ページも frontmatter で `RESERVE_API`（`config.js` 由来・値は `PUBLIC_RESERVE_API`）を読み、
  `reserve-config` JSON でクライアントへ渡して**お客様と同一の直接 GET** で取得。管理 API（adminCreateBooking 等）は
  従来どおり Worker 経由（adminToken 付与）で、availabilityRaw だけ Worker を通さない。
- 結果 **GAS（Code.gs）・Worker（action.js）は一切変更なし**。上告不要。

## 検証（実体）
- **`pnpm build`** 成功（末尾 `[build] Complete!` / `Server built in 5.87s`）。reservations は
  **オンデマンド維持**（静的 `reservations*.html` 不在、`dist/server/chunks/reservations_*.mjs` 生成）。
- **共有チャンクの実体**: `dist/client/_astro/datetime-picker.*.js` に `cal-cell cal-day avail` を含み、
  index の主モジュール・manage・reservations の各クライアントエントリが `datetime-picker.*.js` を import
  （reservations は加えて `availability.*.js` を import）＝3ページで同一 picker チャンクを共有。
- **お客様側 回帰ゼロの根拠（コードレベル）**: 抽出前（git HEAD）の index/manage の `renderCalendar`
  HTML ビルダー行と、共有 `renderAvailabilityCalendar` の HTML ビルダー行を、変数名差だけ正規化して
  `diff` → **両者とも完全一致（IDENTICAL）**。index/manage は同一の入力（WD/HEAT_HI_MIN/state.*/esc）を渡すため
  生成 DOM・クラス・凡例・前月次月/日付クリックの配線が同一。差分は「インライン→共有呼び出し」の付け替えのみ。
- **代理ピッカーが動く証跡（実駆動）**: 外部依存を足さない軽量 DOM モックで `createDateTimePicker` を
  end-to-end 駆動（実 API は叩かず合成 availabilityRaw を使用）。
  - `computeDaysForSlot`（slotMin=90, busy=[10:00-11:00]）→ 13日は 10:00/10:30 が busy 重なりで除外、
    `['11:00','13:00']`、14日 `['10:00','10:30','14:00']`（busy 判定が効くこと確認）。
  - カレンダー HTML に `cal-head`/`cal-legend`/`data-date="2026-07-13"`・`data-date="2026-07-14"`・
    祝日セル（`disabled holiday`＋祝日名）が出ることを生成 HTML から確認。
  - 日付 13日タップ→時刻ポップアップに 11:00/13:00 描画→13:00 タップ→
    **`onSelect` / `getSelection()` = `{date:"2026-07-13", time:"13:00"}`**、ダイアログ close、
    `date` は `^\d{4}-\d{2}-\d{2}$`・`time` は `^\d{2}:\d{2}$`（GAS 期待形式）を満たす。reset で選択・カレンダー初期化。
  - 検証スクリプトは実行後に削除（環境クリーン）。
- **お客様側の目視（astro dev / wrangler dev）と代理フォームのブラウザ目視は本人の実機 E2E に委ねる**
  （管理ページはサーバゲート済みのためテストトークンでログインが必要）。
- 追加差分に secret 実値・個人情報の混入なし（`RESERVE_API` は既に公開ページで露出済みの GAS /exec URL）。

## 未実施＝本人GO残
- **git push / clasp は一切していない**（develop 上のローカルコミットのみ）。GAS 改修が無いため今回は
  git push だけで dev 反映できる見込み（本人 GO 後）。
- ブラウザでの実機目視（お客様カレンダーの回帰確認＋代理フォームの空き枠カレンダー→TimeDialog→登録）は本人。
- prod（本番 GAS / wwwasyo.com）は一切触っていない。

## コミット
- （1）refactor(reserve): 日時ピッカーのカレンダー描画を共有部品へ抽出（挙動不変）
- （2）feat(reserve): 代理登録の日時入力を空き枠駆動ピッカーに統一
- 本ログは docs コミットで別途。
