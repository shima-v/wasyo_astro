# 2026-07-09 管理セッションの複合タイムアウト化（アイドル30分＋絶対12時間）

## 目的（なぜ）
管理セッションの TTL を、現行の**単一の絶対 TTL（発行から60分・仮値）**から、
**複合タイムアウト＝アイドル30分＋絶対12時間**へ改修する（2026-07-04 本人確定）。

- 現行 `src/worker/session.js` の payload は `{exp}` のみ＝発行時刻＋60分の絶対のみ。
  アイドル失効もスライド（活動での延長）も無い仮実装だった（`SESSION_TTL_SEC=3600`）。
- 席を離れた端末の乗っ取り窓が最大60分の固定で、かつ操作中でも60分で強制切断される
  （UX と安全のどちらにも中途半端）。アイドル＋絶対の二段にすることで
  「無操作なら早く切る／操作中は延ばす／ただし発行から一定で必ず切る」を両立する。

### 確定値の根拠（本人確定 2026-07-04）
- **アイドル 30分**: 最終アクティビティから30分の無操作で失効。根拠＝OWASP Session Management
  Cheat Sheet（低リスク業務のアイドルは 15–30分）。活動ごとに再発行して窓をスライド延長。
- **絶対 12時間**: ログイン時刻（iat）から12時間で必ず失効（再発行でも延びない硬い上限）。
  根拠＝NIST SP 800-63B-4 AAL2（再認証は「アイドル ≤ 1h」かつ「絶対 ≤ 24h」を SHOULD）。
  小規模サロン運用に合わせ SHOULD の範囲内でより短い 30分/12時間に寄せた。値は定数。

## スコープ / 制約
- **フロント（Cloudflare Worker / Astro middleware）のみ**。GAS・clasp・prod は一切触らない。
- ステートレス署名 Cookie 方式（サーバ側ストア不要）は維持。実装＋ローカル検証＋コミットまで（push は本人GO）。
- secret 実値・個人情報はコードに書かない（`SESSION_SECRET` は `env.` 参照のみ）。
- prerender=false リテラル維持・サーバゲート維持・定数時間比較（`constEq`）を弱めない。

## 変更ファイル（4ファイル）
- `src/worker/session.js` — payload を `{exp}` → **`{iat, seen}`** に。定数を複合化し、検証＋スライド
  再発行を1経路（`refreshSession`）へ集約。時刻注入可能に（発行・検証系は `nowSec` を既定引数で受ける）。
- `src/worker/routes/login.js` — 新規発行を `issueSession(secret)`（iat=seen=now）に。`sessionCookie(session)`
  で Max-Age＝アイドル（30分）既定。`SESSION_TTL_SEC` import 除去。
- `src/middleware.js` — `verifySession` → `refreshSession`。truthy なら `next()` の Response に
  `Set-Cookie: sessionCookie(fresh)` を追記してページ遷移でアイドル窓をスライド／falsy なら 302 login。
- `src/worker/routes/action.js` — 同じく `refreshSession` で検証し、**認証成功パスのレスポンスにのみ**
  スライド Cookie を付与（apiPost が管理の主要アクティビティ＝ここでのスライドが肝）。401/forbidden は付けない。

## 実装の要点と設計判断
### 1. payload を `{iat, seen}` に（絶対のアンカーと最終活動を分離）
- `iat`＝ログイン時刻（**絶対上限のアンカー・スライド再発行でも不変**）。`seen`＝最終アクティビティ時刻。
- 従来の `exp`（絶対のみ）では「発行から延ばさない上限」と「無活動で切る」を1値で表せなかった。
  2値に分けることで、絶対＝`iat + ABSOLUTE`、アイドル＝`seen + IDLE` を独立に判定できる。

