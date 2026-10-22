import { defineConfig } from '@playwright/test';

// 真实模型实测，单独配置：`just e2e` 不会跑到这里，避免日常测试产生 API 费用
export default defineConfig({
  testDir: 'tests/live',
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
});
