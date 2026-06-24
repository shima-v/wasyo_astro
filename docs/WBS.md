# 予約機能 WBS（進捗管理）

> サロン和笑〜Violane〜 予約システム開発の進捗管理。
> 設計＝[`RESERVATION_PLAN.md`](./RESERVATION_PLAN.md) ／ 開発メモ＝[`DEV_NOTES.md`](./DEV_NOTES.md) ／ 外部設定＝[`SETUP.md`](./SETUP.md) ／ バックエンド＝[`../gas/README.md`](../gas/README.md)。

- **状態**: **本番初リリース済み（2026-06-19）**。Web 予約（空き枠→仮予約→店の承認→確定→変更/取消、新規/常連の初回料金自動適用、LINE/メール通知）は dev/prod とも稼働。
- **作業ブランチ**: `develop`（本番=`main`）
- **凡例**: `[ ]`未着手 / `[~]`進行中 / `[x]`完了 ／ 🤖=Claude実装 / 👤=ユーザー手動作業

---

## 残タスク（👤 手動作業のみ）

LIFF（LINEアプリ内予約）と定期通知のコードは実装・ビルド確認済み。本番で有効化するには以下の LINE コンソール／GAS トリガー設定が残る（任意機能。未設定でも Web 予約・確定通知は稼働し、リマインド/フォロー/LIFF内予約のみ無効）:

- [ ] repo secret `PROD_LIFF_ID` を登録（GitHub Actions が `PUBLIC_LIFF_ID` に注入）
- [ ] dev/prod の LINE Login チャネルに **LIFF アプリ追加**（エンドポイント=各 `/reserve/`・サイズ Full・スコープ `profile openid email` `chat_message.write`・bot_prompt=normal）→ `LIFF_ID` 控え
- [ ] LINE Login チャネルに**公式アカウント（Messaging API）を連携**（`getFriendship`/友だち追加の前提）＋ email 取得申請
- [ ] リッチメニュー/トークカード/プロフィールに **LIFF URL**（`https://liff.line.me/{LIFF_ID}`）設定 ※**本番LIFF専用**（理由は [`DEV_NOTES.md`](./DEV_NOTES.md)「リッチメニューは本番LIFF専用」）
- [ ] **GAS 時間トリガー登録**: `sendReminders`/`sendFollowUps`/`checkQuota` を日次＋ Script Property `MONTHLY_FREE_QUOTA`（既定200）。手順は [`SETUP.md`](./SETUP.md) G-2
- [ ] **LIFF e2e**: dev Workers URL→LINEアプリで起動→自動入力→予約→`liffVerify` 検証・リマインド/フォロー多重防止・無料枠表示・警告

---

## 完了済みフェーズ（要約）

| フェーズ | 内容 | 結果 |
|---------|------|------|
| Phase 0 | 基盤・環境準備（`develop`・docs・`.gitignore`／dev/prod 外部資源〔カレンダー・台帳・GAS・LINE Login〕・Cloudflare Workers・Script Properties） | ✅ 完了 |
| Phase 1 | GAS バックエンド（ルーター・空き枠計算・仮予約・承認/辞退/変更/取消・顧客台帳・HMAC・管理画面・2系統デプロイ） | ✅ 完了・dev 単体確認済み |
| Phase 2 | フロント予約UI（メニュー/月送りカレンダー/フォーム/同意/完了画面・`manage.astro`・LINE Login 連携・管理画面レスポンシブ） | ✅ 完了・dev 反映済み |
| Phase 3 | 既存サイト統合・環境切替（CTA を `/reserve` へ・RESERVA フォールバック・`PUBLIC_SITE_URL` 切替・repo secret 注入） | ✅ 完了 |
| Phase 4 | 検証・リリース（e2e・新規/常連判定・取消/変更・バリデーション・`develop`→`main` マージ・prod 反映） | ✅ 完了（**2026-06-19 本番初リリース**） |
| Phase 5 | LIFF 化（IDトークンの GAS 検証・前日リマインド/来店後フォロー・Messaging API 無料枠監視）※2026-06-20 | 🤖 コード実装・ビルド確認済み／👤 残=上記「残タスク」 |

### Phase 5 実装済み内訳（コード・🤖）
- **GAS**: `verifyLineIdToken_`/`liffVerify_`（id_token をサーバ検証＝なりすまし防止）・`sendReminders`/`sendFollowUps`（`reminded`/`followedUp` タグで多重送信防止・`status===confirmed` のみ）・無料枠監視（`getQuotaConsumption_`/`adminGetQuota_`/`checkQuota`・`QUOTA_WARNED_YYYYMM`）・送信ログ（`logPush_`・宛先マスク）
- **フロント**: `config.js` の `LIFF_ID`＋SDK 読込（設定時のみ）・`reserve/index.astro` の `initLiff`/`liffAfterBooking`（各 `isApiAvailable` ガード・外部ブラウザは OAuth/手入力にフォールバック）・`admin.html` の無料枠表示
- **env/CI**: `.env.development(.example)`・`deploy.yml` に `PUBLIC_LIFF_ID`

---

## 確定仕様・教訓（正本へのリンク）

WBS は概要のみ。詳細は各正本を参照:

- **LINE Login（userId 取得・同端末 localStorage 自動連携）／管理画面レスポンシブ**: 設計＝[`RESERVATION_PLAN.md`](./RESERVATION_PLAN.md)、ハマりどころ＝[`DEV_NOTES.md`](./DEV_NOTES.md)「お客様 LINE 連携の落とし穴」、設定＝[`SETUP.md`](./SETUP.md) E。氏名は LINE 表示名で自動補完、電話・性別は手入力必須のまま。
- **GET の冪等性（通知リンクのクローラ先読み対策）**: 状態変更（承認/辞退/削除）は GET 単独で完了させず、確認ページ＋ボタン（`google.script.run.decideBySig`）に分離。詳細＝[`DEV_NOTES.md`](./DEV_NOTES.md)「仮予約が勝手に消える」。
- **LINE Messaging API は dev/prod 共有**（1公式アカウント=1チャネル制約）: `ENV_LABEL`（dev=`【開発】`／prod は未登録）で店通知・お客様メールの先頭を区別。詳細＝[`RESERVATION_PLAN.md`](./RESERVATION_PLAN.md)「環境管理」。
- **新規/常連判定の取りこぼし**: 別端末/別連絡先は新規扱い → 店が承認時に補正（運用許容）。[`RESERVATION_PLAN.md`](./RESERVATION_PLAN.md)。
- **UX**: 月送りカレンダーグリッド（●印＝空きあり）＋スピナー/スケルトン、空き取得は範囲一括1回に最適化（`reserve/index.astro`・`manage.astro`）。
