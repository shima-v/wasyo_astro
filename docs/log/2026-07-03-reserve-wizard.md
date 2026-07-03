# 2026-07-03 予約画面をステップ式ウィザードに改修（front のみ・GAS 変更なし）

## 目的（なぜ）
現状の `/reserve` は「①メニュー→②日時→③お客様情報→完了」を、前ステップも表示したまま下方向に開示＋`scrollIntoView` で見せていた。これを **1画面1ステップのウィザード**（アクティブなステップのみ表示）に変える。遷移は「選択で自動前進」を主とし、加えて戻る/進むボタンとドット式インジケーターで行き来できるようにする。上部の案内（リード文・受付時間・当日予約の注意）は全ステップで常に表示のまま。

変更は `src/pages/reserve/index.astro` の **1ファイルのみ**。GAS（`gas/`）は一切触っていない。

## 実装（承認済み計画 A〜F のとおり）

### A) ステップインジケーター（ドット）
- `ul.hours` 直後・STEP1 の前に `<ol class="steps-indicator" aria-label="ご予約の進み具合">` を追加（3項目 = メニュー/日時/お客様情報）。各 li に `.dot`＋`.lbl`、CSS `::before` でコネクタ線。
- 状態クラス: `.is-active`（現在・aria-current="step"）/ `.is-done`（到達済みで現在地以外）/ 既定（未到達）。到達済みドットは `role="button"`＋`tabindex="0"` でクリック/Enter 移動可、未到達は `aria-disabled="true"`＋tabindex 無しで不活性。
- 完了面（step-done 表示時）はインジケーター自体を hidden。
- 初期状態は HTML に直接 `is-active`/`aria-current` を持たせ、step1 active で描画。

### B) 中央ナビ関数 `showStep(target)` を新設（遷移の単一窓口）
- STEP1 の section に `id="step-menu"` を付与。制御対象4面 = `step-menu`/`step-date`/`step-form`/`step-done`。
- 動作: 4面すべて hidden にし target だけ表示 → `state.step` 更新 → `maxReached = Math.max(...)`（done は 3 相当）→ `renderIndicator()`＋`updateNavButtons()` で再描画 → `window.scrollTo({top:0})`（ヘッダー sticky のため 0）＋対象見出し `h2`（`tabindex="-1"` 付与済み）へ `focus({preventScroll:true})`。
- `target==='done'` はインジケーターを隠して `#step-done` を表示。
- `state` に `step`（初期1）と `maxReached`（初期1）を追加。
- 補助関数: `renderIndicator()`（ドット再描画）/ `updateNavButtons()`（②③の「次へ」の disabled 更新）。

### C) 既存の遷移発火点を showStep に差し替え
1. メニュー `change`: `$('#step-date').hidden=false`＋`scrollIntoView` を撤去。下流無効化として `state.date=null; state.time=null; state.maxReached=2;` → `showStep('step-date')`。`loadAvailability()`/`updateSummary()` は維持。
2. 日付クリック（renderCalendar 内）: `state.time=null`＋`state.maxReached=2`＋`updateNavButtons()` を追加（時刻を選び直すまで③へ行けない）。`#timeList` への `scrollIntoView` は維持。
3. 時刻クリック（renderTimes 内）: `$('#step-form').hidden=false`＋`scrollIntoView` を `showStep('step-form')` に置換（選択で自動前進、maxReached=3 は showStep が更新）。`updateSummary()` は維持。
4. 送信成功（renderDone）: 冒頭の重複 hide（`['step-date','step-form'].forEach(hide)`）と no-op ループ（`document.querySelectorAll('.step h2 .step-no').forEach(()=>{})`）を撤去。末尾の `done.hidden=false`＋`scrollIntoView` を `showStep('done')` に集約。`#doneBody` の innerHTML 生成はそのまま（showStep の前に実行）。

