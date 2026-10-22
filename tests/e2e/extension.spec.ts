import path from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { startMockServer, type MockServer } from './mock-server';

// sw.evaluate 的回调运行在扩展的 Service Worker 里，那里有全局 chrome
declare const chrome: typeof browser;

/**
 * 端到端：加载 .output/chrome-mv3 里真实构建的扩展，配合本地 mock 模型服务。
 * 需先 `pnpm build`（`just e2e` 会自动构建）。
 */

const EXTENSION = path.resolve('.output/chrome-mv3');

let context: BrowserContext;
let sw: Worker;
let server: MockServer;
let extensionId: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  server = await startMockServer();
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(sw.url()).host;

  await sw.evaluate(async (baseURL) => {
    await chrome.storage.local.set({
      providers: [
        {
          id: 'mock',
          name: 'Mock',
          type: 'openai',
          baseURL,
          apiKey: 'test-key',
          model: 'mock-model',
          temperature: 0,
          maxConcurrent: 3,
          timeoutMs: 20_000,
          stream: true,
          prompt: '',
        },
      ],
      settings: { activeProviderId: 'mock', targetLang: 'zh-CN' },
    });
  }, `${server.url}/v1`);
});

test.afterAll(async () => {
  await context?.close();
  await server?.close();
});

/** 模拟快捷键 / 弹窗按钮：通过 background 给页面发 toggle 消息（内容脚本就绪前重试） */
async function toggle(page: Page) {
  const url = page.url();
  await sw.evaluate(async (target) => {
    for (let i = 0; i < 50; i++) {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url === target);
      try {
        if (tab?.id !== undefined) return await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
      } catch {
        // 内容脚本还没注入
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('content script not ready');
  }, url);
}

async function setSettings(patch: Record<string, unknown>) {
  await sw.evaluate(async (p) => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(settings as object), ...p } });
  }, patch);
}

const translation = (page: Page, selector: string) => page.locator(`${selector} > ptx-t`);

test('整页翻译：段落出现译文，链接与行内代码保留，中文与代码块跳过', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await toggle(page);

  await expect(translation(page, '#p-link')).toContainText('【译】Read');
  // 富文本：译文中的链接可点击、行内代码原样保留
  await expect(translation(page, '#p-link').locator('a[href="/docs"]')).toHaveText('the documentation');
  await expect(translation(page, '#p-link').locator('code')).toHaveText('npm install');
  // 克隆的元素去掉 id，避免重复
  await expect(page.locator('#docs-link')).toHaveCount(1);

  await expect(translation(page, '#title')).toContainText('【译】Getting Started');
  await expect(translation(page, '#li-parent')).toContainText('【译】Parent item');
  await expect(translation(page, '#li-child')).toContainText('【译】Child item text');
  await expect(page.locator('#p-zh ptx-t')).toHaveCount(0);
  await expect(page.locator('#code-block ptx-t')).toHaveCount(0);
  // 视觉隐藏的读屏文字不进入译文；导航这类短界面文字不自动翻译
  await expect(translation(page, '#p-sr')).toHaveText('【译】Visible sentence here.');
  await expect(page.locator('#nav-home ptx-t')).toHaveCount(0);
  // 上下标、图标字体原样克隆进译文，不交给模型改写
  const cite = translation(page, '#p-cite');
  await expect(cite).toContainText('【译】Water is H');
  await expect(cite.locator('sub')).toHaveText('2');
  await expect(cite.locator('sup a[href="#cite-1"]')).toHaveText('[1]');
  await expect(cite.locator('.material-icons')).toHaveText('search');

  // 多段合并成一次请求
  expect(server.batches.some((b) => b.length > 1)).toBe(true);
  await page.close();
});

test('懒翻译：视口外的段落滚动到附近才请求', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await toggle(page);
  await expect(translation(page, '#p-second')).toBeVisible();

  const requested = () => server.batches.flat().some((s) => s.includes('far below the fold'));
  expect(requested()).toBe(false);
  await expect(translation(page, '#p-far')).toHaveCount(0);

  await page.locator('#p-far').scrollIntoViewIfNeeded();
  await expect(translation(page, '#p-far')).toContainText('【译】This paragraph is far below the fold.');
  expect(requested()).toBe(true);
  await page.close();
});

test('动态内容：新插入的段落自动翻译，被页面删除的译文自动补回', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await toggle(page);
  await expect(translation(page, '#p-link')).toBeVisible();

  await page.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'p-dyn';
    p.textContent = 'Dynamically inserted paragraph.';
    document.querySelector('#dynamic')!.append(p);
    document.querySelector('#dynamic')!.scrollIntoView();
  });
  await expect(translation(page, '#p-dyn')).toContainText('【译】Dynamically inserted paragraph.');

  // 模拟框架重渲染把译文节点删掉
  await page.evaluate(() => document.querySelector('#p-second > ptx-t')!.remove());
  await expect(translation(page, '#p-second')).toContainText('【译】The quick brown fox');
  await page.close();
});

