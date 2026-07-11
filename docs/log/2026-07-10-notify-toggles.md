# 通知トグルの機能化（任意通知だけ個別ON/OFF）— 2026-07-10

## 背景・目的

和笑の LINE/メール/Discord 通知はすべて GAS（`gas/Code.gs`）に集約され、Worker/Astro は転送プロキシに過ぎない。現状オーナーは「どの通知を送るか」を選べず全部が自動で飛ぶ。本人確定の方針（2026-07-10）＝「種別ごとに個別ON/OFF。ただし予約の進行に必須の通知はトグル不可（常時送信）」。

通知を **必須（常時送信・トグル不可）／任意（トグル可）** の2群に分け、必須群は発火点を一切触らず常時送信（既存関数を無改変）、任意群だけに「既定ON」の1行ゲートを差し、設定ページにトグルを出す。既存の配信コア（`notifyCustomer_`/`notifyCustomerProps_`/`notifyOwner_`/`linePushMessages_`）も無改修。アーキ変更なし（既存の `getSlotConfig`/`setSlotConfig` と同型の config パターンを1組増やすだけ）。

## 全13種別の必須/任意の線引き（本人確定 2026-07-10）

必須（トグル不可・常時送信・発火点無改変）／任意（トグル可・既定ONのゲート）。

| # | 通知 | 発火点 | 送信先 | 確定 | key |
|---|---|---|---|---|---|
| 1 | 仮予約受付の控え | `createBookingCore_` | 客 | 任意 | `customerReceipt` |
| 2 | 予約確定通知 | `decide_` | 客 | 必須 | — |
| 3 | 予約却下通知 | `decide_` | 客 | 必須 | — |
| 4 | キャンセル控え | `cancelBooking_` | 客 | 任意 | `customerCancel` |
| 5 | 日時変更の控え | `changeBooking_` | 客 | 任意 | `customerChange` |
| 6 | 新規仮予約（承認待ち） | `createBookingCore_` | オーナー | 必須 | — |
| 7 | 日時変更・再承認 | `changeBooking_` | オーナー | 必須 | — |
| 8 | 顧客キャンセル通知 | `cancelBooking_` | オーナー | 任意 | `ownerCancel` |
| 9 | 前日リマインド | `sendReminders` | 客 | 任意 | `reminder` |
| 10 | 来店後フォロー | `sendFollowUps` | 客 | 任意 | `followup` |
| 11 | 日次ダイジェスト | `sendOwnerDailyDigest` | オーナー | 任意 | `ownerDigest` |
| 12 | LINE無料枠80%警告 | `checkQuota` | オーナー | 任意 | `ownerQuotaWarn` |
| 13 | 代理登録の報告 | `adminCreateBooking_` | オーナー | 任意 | `ownerProxy` |

- 必須＝4種（#2 確定 / #3 却下 / #6 新規承認待ち / #7 再承認）。任意＝9種（残り全部）。
- そもそもトグル対象外（手動・オーナーが自分で押す）＝任意メッセージ（`messageSendBySig_`）／一斉送信・テスト（`adminBroadcast_`/`adminBroadcastTest_`）／接続テスト（`adminOwnerChannelTest_`）／デプロイ通知／diag。送りたくなければ押さないだけなので UI に載せない。

## NOTIFY_CONFIG 設計

- 専用の ScriptProperty キー `NOTIFY_CONFIG`（`SLOT_CONFIG` とは別枠＝slotconfig 保存との相互 clobber を回避）。
- 値は `{ key: boolean }` の単純 JSON。PII は一切持たない（boolean のみ）。
- ゲート判定 `notifyOn_(key)` は `readNotifyConfig_()[key] !== false`。
  - 未設定（キーなし）→ `undefined !== false` → `true`（送る）。
  - `true` → `true !== false` → `true`（送る）。
  - `false` → `false !== false` → `false`（抑止）。
  - ＝**既定ON**。未設定時は現行挙動を厳密に維持（回帰ゼロ）。JSON パース失敗時も `{}` で全キー既定ON。

## GAS 側の変更（`gas/Code.gs`）

### 純追加（既存の配信コアは無改修）

- `readNotifyConfig_()` — `readSlotConfig_` と同型（`JSON.parse(prop_('NOTIFY_CONFIG')||'{}')`、失敗時 `{}`）。
- `notifyOn_(key)` — 上記の既定ON判定。
- `adminGetNotifyConfig_()` / `adminSetNotifyConfig_(b)` — `adminGetSlotConfig_`/`adminSetSlotConfig_` の完全ミラー（get＝`{ok,config}`、set＝`setProperty('NOTIFY_CONFIG', JSON.stringify(b.config||{}))`）。
- doPost の switch に2 case 追加（`getSlotConfig`/`setSlotConfig` の並び）：
  - `getNotifyConfig` → `requireAdminToken_(body, adminGetNotifyConfig_)`
  - `setNotifyConfig` → `requireAdminToken_(body, () => adminSetNotifyConfig_(body))`

### 任意9通知の発火点に差した1行ゲート（既定ONで未設定時は挙動不変）

