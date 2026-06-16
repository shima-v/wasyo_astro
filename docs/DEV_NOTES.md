# 開発メモ・既知のハマりどころ（備忘録）

サロン和笑〜Violane〜 予約システム開発で実際に踏んだ落とし穴と対策の記録。
同種の事故を繰り返さないために、原因が非自明だったものをここに蓄積する。

- 設計: [`../RESERVATION_PLAN.md`](../RESERVATION_PLAN.md) ／ 進捗: [`../WBS.md`](../WBS.md) ／ GAS: [`../gas/README.md`](../gas/README.md)

---

## 2026-06-17 — 仮予約が「作成直後に勝手に消える」／承認リンクが not_found

### 症状
- フロント・curl どちらから `createBooking` しても `ok:true`＋token が返るのに、
  **数十秒後にはカレンダーからイベントが消え**、`?action=booking&token=...` が `not_found` になる。
- 店LINEの承認リンクをクリックすると `エラー: not_found`。
- ある予約では、作成直後の GET で一瞬 `status:"confirmed"` を返し、その後消滅、という挙動も観測。
- 空き枠（availability）でも、消滅後はその枠が**空きに戻る**（＝実際に削除されている）。

### 切り分け（重要・ここが学び）
1. `diagCal()`（GASエディタ実行＝オーナー権限）で作成→検索→削除は**同一実行内では正常**。
2. `diagTriggers()` で計測：
   - **プロジェクトの時間トリガーは 0 件**（自動クリーンアップ処理は存在しない）。
   - **エディタで作ったイベントは 75 秒後も生存（ALIVE / FOUND）**。
3. デプロイ経由（`createBooking`）で作ったイベントだけが**作成 ~40 秒後に消滅**（複数回再現）。
4. エディタ作成（生存）とデプロイ作成（消滅）の**唯一の差は「LINE通知を送っているか否か」**。

→ カレンダー層（getEvents/getTag/createEvent）は正常。犯人は通知側にある、と特定できた。

### 真因
**LINE のリンクプレビュー（OGP取得）用クローラが、店通知メッセージ内の
承認/辞退リンク（GET・有効なHMAC署名つき URL）を自動で取得（先読み）し、
`?action=decline` を実行 → `deleteEvent` していた。**

- 承認リンクも先読みされるため「一瞬 `confirmed` 化 → 直後に辞退で削除」という順序も起きる。
- ユーザーがクリックした時点では**すでにクローラが辞退・削除済み**なので `not_found`。
- これは「**GET なのに副作用（状態変更）がある**」という設計上の問題。メール・チャット・
  LINE・Slack・アンチウイルス・企業プロキシなどは**リンクを勝手に先読みする**のが普通。

### 対策（実装済み）
- **GET は状態変更しない**。承認(`?action=approve`)/辞退(`?action=decline`)は
  署名検証のうえ**確認ページ（HTML）を表示するだけ**にした（`renderDecisionPage_`）。
- 実際の確定/辞退は**ボタン押下 → `google.script.run.decideBySig(token, sig, approve)`**
  で実行（クローラはJSのクリックを実行しないため誤発火しない）。
- 店通知は **confirm テンプレートのボタン（✅承認する / ❌辞退する）** で送る
  （長いURLを本文に直接置かない＝先読み対象を減らす・UIも明快）。
- リンク基底は `ScriptApp.getService().getUrl()`（複数デプロイ環境で別デプロイの
  URLを返し不安定）をやめ、Script Property **`PUBLIC_EXEC_URL`（環境別）** に固定。

### 検証
- 再デプロイ後、`createBooking` したイベントは **60 秒経っても生存**。
- 承認URLを（不正・正当問わず）GET しても **`status` は `pending` のまま**＝状態不変。

### 一般教訓
- **通知・共有するURLは「第三者に勝手にGETされる」前提で設計する。**
  状態を変える操作（承認・辞退・削除・購読解除など）は**絶対にGET単独で完了させない**。
  確認ページ＋ボタン（POST / `google.script.run` 相当）に分離する。冪等性を守る。
- 「作成したはずのリソースが少し経つと消える」系は、トリガーや外部同期だけでなく
  **通知に載せたリンクの先読み**も疑う。
- 複数デプロイがある GAS で `ScriptApp.getService().getUrl()` は当てにしない。
  公開する `/exec` は Script Property に固定する。

参考実装: [`../gas/Code.gs`](../gas/Code.gs)（`renderDecisionPage_` / `decideBySig` / `notifyOwnerNewBooking_` / `publicExecUrl_`）
