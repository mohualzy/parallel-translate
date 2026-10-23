import path from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { startMockServer, type MockServer } from '../e2e/mock-server';

/**
 * 真实模型实测（会产生少量 API 费用）：用 DeepSeek 验证模型确实遵守分段与占位标签协议。
 * 运行：`just e2e-live`；未设置 DEEPSEEK_API_KEY 时整组跳过。本地 mock 服务只用来托管测试页。
 */

declare const chrome: typeof browser;

const EXTENSION = path.resolve('.output/chrome-mv3-e2e');
const API_KEY = process.env.DEEPSEEK_API_KEY;
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash';

let context: BrowserContext;
let sw: Worker;
let server: MockServer;
let extensionId: string;

test.describe.configure({ mode: 'serial' });
test.skip(!API_KEY, '未设置 DEEPSEEK_API_KEY');

test.beforeAll(async () => {
  server = await startMockServer();
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(sw.url()).host;
  await sw.evaluate(
    async ({ apiKey, model }) => {
      await chrome.storage.local.set({
        providers: [
          {
            id: 'deepseek',
            name: 'DeepSeek',
            type: 'openai',
            baseURL: 'https://api.deepseek.com/v1',
            apiKey,
            model,
            temperature: 0.3,
            maxConcurrent: 3,
            timeoutMs: 90_000,
            stream: true,
            prompt: '',
            extraBody: '{"thinking": {"type": "disabled"}}',
          },
        ],
        settings: { activeProviderId: 'deepseek', targetLang: 'zh-CN' },
      });
    },
    { apiKey: API_KEY!, model: MODEL },
  );
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

test('真实模型：译文为中文，链接/代码/上下标/图标原样保留，没有残留协议标签', async () => {
  test.setTimeout(120_000);
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await toggle(page);

  const link = translation(page, '#p-link');
  await expect(link).toHaveText(CJK, { timeout: 60_000 });
  await expect(link.locator('a[href="/docs"]')).toHaveCount(1);
  await expect(link.locator('code')).toHaveText('npm install');

  const cite = translation(page, '#p-cite');
  await expect(cite).toHaveText(CJK, { timeout: 60_000 });
  await expect(cite.locator('sub')).toHaveText('2');
  await expect(cite.locator('sup a[href="#cite-1"]')).toHaveText('[1]');
  await expect(cite.locator('.material-icons')).toHaveText('search');

  for (const id of ['#title', '#p-sr', '#li-parent', '#li-child', '#p-second']) {
    await expect(translation(page, id)).toHaveText(CJK, { timeout: 60_000 });
  }
  await expect(page.locator('#p-zh ptx-t')).toHaveCount(0);
  await expect(page.locator('ptx-t.ptx-error')).toHaveCount(0);
  const leaked = await page.locator('ptx-t').evaluateAll((els) =>
    els.map((e) => e.textContent ?? '').filter((t) => /<\/?[gxs]\d|<s id=/.test(t)),
  );
  expect(leaked).toEqual([]);
  await page.close();
});

test('真实模型：<br><br> 分段的文章逐段翻译', async () => {
  test.setTimeout(120_000);
  const page = await context.newPage();
  await page.goto(`${server.url}/essay.html`);
  await toggle(page);
  const views = page.locator('#essay > ptx-t:not(.ptx-pending)');
  await expect(views.nth(2)).toHaveText(CJK, { timeout: 60_000 });
  await expect(views.nth(2).locator('a[href="#note-1"]')).toHaveCount(1);
  await expect(page.locator('ptx-t.ptx-error')).toHaveCount(0);
  await page.close();
});

test('真实模型：划词翻译，单词给出词典式释义，句子给出译文', async () => {
  test.setTimeout(120_000);
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await page.waitForTimeout(300);
  const trigger = page.locator('ptx-ui-selection .trigger');
  const result = page.locator('ptx-ui-selection .panel .result');

  // 精确选中一个词（双击元素中心可能落在行尾空白处）
  await page.evaluate(() => {
    const node = document.querySelector('#p-second')!.firstChild!;
    const start = node.textContent!.indexOf('brown');
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + 'brown'.length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    document.querySelector('#p-second')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await trigger.click();
  await expect(result).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  const definition = await result.innerText();
  expect(definition).toMatch(CJK);
  expect(definition.split('\n').length).toBeGreaterThan(1);
  // 第一行应是音标而不是单词本身
  expect(definition.split('\n')[0]?.trim()).not.toBe('brown');
  expect(definition).not.toMatch(/<\/?(text|context)>/);
  await page.screenshot({ path: 'test-results/live-selection-word.png' });

  await page.keyboard.press('Escape');
  await page.locator('#p-second').click({ clickCount: 3 });
  await trigger.click();
  await expect(result).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  await expect(result).toHaveText(CJK);
  expect(await result.innerText()).not.toMatch(/<\/?(text|context)>/);
  await page.screenshot({ path: 'test-results/live-selection-sentence.png' });
  await page.close();
});

test('真实模型：遵守术语表（故意指定不常见译法）', async () => {
  test.setTimeout(120_000);
  await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(settings as object), glossary: 'fox = 狐仙' } });
  });
  try {
    const page = await context.newPage();
    await page.goto(`${server.url}/page.html`);
    await toggle(page);
    await expect(translation(page, '#p-second')).toContainText('狐仙', { timeout: 60_000 });
    await page.close();
  } finally {
    await sw.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...(settings as object), glossary: '' } });
    });
  }
});

test('真实模型：设置页测试连接成功', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.locator('#test-provider').click();
  await expect(page.locator('#test-result')).toContainText('连接成功', { timeout: 60_000 });
  await page.close();
});
