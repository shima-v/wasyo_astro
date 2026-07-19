# person/channel identity層 — Phase 2（反映前検証・#17）2026-07-18

顧客名寄せ機能（#17）を **本番（`main`／prod GAS／prod台帳）へ反映する前の P0 反映前検証**の記録。作業ブランチは検証対象＝`develop`（tip `4a4a0f6`）。本ログ時点で **commit・push・clasp push・prod への操作はいずれも未実施**（すべて本人GO事項）。

## 何を反映しようとしているか（#17 後半コミット）

Phase 1（土台＝`2026-07-13-person-identity-phase1.md`）の person/channel 分離の上に積んだ、名寄せ本体と顧客一覧の編集群。`develop` の main 未昇格 13 コミット＝:

- **①氏名編集**（顧客一覧でお客様氏名を編集）
- **②連絡先の追加・編集・削除**（電話/メールの編集、LINE 客への電話追加、削除は **A案＝履歴を守る**＝アーカイブして count を残す）
- **③名寄せ**（本人同意の引き継ぎ導線＝お客様側入口②、店主の手動マージ UI、person 単位の重複表示解消、`handoverCheck`）
- 保存前の**確認モーダル**（「更新中…」表示）
- 移行 dry-run/apply ラッパー（`migrateDryRun` / `migrateApply`）

反映方針: `develop` 全体を `main` へ通常マージ昇格（fast-forward 不可・merge commit を作る）。

## 検証結果（クロコ／CTO が EXIT を自分で確認）

### 1. テスト green — EXIT=0・60 pass / 0 fail

`pnpm install --frozen-lockfile`（EXIT=0・Already up to date）→ `pnpm test`（`node --test "src/**/*.test.js"`）:

| テストファイル | pass | 区分 |
| --- | ---: | --- |
| `src/gas-tests/customer-contact.test.js` | 7 | #17 追加 |
| `src/gas-tests/customer-contact-archive.test.js` | 7 | #17 追加 |
| `src/gas-tests/customer-merge.test.js` | 9 | #17 追加 |
| `src/gas-tests/qa-customer-contact-archive.test.js` | 14 | #17 追加（独立QA観点） |
| **#17 小計** | **37** | |
| `src/worker/session-http.test.js` | 13 | 既存（session）|
| `src/worker/session.test.js` | 10 | 既存（session）|
| **既存 小計** | **23** | |
| **合計** | **60** | **fail 0** |

- **TEST_EXIT=0**（`# tests 60 / # pass 60 / # fail 0`）をクロコ自身が確認。
- Phase 1 ログの「23 pass」は **#17 の4本を追加する前**＝session 系のみの数。今回 #17 で **37 ケースが純増**し、既存 23 は不変＝**回帰ゼロ**。
- QA観点（`qa-customer-contact-archive.test.js` 14ケース）は削除＝アーカイブの安全側倒し（CALENDAR_ID 未設定・判定不能時は物理削除しない）、archived キーのキー予約継続、監査ログ（contactDelete/contactEdit）などをカバー。

### 2. ビルド green — EXIT=0

`pnpm build`（`astro build`）**BUILD_EXIT=0**。server 出力・`@astrojs/cloudflare` adapter・静的 7 ルート（`/privacy`・`/reserve` 各画面）prerender 完了。build 後の作業ツリーは clean（`dist/` 等は gitignore 済み）。

### 3. マージ衝突ドライラン — 衝突なし

`git checkout main && git merge --no-commit --no-ff develop`:

- 結果 **"Automatic merge went well; stopped before committing as requested"**（MERGE_EXIT=0）。
- **衝突ファイル 0**（`git diff --name-only --diff-filter=U` が空）。
- 変更 **12 ファイル・+3396 / −43**（`gas/Code.gs`・`src/gas-tests/*` 4本・`src/pages/reserve/admin/customers.astro`・`handover.astro`・`reserve/index.astro`・`manage.astro`・`src/styles/admin-cabinet.css`・`src/worker/routes/action.js`・Phase 1 ログ）。
- 事前想定の唯一の衝突候補 `src/pages/privacy/index.astro` は**変更一覧に出ない**＝ develop 側の同パッチ（`be651a2`）が既に main（`7d9eb3f`）へ取り込み済みで、そもそも衝突化しない。
- `git merge --abort` で **main `7d9eb3f`・作業ツリー clean に復元**（commit・push はしていない）。

