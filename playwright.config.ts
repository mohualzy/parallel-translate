import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  // 扩展测试共用一个持久化浏览器上下文，串行更稳定
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
});
