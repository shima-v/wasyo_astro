import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  // site: 'https://[ユーザー名].github.io',
  // base: '/[リポジトリ名]',
  // ※後で独自ドメインにする場合はここを修正しますが、一旦はこのままでも動く設定が多いです。
  // GitHub Pagesのサブディレクトリで動かす場合は base: '/リポジトリ名' が必要になります。
  site: 'https://shima-v.github.io',
  base: 'wasyo_astro',
});