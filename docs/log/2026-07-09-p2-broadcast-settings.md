# 2026-07-09 P2 一斉通知・設定のページ化（集約 tools を2区分へ分割）

## 背景（なぜ）
ADR-0001（Accepted）決定1の4区分 IA のうち、これまで集約ページ `tools.astro`（529行）に
5機能が menu-btn タブ切替で同居していた最後の塊を、独立ページへ切り出す P2 の続き。
予約管理（reservations）・顧客管理（customers）は先行してページ化済み。今回で残る
「一斉通知」「設定」も区分ページになり、集約ページ tools を撤去して4区分 IA が揃う。
作業ブランチ: `develop`。**未 push（本人GO事項）**・**dev のみ／prod・GAS・clasp は一切触らない（GASゼロ改修）**。

## 区分割り当ての判断（ADR-0001 決定1 準拠）
tools.astro の5機能を、ADR-0001 決定1の区分定義とハブ設定チャートの自称ラベル
「受付枠・通知先・臨時営業」に従って2ページへ分けた:
- **一斉通知（`/reserve/admin/broadcast`）** ＝ `broadcast`（一斉送信）＋ `quota`（LINE無料枠）
  - quota を同居させる理由: 一斉送信が LINE 無料枠を消費するため「送る前に残枠を見る」動線が自然
    （ADR-0001 決定1 の理由と同じ）。配置に設計分岐なし＝ADR で確定済み。
- **設定（`/reserve/admin/settings`）** ＝ `schedule`（臨時営業・休業）＋ `slotconfig`（受付枠設定）
  ＋ `ownertest`（オーナー通知 接続テスト）

## 変更ファイル
- `src/pages/reserve/admin/broadcast.astro`（新規・約270行）… 一斉通知ページ。tools の broadcast＋quota
  セクションと対応 JS を一字一句移設。`prerender=false`（リテラル）・`AdminHeader back="/reserve/admin"`・
  `admin.css`＋`admin-cabinet.css` を import（reservations.astro と同じ積み上げ作り）。
- `src/pages/reserve/admin/settings.astro`（新規・約340行）… 設定ページ。tools の schedule＋slotconfig＋
  ownertest セクションと対応 JS を一字一句移設。同上の作り。
- `src/pages/reserve/admin.astro`（+2/-2）… ハブの一斉送信チャート導線を `/tools`→`/broadcast`、
  設定チャート導線を `/tools`→`/settings` に繋ぎ替え。
- `src/pages/reserve/admin/tools.astro`（削除・-529行）… 5機能が全て新2ページへ移ったため撤去。
- 再利用（無改修）: `src/lib/admin-api.js`・`src/lib/admin-ui.js`・`src/components/AdminHeader.astro`・
  `src/components/EnvBadge.astro`・`src/components/SubmitOverlay.astro`・`src/styles/admin.css`・
  `src/styles/admin-cabinet.css`。**GAS（gas/Code.gs）・action.js は一切触らない**（新 action / 新 GAS 関数ゼロ）。

## 挙動不変と「唯一の意図的差分」
- 各セクションの HTML（id・class・aria）とそれに紐づく JS 関数（broadcast の送信/プレビュー/試し送信、
  quota の loadQuota/render、schedule の登録、slotconfig の枠 CRUD、ownertest の接続テスト）は
  tools.astro から**改変せず移設**。共有ヘルパ（createAdminApi/esc/createToast/loadingHtml/emptyHtml/
  handleForbidden）も再利用。403 は `handleForbidden()` で既存どおり。ログアウト（#logoutBtn）も維持
  （customers.astro と同じ・panel-bar）。
- **唯一の意図的差分＝タブ撤去**: tools では menu-btn / SECTIONS / showSection でセクションを出し入れし、
  `quota`/`slotconfig` を「タブ初回表示時に遅延ロード」していた。積み上げレイアウトではタブが無いため、
  ①各セクションの `hidden` 属性を外して常時表示にし、②遅延ロードしていた `loadQuota()`（broadcast ページ）
  ／`loadConfig()`（settings ページ）を **init 時に即時呼び出し**に変えた（同じデータ・同じタイミングの即時化）。
  menu-btn / SECTIONS / showSection の切替機構は各新ページから撤去。
- JS の分割: broadcast ページには broadcast＋quota の JS のみ、settings ページには schedule＋slotconfig＋
  ownertest の JS のみを載せた。両群に相互依存は無く（共有は el / apiPost / toast など純ヘルパのみ）、綺麗に分離。

## 検証（ローカル・push 不要・GAS は叩いていない）
- **prerender リテラル**: `grep` で broadcast.astro:13・settings.astro:13 とも `export const prerender = false;`
  がリテラルで在ることを確認。
- **`pnpm build` 成功**（環境変数なし＝CI 模擬）。prerendering static routes に出るのは
  `/reserve/admin/login/index.html` のみ（broadcast/settings/tools は出ない）。
- **配信種別が期待どおり**:
  - `dist/client/reserve/admin/broadcast/index.html`・`settings/index.html` は **不在**
    （＝オンデマンド＝middleware ゲート対象＝正）。
  - `dist/client/reserve/admin/login/index.html` は **在る**（静的公開ゲート）。admin 配下の静的成果物は login のみ。
  - `dist/client/reserve/admin/tools/` は **消えている**（撤去確認）。
  - server バンドルに `broadcast_*.mjs`・`settings_*.mjs` が生成（オンデマンドルートとして登録）。
- **`/tools` 参照ゼロ**: `grep -rn "admin/tools" src/` = 該当なし（ハブ導線の繋ぎ替え完了）。
- **ダミー名・secret 混入なし**: モックのダミー名検出なし。連絡先は公開代表番号 `tel`（顧客 PII ではない）のみ。

## 次にやること・残した事項
- **実 GAS 往復 E2E（実ブラウザ）**: dev push（本人GO）後に、一斉送信のプレビュー/試し送信、LINE 無料枠表示、
  臨時営業・休業登録、受付枠 CRUD、オーナー通知テストの実機確認。**push が要るため今回は未実施**。
- **本人GO事項（不可逆）**: `develop` の push・dev の Workers Builds 反映。prod は対象外。

## 申し送り（本 PL では未実施＝範囲外）
- push はすべて**本人GO後にクロコが実行**（本作業はローカルコミットまで）。clasp push / deploy は不要（GASゼロ改修）。