## dev 素振り実施結果（2026-07-18・green）

本人が対話ターミナルで `clasp login` を再認可済み。以降はクロコが headless で実施し、EXIT を自分で確認した。

1. **認証確認（read-only）**: `.clasp.json` が dev を指すことを sha256 で再確認（prod と別ハッシュ・ACTIVE==dev）。`clasp list-deployments` が **EXIT=0**・「Found 2 deployments」（`@77`＝#17 の dev デプロイ）を返し、認証復活を確認。
2. **dev へ反映**: `git checkout develop`（`4a4a0f6`）→ **`clasp push -f`（dev のみ）**で `Code.gs`＋`appsscript.json` を反映（**PUSH_EXIT=0**・"Pushed 2 files"）。
3. **`migrateDryRun`（GAS エディタで Run・書き込みなし）の返り値**（非PII）:

   ```json
   {"ok":true,"dryRun":true,"total":16,"alreadyAssigned":16,"assigned":0,"nameCollisionGroups":2,"nameCollisionRows":[[12,14,15,16],[13,17]]}
   ```

   - `total=16` かつ `alreadyAssigned=16`・**`assigned=0`** ＝ dev台帳は**過去の実行で既に全行 col7 採番済み**。整合式 `total = alreadyAssigned + assigned`（16=16+0）も一致。
   - よって**冪等性を実データ上で直接確認**（既移行の台帳に対し dry-run が `assigned:0`＝再採番しない）。これは「二度流し `assigned:0`」の到達状態そのもの。
   - **`migrateApply` は no-op（assigned:0）**のため今回は実行省略（既移行済み＝書き込む対象が無い）。
   - `nameCollisionGroups=2`（行 [12,14,15,16] / [13,17]）＝同名グループ＝**将来の名寄せ候補。自動統合はせず報告のみ**。dev はダミー（マッサージ店統一）データのため対応不要。
4. **注意（正直な限界）**: dev が既移行だったため、**「assigned>0 → apply で実書き込み」の遷移は今回セッションでは再観測していない**。書き込みパスは #17 の 37 ユニットテスト（green）＋既に正しく採番済みの dev台帳の実在で裏付け。prod では `assigned>0` を実地に観測できる。

### `clasp run` が使えなかった経緯（記録）

`migrateDryRun`/`migrateApply` は **doPost の action ルーティングに無く HTTP 非露出**（コード自身のコメントが「GAS エディタで Run」を指定）。headless の `clasp run` は「Script function not found / API executable 未デプロイ」で不可（`appsscript.json` に `executionApi` 無し・`.clasp.json` に GCP `projectId` 無し＝有効化には GCP で OAuth クライアント作成＝ブラウザ必須）。一回きりの移行に見合わないため **GAS エディタで Run** を採用（本人の1手）。

### 返り値フィールドの意味（prod でも同じ）

- `total`（キーを持つ channel 行の総数）
- `alreadyAssigned`（既に personId〔col7〕を持つ行＝冪等カウンタ）
- `assigned`（今回 personId を採番した行。dry-run は「採番されるはずの数」）
- `nameCollisionGroups`（同名グループ数＝将来の名寄せ候補。自動統合はしない・報告のみ）
- **二度流しは `assigned:0`**（`alreadyAssigned == total`）＝冪等。`col0〜6`・カレンダーは不変。

## prod（`wasyo-prod` / prod GAS / prod台帳）— 別途本人GO・不可逆

- prod 台帳のスキーマ変更（col7 追加）＋移行は不可逆。**バックアップ必須・本人立会い**。※上記は7/18時点の計画。**7/19 に実施完了（下記「prod 反映実施結果」）**。