### D) LINE OAuth 復帰の面を③に統一
- `handleLineReturn` 内の `$('#step-form').hidden=false`＋`scrollIntoView` を全て `showStep('step-form')` に置換（成功1・失敗3）。失敗時も③へ戻して手入力で続行可能に。成功時は menu/date/time が復元されるので `state.maxReached=3` を明示保証してから showStep。
- `renderDates` の LINE 復帰分岐（menu/date/time が揃って復元される所）も `$('#step-form').hidden=false` を `state.maxReached=3` + `showStep('step-form')` に置換。
- 撤去した下位 section 向け scrollIntoView: メニュー change の `#step-date`・時刻クリックの `#step-form`・handleLineReturn 成功の `#step-form`。
- 維持した intra-step スクロール: `#timeList`（日付クリック）・`#formError`（showError 内）・`#lineLink`（連携誘導）。

### E) 戻る/進むボタン（各 step 下部にナビ行 `.step-nav`）
- `#step-menu`: 右に `[次へ →]`（`#navMenuNext`。menu 未選択時 disabled・押下で step-date）。戻る無し（左は空 span でレイアウト確保）。
- `#step-date`: 左 `[← 戻る]`（`#navDateBack`→step-menu）＋右 `[次へ →]`（`#navDateNext`。date&&time で有効・押下で step-form）。
- `#step-form`: 送信ボタン近くに `[← 戻る]`（`#navFormBack`, `type="button"`→step-date）。既存の送信ボタン `#submitBtn`（この内容で仮予約する）が前進/確定を兼ねる。
- ドットクリック: `n <= maxReached` かつ現在地以外のときのみ showStep、未到達は無反応。

### F) 到達管理（回帰を防ぐ不変条件）
- メニューを別ラジオに変更 → 下流リセット＋`maxReached=2`。同一メニュー再選択は change 不発＝state 保持で「次へ」で③に戻れる（自然にそうなる）。
- 日付変更で `state.time=null`＋`maxReached=2`＋②「次へ」無効。
- summary は③内に既存のまま（別の確認ステップは作らない）。

## スタイル（既存 `<style is:global>` 末尾に追記・sticky にしない）
- `.steps-indicator`（flex 等分・ドット・コネクタ `::before`・is-active/is-done の色分け・role/aria-disabled のカーソル）。色は既存変数（`--c-purple`/`--c-accent`/`--c-border`/`--c-muted`/`--c-surface`/`--c-purple-dk`）を流用。
- `.step-nav`（flex 2分割・`.reserve-btn` を横並び幅に・空 span プレースホルダ）。
- 狭幅（max-width:700px）でドットを縮小。
- design レビュー反映（クロコ）: 意味論を明確化するため、完了ドットのゴールド塗り→**紫＋白✓**、現在地に**外周リング**（box-shadow）、未到達を**灰の破線＋減光**（opacity .5）に。モバイルでナビを**縦積み**（送信ラベルの折り返し回避）、戻る(ghost)の枠色を強調。ゴールドはアクセント専用に温存。受付時間表の常時表示は本人決定どおり維持。

## 計画から逸れていない点・判断
- 別機能は足していない。計画 A〜F の範囲厳守。
- `renderIndicator` の is-done 判定は当初やや冗長に書いたが、「is-active でなく n<=maxReached」に単純化（未使用変数 isDone を除去）。挙動は計画どおり。
- `pnpm --dir <path> run build` はリポ内 cwd から `pnpm run build` で実行（同一コマンド）。

## 検証
- build: `pnpm run build` → エラー0、最終行 `[build] Complete!`（7 page 生成、`/reserve/index.html` 含む）。
- grep（`dist/reserve/index.html`）: `steps-indicator`（3）/ `id="step-menu"`（有）/ `step-nav`（3）/ `showStep`（16回・`function showStep(target)` 定義）/ nav ボタン4 id 各1 / 初期 `aria-current="step"`（1）/ 撤去した no-op ループ（0＝不在）。
- `git diff --stat`: `src/pages/reserve/index.astro` のみ +226 / -21。dist は gitignore 済み。

## 未反映（意図的）
- commit / push / prod 反映はしていない（実装のみ）。反映はクロコ／本人が diff・ビルド確認後に行う。
- 実機/実ブラウザでの目視（自動前進の体感・フォーカス移動・ドット行き来・LINE 復帰の③着地）は未実施。ビルドと静的 grep までが機械検証の範囲。
