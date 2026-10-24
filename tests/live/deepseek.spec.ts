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

test('真实模型：带条件的术语按语境判断（Apple 指公司时保留，指水果时照常翻译）', async () => {
  test.setTimeout(120_000);
  await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(settings as object), glossary: 'Apple（指公司时）' } });
  });
  const page = await context.newPage();
  await page.goto(`${server.url}/apple.html`);
  await toggle(page);
  await expect(translation(page, '#company')).toHaveText(CJK, { timeout: 60_000 });
  await expect(translation(page, '#fruit')).toHaveText(CJK, { timeout: 60_000 });
  const company = (await translation(page, '#company').textContent()) ?? '';
  const fruit = (await translation(page, '#fruit').textContent()) ?? '';
  console.log('公司句：', company, '｜水果句：', fruit);
  expect(company).toContain('Apple');
  expect(fruit).toContain('苹果');
  expect(fruit).not.toContain('Apple');
  await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(settings as object), glossary: '' } });
  });
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

test('真实模型：输入框翻译成英文，保留换行、@提及和链接，只输出译文', async () => {
  test.setTimeout(120_000);
  const page = await context.newPage();
  await page.goto(`${server.url}/input.html`);
  await page.waitForTimeout(300);
  const ta = page.locator('#ta');
  await ta.fill('@小明 明天下午三点开会，记得带上周报。\n会议链接：https://example.com/meet/42');
  await ta.press('End');
  await page.keyboard.type('   ');
  await expect(ta).not.toHaveValue(/会议链接/, { timeout: 60_000 });
  const value = await ta.inputValue();
  // \u4eba\u540d\u53ef\u80fd\u6309\u539f\u6837\u4fdd\u7559\uff08@\u5c0f\u660e\uff09\uff0c\u53ea\u68c0\u67e5\u6b63\u6587\u5df2\u8bd1\u6210\u82f1\u6587
  expect(value).not.toMatch(/\u660e\u5929|\u5468\u62a5/);
  expect(value).toMatch(/meeting/i);
  expect(value).toContain('https://example.com/meet/42');
  expect(value).toContain('@');
  expect(value).toContain('\n');
  expect(value).not.toMatch(/<\/?text>/);
  await page.close();
});

test('真实模型：技术文档、社交媒体两种风格下都遵守分段与占位协议', async () => {
  test.setTimeout(180_000);
  const setProfile = (profile: string) =>
    sw.evaluate(async (p) => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...(settings as object), siteProfiles: { '127.0.0.1': p } } });
    }, profile);
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  for (const profile of ['tech', 'social']) {
    await setProfile(profile);
    await page.reload();
    await toggle(page);
    const link = translation(page, '#p-link');
    await expect(link).toHaveText(CJK, { timeout: 60_000 });
    await expect(link.locator('code')).toHaveText('npm install');
    await expect(translation(page, '#p-second')).toHaveText(CJK, { timeout: 60_000 });
    const leaked = await page.locator('ptx-t').evaluateAll((els) =>
      els.map((e) => e.textContent ?? '').filter((t) => /<\/?[gxs]\d|<s id=/.test(t)),
    );
    expect(leaked, profile).toEqual([]);
  }
  await setProfile('general');
  await page.close();
});

test('真实模型：长文抽取出可解析的术语，同一术语在全文译法一致', async () => {
  test.setTimeout(180_000);
  const page = await context.newPage();
  await page.goto(`${server.url}/long-article.html`);
  const state = () =>
    sw.evaluate(async (target) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url === target)!;
      return chrome.tabs.sendMessage(tab.id!, { type: 'get-state' }, { frameId: 0 });
    }, page.url());
  await sw.evaluate(async (target) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === target)!;
    for (let i = 0; i < 50; i++) {
      try {
        return await chrome.tabs.sendMessage(tab.id!, { type: 'translate-whole-page' }, { frameId: 0 });
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }, page.url());
  await expect.poll(async () => (await state()).terms.length, { timeout: 60_000 }).toBeGreaterThan(0);
  const terms = (await state()).terms as { source: string; target: string }[];
  console.log('抽取的术语：', terms.map((t) => `${t.source} = ${t.target}`).join('；'));
  const agent = terms.find((t) => t.source.toLowerCase() === 'agent');
  expect(agent, '应抽取到全文反复出现的 agent').toBeTruthy();
  // 等术语生效后的重翻完成：每段译文都采用同一个译法
  for (const id of ['#a0', '#a6', '#a13']) {
    await expect(translation(page, id)).toContainText(agent!.target, { timeout: 60_000 });
  }
  await page.close();
});

test('真实模型：侧栏多段文本译成中文，保留段落与列表；中文自动译成英文', async () => {
  test.setTimeout(120_000);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const result = panel.locator('#result');
  await panel.locator('#source').fill(
    'Release notes for version 2.0.\n\nWhat changed:\n- Faster startup\n- A new settings page\n\nThanks to everyone who reported bugs.',
  );
  await panel.locator('#translate').click();
  await expect(result).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  const zh = (await result.textContent()) ?? '';
  console.log('侧栏译文：', JSON.stringify(zh));
  expect(zh).toMatch(CJK);
  expect(zh).toContain('\n\n');
  expect(zh).toMatch(/^- /m);
  expect(zh).not.toMatch(/<\/?text>/);

  await panel.locator('#source').fill('这个版本启动更快了，感谢大家反馈问题。');
  await panel.locator('#translate').click();
  await expect(result).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  const en = (await result.textContent()) ?? '';
  console.log('侧栏英文：', JSON.stringify(en));
  expect(en).not.toMatch(CJK);
  expect(en).toMatch(/faster|startup|thank/i);
  await panel.close();
});

test('真实模型：PDF 阅读器翻译标题与两段正文，没有失败', async () => {
  test.setTimeout(120_000);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/pdf.html?file=${encodeURIComponent(`${server.url}/sample.pdf`)}`);
  const first = page.locator('.page[data-page="1"]');
  await expect(first).toHaveAttribute('data-translated', /^[3-9]$/, { timeout: 60_000 });
  await expect(page.locator('#progress')).not.toContainText('失败');
  await expect(page.locator('#notice')).toBeHidden();
  await page.close();
});

test('真实模型：设置页测试连接成功', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.locator('#test-provider').click();
  await expect(page.locator('#test-result')).toContainText('连接成功', { timeout: 60_000 });
  await page.close();
});
