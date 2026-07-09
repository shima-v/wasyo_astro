# 2026-07-09 P2 確定予約の集約（来店履歴／今日の件数）

## 背景（なぜ）
前 PL（`2026-07-09-p2-customers.md`）で顧客管理ページを台帳ベース MVP として起こした際、
「次 PL に残した事項」として明記していた 2 点をここで実装する:
1. 顧客詳細の **来店履歴（来店ごとのメニュー明細）**。前 PL では詳細パネルが
   `emptyHtml('来店ごとのメニュー明細は準備中です…')` のプレースホルダだった。
2. ハブ（`/reserve/admin`）の **今日の予約件数の実数化**。前 PL では「今日の予約＝—／準備中」だった。

いずれも素材は **Google カレンダーの確定イベント**（`【確定】…`・`createBookingCore_` が作る）。
台帳（1 顧客 1 行の集計）には来店明細も当日件数も無いため、カレンダーの確定イベントを
read-only で集約する供給 API が要る＝本 PL。作業ブランチ: `develop`。**未 push（本人GO事項）・dev のみ／prod は一切触らない**。

## スコープ
- GAS に read-only の確定集約関数 `adminListConfirmed_` を **新設（純追加）**。2 用途を引数で分岐。
- 顧客詳細で来店履歴を実データ化、ハブで今日の予約件数を実数化。
- **既存 GAS 関数は 100% 不変（追加のみ）**。`adminListCustomers_` にのみ突合キーを **追加フィールド**として足す（挿入だけ＝既存行の削除・改変ゼロ）。

## 変更ファイル
- `gas/Code.gs`（+63 行・**追加のみ／削除 0**）
  - `adminListConfirmed_(params)` を新設（確定集約セクション・`ledgerDateStr_` の直後）。
    `requireAdminToken_` 保護。`CalendarApp.getEvents` と `MENU` 参照のみ＝**書込・送信・外部 fetch なし**。
  - `params.scope==='today'` → `getEvents(startOfDay, +1日)` の confirmed を数え `{ok,count}` だけ返す（PII なし）。
  - `params.key` → 過去 `CONFIRMED_HISTORY_MONTHS`（=12・定数）〜今後の窓で、`hashKey_(ledgerKey_(getEventProps_(ev)))===key`
    の confirmed だけを `[{date,time,menuName}]` に写像し新しい順で返す。**その顧客の来店だけ**（他人を混ぜない）。
  - doPost に `case 'adminListConfirmed'`（`listPending` と同型・`requireAdminToken_` 保護）を追加。
  - `adminListCustomers_` に来店履歴突合用の **追加フィールド `key`（台帳キーの SHA-256 hex＝opaque 突合トークン）**
    を返す純追加（既存フィールド・挙動は不変）。ハッシュ助関数 `hashKey_` を新設し両 API で共用。
- `src/worker/routes/action.js`（+1/-1）… `ALLOWED_ACTIONS` に `'adminListConfirmed'` を追加。他は不変。
- `src/pages/reserve/admin/customers.astro`（+45/-3）… 詳細を開くたびに `adminListConfirmed({key})` を呼び、
  来店履歴プレースホルダを実データ（日付・時刻・メニュー名の新しい順リスト）に差し替える。0 件・失敗・403 を正直に処理。
- `src/styles/admin-cabinet.css`（+7/-1）… 来店履歴リスト（`.hist__list`/`.hist__item`/`.hist__date`/`.hist__time`/`.hist__menu`）。
- `src/pages/reserve/admin.astro`（+26/-11）… 並列取得に `adminListConfirmed({scope:'today'})` を追加、
  今日の予約を `count` で実数化、「準備中」表記を撤去。取得失敗時は「—」フォールバック。

## 設計判断（選択肢・理由）
- **1 関数 2 用途（scope / key で分岐）**: ハブは件数だけ（PII なし・軽量）、詳細は当該顧客の明細だけ。
  用途ごとに payload と計算コストを最小化し、確定集約のロジックを 1 か所に集約する。
