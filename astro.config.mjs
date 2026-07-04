import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// site は環境で切替: 既定=本番(wwwasyo.com)。dev(Cloudflare Workers) は
// 環境変数 PUBLIC_SITE_URL に *.workers.dev の URL を設定して上書きする。
const site = process.env.PUBLIC_SITE_URL ?? 'https://wwwasyo.com';

// ── dev（Cloudflare Worker）ビルドかどうか ──────────────────────────────
// @astrojs/cloudflare アダプタは出力を dist/client（静的）＋dist/server（Worker）に再編する。
// 一方 prod は GitHub Actions が ./dist をそのまま GitHub Pages にアップロードするため、
// アダプタを常時有効にすると「ルート dist/index.html が消え prod 配信が壊れる」。
// そこで **dev ビルド時のみ**アダプタを有効化し、管理系サーバルートを注入する。
//   - dev: Cloudflare Workers Builds が PUBLIC_ENV=development を注入（or WORKER_BUILD=1）
//   - prod: PUBLIC_ENV=production → アダプタ無し＝従来の flat な dist/ 静的出力（回帰なし）
const isWorkerBuild = process.env.WORKER_BUILD === '1' || process.env.PUBLIC_ENV === 'development';

// 管理系のサーバ（オンデマンド）ルート。src/pages 直下ではなく src/worker/routes に置き、
// **dev ビルド時のみ** injectRoute する。こうすると prod の静的ビルドが未知の prerender=false
// ルートでエラーにならず、管理系は Worker 上だけに存在する。
function adminWorkerRoutes() {
  return {
    name: 'wasyo-admin-worker-routes',
    hooks: {
      'astro:config:setup': ({ injectRoute }) => {
        if (!isWorkerBuild) return;
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
  output: 'static', // 公開ページはプリレンダ（静的HTML）。dev では管理系だけ prerender=false でオンデマンド化。
  integrations: [adminWorkerRoutes()],
  ...(isWorkerBuild
    ? {
        adapter: cloudflare({
          // astro dev / wrangler dev でローカルの .dev.vars・バインディングを参照できるようにする。
          platformProxy: { enabled: true },
        }),
      }
    : {}),
});
