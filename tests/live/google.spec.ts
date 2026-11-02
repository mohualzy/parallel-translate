import path from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { startMockServer, type MockServer } from '../e2e/mock-server';

/**
 * 内置 Google 翻译实测：全新安装、没有任何配置时直接翻译。接口是非官方的，这里确认它还能用、占位标签还能保住。
 * 需要能连上 Google；设置了 HTTPS_PROXY 时浏览器走同一个代理。本地 mock 服务只用来托管测试页。
 */

declare const chrome: typeof browser;

const EXTENSION = path.resolve('.output/chrome-mv3-e2e');
const PROXY = process.env.HTTPS_PROXY;

let context: BrowserContext;
let sw: Worker;
let server: MockServer;
let extensionId: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  server = await startMockServer();
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, ...(PROXY ? [`--proxy-server=${PROXY}`] : [])],
  });
  sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(sw.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  await server?.close();
});

async function toggle(page: Page) {
  await sw.evaluate(async (target) => {
    for (let i = 0; i < 50; i++) {
      const tab = (await chrome.tabs.query({})).find((t) => t.url === target);
      try {
        if (tab?.id !== undefined) return await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
      } catch {
        // 内容脚本还没注入
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('content script not ready');
  }, page.url());
}

const translation = (page: Page, selector: string) => page.locator(`${selector} > ptx-t:not(.ptx-pending)`);
const CJK = /\p{Script=Han}/u;

test('Google 翻译：没有配置时网页直接翻译，链接、代码、上下标保留，没有残留协议标签', async () => {
  test.setTimeout(90_000);
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await toggle(page);

  const link = translation(page, '#p-link');
  await expect(link).toHaveText(CJK, { timeout: 30_000 });
  await expect(link.locator('a[href="/docs"]')).toHaveCount(1);
  await expect(link.locator('code')).toHaveText('npm install');

  const cite = translation(page, '#p-cite');
  await expect(cite).toHaveText(CJK, { timeout: 30_000 });
  await expect(cite.locator('sub')).toHaveText('2');
  await expect(cite.locator('sup a[href="#cite-1"]')).toHaveText('[1]');

  await expect(page.locator('ptx-t.ptx-error')).toHaveCount(0);
  const leaked = await page.locator('ptx-t').evaluateAll((els) =>
    els.map((e) => e.textContent ?? '').filter((t) => /<\/?[gxs]\d|&#39;|&quot;/.test(t)),
  );
  expect(leaked).toEqual([]);
  await page.close();
});

test('Google 翻译：划词给出译文', async () => {
  test.setTimeout(60_000);
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await page.waitForTimeout(500);
  await page.locator('#p-second').click({ clickCount: 3 });
  await page.locator('ptx-ui-selection .trigger').click();
  const result = page.locator('ptx-ui-selection .panel .result');
  await expect(result).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  await expect(result).toHaveText(CJK);
  await page.close();
});

test('Google 翻译：侧栏多段文本保留分段', async () => {
  test.setTimeout(60_000);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const source = page.locator('#source');
  await source.fill('The first paragraph is here.\n\nThe second paragraph is there.');
  await source.press('Control+Enter');
  const result = page.locator('#result');
  await expect(result).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  await expect(result).toHaveText(CJK);
  expect(await result.textContent()).toContain('\n\n');
  await page.close();
});

test('Google 翻译：PDF 译文页翻译完成', async () => {
  test.setTimeout(90_000);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/pdf.html?file=${encodeURIComponent(`${server.url}/sample.pdf`)}`);
  await expect(page.locator('#progress')).toContainText('已翻译 2 / 2 页', { timeout: 60_000 });
  await expect(page.locator('.page[data-page="1"]')).toHaveAttribute('data-translated', /[1-9]/);
  await page.close();
});
