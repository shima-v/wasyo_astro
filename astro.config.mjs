import { defineConfig, sessionDrivers } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// site は環境で切替: 既定=本番(wwwasyo.com)。dev(Cloudflare Workers) は
// 環境変数 PUBLIC_SITE_URL に *.workers.dev の URL を設定して上書きする。
const site = process.env.PUBLIC_SITE_URL ?? 'https://wwwasyo.com';

// ── 配信基盤: dev/prod とも Cloudflare へ統一（ADR-0002） ──────────────────
// @astrojs/cloudflare アダプタは出力を dist/client（静的）＋dist/server（Worker）に再編する。
// 以前は prod=GitHub Pages（flat な dist/ 前提）だったため、アダプタと injectRoute を
// dev ビルド時のみ有効化する二態（isWorkerBuild 分岐）だった。prod も Cloudflare 配信へ
// 統一したのでこの分岐を撤廃し、アダプタと管理系サーバルートを dev/prod とも常時有効化する。
//   - 公開ページ（LP・予約フォーム・privacy 等）は output:'static' のままプリレンダ静的で
//     dist/client に出力され、Cloudflare が静的アセットとして配信する（見た目・機能は不変）。
//   - 管理系 API（login/logout/action）は prerender:false で Worker（dist/server）が処理する。
// ※ PUBLIC_ENV は配信構造の分岐からは外し、開発バッジ/【開発】ラベル等の表示切替に引き続き使う。

// 管理系のサーバ（オンデマンド）ルート。src/pages 直下ではなく src/worker/routes に置き、
// dev/prod とも injectRoute で prerender:false のオンデマンドルートとして注入する。
function adminWorkerRoutes() {
  return {
    name: 'wasyo-admin-worker-routes',
    hooks: {
      'astro:config:setup': ({ injectRoute }) => {
        injectRoute({ pattern: '/reserve/admin/api/login', entrypoint: './src/worker/routes/login.js', prerender: false });
        injectRoute({ pattern: '/reserve/admin/api/logout', entrypoint: './src/worker/routes/logout.js', prerender: false });
        injectRoute({ pattern: '/reserve/admin/api/action', entrypoint: './src/worker/routes/action.js', prerender: false });
      },
    },
  };
}

// https://astro.build/config
export default defineConfig({
  site,
  base: '/', // サブディレクトリ（wasyo_astro）を空にする
  output: 'static', // 公開ページはプリレンダ（静的HTML）。管理系だけ prerender=false でオンデマンド化。
  integrations: [adminWorkerRoutes()],
  // Astro の Session API は未使用（管理セッションは自前の HMAC 署名 Cookie ＝ src/worker/session.js）。
  // 既定のままだと @astrojs/cloudflare が SESSION KV バインディングを自動有効化し、deploy 時に
  // KV 名前空間のプロビジョニングが要る。非 KV ドライバ（memory）を明示して KV 依存を断つ
  // （sessions は実際には使わないのでドライバは何でもよい）。
  // オブジェクト形式で渡す（文字列 'memory' は Astro 6 で deprecated のため sessionDrivers ヘルパを使う）。
  session: { driver: sessionDrivers.memory() },
  adapter: cloudflare({
    // astro dev / wrangler dev でローカルの .dev.vars・バインディングを参照できるようにする。
    platformProxy: { enabled: true },
    // Astro Image / astro:assets は未使用（画像は生 <img>）。既定だと Cloudflare Images の
    // IMAGES バインディングを有効化するため、passthrough にして Images 依存を断つ。
    imageService: 'passthrough',
  }),
});