## prod 反映実施結果（2026-07-19・完了）

> 匿名化: scriptId / deploymentId のフル値・PII・氏名は載せない（版番号・件数のみ）。

**前提の訂正（重要）**: `wasyo-prod` は7/12の Cloudflare 統一移行で稼働済み・**Workers Builds が `main` 連携**。よって develop→main 昇格の `main` push（`9d34ca1`）で **#17 の"フロント"は自動で本番デプロイ済み**だった。一方 prod GAS は旧版（`@26`）のままで、新フロントが呼ぶ新 action（名寄せ/連絡先編集）が `unknown_action` になる不整合が発生。今回の GAS 反映でこれを解消。

- **① prod台帳バックアップ（本人）**: Drive で「和笑台帳-prod のバックアップ20260719」をコピー作成。※クロコの Drive 連携アカウントからは和笑台帳が別アカウント所有で不可視＝**控えの実在はクロコ側で独立検証できず・本人確認**。移行は col7 追加の加算的操作（列0〜6不変）ゆえリスクは限定的。
- **認証（RAPT 失効の切り分け）**: 7/18夜に成功した clasp 認証が日付跨ぎで `invalid_grant`/`invalid_rapt`（reauth）に。**dev も同時に弾かれた**ことで「prod 固有でなく再認証（RAPT）の期限切れ」と切り分け（平凡な説明が正解）。本人再ログイン → prod `list-deployments` EXIT=0 で復活確認。
- **② prod GAS push（クロコ）**: `.clasp.json`を `.clasp.prod.json` へ切替（sha256 で prod 一致確認）→ `clasp push -f`（`Code.gs`+`appsscript.json`・**PUSH_EXIT=0**）→ **dev へ復帰**。公開 `/exec` は `@26` 維持（HEAD のみ更新）。
- **③ prod台帳 col7 移行（本人・GAS エディタ）**:
  - `migrateDryRun` = `{total:29, alreadyAssigned:0, assigned:29, nameCollisionGroups:0}`（未移行の想定どおり・整合 29=0+29）。
  - `migrateApply` 1回目 = `{assigned:29, alreadyAssigned:0}`（29行に採番）／2回目（二度流し）= `{assigned:0, alreadyAssigned:29}`（**冪等**）。
  - **同名衝突 0** ＝ 手動名寄せ不要。列0〜6・カレンダーは不変。
- **④ prod deploy（クロコ）**: `clasp deploy -i <`@26`の versioned deploymentId> -d "#17 顧客名寄せ..."` → **同一 deployment が `@27` に版更新**（deployment 数は 2 のまま＝bare deploy を回避・`/exec` URL 不変）→ dev へ復帰。
- **⑤ ヘルスチェック（クロコ・読取のみ）**: `/exec` bare GET = HTTP200 `{unknown_action}`／`action=availabilityRaw` = HTTP200 で実データ返却＝**予約バックエンド正常**。管理画面新機能の目視は本人ブラウザ（別途）。
- **ロールバック**: 異常時は prod GAS を**直前 version（`@26`）へ再 deploy で即戻し**（version 保持）。台帳は①の控え。

## 匿名化（Phase 1 と同方針）

scriptId / deploymentId / secret / token / PII / 電話番号は本ログ・コード・検証コマンド出力に載せない（行番号・件数のみ）。

## 次

- dev 素振り／`develop`→`main` 昇格（`9d34ca1`）／`main` push／**prod 反映（②〜⑤）すべて完了（2026-07-19）**。
- 残: **本人ブラウザでの管理画面スモーク**（顧客一覧・氏名/連絡先編集・名寄せ UI が本番で動くこと／通常予約フロー）。`main` push 直後〜④前は旧 GAS（@26）で新 action がエラーだったため、ここが最終確認。
- 名寄せの実統合（同名顧客のマージ）は prod 同名衝突 0 のため当面不要。将来生じたらオーナーが UI で手動判断。