### 2. 検証＋スライド再発行を `refreshSession` に一本化
- 呼び側が「検証」と「延長トークン発行」を別々に呼ぶと取りこぼしやすいため、1関数で
  **truthy=新トークン文字列／falsy=`''`（無効・期限切れ）** を返す形にした。判定順は
  ①署名一致（`constEq`・定数時間） ②絶対（`now >= iat+ABSOLUTE`） ③アイドル（`now >= seen+IDLE`）
  ④全通過なら **iat 据置・seen=now で再署名**。呼び側は truthy なら Set-Cookie、falsy なら拒否するだけ。
- 純検証 `verifySession`（旧・bool）は呼び出しが2箇所とも `refreshSession` に寄るため**撤去**
  （デッドコードを残さない）。純署名検証は内部ヘルパ `verifiedPayload` に factor out。

### 3. スライド延長の付与箇所（活動でのみ延ばす）
- **middleware（ページ遷移）**: `next()` の戻り Response に `Set-Cookie` を追記して延長。
  Astro のオンデマンド管理ページ（prerender:false）でのみここに到達するため Response は可変で安全。
- **action（API＝主要アクティビティ）**: 認証成功後の全レスポンス（200/400 unknown_action/500/502）に
  スライド Cookie を付与。これらは全て「認証済みユーザの活動」なので延長対象。
  **未認証（401 forbidden）では付けない**（`fresh` が falsy のため構造的に到達しない）。

### 4. Cookie の Max-Age＝アイドル（30分）＝多層防御
- 活動ごとに再発行して延長するため、ブラウザ側 Cookie の Max-Age もアイドル（30分）にする。
  無活動ならブラウザ側でも失効し、サーバ側 `iat` による絶対上限（12時間）と併せて二重に守る。

### 5. 後方互換は持たない（旧 `exp` トークンは無効）
- 旧 `{exp}` 形式トークンは `verifiedPayload` が iat/seen 不在で null を返す＝無効扱い。
  **署名が正当でも payload 形状で拒否**する（新旧混在は再ログインで解消・後方互換不要）。

### 6. テスト容易性（時刻注入）
- 発行・検証系は `nowSec = Math.floor(Date.now()/1000)` を**引数の既定値**で受ける。
  QA が後で境界（アイドル/絶対の失効）を決定的にテストできる。committed なテストは QA が別途作成。

## 検証（ローカル・push なし）
- `pnpm build` 成功（Node v22.22.3・WebCrypto は `globalThis.crypto.subtle`）。
- ゲート維持（grep）: `dist/client/reserve/admin/` に管理本体 index.html **不在**／`login/index.html` **在**／
  管理ページ4種（broadcast/customers/reservations/settings）＋ worker routes の `export const prerender = false` 健在。
- **時刻注入 inline サニティチェック（コミットしない一時スクリプト・全 PASS）**:
  - ① 発行直後（iat=seen=t0）: `refresh` truthy＝有効。
  - ② アイドル境界（seen=t0）: now=seen+29:59 有効／now=seen+30:00 無効。
  - ③ 絶対上限（iat=t0・seen=iat+43199 と直近）: now=iat+12h-1 有効／now=iat+12h は**seenが1秒前でも**無効。
  - ④ スライド（活動 act=t0+1000）: 新 payload iat 据置=t0・seen=act に更新。旧 tok は t0+30分で失効するが
    新 tok は act+30分-1 まで有効（アイドルは延びる）。iat=t0 のまま何度スライドしても now=iat+12h で失効（絶対は延びない）。
  - ⑤ 署名改ざん（sig 末尾1文字）: 無効。
  - ⑥ 旧 `exp` 形式（署名は正当・payload={exp}）: iat/seen 不在で無効（後方互換なし）。
  - ⑦ Cookie: `Max-Age=1800`（アイドル30分）・`Path=/reserve/admin; HttpOnly; Secure; SameSite=Strict` 維持。

## 残 / 申し送り
- QA が時刻注入で committed な独立テスト（境界6ケース＋スライド）を後で作成する前提。
- push は本人GO（dev deploy で実機のアイドル/絶対の体感確認は本人操作）。