- **顧客突合キー＝台帳キーの SHA-256 hex（opaque トークン）を echo（本人判断で採用／後述）**。指定トークンに
  一致する確定イベントだけをサーバ側でフィルタして返す＝**他人の来店履歴は payload に載せない**（PII 最小化）。
  生の識別子（lineUserId・電話・メール）は突合トークンとして出さない。
  「全確定予約を一括返却してクライアント名寄せ」方式は他人の履歴も載るため採らない。
- **遡り期間 12 ヶ月（既定・定数 `CONFIRMED_HISTORY_MONTHS`）**: 常連の来歴を実用的に見せつつ窓を有限化。
  後で調整可。窓 = 過去 12 ヶ月〜今後（`RULES.maxAdvanceDays+1`）＝**今後の確定予約も履歴に含める**。
  → パフォーマンス懸念（窓が広い）が実機で出れば期間短縮または月別ページングを検討（**未確認・要実機観測**）。
- **来店履歴は詳細を開くたびに取りに行く**: 一覧段階で明細 PII を持たない段階開示の思想を維持
  （前 PL の連絡先マスクと同じ流儀）。取得中に別詳細へ切り替わったら反映を破棄するレース対策を入れた。
- **既存 GAS 関数は無改変**: 初回 API コミットは純追加（63 insertions・0 deletions）。ハッシュ手戻りで
  `adminListCustomers_` の `key` 生成（`hashKey_(key)`）と `adminListConfirmed_` の突合行は変わるが、これらは
  いずれも当 PR で自分が足した新規コード。`createBookingCore_`/`adminListPending_`/`ledgerUpsert_`/`decide_` は
  1 バイトも触っていない。

## PII 判断点【本人判断で決着＝opaque ハッシュ化を採用】
来店履歴の突合には、顧客詳細から確定イベントへ渡す**突合キー**が要る。当初は台帳キー
（`line:<lineUserId>` / `phone:<正規化電話>` / `email:<小文字>`）を生のまま返し client が echo する
実装で、**`line:` 型の顧客のみ `lineUserId` がクライアントに新規露出**する点を本人確認事項とした。

**本人判断＝生の識別子を突合トークンとして出さない opaque ハッシュ化を採用**（PII 最小化）。追実装:
- GAS に助関数 **`hashKey_(rawKey)`** を新設＝台帳キーを `Utilities.computeDigest(SHA_256, rawKey)` の
  hex 文字列に一方向化（空文字は空文字）。ゲート内の owner 自身のデータで脅威モデルが小さいため素の
  SHA-256 hex で十分（salt/HMAC なし）。
- `adminListCustomers_` の返す `key` を **`hashKey_(台帳キー)`** に変更＝**生の識別子（lineUserId・電話・メール）は
  突合トークンとして出さない**。表示用の `phone`/`email` フィールド（段階開示の正規表示）はそのまま。
- `adminListConfirmed_`（`params.key` 突合）を **`hashKey_(ledgerKey_(getEventProps_(ev))) === key`** に変更
  ＝イベント側も同じハッシュにしてから突合。**両 API で同一 `hashKey_` を使う**（一致必須）。`scope:'today'` 側は不変。
- フロントは `c.key`（ハッシュ）をそのまま echo するだけ＝機能変更なし（コメントを「突合トークン」表記に修正）。
- **実証**: node で SHA-256 hex を再現し、`line:`/`phone:`/`email:` の生値は 64 文字 hex に一方向化されて
  payload に出ない・同一入力は決定的に一致することを確認（詳細は下の検証節）。
- line 顧客も、この opaque トークンで来店履歴を引ける（生 lineUserId は出さない）。突合トークンが空の顧客は
  履歴を引けない旨を UI で明示（作話しない）。

