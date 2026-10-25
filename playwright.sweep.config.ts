import { defineConfig } from '@playwright/test';

// 多站点回归检查（just sweep）：真实网站 + mock 翻译，单独配置，不进日常 E2E
export default defineConfig({
  testDir: 'tests/sweep',
  // Playwright 每次运行会清空 outputDir；指到子目录，保住 test-results/sweep 下新旧两次运行的结果
  outputDir: 'test-results/sweep/.playwright',
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
});
