# 2026-07-09 P2 顧客管理ページ化（台帳ベース MVP）

## 背景（なぜ）
ADR-0001（Accepted）決定1の4区分 IA のうち、これまで「準備中」だった **顧客管理** を実ページ化する
P2 の続き。ハブ（`/reserve/admin`）の顧客カードは非リンクの「準備中」、今日の帯の「顧客数」は「—」の
ままだった。今回これを **顧客台帳シート（LEDGER_SHEET）だけを素材にした最小ページ**（台帳ベース MVP）
として起こす。作業ブランチ: `develop`。**未push（本人GO事項）**・**dev のみ／prod は一切触らない**。

## スコープの確定（本人確定＝台帳ベース MVP）
- 既存の顧客台帳（`ledgerUpsert_` が確定予約ごとに 1 行更新する）だけを読む read-only ページ。
- 来店履歴の **明細（日付＋メニュー）は台帳に無い** ため今回は作らず「準備中」で正直に未接続にする
  （明細はカレンダー集約＝別 PL）。作話しない・空箱を出す流儀（ハブの「今日の予約＝準備中」と同じ）。

## 変更ファイル
- `gas/Code.gs`（+43行・**追加のみ／既存関数は 100% 不変**）… read-only の `adminListCustomers_()` を
  台帳セクション（`ledgerUpsert_` の直後）に新設。doPost に `case 'adminListCustomers'`（`listPending` の
  並び）を1行追加。`requireAdminToken_` で保護（`listPending`/`getQuota` と同型）。
- `src/worker/routes/action.js`（+1/-1）… `ALLOWED_ACTIONS` に `'adminListCustomers'` を追加。他は不変。
- `src/pages/reserve/admin/customers.astro`（新規）… 顧客管理ページ。一覧（電話常時マスク）＋在ページ詳細
  パネル（PII 段階開示）。`prerender=false`（リテラル）・URL は `/reserve/admin/` 配下固定。
- `src/styles/admin-cabinet.css`（+64行）… 顧客一覧/カルテ/PII 開示/来店履歴のクラスを追記
  （`.clist`/`.tag`/`.krt`/`.field`/`.pii`/`.mini-btn`/`.reveal-note`/`.hist` 等）。admin.css は肥大させない。
- `src/pages/reserve/admin.astro`（+29/-12）… 顧客カードをリンク化（→`/reserve/admin/customers`）、
  ハブの並列取得に `adminListCustomers` を追加、今日の帯「顧客数」を実数化（失敗時 `—` フォールバック）。
- 再利用（無改修）: `src/lib/admin-api.js`・`src/lib/admin-ui.js`・`src/components/AdminHeader.astro`。

## データモデル（`ledgerUpsert_` と対応）
`col0 key`（`line:` / `phone:<正規化=数字のみ>` / `email:<小文字>`）／`col1 type`／`col2 name`／
`col3 firstVisit`／`col4 count`／`col5 lastVisit`／`col6 note`。
`adminListCustomers_` は各行を `{name,type,count,firstVisit,lastVisit,tag}` に写像し、`tag = count<=1 ? '新規' : '常連'`。
連絡先は key の `type:value` の value 部から復元（phone→正規化数字、email→小文字、line→連絡先なし）。
`lastVisit` 降順ソート。`ledgerSheet_()` が null（LEDGER 未設定）なら `{ok:true, customers:[]}`（作話しない）。

## 設計判断（選択肢・理由）
- **台帳ベース MVP を選んだ理由**: 来店履歴の「明細」は台帳（1顧客1行の集計）に無く、カレンダーの確定
  イベント群を顧客キーで集約する別供給（`adminListConfirmed_` 系）が要る＝別 PL。今 PL は既存台帳だけで
  出せる「一覧＋素性＋段階開示」に絞り、明細は準備中で正直に示す（機能を一気にやらず最小単位で刻む）。
