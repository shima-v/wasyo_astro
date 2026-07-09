// 管理セッション複合TTL（アイドル30分＋絶対12時間）の【HTTP 経路の結合テスト】。
// 純関数テスト（session.test.js）が「refreshSession の失効判定そのもの」を担保するのに対し、
// こちらは consumers（middleware.js / routes/action.js）の【配線】を独立に検証する:
//   Cookie 読取 → refreshSession → truthy なら Set-Cookie を付けて通す / falsy なら 302・401 で拒否（Cookie 無）。
//
// 検証の独立性: 実装のロジックをなぞらず「仕様がこうなら、この入力でこう応答するはず」を先に決めてから
//   実挙動と突き合わせる。失効トークンは iat/seen を過去にして作る（HTTP 層は実時刻で動くため時刻注入しない）。
//
// モックの当て方（実読して確定）:
//   - middleware.js は `await import('cloudflare:workers')` の env、action.js は `import { env } from 'cloudflare:workers'`
//     を使う（Astro.locals.runtime.env は Astro v6 で廃止・両実装ともコメント/コードで cloudflare:workers を参照）。
//     Node では `cloudflare:workers` を解決できないため、module.register の ESM ローダで空 env の仮想モジュールへ
//     差し替える。テストからも同じ仮想モジュールを import して env を共有・per-test で書き換える。
//   - fetch は globalThis を差し替え、上流 GAS 呼び出しの有無/回数を数える。
//   - origin/ratelimit で弾かれないよう、正当な Origin（リクエストと同一オリジン）と per-test で固有の
//     CF-Connecting-IP を与える（guard.js: Origin 未設定/同一オリジンは許可、rate は per-IP バケット）。
// secret は実値を使わずダミー固定値。個人情報は書かない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// --- cloudflare:workers を空 env の仮想モジュールへ差し替える ESM ローダ（このファイル内に閉じる） ---
// register は同期で、以降の（動的）import に適用される。静的 import で実装を読むと差し替え前に
// cloudflare:workers を解決してしまうため、実装モジュールは【この register の後に動的 import】する。
const loaderSrc = `
const VIRT = 'virtual:cloudflare-workers-stub';
export async function resolve(spec, ctx, next) {
  if (spec === 'cloudflare:workers') return { url: VIRT, shortCircuit: true };
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (url === VIRT) return { format: 'module', shortCircuit: true, source: 'export const env = {};' };
  return next(url, ctx);
}
`;
register('data:text/javascript,' + encodeURIComponent(loaderSrc), import.meta.url);

// register 後に解決されるよう、実装は動的 import（トップレベル await）で読む。
const cf = await import('cloudflare:workers'); // ← 実装と同一の env オブジェクトを共有
const { issueSession, reissueSession, sessionCookie, SESSION_COOKIE } = await import('./session.js');
const { onRequest } = await import('../middleware.js');
const { POST } = await import('./routes/action.js');

const SECRET = 'test-secret-not-a-real-credential';
const ORIGIN = 'https://wwwasyo.com';
const COOKIE_FMT = 'Max-Age=1800; Path=/reserve/admin; HttpOnly; Secure; SameSite=Strict';

// env を毎テストでクリーンに差し替える（共有オブジェクトの残留を断つ）。
function setEnv(obj) {
  for (const k of Object.keys(cf.env)) delete cf.env[k];
  Object.assign(cf.env, obj);
}
// globalThis.fetch を差し替え、呼び出し回数を数える。戻り値は毎回新しい Response（body 二重読み回避）。
function installFetch(makeResponse) {
  const orig = globalThis.fetch;
  const state = { calls: 0 };
  globalThis.fetch = async () => { state.calls++; return makeResponse(); };
  state.restore = () => { globalThis.fetch = orig; };
  return state;
}
function nowSec() { return Math.floor(Date.now() / 1000); }

// tamper: 正当トークンの署名末尾1文字を改変して「署名不一致」を作る。
function tamper(token) {
  const [body, sig] = token.split('.');
  const last = sig[sig.length - 1];
  return body + '.' + sig.slice(0, -1) + (last === 'A' ? 'B' : 'A');
}

// ============================================================
// middleware（/reserve/admin ゲート）: onRequest(context, next)
// ============================================================