test('批内去重与漏段补翻：相同段落只发送一次，被模型漏掉的段单独补翻', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await page.evaluate(() => {
    const texts = ['Duplicate sentence appears twice.', 'Duplicate sentence appears twice.', 'The model skips this sentence in batches.'];
    const html = texts.map((t, i) => `<p id="p-batch-${i}">${t}</p>`).join('');
    document.querySelector('#title')!.insertAdjacentHTML('afterend', html);
  });
  server.dropWhen = (s) => s.includes('skips this sentence');
  try {
    await toggle(page);
    await expect(translation(page, '#p-batch-0')).toContainText('【译】Duplicate sentence');
    await expect(translation(page, '#p-batch-1')).toContainText('【译】Duplicate sentence');
    await expect(translation(page, '#p-batch-2')).toContainText('【译】The model skips');
  } finally {
    server.dropWhen = null;
  }
  expect(server.batches.flat().filter((s) => s === 'Duplicate sentence appears twice.')).toHaveLength(1);
  const withSkipped = server.batches.filter((b) => b.some((s) => s.includes('skips this sentence')));
  expect(withSkipped.map((b) => b.length > 1)).toEqual([true, false]);
  await page.close();
});

test('还原与缓存：关闭后译文全部移除，再次开启命中缓存不再请求模型', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await toggle(page);
  await expect(translation(page, '#p-second')).toBeVisible();

  await toggle(page);
  await expect(page.locator('ptx-t')).toHaveCount(0);

  const before = server.batches.length;
  await toggle(page);
  await expect(translation(page, '#p-second')).toContainText('【译】');
  await expect(translation(page, '#title')).toContainText('【译】');
  expect(server.batches.length).toBe(before);
  await page.close();
});

test('仅译文模式：隐藏原文，译文保持原字号', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await toggle(page);
  await expect(translation(page, '#p-link')).toBeVisible();

  await setSettings({ displayMode: 'translation' });
  await expect(page.locator('#p-link')).toHaveAttribute('data-ptx-hide', '');
  await expect(page.locator('#docs-link')).toBeHidden();
  const sizes = await page.evaluate(() => ({
    container: getComputedStyle(document.querySelector('#p-link')!).fontSize,
    translation: getComputedStyle(document.querySelector('#p-link > ptx-t')!).fontSize,
  }));
  expect(sizes).toEqual({ container: '0px', translation: '16px' });

  await setSettings({ displayMode: 'bilingual' });
  await expect(page.locator('#p-link')).not.toHaveAttribute('data-ptx-hide', '');
  await expect(page.locator('#docs-link')).toBeVisible();
  await page.close();
});

test('悬停翻译：鼠标停在段落上单按 Ctrl 翻译/收起这一段', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await page.waitForTimeout(300); // 等内容脚本注入

  await page.locator('#p-second').hover();
  await page.keyboard.press('Control');
  await expect(translation(page, '#p-second')).toContainText('【译】The quick brown fox');
  await expect(page.locator('#title ptx-t')).toHaveCount(0);

  // Ctrl+C 这样的组合键不触发
  await page.locator('#title').hover();
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(300);
  await expect(page.locator('#title ptx-t')).toHaveCount(0);

  await page.locator('#p-second').hover();
  await page.keyboard.press('Control');
  await expect(translation(page, '#p-second')).toHaveCount(0);

  // 自动翻译跳过的界面文字，悬停点名时仍然翻译
  await page.locator('#nav-pricing').hover();
  await page.keyboard.press('Control');
  await expect(translation(page, '#nav-pricing')).toContainText('【译】Pricing');
  await page.close();
});

test('出错：显示可点击重试的提示，恢复后点击即可翻译', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await page.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'p-error';
    p.textContent = 'A brand new sentence that is not cached yet.';
    document.querySelector('#title')!.after(p);
  });
  server.failWith = 401;
  await toggle(page);
  const error = page.locator('#p-error > ptx-t.ptx-error');
  await expect(error).toBeVisible();
  await expect(error).toHaveAttribute('title', /API Key 无效/);

  server.failWith = null;
  await error.click();
  await expect(translation(page, '#p-error')).toContainText('【译】A brand new sentence');
  await page.close();
});

test('设置页：显示已配置服务，测试连接与获取模型列表可用', async () => {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  await expect(page.locator('.chip')).toHaveText('Mock');
  await expect(page.locator('[name="model"]')).toHaveValue('mock-model');

  await page.locator('#test-provider').click();
  await expect(page.locator('#test-result')).toContainText('连接成功');

  await page.locator('#fetch-models').click();
  await expect(page.locator('#models-status')).toContainText('共 2 个模型');
  expect(errors).toEqual([]);
  await page.close();
});

test('弹窗页面可正常渲染', async () => {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator('#provider option')).toHaveText('Mock · mock-model');
  await expect(page.locator('#target-lang')).toHaveValue('zh-CN');
  // 在标签页中打开时「当前标签页」就是弹窗自己，属于不可翻译页面
  await expect(page.locator('#toggle')).toHaveText('此页面无法翻译');
  expect(errors).toEqual([]);
  await page.close();
});