## 検証（ローカル・push 不要・GAS は叩いていない）
- **既存 GAS 関数無改変**: 初回 API コミットの `git diff --stat gas/Code.gs` = **63 insertions・0 deletions**。
  ハッシュ手戻りコミットの diff も `createBookingCore_`/`adminListPending_`/`ledgerUpsert_`/`decide_` を
  1 バイトも触らず、変更は自分が足した新規コード（`hashKey_` 新設・`adminListConfirmed_`/`adminListCustomers_` の
  `key` の作り方）だけに限る（既存関数名は「雛形にした」旨のコメント参照のみ）。
- **突合トークンのハッシュ化（実体）**: `git diff` で client に返る `key` が `key: key`（生）→ **`key: hashKey_(key)`**
  に変わり、`adminListConfirmed_` の突合も `hashKey_(ledgerKey_(...)) === key` に変わったことを確認＝
  payload に `line:`/`phone:`/`email:` の生値が突合トークンとして出ない。**両 API で同一 `hashKey_`** を使用
  （`adminListCustomers_`: `key: hashKey_(key)` ／ `adminListConfirmed_`: `hashKey_(ledgerKey_(getEventProps_(ev)))`）。
- **ハッシュの opaque 性・決定性（node 実証）**: SHA-256 hex を再現し、`line:U…`/`phone:0901…`/`email:…@…` は
  いずれも 64 文字 hex に一方向化され原文字列を含まない・空文字は空文字・同一入力は決定的に一致することを確認。
- **read-only 裏取り**: `adminListConfirmed_` 本体に `setValue`/`appendRow`/`setProperty`/`createEvent`/`setTag`/
  `UrlFetchApp`/`MailApp`/`linePush_`/`notifyOwner_`/`postDiscord_` 等の書込・送信・fetch は**検出ゼロ**（手戻り後も維持）。
  使用は `getEvents`/`MENU`/`getEventProp(s)_`/`ledgerKey_`/`hashKey_`（`Utilities.computeDigest` のみ）/`fmt_`/
  `startOfDay_`/`addDays_`/`setMonth`。`hashKey_` も Utilities の計算のみで副作用なし。
- **GAS 構文**: `cp gas/Code.gs /tmp/x.js && node --check` → OK。
- **`pnpm build` 成功**。配信種別が期待どおり:
  - `dist/client/reserve/admin/customers/index.html`・`admin/index.html` は **不在**（＝オンデマンド＝ゲート対象）。
  - `dist/client/reserve/admin/login/index.html` は **在**（静的公開ゲート）。
  - `prerender = false`（リテラル）は admin.astro・customers.astro とも維持。server chunk（customers/admin）生成。
- **PII・ダミー名・secret 混入なし**: 追加行にモックのダミー名（山田花子 等）・secret 実値・実電話番号の混入なし
  （`tel` はサロン公開代表番号のみ＝顧客 PII ではない）。顧客 PII はランタイムで GAS から取得しリポに残さない。
- **未 push / 未 clasp**: コミットはローカルのみ。clasp push/deploy・git push は未実施（本人GO事項）。
- **実 GAS 往復 E2E（実ブラウザ）は未実施**: dev push が要るため今回は範囲外（本人GO後に実台帳・実カレンダーで
  来店履歴取得・当日件数・0 件フォールバック・line 顧客の突合を実機確認）。

## 次 PL／残した事項
- **実機 E2E**（dev push 後）: 来店履歴の実データ表示・当日件数・0 件/失敗フォールバック・line 顧客の
  opaque トークン突合（ハッシュ一致で正しく履歴が引けるか）。
- **遡り期間の再評価**: 12 ヶ月窓のパフォーマンス実測（広ければ期間短縮/月別ページング）。
- **突合方式は決着**: 本人判断で opaque ハッシュ化を採用済み（生の識別子は非露出）。
- **本人GO事項（不可逆）**: `develop` の push・dev の clasp push/deploy・Workers Builds 反映。prod は対象外。