| key | 発火点 | ゲートの形 |
|---|---|---|
| `customerReceipt` | `createBookingCore_` 受付控え | `if (notifyCustomerFlag && notifyOn_('customerReceipt')) { ... }`（既存 opts ガードと AND 合成） |
| `ownerProxy` | `adminCreateBooking_` 代理報告 | `if (notifyOn_('ownerProxy')) notifyOwner_(...)` |
| `ownerCancel` | `cancelBooking_` オーナー通知 | `if (notifyOn_('ownerCancel')) notifyOwner_(...)` |
| `customerCancel` | `cancelBooking_` 顧客控え | `if (notifyOn_('customerCancel')) notifyCustomerProps_(...)` |
| `customerChange` | `changeBooking_` 顧客控え | `if (notifyOn_('customerChange')) notifyCustomerProps_(...)` |
| `reminder` | `sendReminders` | `if (notifyOn_('reminder')) { notifyCustomerProps_(...); ev.setTag('reminded','true'); }`（処理済みマークはブロック内＝送信時のみ） |
| `followup` | `sendFollowUps` | `if (notifyOn_('followup')) { notifyCustomerProps_(...); ev.setTag('followedUp','true'); }`（処理済みマークはブロック内＝送信時のみ） |
| `ownerDigest` | `sendOwnerDailyDigest` | `if (notifyOn_('ownerDigest')) notifyOwner_(...)` |
| `ownerQuotaWarn` | `checkQuota` | `if (notifyOn_('ownerQuotaWarn')) { notifyOwner_(...); setProperty('QUOTA_WARNED_YYYYMM', ym); }`（警告送信と月フラグをまとめてゲート＝送信時のみ警告済みにする） |

各ゲートは本文・文言・kind 引数を変えず、送信呼び出しを包むだけ。

### 処理済みマークは送信したときだけ付ける（設計確定 2026-07-10）

「二重送信防止マーク」を送信ゲートの外に置くと、トグルOFF運用時に「送らないのに処理済みになる」→途中でONに戻してもその対象は二度と送られない粘着挙動になる。そこで **`sendReminders`（`reminded`）・`sendFollowUps`（`followedUp`）・`checkQuota`（`QUOTA_WARNED_YYYYMM`）の3箇所は、マーク／月フラグの更新を送信ゲートのブロック内・送信直後へ移した**。既定ON（未設定）の挙動は完全に不変で、OFF↔ON の再開が直感どおりになる（OFF中はマークを立てず、ON復帰で対象が再び送信・再警告の候補に戻る）。

### 無改変（必須群・発火点を一切触っていない）

- `decide_`（#2 確定 / #3 却下）は完全不変。
- `createBookingCore_` の `notifyOwnerNewBooking_`（#6 新規承認待ち）は不変。
- `changeBooking_` の `notifyOwnerPendingApproval_`（#7 再承認）は不変。
- 配信コア（`notifyCustomer_`/`notifyCustomerProps_`/`notifyOwner_`/`linePushMessages_`）と `constEq_`（定数時間比較）も無改修。

## Worker 側（`src/worker/routes/action.js`）

- `ALLOWED_ACTIONS` に `getNotifyConfig`・`setNotifyConfig` を追加（`setSlotConfig` の並び）。それ以外は無改変。

## 設定ページ（`src/pages/reserve/admin/settings.astro`）

- 新セクション「通知設定」を追加（受付枠設定の下）。既存の slotconfig 往復（`loadConfig`/`saveConfig`）を写経し、`getNotifyConfig` で初期ロード → トグル描画 → `setNotifyConfig` に `{config}` を保存。
- 任意9キーだけを checkbox で出す。お客様向け（`customerReceipt`/`customerCancel`/`customerChange`/`reminder`/`followup`）とお店向け（`ownerCancel`/`ownerProxy`/`ownerDigest`/`ownerQuotaWarn`）の2レーンに分割。各トグルは `data-notify-key` を持ち、既定チェックON（`config[key] !== false`）。
- 必須4通知（予約確定 / 予約却下 / 新規仮予約〈承認待ち〉/ 日時変更・再承認）は「常時送信（変更不可）」として淡色・`disabled` で一覧表示（切れないことを明示・隠さない）。これらは `data-notify-key` を持たないため保存対象に含まれない。
- トグル UI は既存 checkbox（`#scAllDay` 付近）のスタイルを流用。`apiPost` は `src/lib/admin-api.js` の既存を使用。`export const prerender = false;` リテラルは維持。
- config は `{ key: boolean }` の単純 JSON。PII は持たない。

## 検証結果

- `pnpm build`（wasyo_astro）＝**成功**。settings.astro はコンパイルでき、prerender の static 一覧に現れない（＝server-render 維持・middleware ゲート下）。回帰なし。
- `notifyOn_` の論理をコード上でトレース：未設定→送る／`true`→送る／`false`→抑止（既定ON）を確認。
- `git diff` 上に `decide_`・`notifyOwnerNewBooking_`・`notifyOwnerPendingApproval_` の該当行は一切現れない（必須4通知の無改変を確認）。

## push・デプロイ状況

- **git commit / git push / clasp push / clasp deploy はいずれも未実施**（作業ツリーに未コミットで残す）。dev の実機反映と本番切替は本人GO事項（不可逆）。
- prod GAS（wwwasyo.com）は一切触っていない。dev develop 起点の編集のみ。

## dev E2E（clasp push＋git push＝本人GO 後に実施予定）

1. 設定画面で任意通知（例 `reminder`）を OFF 保存 → `NOTIFY_CONFIG` に反映（`getNotifyConfig` で往復確認）。
2. 該当 cron（例 `sendReminders`）実行 → 台帳「送信ログ」に該当 `kind` 行が増えないこと。ON に戻すと送信されること。
3. 必須通知（確定/却下/新規承認待ち/再承認）は無改変 → 通常予約フローが従来どおり通り、設定に関係なく必ず送信（回帰ゼロ）。
4. 設定画面で必須群が「常時送信（変更不可）」表示・非活性であること。