// Astro middleware の context/next スタブ。context.url / context.request / context.redirect を最小実装。
function mwContext({ path, cookie }) {
  const url = new URL(ORIGIN + path);
  const headers = {};
  if (cookie) headers['Cookie'] = SESSION_COOKIE + '=' + cookie;
  const request = new Request(url, { headers });
  return {
    url,
    request,
    redirect(location, status) {
      return new Response(null, { status, headers: { Location: location } });
    },
  };
}
function mwNext(bodyText = '<html>admin page</html>') {
  const state = { calls: 0 };
  const fn = async () => {
    state.calls++;
    return new Response(bodyText, { status: 200, headers: { 'Content-Type': 'text/html' } });
  };
  fn.state = state;
  return fn;
}

// --- ケース1: 有効セッション → next() 実行・200 に Set-Cookie 付与（アイドル窓スライド）・302 でない ---
test('middleware ケース1 有効セッション: next()実行しレスポンスにSet-Cookie付与（302でない）', async () => {
  setEnv({ SESSION_SECRET: SECRET });
  const tok = await issueSession(SECRET, nowSec()); // iat=seen=now → 実時刻の refresh で有効
  const next = mwNext();
  const res = await onRequest(mwContext({ path: '/reserve/admin/hub', cookie: tok }), next);

  assert.strictEqual(res.status, 200, '通過（302 リダイレクトではない）');
  assert.strictEqual(next.state.calls, 1, 'next() が1回呼ばれる（管理ページを配信）');
  const sc = res.headers.get('set-cookie');
  assert.ok(sc, 'Set-Cookie が付く（アイドル延長）');
  assert.ok(sc.startsWith(SESSION_COOKIE + '='), 'Cookie 名で始まる');
  assert.ok(sc.includes(COOKIE_FMT), 'sessionCookie 形式（' + COOKIE_FMT + '）');
});

// --- ケース2: アイドル失効（seen が30分超過）→ 302 LOGIN_REDIRECT・Set-Cookie無・next()呼ばれない ---
test('middleware ケース2 アイドル失効: 302 /login・Set-Cookie無・next()不呼出', async () => {
  setEnv({ SESSION_SECRET: SECRET });
  const tok = await issueSession(SECRET, nowSec() - 3600); // seen=now-3600（>1800 で失効）
  const next = mwNext();
  const res = await onRequest(mwContext({ path: '/reserve/admin/hub', cookie: tok }), next);

  assert.strictEqual(res.status, 302, 'アイドル失効は 302');
  assert.strictEqual(res.headers.get('location'), '/reserve/admin/login/', 'LOGIN_REDIRECT へ');
  assert.strictEqual(res.headers.get('set-cookie'), null, '失効時は Cookie を付けない');
  assert.strictEqual(next.state.calls, 0, 'next() は呼ばれない（管理HTMLを返さない）');
});

// --- ケース3: 絶対失効（iat が12時間超過・seen は直近でアイドルは通す）→ 302・Cookie無 ---
test('middleware ケース3 絶対失効: iat 12時間超過（seen直近でも）→ 302・Set-Cookie無', async () => {
  setEnv({ SESSION_SECRET: SECRET });
  const t = nowSec();
  const tok = await reissueSession(SECRET, t - 43201, t - 10); // iat=now-43201（絶対超過）, seen=now-10（アイドルは通る）
  const next = mwNext();
  const res = await onRequest(mwContext({ path: '/reserve/admin/hub', cookie: tok }), next);

  assert.strictEqual(res.status, 302, '絶対失効は 302');
  assert.strictEqual(res.headers.get('set-cookie'), null, 'Cookie を付けない');
  assert.strictEqual(next.state.calls, 0, 'next() は呼ばれない');
});

// --- ケース4: Cookie 無し／改ざん → 302・Cookie無・next()不呼出 ---
test('middleware ケース4 Cookie無し: 302・Set-Cookie無・next()不呼出', async () => {
  setEnv({ SESSION_SECRET: SECRET });
  const next = mwNext();
  const res = await onRequest(mwContext({ path: '/reserve/admin/hub' }), next); // cookie 無し

  assert.strictEqual(res.status, 302, 'Cookie 無しは 302');
  assert.strictEqual(res.headers.get('set-cookie'), null, 'Cookie を付けない');
  assert.strictEqual(next.state.calls, 0, 'next() は呼ばれない');
});
test('middleware ケース4 改ざんトークン: 署名不一致は 302・Set-Cookie無', async () => {
  setEnv({ SESSION_SECRET: SECRET });
  const tok = await issueSession(SECRET, nowSec());
  const next = mwNext();
  const res = await onRequest(mwContext({ path: '/reserve/admin/hub', cookie: tamper(tok) }), next);

  assert.strictEqual(res.status, 302, '改ざんは 302');
  assert.strictEqual(res.headers.get('set-cookie'), null, 'Cookie を付けない');
  assert.strictEqual(next.state.calls, 0, 'next() は呼ばれない');
});

