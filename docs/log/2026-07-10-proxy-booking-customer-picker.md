# 代理予約：お客様を「顧客一覧から選択」＋顧客PII参照の監査ログ配線

- 日付: 2026-07-10
- 対象: dev のみ（scriptId `1StLUSf…` / `wasyo-dev`）。prod（wwwasyo.com）は未変更。
- 種別: 機能追加（フロント）＋監査ログ配線（GAS）。アーキ変更なし。

## 背景・目的

代理予約フォーム（`/reserve/admin/reservations`「代理で予約を入れる」）は、お名前・電話・メールを毎回手入力していた。常連客の予約を電話で受けるたびに打ち直すのは手間で誤入力も起きる。既存の顧客台帳を選択元にして、フォームへ流し込めるようにする。

## 調査で判明した肝（既存資産の再利用でアーキ変更不要）

`adminListCustomers`（GAS `adminListCustomers_`・read-only・Worker 経由・`requireAdminToken_` 保護・`ALLOWED_ACTIONS` 登録済み）は、フロントが表示上マスクしているだけで、**返却 JSON に名前・電話・メールの実値**を含む（`name` / `phone`＝正規化数字 / `email` / `key`＝SHA-256 の opaque 突合トークン）。
→ 新規データ API もアーキ変更も不要。代理予約フォームからこの既存 API を呼び、選んだ顧客を `#agentName`／`#agentPhone`／`#agentEmail` に autofill するだけ。

## 本人確定の方針（2026-07-10）

1. **選択モーダルの一覧では電話を伏字**（名前・新規/常連・最終来店日で選ぶ）。選択したらフォーム欄へ実値を注入＝画面に電話を一覧で並べない（既存 `customers.astro` の常時マスク方針と一貫・のぞき見耐性）。
2. **LINE 連携客（台帳に電話・メール無し）も一覧に出す**。選ぶと名前は入るが電話欄は空＝「電話は手入力してください」を明示。
3. **顧客 PII を参照した代理予約は監査ログに残す**（当初「配線しない」だったが本人が方針変更）。

## 実装

### フロント `src/pages/reserve/admin/reservations.astro`（フロントのみ）
- お名前欄に「顧客一覧から選ぶ」ボタン＋選択中チップ。ネイティブ `<dialog>`（TimeDialog 同様）で顧客選択モーダル：`apiPost('adminListCustomers', null, {silent:true})` → 名前部分一致の検索＋行リスト。**電話は `maskPhoneCell`（customers.astro と同等）で常に伏字**、LINE 等連絡先なしは「連絡先なし」を明示して出す。
- 行選択で `#agentName`／`#agentPhone`（実値・LINE 客は空）／`#agentEmail` を autofill。選択中は「○○さんを選択中／解除」表示、電話が空なら手入力を促す。解除で控え・autofill 値をクリアして手入力へ戻す。
- 送信ペイロードは**選択由来のときだけ** `pickedKey`（一覧が返す opaque `key` を echo）を添付。**生の電話・識別子は送らない**。
- `export const prerender = false;` は現状維持。`src/worker/routes/action.js` は無改変（`adminListCustomers`/`adminCreateBooking` は既に許可済み・新規 payload は素通し）。

### GAS `gas/Code.gs` `adminCreateBooking_`
- 予約確定・通知の後、`return res;` の直前に既存土台 `auditPush_` を1行配線：
  `auditPush_(tokenFp_(b.adminToken), b.pickedKey ? 'proxyBook:picked' : 'proxyBook:manual', b.phone, res.ok ? 'ok' : 'ng');`
  - operator＝`tokenFp_`（HMAC 指紋・生トークンは残さない）。op＝`proxyBook`（土台が最初から想定列挙）を picked/manual で区別。target＝`b.phone`（`auditPush_` 内 `maskId_` が末尾4桁マスク）。
  - `auditPush_` は try/catch 済み・`LEDGER_SHEET_ID` 未設定なら no-op＝監査失敗が予約本体を巻き込まない。副作用なしで最後に呼ぶだけ。
- 配信コア・必須通知発火点・`decide_`・`constEq_`・`adminListCustomers_` 本体・`auditPush_`/`tokenFp_`/`maskId_` 土台は無改変。

## 検証

- ローカル `pnpm build` 成功（回帰なし・クロコが実体実行）。
- diff 実体裏取り：GAS は監査1行のみ・action.js 差分空・`prerender=false` 維持・`pickedKey` は opaque key のみ echo。
- dev 実機 E2E（配備後・本人）：モーダル電話伏字→選択で実値注入／LINE 客は電話空＋手入力促し／選択予約で台帳「監査ログ」シートに `proxyBook:picked` 行が増える／手入力のみは `proxyBook:manual`／手入力フロー・通常予約・必須通知は回帰なし。

## 配備（本人 GO・不可逆）

- フロント＝git push（dev develop）→ Workers Builds が dev 自動デプロイ。
- GAS＝`clasp push` ＋ `clasp deploy --deploymentId AKfycbz…`（versioned・/exec URL 維持・bare deploy 禁・デプロイ数2維持）。
- prod（wwwasyo.com）は将来の本番切替（PR-C/D）の系譜で別途。
