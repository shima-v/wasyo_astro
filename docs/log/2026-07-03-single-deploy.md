# 2026-07-03 改修⑥ GAS 単一デプロイ化（管理デプロイ②依存の撤去）

## 目的（なぜ）
管理パネル（P1/P2 で front `/reserve/admin` + bearer `requireAdminToken_` へ移行）・承認/辞退（front `/reserve/decision` + doPost `decide`）・顧客メッセージ（改修⑤で front `/reserve/message` + `messageInfoBySig_`/`messageSendBySig_` へ移行）が出そろい、旧・管理デプロイ②（`executeAs=アクセスユーザー`・要 Google ログイン）向けの Google ログイン系コードが全て不要になった。これを撤去し、`gas/appsscript.json`（`executeAs=USER_DEPLOYING` / `access=ANYONE_ANONYMOUS`）どおりの**単一デプロイ①**にコードとドキュメントを一致させる。

## 撤去したもの（②＝Googleログイン依存）— `gas/Code.gs`
- `requireAdmin_`（`Session.getActiveUser()` + `ADMIN_EMAILS` 照合）本体と全呼び出し元。
- 旧 `sendCustomerMessageBySig`（requireAdmin_ 版）。代替は改修⑤の `messageSendBySig_`。
- `adminApi*` 公開ラッパ群（旧 admin.html が `google.script.run` で叩いていたもの）: `adminApiGetConfig`/`adminApiSetConfig`/`adminApiListPending`/`adminApiDecision`/`adminApiGetQuota`/`adminApiBroadcastPreview`/`adminApiBroadcast`/`adminApiBroadcastTest`/`adminApiSetTempSchedule`/`adminApiOwnerChannelTest`。
- `renderMessagePage_` と `doGet` の `case 'message'`。
- `renderDecisionPage_` と `doGet` の `case 'approve'`/`case 'decline'`。
- `doGet` の `case 'admin'`（`HtmlService.createTemplateFromFile('admin')`）と **`gas/admin.html` ファイルごと削除**。
- `adminExecUrl_` 関数と `ADMIN_EXEC_URL` 参照。
- `diag()` の②固有ログ2行（`ADMIN_EMAILS` / `Session.getActiveUser()`）。
- `doGet` は残 case（`availability`/`booking`）のみの簡潔な switch に整理。

## 残したもの（②依存でない・現行）
- `requireAdminToken_`（bearer `ADMIN_TOKENS`）とそれで保護された doPost 管理ハンドラ群。
- `messageInfoBySig_`/`messageSendBySig_`（改修⑤）。`decideBySig`/`decide_`/`adminDecision_`。
- `doGet('availability')`/`doGet('booking')`。`adminEventDescription_`（⑤で front 基底に張替済）。
- `adminOwnerChannelTest_`（実体・doPost `ownerChannelTest` から `requireAdminToken_` 経由で使用）。ラッパ `adminApiOwnerChannelTest` のみ撤去。
- 通知系・`deployNotify`/`notifyDeploy_`・`decisionBaseUrl_`。

## PUBLIC_EXEC_URL / publicExecUrl_ の判断
- `adminExecUrl_` 撤去後、`publicExecUrl_`/`PUBLIC_EXEC_URL` の残る参照は `diag()` のログ表示のみ。
- これは②（Googleログイン）依存ではなく①の `/exec` URL 固定用のため、**②撤去のスコープ外＝残置**とした。docs では「現在は `diag` ログでのみ参照する任意キー」に整理。
- diag の該当ログ文言「承認リンクbase」は front 移行後に実態とズレるが、診断ログの整理は本工程スコープ外のためコードは触らず、報告で判断を仰ぐこととした。

## docs 改訂（②・ADMIN_EXEC_URL・ADMIN_EMAILS・requireAdmin・admin.html を削除し、単一デプロイ＋front 管理/メッセージ＋ADMIN_TOKENS に統一）
- `docs/SETUP.md`: Script Property 表の `ADMIN_EMAILS` 行を **`ADMIN_TOKENS`（bearer）に置換**（P1/P2 で導入済みだが docs 未記載だった漏れを補完）。`ADMIN_EXEC_URL` 行を削除。`PUBLIC_EXEC_URL` を「diag ログ専用の任意キー」に整理。②管理デプロイ作成手順（G-4）と `?action=admin` を削除し、G を単一デプロイ①に整理。チェックリストも更新。
- `docs/RESERVATION_PLAN.md`: 「管理・承認」を front `/reserve/admin`（bearer `ADMIN_TOKENS`）＋ front `/reserve/decision` に更新。Script Properties の「管理者メール許可リスト」→「管理トークン」。「作るもの」の管理画面を GAS HTML Service → front + bearer に、単一デプロイ①へ更新。
- `gas/README.md`: `admin.html` 行削除。「デプロイは2系統」→「デプロイは単一（公開ウェブアプリ①のみ）」。「管理者ユーザーの登録・管理（ADMIN_EMAILS）」節 →「管理トークンの発行・運用（ADMIN_TOKENS）」節に差替。エンドポイント早見を front POST アクション表に更新。Script Properties の `ADMIN_EMAILS`→`ADMIN_TOKENS`。承認/辞退節を front `/reserve/decision` + POST decide に更新。動作確認を front `/reserve/admin` に更新。

## 検証
- 撤去シンボルの残存参照: `requireAdmin_(`/`renderMessagePage_(`/`renderDecisionPage_(`/`adminExecUrl_`/`ADMIN_EXEC_URL`/`ADMIN_EMAILS`/`adminApi`/`createTemplateFromFile`/`getActiveUser` は **コード側（gas/*.gs・src/）で 0 件**（残るのは Code.gs 内コメントの歴史的言及のみ・ダングリング参照なし）。`gas/admin.html` は削除済み。
- `node --check`（Code.gs を .js コピー）構文 OK。`pnpm run build` 成功、`/reserve/{admin,decision,manage,message}/index.html` を生成。
- doGet=`availability`/`booking` のみ、doPost=`createBooking`/`cancelBooking`/`changeBooking`/`lineLogin`/`liffVerify`/`decide`/`messageInfo`/`messageSend`/管理系（bearer）/`deployNotify` が全て健全（参照先関数は残存）。
- 個人情報・秘密（トークン/メール実値・APIキー）の混入なし。
- 差分: `gas/Code.gs`（+16/-180）・`gas/admin.html` 削除（-724）・`docs/SETUP.md`・`docs/RESERVATION_PLAN.md`・`gas/README.md`。

## 未了・上告事項（本工程外）
- **コミット / push / clasp push / デプロイ / Apps Script UI の②デプロイ削除は未実施**（本人立会いで実施）。②デプロイ削除は不可逆操作。
- **`docs/DEV_NOTES.md`・`docs/WBS.md` は未変更**。両者は日付付きの歴史記録（DEV_NOTES=②時代の getActiveUser トラブルシューティング、WBS=Phase 1「2系統デプロイ」/Phase 5「admin.html 無料枠表示」の完了内訳）で、撤去済みシンボルを「現行」として記述している。歴史記録を後から書き換えるべきか、front/bearer 移行済みの注記を足すか、WBS に改修⑥行を追記するかは、本人の運用方針確認が要るため独断で触らず判断を仰ぐ。
- ②撤去後の Script Property `ADMIN_EXEC_URL`・`ADMIN_EMAILS` は GAS 側で不要になったが、Script Properties からの削除は本人操作（本工程はコード＋docs のみ）。