- **PII 段階開示は ADR-0001 決定3 準拠**: 一覧＝電話は phone 型のみ常時マスク（`090-****-1234`。line/email 型は
  電話欄「—」）／詳細＝既定マスク→[表示]で開示＋[コピー]表示＋**放置で自動再マスク（20秒目安）**。
  一覧に生の連絡先を晒さない P1 のセキュリティ思想を UI で徹底。電話整形（正規化数字→ハイフン付き）は
  フロントで（11桁のみ 3-4-4、想定外桁は整形せずそのまま＝作話しない）。
- **詳細は「在ページのパネル」で開く（URL に顧客キーを出さない）**: プライバシー（のぞき見・履歴/共有 URL
  への PII 露出回避）と Cookie Path=/reserve/admin 制約の両面で有利。行タップで list を隠し detail を表示、
  「‹ 一覧へ戻る」で戻す。
- **`adminListCustomers_` は read-only**: シート書き込み・カレンダー変更・通知・PII 外部送出を一切しない。
  `requireAdminToken_` で保護（Worker セッション Cookie→Worker が管理トークンを添えて GAS。ブラウザは
  管理トークンを持たない）。
- **ハブの顧客数を実数化しつつ、今日の予約件数は「—」＋準備中のまま**: 顧客数＝`customers.length` は
  台帳から出せる。今日の予約件数は供給 API 未実装のため据え置き（変えない）。並列取得は顧客取得の失敗が
  承認待ち/残枠表示を巻き込まないよう、Promise.all 全体の reject 時のみ各セルを `—` にする素直な構成。

## 検証（ローカル・push 不要・GAS は叩いていない）
- **既存 GAS 関数無改変**: `git diff --stat gas/Code.gs` = **43 insertions・0 deletions**（純追加）。
  `createBooking_`/`createBookingCore_`/`adminCreateBooking_`/`adminListPending_`/`ledgerUpsert_` 等に変更なし。
- **3点そろい**: `function adminListCustomers_`（Code.gs:969）・`case 'adminListCustomers'`（Code.gs:174）・
  `ALLOWED_ACTIONS` の `'adminListCustomers'`（action.js:12）。
- **GAS 構文**: `.gs` を一時 `.js` にコピーして `node --check` → OK（ES5/plain JS）。
- **`pnpm build` 成功**（環境変数なし＝CI 模擬）。配信種別が期待どおり:
  - `dist/client/reserve/admin/customers/index.html` は **不在**（＝オンデマンド＝middleware ゲート対象）。
  - `dist/client/reserve/admin/login/index.html` は **在る**（静的公開ゲート）。admin 配下の静的成果物は login のみ。
  - 公開ページ（index/reserve/manage/decision/message/privacy）は静的維持（無回帰）。
  - server バンドルに `dist/server/chunks/customers_*.mjs` が生成され、manifest 登録数は reservations と同数（15）。
- **PII・ダミー名・secret 混入なし**: モックのダミー名（山田花子 等）検出なし。secret/token の実値なし
  （検出は仕様コメントとサロン公開代表番号 `tel` のみ＝顧客 PII ではない）。
- **未 push / 未 clasp**: `git rev-list origin/develop...develop` = `0 0`（コミット前時点）。clasp push/deploy は未実施。

## 次 PL に残した事項
- **来店履歴の明細（日付＋メニュー）**: GAS にカレンダーの確定イベントを顧客キーで集約する
  `adminListConfirmed_`（仮）系を新設し、詳細パネルの「準備中」を実データに置換する。台帳 key（line/phone/email）
  と確定イベントの照合方法（正規化電話・LINE userId 等）を設計する必要あり。
- **ハブ「今日の予約件数」の実数化**: 上記の確定一覧供給ができれば当日分で実数化できる（今は「—」＋準備中）。
- **実 GAS 往復 E2E**: dev push（本人GO）後に、実台帳での一覧取得・空台帳フォールバック・段階開示の実機確認。
- **本人GO事項（不可逆）**: `develop` の push・dev の clasp push/deploy・Workers Builds への反映。prod は対象外。

## 申し送り（本 PL では未実施＝範囲外）
- push / clasp push / clasp deploy はすべて**本人GO後にクロコが実行**（本作業はローカルコミットまで）。
