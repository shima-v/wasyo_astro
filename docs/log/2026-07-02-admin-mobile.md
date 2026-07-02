# 2026-07-02 admin.html スマホ対応（実装B）

## 対象
- `gas/admin.html` のみ（Code.gs は CTO 担当・不変更）。
- 承認済みプラン `google-fancy-pizza.md`「実装B：admin.html スマホ対応」。

## 背景
- `<head>` に viewport メタタグが欠落。viewport が無いためスマホがデスクトップ幅でレンダリングして全体を縮小表示し、既存 `@media (max-width:600px)` が実機で正しく発火しない状態だった（最大の欠落）。
- 既存メディアクエリ（前バッチ 342c16e）は入力欄の全幅化・承認/辞退ボタンの均等幅化などを持つが、viewport 前提が崩れていた。

## 実施内容と経緯

### 1. viewport 追加（最優先の一撃）
- `<meta name="viewport" content="width=device-width, initial-scale=1" />` を charset の直後に追加。
- これで既存メディアクエリが実機で意図通り発火するようになる。

### 2. iOS Safari の自動ズーム防止
- 論点: `input`/`textarea` が `font-size: .9rem`（≒14.4px）で 16px 未満 → iOS Safari はフォーカス時に自動ズームする。
- 選択肢: (a) 全体（デスクトップ含む）で 16px に上げる／(b) スマホ時のみ 16px に上げる。
- 決定: (b)。デスクトップの既存見た目（.9rem）を変えないため、メディアクエリ内でのみ `font-size: 16px` を適用。合わせてタップ性のため padding も少し増やした。

### 3. タップ高さ
- 論点: 主要操作（承認/辞退・追加・再読込・保存）が全て `button.sm { min-height: 32px }` で、指のタップ目標として小さい。
- 決定: スマホ時のみ `button { min-height: 48px }` / `button.sm { min-height: 44px }`。チップの × ボタン（class 無し・元 `min-height:auto`）は当たり判定として `min-height/min-width: 32px` を確保。
- 詳細度: `button.sm`(0011) は `button`(0001) に勝つ。`.chip button`(0011) は `.chip` 内に `.sm` が無いので競合せず、`button`(0001) に勝って 32px。意図通り。

### 4. 日付＋時刻行の折り返し
- 論点: 時間枠クローズ行は date + time + 追加ボタンの3要素。前バッチは input を全幅（縦積み）にしていたが、date と time が別々に100%幅で縦に積まれると縦長すぎる。
- 決定: `.row > input[type=date]/input[type=time]` を `flex: 1 1 40%`（横並びペア）、追加ボタンは `flex: 1 1 100%`（次行で全幅）。

## 検証（375px 想定・静的レビュー）
- 実機なし。DevTools デバイスモード相当の 375px 幅を想定した静的レビューで実施。
- タグ開閉の一致（section 3・div 30・style/script/head/body/html 各1）を確認。DOM 構造・id・class・`google.script.run` 呼び出しは一切不変更（style と head のみの変更）。
- CSS 詳細度の競合を個別に検証し、意図した宣言が勝つことを確認。
- カード一覧・チップUI（`flex-wrap: wrap`）は 375px でも自然に折り返し、崩れない。
- 601px 以上ではメディアクエリが発火しないため、既存デスクトップ表示は完全維持。
- 既存デザイントーン（`var(--c-*)` 配色・角丸・明朝・トースト）は維持。

## 未実施・引き継ぎ
- 実機（スマホ）目視は未実施 → ひろまさ本人の最終確認事項。
- clasp push / deploy・git commit はしていない（指示どおり）。
