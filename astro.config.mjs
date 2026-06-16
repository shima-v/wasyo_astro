import { defineConfig } from 'astro/config';

// site は環境で切替: 既定=本番(wwwasyo.com)。dev(Cloudflare Workers) は
// 環境変数 PUBLIC_SITE_URL に *.workers.dev の URL を設定して上書きする。
const site = process.env.PUBLIC_SITE_URL ?? 'https://www.wwwasyo.com';

// https://astro.build/config
export default defineConfig({
  site,
  base: '/',  // サブディレクトリ（wasyo_astro）を空にする
});