// --- ケース5: 素通し（ゲート対象外）→ 認証なしでも next()・302 でない ---
test('middleware ケース5 素通し: /login/ は認証なしでも next()（302でない）', async () => {
  setEnv({ SESSION_SECRET: SECRET });
  const next = mwNext();
  const res = await onRequest(mwContext({ path: '/reserve/admin/login/' }), next); // cookie 無し
  assert.strictEqual(next.state.calls, 1, 'ログイン導線は素通し（next 実行）');
  assert.strictEqual(res.status, 200, '302 ではない');
});
test('middleware ケース5 素通し: /api/ は認証なしでも next()（各ルートが自前認可）', async () => {
  setEnv({ SESSION_SECRET: SECRET });
  const next = mwNext();
  const res = await onRequest(mwContext({ path: '/reserve/admin/api/action' }), next); // cookie 無し
  assert.strictEqual(next.state.calls, 1, '管理APIは素通し（next 実行）');
  assert.strictEqual(res.status, 200, '302 ではない');
});

// ============================================================
// action ルート（POST /reserve/admin/api/action）: POST(context)
// 順序: originAllowed → rateLimited → refreshSession → 上流 fetch
// ============================================================

function actionRequest({ cookie, action, ip, origin = ORIGIN }) {
  const headers = { 'CF-Connecting-IP': ip, 'Content-Type': 'text/plain;charset=utf-8' };
  if (origin) headers['Origin'] = origin;
  if (cookie) headers['Cookie'] = SESSION_COOKIE + '=' + cookie;
  return new Request(ORIGIN + '/reserve/admin/api/action', {
    method: 'POST', headers, body: JSON.stringify({ action }),
  });
}
function okEnv() {
  setEnv({ SESSION_SECRET: SECRET, RESERVE_API: 'https://gas.example/exec', ADMIN_TOKEN: 'dummy-admin-token' });
}

// --- ケース6: 有効セッション → 上流 fetch 通過・200 に Set-Cookie 付与 ---
test('action ケース6 有効セッション: 上流fetch通過・200にSet-Cookie付与', async () => {
  okEnv();
  const tok = await issueSession(SECRET, nowSec());
  const f = installFetch(() => new Response(JSON.stringify({ ok: true, pending: [] }), {
    headers: { 'content-type': 'application/json' },
  }));
  try {
    const res = await POST({ request: actionRequest({ cookie: tok, action: 'listPending', ip: '198.51.100.6' }) });
    assert.strictEqual(res.status, 200, '認証通過で上流応答（200）');
    assert.strictEqual(f.calls, 1, '上流 GAS へ fetch を1回呼ぶ');
    const sc = res.headers.get('set-cookie');
    assert.ok(sc && sc.startsWith(SESSION_COOKIE + '='), 'Set-Cookie が付く');
    assert.ok(sc.includes(COOKIE_FMT), 'sessionCookie 形式（アイドル窓スライド）');
    const body = await res.json();
    assert.deepStrictEqual(body, { ok: true, pending: [] }, '上流JSONをそのまま返す');
  } finally { f.restore(); }
});

// --- ケース7: 未認証（Cookie無/失効）→ 401 forbidden・Set-Cookie無・上流fetch不呼出 ---
test('action ケース7 未認証(Cookie無): 401 forbidden・Set-Cookie無・fetch不呼出', async () => {
  okEnv();
  const f = installFetch(() => new Response('{}'));
  try {
    const res = await POST({ request: actionRequest({ action: 'listPending', ip: '198.51.100.7' }) }); // cookie 無し
    assert.strictEqual(res.status, 401, '未認証は 401');
    assert.deepStrictEqual(await res.json(), { ok: false, error: 'forbidden' }, 'error:forbidden');
    assert.strictEqual(res.headers.get('set-cookie'), null, '失効/未認証は Cookie を付けない');
    assert.strictEqual(f.calls, 0, '未認証は上流 fetch を呼ばない');
  } finally { f.restore(); }
});
test('action ケース7 失効セッション: アイドル超過トークンも 401・fetch不呼出', async () => {
  okEnv();
  const expired = await issueSession(SECRET, nowSec() - 3600); // アイドル失効
  const f = installFetch(() => new Response('{}'));
  try {
    const res = await POST({ request: actionRequest({ cookie: expired, action: 'listPending', ip: '198.51.100.17' }) });
    assert.strictEqual(res.status, 401, '失効は 401');
    assert.strictEqual(res.headers.get('set-cookie'), null, 'Cookie を付けない');
    assert.strictEqual(f.calls, 0, '上流 fetch を呼ばない');
  } finally { f.restore(); }
});

// --- ケース8: 認証済み・unknown_action → 400 だが Set-Cookie は付く（認証済み活動でスライド） ---
test('action ケース8 認証済みunknown_action: 400・ただしSet-Cookieは付く（スライド）・fetch不呼出', async () => {
  okEnv();
  const tok = await issueSession(SECRET, nowSec());
  const f = installFetch(() => new Response('{}'));
  try {
    const res = await POST({ request: actionRequest({ cookie: tok, action: 'not_a_real_action', ip: '198.51.100.8' }) });
    assert.strictEqual(res.status, 400, '未知アクションは 400');
    assert.deepStrictEqual(await res.json(), { ok: false, error: 'unknown_action' }, 'error:unknown_action');
    const sc = res.headers.get('set-cookie');
    assert.ok(sc && sc.includes(COOKIE_FMT), '認証済み活動ゆえ Set-Cookie は付く（スライド）');
    assert.strictEqual(f.calls, 0, '未知アクションは上流 fetch を呼ばない');
  } finally { f.restore(); }
});

// --- ケース9(任意): origin 不正 → 403／レート超過 → 429 が認証より前に効く（Cookie無・fetch不呼出） ---
test('action ケース9a origin不正: 有効Cookieでも 403 forbidden_origin（認証より前）・Set-Cookie無', async () => {
  okEnv(); // ALLOWED_ORIGIN 未設定 → 同一オリジンのみ許可
  const tok = await issueSession(SECRET, nowSec());
  const f = installFetch(() => new Response('{}'));
  try {
    const res = await POST({
      request: actionRequest({ cookie: tok, action: 'listPending', ip: '198.51.100.9', origin: 'https://evil.example' }),
    });
    assert.strictEqual(res.status, 403, 'クロスオリジンは 403');
    assert.deepStrictEqual(await res.json(), { ok: false, error: 'forbidden_origin' }, 'error:forbidden_origin');
    assert.strictEqual(res.headers.get('set-cookie'), null, 'Cookie を付けない');
    assert.strictEqual(f.calls, 0, 'origin 弾きは上流 fetch を呼ばない');
  } finally { f.restore(); }
});
test('action ケース9b レート超過: 121回目は 429（認証より前）・Set-Cookie無・fetch不呼出', async () => {
  okEnv();
  const ip = '203.0.113.121'; // このテスト専用IP（他テストと分離）
  const f = installFetch(() => new Response('{}'));
  try {
    // 1〜120回目はレート内（認証は失敗して 401 だがレートは通る）＝バケットを満たす
    for (let i = 0; i < 120; i++) {
      const res = await POST({ request: actionRequest({ action: 'listPending', ip }) });
      assert.notStrictEqual(res.status, 429, i + '回目はまだレート超過でない');
    }
    // 121回目: 有効Cookieを与えてもレート超過が先に効く（＝認証より前）
    const tok = await issueSession(SECRET, nowSec());
    const res = await POST({ request: actionRequest({ cookie: tok, action: 'listPending', ip }) });
    assert.strictEqual(res.status, 429, '121回目はレート超過 429');
    assert.deepStrictEqual(await res.json(), { ok: false, error: 'rate_limited' }, 'error:rate_limited');
    assert.strictEqual(res.headers.get('set-cookie'), null, 'Cookie を付けない');
    assert.strictEqual(f.calls, 0, 'レート超過は上流 fetch を呼ばない');
  } finally { f.restore(); }
});
