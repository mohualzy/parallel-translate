import path from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { startMockServer, type MockServer } from './mock-server';

// sw.evaluate 的回调运行在扩展的 Service Worker 里，那里有全局 chrome
declare const chrome: typeof browser;

/**
 * 端到端：加载 .output/chrome-mv3-e2e 里真实构建的扩展（e2e 模式），配合本地 mock 模型服务。
 * 需先 `pnpm build`（`just e2e` 会自动构建）。
 */

const EXTENSION = path.resolve('.output/chrome-mv3-e2e');

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
  // 页面标题与摘要作为上下文随请求发送
  expect(server.users.at(-1)).toContain('网页标题（仅供参考，不要翻译）：E2E Fixture');
  expect(server.users.at(-1)).toContain('网页摘要（仅供参考，不要翻译）：A fixture page about getting started with the extension.');
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

test('<br><br> 分段的文章：逐段对照，纯文本段落也只在滚动到附近时请求', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/essay.html`);
  await toggle(page);

  const views = page.locator('#essay > ptx-t:not(.ptx-pending)');
  await expect(views.nth(0)).toContainText('【译】July 2023');
  await expect(views.nth(1)).toContainText('【译】The first paragraph explains');
  // 单个 <br> 仍属于同一段
  await expect(views.nth(2)).toContainText('【译】The second paragraph has a footnote and continues');
  await expect(views.nth(2)).toContainText('on a soft line break.');
  await expect(views.nth(2).locator('br')).toHaveCount(1);
  await expect(views.nth(2).locator('a[href="#note-1"]')).toHaveText('footnote');

  const requestedFar = () => server.batches.flat().some((s) => s.includes('far paragraph'));
  await page.waitForTimeout(500);
  expect(requestedFar()).toBe(false);
  await page.mouse.wheel(0, 4500);
  await expect(views.nth(3)).toContainText('【译】The far paragraph should wait');
  expect(requestedFar()).toBe(true);
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

test('持续变化的段落：内容稳定后才翻译，不会每次变化都请求', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await toggle(page);
  await expect(translation(page, '#title')).toBeVisible();

  const sentence = 'Streaming answer grows word by word until it is finally complete.';
  // 模拟 AI 对话逐字输出：每 150ms 改写一次段落内容
  await page.evaluate(async (text) => {
    const words = text.split(' ');
    const p = document.createElement('p');
    p.id = 'p-stream';
    document.querySelector('#title')!.after(p);
    for (let i = 1; i <= words.length; i++) {
      p.textContent = words.slice(0, i).join(' ');
      await new Promise((r) => setTimeout(r, 150));
    }
  }, sentence);

  await expect(translation(page, '#p-stream')).toHaveText(`【译】${sentence}`);
  // 最多两次：段落刚出现时的第一版 + 稳定后的最终版
  const requested = server.batches.flat().filter((s) => s.startsWith('Streaming'));
  expect(requested.length).toBeLessThanOrEqual(2);
  expect(requested.at(-1)).toBe(sentence);
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

async function command(page: Page, type: 'translate-whole-page' | 'toggle-mask' | 'toggle-display-mode') {
  await sw.evaluate(
    async ({ target, type }) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url === target);
      await chrome.tabs.sendMessage(tab!.id!, { type });
    },
    { target: page.url(), type },
  );
}

test('快捷键：Alt+W 立即翻译整页（不等滚动），再按还原；学习遮罩模糊译文', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await toggle(page); // 先确认内容脚本就绪，再还原
  await toggle(page);
  await expect(page.locator('ptx-t')).toHaveCount(0);

  await command(page, 'translate-whole-page');
  // 视口外的段落也被翻译；看不见的（收起的菜单、读屏专用标题）不翻
  await expect(translation(page, '#p-far')).toContainText('【译】This paragraph is far below the fold.');
  const sent = server.batches.flat().join('\n');
  expect(sent).not.toContain('Hidden dropdown item');
  expect(sent).not.toContain('Repository navigation landmark');
  await command(page, 'translate-whole-page');
  await expect(page.locator('ptx-t')).toHaveCount(0);

  await command(page, 'toggle-mask');
  await expect(page.locator('html')).toHaveAttribute('data-ptx-mask', '');
  const title = translation(page, '#title').locator('ptx-i');
  await expect(title).toContainText('【译】');
  expect(await title.evaluate((el) => getComputedStyle(el).filter)).toBe('blur(5px)');
  await command(page, 'toggle-mask');
  await expect(page.locator('html')).not.toHaveAttribute('data-ptx-mask', '');
  expect(await title.evaluate((el) => getComputedStyle(el).filter)).toBe('none');
  await page.close();
});

test('同语言提示：页面已是目标语言时提示，不发请求；外文页面不提示', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/zh.html`);
  const before = server.batches.length;
  await toggle(page);
  const toast = page.locator('ptx-ui-toast .toast');
  await expect(toast).toHaveText('没有找到需要翻译的内容（页面可能已经是简体中文）');
  expect(server.batches.length).toBe(before);
  await page.close();

  const foreign = await context.newPage();
  await foreign.goto(`${server.url}/page.html`);
  await toggle(foreign);
  await expect(translation(foreign, '#title')).toBeVisible();
  await foreign.waitForTimeout(1800);
  await expect(foreign.locator('ptx-ui-toast .toast')).toHaveCount(0);
  await foreign.close();
});

test('模型原样返回的段落（人名等）不重复显示', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await page.evaluate(() =>
    document.querySelector('#title')!.insertAdjacentHTML('afterend', '<p id="p-name">Oleksandr Tarasiuk and Ada Lovelace</p>'),
  );
  server.echoWhen = (s) => s.includes('Oleksandr');
  try {
    await toggle(page);
    await expect(translation(page, '#title')).toContainText('【译】');
    await expect.poll(() => server.batches.flat().some((s) => s.includes('Oleksandr'))).toBe(true);
    await page.waitForTimeout(300);
    await expect(page.locator('#p-name ptx-t')).toHaveCount(0);
  } finally {
    server.echoWhen = null;
  }
  await page.close();
});

test('标签页标题：翻译时换成译文，页面改标题后重新翻译，关闭时还原；上下文仍用原标题', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await toggle(page);
  await expect(page).toHaveTitle('【译】E2E Fixture');
  // 标题翻译之后发出的正文请求，上下文里仍是原标题
  await page.evaluate(() => {
    const p = document.createElement('p');
    p.textContent = 'A paragraph requested after the title was translated.';
    document.querySelector('#title')!.after(p);
  });
  await expect.poll(() => server.users.some((u) => u.includes('requested after the title'))).toBe(true);
  const user = server.users.find((u) => u.includes('requested after the title'))!;
  expect(user).toContain('网页标题（仅供参考，不要翻译）：E2E Fixture\n');

  await page.evaluate(() => (document.title = 'Second Route'));
  await expect(page).toHaveTitle('【译】Second Route');
  await toggle(page);
  await expect(page).toHaveTitle('Second Route');
  await page.close();
});

test('Shadow DOM：翻译 open shadow root 内的段落与 slot 投影内容，译文有样式，shadow 内新增内容也会翻译', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/shadow.html`);
  await toggle(page);
  // Playwright 的 CSS 定位会自动穿透 open shadow root
  await expect(page.locator('#shadow-title > ptx-t')).toContainText('【译】Post title inside the shadow tree');
  const body = page.locator('#shadow-body > ptx-t');
  await expect(body).toContainText('【译】This paragraph lives in an open shadow root.');
  // shadow root 注入了样式：段落译文是块级显示
  expect(await body.evaluate((el) => getComputedStyle(el).display)).toBe('block');
  // 投影内容的译文插在 light DOM（宿主的子节点），经默认 slot 渲染在原文之后
  const slotted = page.locator('#post > ptx-t');
  await expect(slotted).toContainText('【译】Slotted light DOM text');
  expect(await slotted.evaluate((el) => el.assignedSlot !== null && el.getBoundingClientRect().height > 0)).toBe(true);

  await page.evaluate(() => {
    const host = document.querySelector('#post')!;
    const p = document.createElement('p');
    p.id = 'shadow-added';
    p.textContent = 'A comment loaded later inside the shadow root.';
    host.shadowRoot!.querySelector('#shadow-dynamic')!.append(p);
  });
  await expect(page.locator('#shadow-added > ptx-t')).toContainText('【译】A comment loaded later');
  await page.close();
});

test('iframe：跟随顶层页面开关，后加载的 iframe 也跟随；太小的 iframe 不翻译；弹窗状态来自顶层', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/frame.html`);
  await page.waitForTimeout(500); // 等各 frame 的内容脚本就绪
  const inner = page.frameLocator('#inner');

  await toggle(page);
  await expect(translation(page, '#top-p')).toContainText('【译】This paragraph belongs to the top page.');
  await expect(inner.locator('#frame-p > ptx-t')).toContainText('【译】This paragraph lives inside an embedded iframe.');

  // 翻译开启后才加载的 iframe
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.id = 'late';
    frame.src = '/frame-inner.html';
    frame.style.cssText = 'width: 600px; height: 200px';
    document.body.append(frame);
  });
  await expect(page.frameLocator('#late').locator('#frame-p > ptx-t')).toContainText('【译】This paragraph lives inside');

  // 弹窗查询到的是顶层页面的状态
  const state = await sw.evaluate(async (target) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === target);
    return chrome.tabs.sendMessage(tab!.id!, { type: 'get-state' }, { frameId: 0 });
  }, page.url());
  expect(state).toMatchObject({ enabled: true });

  await toggle(page);
  await expect(inner.locator('ptx-t')).toHaveCount(0);
  await expect(page.locator('ptx-t')).toHaveCount(0);
  expect(server.batches.flat().some((s) => s.includes('Tracking pixel'))).toBe(false);
  await page.close();
});

test('YouTube 字幕：打开 CC 后显示原文 + 译文并跟随播放；按进度翻译；原生字幕隐藏，关闭 CC 后恢复', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/watch?v=test123`);
  await page.waitForTimeout(500);
  const layer = page.locator('ptx-ui-subtitles .layer');
  const original = page.locator('ptx-ui-subtitles .original');
  const translated = page.locator('ptx-ui-subtitles .translated');
  const nativeCaptions = page.locator('#ytp-caption-window-container');

  await page.locator('.ytp-subtitles-button').click();
  await expect(original).toHaveText('Hello and welcome to the channel.');
  await expect(translated).toHaveText('【译】Hello and welcome to the channel.');
  await expect(page.locator('html')).toHaveAttribute('data-ptx-subtitles', '');
  await expect(nativeCaptions).toBeHidden();

  // 跟随播放进度切换到下一条
  await expect(original).toHaveText('Today we talk about translation.', { timeout: 8000 });
  await expect(translated).toHaveText('【译】Today we talk about translation.');

  // 只翻译当前时间附近的字幕：5 分钟处那条还没有请求；请求上下文标注为视频字幕
  const batchIndex = server.batches.findIndex((b) => b.some((s) => s.includes('Hello and welcome')));
  expect(server.batches[batchIndex]).not.toContain('A far away line near the end of the video.');
  expect(server.users[batchIndex]).toContain('内容类型：视频字幕');
  expect(server.batches.flat().some((s) => s.includes('far away line'))).toBe(false);

  await page.locator('.ytp-subtitles-button').click();
  await expect(layer).toBeHidden();
  await expect(page.locator('html')).not.toHaveAttribute('data-ptx-subtitles', '');
  await page.close();
});

test('YouTube 字幕：单页应用切换视频后换成新视频的字幕；关闭设置后不接管字幕', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/watch?v=test123`);
  await page.waitForTimeout(500);
  const cc = page.locator('.ytp-subtitles-button');
  const original = page.locator('ptx-ui-subtitles .original');
  const layer = page.locator('ptx-ui-subtitles .layer');

  await cc.click();
  await expect(original).toHaveText('Hello and welcome to the channel.');

  // 切换视频：旧字幕不再显示；新视频请求字幕后显示新字幕
  await page.evaluate(() => history.pushState({}, '', '/watch?v=second'));
  await expect(layer).toBeHidden();
  await cc.click();
  await cc.click();
  await expect(original).toHaveText('Second video subtitle line.');
  await expect(page.locator('ptx-ui-subtitles .translated')).toHaveText('【译】Second video subtitle line.');

  await setSettings({ youtubeSubtitles: false });
  try {
    await expect(layer).toBeHidden();
    await expect(page.locator('#ytp-caption-window-container')).toBeVisible();
  } finally {
    await setSettings({ youtubeSubtitles: true });
  }
  await page.close();
});

test('YouTube 字幕：默认是自动字幕但另有人工字幕时切到人工字幕，每个视频只切一次', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/watch?v=mixed`);
  await page.waitForTimeout(500);
  const original = page.locator('ptx-ui-subtitles .original');
  const badge = page.locator('ptx-ui-subtitles .badge');

  await page.locator('.ytp-subtitles-button').click();
  await expect(original).toHaveText('Manual caption line for the mixed video.');
  await expect(page.locator('ptx-ui-subtitles .translated')).toHaveText('【译】Manual caption line for the mixed video.');
  await expect(badge).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as { __selectedTrack?: string }).__selectedTrack)).toBe('.en');

  // 用户手动切回自动字幕：不再干预
  await page.evaluate(() => {
    const player = document.getElementById('movie_player') as unknown as {
      setOption(m: string, o: string, t: object): void;
    };
    player.setOption('captions', 'track', { languageCode: 'en', kind: 'asr', vss_id: 'a.en' });
  });
  await expect(original).toHaveText('auto generated words here.');
  await expect(badge).toBeVisible();
  await page.waitForTimeout(500);
  await expect(original).toHaveText('auto generated words here.');
  await page.close();
});

test('YouTube 字幕：只有自动字幕时保留它，并在字幕层标注「自动字幕」', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/watch?v=asronly`);
  await page.waitForTimeout(500);
  await page.locator('.ytp-subtitles-button').click();
  await expect(page.locator('ptx-ui-subtitles .original')).toHaveText('auto generated words here.');
  await expect(page.locator('ptx-ui-subtitles .translated')).toHaveText('【译】auto generated words here.');
  await expect(page.locator('ptx-ui-subtitles .badge')).toHaveText('自动字幕');
  await expect(page.locator('ptx-ui-subtitles .badge')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __selectedTrack?: string }).__selectedTrack)).toBeUndefined();
  await page.close();
});

test('YouTube 字幕：YouTube 自动翻译成英文时当原文再翻；自动翻译成中文时交给原生字幕', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/watch?v=tlang-en`);
  await page.waitForTimeout(500);
  await page.locator('.ytp-subtitles-button').click();
  await expect(page.locator('ptx-ui-subtitles .original')).toHaveText('Hello and welcome to the channel.');
  await expect(page.locator('ptx-ui-subtitles .translated')).toHaveText('【译】Hello and welcome to the channel.');

  await page.goto(`${server.url}/watch?v=tlang-zh`);
  await page.waitForTimeout(500);
  await page.locator('.ytp-subtitles-button').click();
  await page.waitForTimeout(1000);
  await expect(page.locator('ptx-ui-subtitles .layer')).toBeHidden();
  await expect(page.locator('html')).not.toHaveAttribute('data-ptx-subtitles', '');
  await expect(page.locator('#ytp-caption-window-container')).toBeVisible();
  await page.close();
});

test('解除截断：省略号容器里的译文完整可见，关闭翻译后复原', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  const box = page.locator('#ellipsis-box');
  await toggle(page);
  await expect(translation(page, '#ellipsis-box')).toContainText('【译】This commit message');
  await expect(box).toHaveAttribute('data-ptx-unclamp', '');
  const clipped = await box.evaluate((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
  expect(clipped).toBe(false);

  await toggle(page);
  await expect(page.locator('ptx-t')).toHaveCount(0);
  await expect(box).not.toHaveAttribute('data-ptx-unclamp', '');
  await page.close();
});

test('术语表：只把页面里出现的术语注入 prompt，改术语表后不复用旧缓存', async () => {
  await setSettings({ glossary: 'fox = 狐狸君\nunicorn = 独角兽' });
  try {
    const page = await context.newPage();
    await page.goto(`${server.url}/page.html`);
    const before = server.batches.length;
    await toggle(page);
    await expect(translation(page, '#p-second')).toContainText('【译】The quick brown fox');
    // p-second 之前已被缓存；带了术语后缓存键不同，必须重新请求
    const index = server.batches.findIndex((b, i) => i >= before && b.some((s) => s.includes('quick brown fox')));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(server.systems[index]).toContain('- fox → 狐狸君');
    expect(server.systems[index]).not.toContain('unicorn');
    await page.close();
  } finally {
    await setSettings({ glossary: '' });
  }
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

test('折叠起来（高度为 0）的内容：看不见就不翻译，也不会被「解除截断」撑开', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await toggle(page);
  await expect(translation(page, '#p-second')).toContainText('【译】');
  await page.waitForTimeout(500);
  await expect(page.locator('#collapsed-p ptx-t')).toHaveCount(0);
  await expect(page.locator('#collapsed')).not.toHaveAttribute('data-ptx-unclamp', '');
  expect(await page.locator('#collapsed').evaluate((el) => el.getBoundingClientRect().height)).toBe(0);
  await page.close();
});

test('仅译文模式：用 ch 限宽的段落隐藏原文会被挤成竖排，检测到后退回双语显示', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await toggle(page);
  await expect(translation(page, '#ch-desc')).toContainText('【译】Deploy simple sites');
  await setSettings({ displayMode: 'translation' });
  try {
    const desc = translation(page, '#ch-desc');
    await expect(desc).toContainText('【译】Deploy simple sites');
    await expect(page.locator('#ch-desc')).not.toHaveAttribute('data-ptx-hide', '');
    expect(await desc.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(200);
    // 普通段落仍然正常隐藏原文
    await expect(page.locator('#p-link')).toHaveAttribute('data-ptx-hide', '');
  } finally {
    await setSettings({ displayMode: 'bilingual' });
  }
  await page.close();
});

test('仅译文模式下导航等短界面文字照常翻译；双语对照下仍跳过', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await toggle(page);
  await expect(translation(page, '#p-second')).toContainText('【译】');
  await expect(page.locator('#nav-home ptx-t')).toHaveCount(0);
  await expect(page.locator('#nav-group ptx-t')).toHaveCount(0);
  await setSettings({ displayMode: 'translation' });
  try {
    await expect(translation(page, '#nav-home')).toContainText('【译】Home');
    await expect(page.locator('#nav-home')).toHaveAttribute('data-ptx-hide', '');
    // 按钮（如 Cloudflare 侧栏的可展开分组）：文字在按钮内部原地替换，点击照常生效
    const group = page.locator('#nav-group');
    await expect(translation(page, '#nav-group')).toContainText('【译】Storage settings');
    await expect(group).toHaveAttribute('data-ptx-hide', '');
    await translation(page, '#nav-group').click();
    await expect(group).toHaveAttribute('data-clicks', '1');
  } finally {
    await setSettings({ displayMode: 'bilingual' });
  }
  await expect(page.locator('#nav-home ptx-t')).toHaveCount(0);
  await expect(page.locator('#nav-group ptx-t')).toHaveCount(0);
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

/** 在标题后插入几段没有缓存过的新段落（用于制造失败） */
async function addFreshParagraphs(page: Page, prefix: string, count: number) {
  await page.evaluate(
    ({ prefix, count }) => {
      const title = document.querySelector('#title')!;
      for (let i = count - 1; i >= 0; i--) {
        const p = document.createElement('p');
        p.id = `${prefix}-${i}`;
        p.textContent = `A brand new ${prefix} sentence number ${i} that is not cached yet.`;
        title.after(p);
      }
    },
    { prefix, count },
  );
}

test('出错：提示失败原因；点击任一失败提示，所有失败段落一起重试', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await addFreshParagraphs(page, 'err', 2);
  server.failWith = 401;
  await toggle(page);
  const errors = page.locator('ptx-t.ptx-error');
  await expect(errors).toHaveCount(2);
  await expect(errors.first()).toHaveAttribute('title', /API Key 无效/);
  await expect(page.locator('ptx-ui-toast .toast')).toContainText(/段翻译失败：.*API Key 无效.*点击任一失败提示可全部重试/);

  server.failWith = null;
  await errors.first().click();
  await expect(translation(page, '#err-0')).toContainText('【译】A brand new err sentence number 0');
  await expect(translation(page, '#err-1')).toContainText('【译】A brand new err sentence number 1');
  await expect(errors).toHaveCount(0);
  await page.close();
});

test('出错：弹窗显示「重试失败的 N 段」，点击后全部重试', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await addFreshParagraphs(page, 'pop', 2);
  server.failWith = 401;
  await toggle(page);
  await expect(page.locator('ptx-t.ptx-error')).toHaveCount(2);
  server.failWith = null;

  // 弹窗作为同一窗口里的后台标签页打开，它的「当前标签页」就是测试页
  await page.bringToFront();
  const popupPromise = context.waitForEvent('page');
  await sw.evaluate(async (target) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === target)!;
    await chrome.tabs.create({ windowId: tab.windowId, url: chrome.runtime.getURL('/popup.html'), active: false });
  }, page.url());
  const popup = await popupPromise;
  const retry = popup.locator('#retry');
  await expect(retry).toHaveText('重试失败的 2 段');
  await retry.click();
  await expect(translation(page, '#pop-0')).toContainText('【译】A brand new pop sentence number 0');
  await expect(translation(page, '#pop-1')).toContainText('【译】A brand new pop sentence number 1');
  await expect(retry).toBeHidden();
  await popup.close();
  await page.close();
});

/** 在页面里选中某个元素内的一段文字，并触发 mouseup（模拟用户划词） */
async function selectText(page: Page, selector: string, needle?: string) {
  await page.evaluate(
    ({ selector, needle }) => {
      const el = document.querySelector(selector)!;
      const node = el.firstChild!;
      const text = node.textContent!;
      const start = needle ? text.indexOf(needle) : 0;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, needle ? start + needle.length : text.length);
      const sel = getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    },
    { selector, needle },
  );
}

test('划词翻译：选中句子出现按钮，点击后流式显示译文，Esc 关闭', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await page.waitForTimeout(300);

  await page.locator('#p-second').click({ clickCount: 3 });
  const trigger = page.locator('ptx-ui-selection .trigger');
  await expect(trigger).toBeVisible();
  await trigger.click();

  const panel = page.locator('ptx-ui-selection .panel');
  await expect(panel.locator('.result')).toHaveAttribute('data-state', 'done');
  await expect(panel.locator('.result')).toHaveText('【译】The quick brown fox jumps over the lazy dog.');
  await expect(panel.locator('.source')).toHaveText('The quick brown fox jumps over the lazy dog.');
  expect(server.selections.at(-1)).toMatchObject({ word: false, text: 'The quick brown fox jumps over the lazy dog.' });
  // 划词不会触发整页翻译
  await expect(page.locator('ptx-t')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await page.close();
});

test('划词翻译：单词走词典模式并带上段落语境；中文选区不出现按钮；点击别处关闭弹窗', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await page.waitForTimeout(300);

  await selectText(page, '#p-second', 'brown');
  const trigger = page.locator('ptx-ui-selection .trigger');
  await trigger.click();
  const panel = page.locator('ptx-ui-selection .panel');
  await expect(panel.locator('.result')).toHaveText('【译】brown');
  expect(server.selections.at(-1)).toMatchObject({
    text: 'brown',
    word: true,
    context: 'The quick brown fox jumps over the lazy dog.',
  });

  await page.mouse.click(5, 5);
  await expect(panel).toBeHidden();

  await selectText(page, '#p-zh');
  await page.waitForTimeout(300);
  await expect(trigger).toBeHidden();
  await page.close();
});

/** 模拟 Alt+I：后台把命令发给标签页的所有 frame（与 background.ts 一致） */
async function translateInput(page: Page) {
  await sw.evaluate(async (target) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === target);
    await chrome.tabs.sendMessage(tab!.id!, { type: 'translate-input' }).catch(() => undefined);
  }, page.url());
}

const toast = (page: Page) => page.locator('ptx-ui-toast .toast');

test('输入框翻译：末尾连按三次空格译成英文并写回，Ctrl+Z 撤销；contenteditable 同样可用', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/input.html`);
  await page.waitForTimeout(300);
  const before = server.inputs.length;

  const ta = page.locator('#ta');
  await ta.click();
  await page.keyboard.type('你好世界');
  await page.keyboard.type('   ');
  await expect(ta).toHaveValue('【译】你好世界');
  expect(server.inputs.slice(before)).toEqual(['你好世界']);
  await expect(toast(page)).toContainText('已翻译成 English');
  // 写回走 execCommand，进入浏览器原生撤销栈
  await page.keyboard.press('Control+z');
  await expect(ta).toHaveValue('你好世界   ');

  const ce = page.locator('#ce');
  await ce.click();
  await page.keyboard.type('早上好');
  await page.keyboard.type('   ');
  await expect(ce).toHaveText('【译】早上好');

  // 多行：普通 contenteditable 不处理粘贴，走 insertText，换行保留
  await ce.evaluate((el) => (el.innerHTML = '<div>第一行</div><div>第二行</div>'));
  await ce.focus();
  await translateInput(page);
  await expect.poll(() => ce.evaluate((el) => (el as HTMLElement).innerText.replace(/\n+/g, '\n'))).toBe('【译】第一行\n第二行');

  // 多行：自己处理粘贴的编辑器（仿 Lexical，insertText 会丢换行）先走粘贴
  const rich = page.locator('#rich');
  await rich.evaluate((el) => (el.innerHTML = '<p>你好</p><p>再见</p>'));
  await rich.focus();
  await translateInput(page);
  await expect(rich.locator('p')).toHaveText(['【译】你好', '再见']);
  await page.close();
});

test('输入框翻译：Alt+I 只替换选中的部分；已是目标语言时不写回；密码框不翻', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/input.html`);
  await page.waitForTimeout(300);

  const input = page.locator('#in');
  await input.fill('Say 你好 please');
  await input.evaluate((el: HTMLInputElement) => el.setSelectionRange(4, 6));
  await translateInput(page);
  await expect(input).toHaveValue('Say 【译】你好 please');

  server.echoWhen = (s) => s === 'Already English';
  await input.fill('Already English');
  await translateInput(page);
  await expect(toast(page)).toContainText('内容已经是 English');
  await expect(input).toHaveValue('Already English');
  server.echoWhen = null;

  const before = server.inputs.length;
  await page.locator('#pw').fill('secret');
  await translateInput(page);
  await expect(toast(page)).toContainText('请先点进一个输入框');
  expect(server.inputs.length).toBe(before);
  await page.close();
});

test('输入框翻译：行首缩进、代码编辑器、关闭开关时连按空格不触发；请求期间内容变了不写回', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/input.html`);
  await page.waitForTimeout(300);
  const before = server.inputs.length;

  const ta = page.locator('#ta');
  await ta.click();
  await page.keyboard.type('line one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('   ');
  await page.locator('#code').click();
  await page.keyboard.type('const a = 1;   ');
  await setSettings({ inputSpaceTrigger: false });
  await page.locator('#in').click();
  await page.keyboard.type('你好   ');
  await page.waitForTimeout(500);
  expect(server.inputs.length).toBe(before);
  await setSettings({ inputSpaceTrigger: true });

  server.delayMs = 800;
  await ta.fill('');
  await ta.click();
  await page.keyboard.type('慢一点   ');
  await page.waitForTimeout(200);
  await page.keyboard.type('还在写');
  await expect(toast(page)).toContainText('输入框内容已改变');
  await expect(ta).toHaveValue('慢一点   还在写');
  server.delayMs = 0;
  await page.close();
});

async function storedSettings(): Promise<Record<string, unknown>> {
  return sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings as Record<string, unknown>);
}

test('悬浮球：点击切换整页翻译并与快捷键同步；拖动不触发翻译且记住位置；可在当前网站隐藏', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  const ball = page.locator('ptx-ui-float-ball .ball');
  await expect(ball).toBeVisible();
  await expect(ball).toHaveAttribute('aria-pressed', 'false');

  await ball.click();
  await expect(translation(page, '#title')).toBeVisible();
  await expect(ball).toHaveAttribute('aria-pressed', 'true');
  await toggle(page); // 快捷键 / 弹窗关闭翻译后，悬浮球状态同步
  await expect(page.locator('ptx-t')).toHaveCount(0);
  await expect(ball).toHaveAttribute('aria-pressed', 'false');

  const box = (await ball.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 150, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await expect(page.locator('ptx-t')).toHaveCount(0);
  expect(Number((await storedSettings()).floatBallTop)).toBeLessThan(0.6);

  await page.locator('ptx-ui-float-ball .dock').hover();
  await page.locator('ptx-ui-float-ball .hide').click();
  await expect(ball).toHaveCount(0);
  expect((await storedSettings()).floatBallHiddenSites).toEqual(['127.0.0.1']);

  await setSettings({ floatBallHiddenSites: [], floatBallTop: 0.6 });
  await expect(ball).toBeVisible();
  await page.close();
});

test('免刷新：安装前打开的页面，打开弹窗时自动注入内容脚本，可直接翻译', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/preinstalled.html`);
  await page.waitForTimeout(500);
  await expect(page.locator('ptx-ui-float-ball')).toHaveCount(0);

  // 弹窗作为同一窗口里的后台标签页打开，它的「当前标签页」就是测试页
  await page.bringToFront();
  const popupPromise = context.waitForEvent('page');
  await sw.evaluate(async (target) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === target)!;
    await chrome.tabs.create({ windowId: tab.windowId, url: chrome.runtime.getURL('/popup.html'), active: false });
  }, page.url());
  const popup = await popupPromise;
  await expect(popup.locator('#toggle')).toHaveText('翻译此页面');
  await expect(page.locator('ptx-ui-float-ball')).toHaveCount(1);
  await popup.locator('#toggle').click();
  await expect(translation(page, '#old-p')).toHaveText('【译】This page was opened before the extension was installed.');
  await popup.close();
  await page.close();
});

// 扩展更新 / 重载后的真实流程（旧脚本成为孤儿、onInstalled 补注入）在 Playwright 里模拟不了：
// runtime.reload() 会把命令行加载的扩展直接卸掉。这里用「对已有实例的页面再注入一次」覆盖新旧实例交接，
// 真实重载在日常 Chrome 里手动验证（见 docs/TECH_NOTES.md）。
test('免刷新：再次注入时旧实例退场，新实例接续翻译，悬浮球不重复，开关照常可用', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await toggle(page);
  await expect(translation(page, '#p-second')).toHaveText('【译】The quick brown fox jumps over the lazy dog.');
  const before = server.batches.length;

  await sw.evaluate(async (target) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === target)!;
    const entry = chrome.runtime.getManifest().content_scripts!.find((s) => s.matches?.includes('<all_urls>'))!;
    await chrome.scripting.executeScript({ target: { tabId: tab.id!, allFrames: true }, files: entry.js as never });
  }, page.url());

  await expect(page.locator('html')).toHaveAttribute('data-ptx-on', '');
  await expect(translation(page, '#p-second')).toHaveCount(1);
  await expect(translation(page, '#p-second')).toHaveText('【译】The quick brown fox jumps over the lazy dog.');
  await expect(page.locator('ptx-ui-float-ball')).toHaveCount(1);
  // 接续翻译全部命中缓存，不再请求模型
  expect(server.batches.length).toBe(before);
  // 新实例响应开关；旧实例的点击监听已解绑，悬浮球只切换一次
  await toggle(page);
  await expect(page.locator('ptx-t')).toHaveCount(0);
  await page.locator('ptx-ui-float-ball .ball').click();
  await expect(translation(page, '#p-second')).toHaveCount(1);
  await page.close();
});

test('网站规则：白名单内的短标题和正文照翻，白名单外的元信息不翻，排除区域不翻；关闭开关后回到通用识别', async () => {
  const page = await context.newPage();
  // e2e 构建里 localhost 有一条测试规则（见 lib/site-rules.ts），127.0.0.1 上的其他测试页不受影响
  await page.goto(`${server.url.replace('127.0.0.1', 'localhost')}/site-rules.html`);
  await toggle(page);
  await expect(translation(page, '#title-cell')).toHaveText('【译】A short story title (example.com)');
  await expect(translation(page, '#comment')).toContainText('【译】This comment body should be translated');
  await page.waitForTimeout(500);
  await expect(page.locator('#meta ptx-t, #comhead ptx-t, #code ptx-t')).toHaveCount(0);

  await setSettings({ siteRules: false });
  await expect(translation(page, '#meta')).toContainText('【译】42 points');
  await expect(translation(page, '#code')).toContainText('【译】let answer');
  await setSettings({ siteRules: true });
  await page.close();
});

test('翻译风格：论文页自动用学术论文风格；在弹窗里为网站改成文学风格后按新风格重翻', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/paper.html`);
  await toggle(page);
  await expect(translation(page, '#abstract')).toContainText('【译】We propose a method');
  expect(server.systems.at(-1)).toContain('这是学术论文');

  await page.bringToFront();
  const popupPromise = context.waitForEvent('page');
  await sw.evaluate(async (target) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === target)!;
    await chrome.tabs.create({ windowId: tab.windowId, url: chrome.runtime.getURL('/popup.html'), active: false });
  }, page.url());
  const popup = await popupPromise;
  const select = popup.locator('#profile');
  await expect(select.locator('option[value="auto"]')).toHaveText('自动（学术论文）');
  const before = server.systems.length;
  await select.selectOption('fiction');
  // 风格计入缓存键：同一段落按新风格重新请求
  await expect.poll(() => server.systems.slice(before).some((s) => s.includes('这是小说或文学作品'))).toBe(true);
  await expect(translation(page, '#abstract')).toContainText('【译】We propose a method');

  await select.selectOption('auto');
  await expect.poll(async () => (await storedSettings()).siteProfiles).toEqual({});
  await popup.close();
  await page.close();
});

async function tabState(page: Page) {
  return sw.evaluate(async (target) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === target)!;
    return chrome.tabs.sendMessage(tab.id!, { type: 'get-state' }, { frameId: 0 });
  }, page.url());
}

test('文章术语：长文抽取一次术语，之后的批次带上命中的术语；首屏译法冲突的段落带着术语重翻', async () => {
  server.termsOutput = 'agent = 智能体\nscratchpad = 草稿区\nhallucinated term = 不存在';
  const extractionsBefore = server.extractions.length;
  const page = await context.newPage();
  await page.goto(`${server.url}/long-article.html`);
  await toggle(page);
  await expect(translation(page, '#a0')).toContainText('【译】Section 0');
  await expect.poll(() => server.extractions.length).toBe(extractionsBefore + 1);
  // 正文里没有出现的「术语」被丢弃
  await expect.poll(async () => (await tabState(page)).terms).toEqual([
    { source: 'agent', target: '智能体' },
    { source: 'scratchpad', target: '草稿区' },
  ]);
  // 首屏在术语返回前就翻好了；mock 的译文不含「智能体」，算冲突，带着术语重翻
  await expect
    .poll(() => server.batches.some((b, i) => b.some((s) => s.startsWith('Section 0:')) && server.systems[i]!.includes('agent → 智能体')))
    .toBe(true);
  // 后面滚动到的段落一开始就带着术语
  await page.locator('#a13').scrollIntoViewIfNeeded();
  await expect(translation(page, '#a13')).toContainText('【译】Section 13');
  const last = server.batches.findIndex((b) => b.some((s) => s.startsWith('Section 13:')));
  expect(server.systems[last]).toContain('scratchpad → 草稿区');
  await page.close();
});

test('文章术语：短页面不抽取；关闭开关后不抽取', async () => {
  const before = server.extractions.length;
  const page = await context.newPage();
  await page.goto(`${server.url}/page.html`);
  await toggle(page);
  await expect(translation(page, '#p-second')).toContainText('【译】');

  await setSettings({ extractTerms: false });
  const long = await context.newPage();
  await long.goto(`${server.url}/long-article.html?off`);
  await toggle(long);
  await expect(translation(long, '#a0')).toContainText('【译】Section 0');
  await long.waitForTimeout(800);
  expect(server.extractions.length).toBe(before);
  expect((await tabState(long)).terms).toEqual([]);
  await setSettings({ extractTerms: true });
  await long.close();
  await page.close();
});

test('侧栏：外文译成目标语言、中文自动译成英文，流式显示；风格切换随请求生效', async () => {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const source = panel.locator('#source');
  const result = panel.locator('#result');

  await source.fill('The agent is ready.\n\nSecond paragraph.');
  await expect(panel.locator('#target option[value="auto"]')).toHaveText('自动（→ 简体中文）');
  await source.press('Control+Enter');
  await expect(result).toHaveAttribute('data-state', 'done');
  await expect(result).toHaveText('【译】The agent is ready.\n\nSecond paragraph.');
  await expect(panel.locator('#direction')).toHaveText('译成 简体中文');
  expect(server.texts.at(-1)!.system).toContain('简体中文母语译者');

  await source.fill('你好，明天见。');
  await expect(panel.locator('#target option[value="auto"]')).toHaveText('自动（→ English）');
  await panel.locator('#profile').selectOption('tech');
  await panel.locator('#translate').click();
  await expect(result).toHaveText('【译】你好，明天见。');
  expect(server.texts.at(-1)!.system).toContain('native English translator');
  expect(server.texts.at(-1)!.system).toContain('technical documentation');
  await panel.close();
});

test('侧栏：粘贴即自动翻译，不用点按钮；已有译文时切换风格自动重翻', async () => {
  // 扩展页面是 opaque origin，不能授予剪贴板权限；剪贴板全浏览器共享，从普通测试页写入
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.url });
  const writer = await context.newPage();
  await writer.goto(`${server.url}/page.html`);
  await writer.evaluate(() => navigator.clipboard.writeText('Pasted text translates by itself.'));
  await writer.close();
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const before = server.texts.length;
  await panel.locator('#source').focus();
  await panel.keyboard.press('Control+v');
  await expect(panel.locator('#result')).toHaveText('【译】Pasted text translates by itself.');
  expect(server.texts.length).toBe(before + 1);

  await panel.locator('#profile').selectOption('news');
  await expect.poll(() => server.texts.at(-1)!.system.includes('这是新闻报道')).toBe(true);
  await expect(panel.locator('#result')).toHaveAttribute('data-state', 'done');
  await panel.close();
});

test('侧栏：手动输入停顿后自动翻译，连续打字只发一次请求；内容没变不重复请求；清空输入即清空译文', async () => {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const source = panel.locator('#source');
  const result = panel.locator('#result');
  const before = server.texts.length;
  await source.focus();
  await panel.keyboard.type('Typed by hand', { delay: 40 });
  await expect(result).toHaveText('【译】Typed by hand');
  expect(server.texts.length).toBe(before + 1);

  // 打一个字再删掉：内容没变，停顿后不重复请求
  await panel.keyboard.type('x');
  await panel.keyboard.press('Backspace');
  await panel.waitForTimeout(1200);
  expect(server.texts.length).toBe(before + 1);

  await panel.keyboard.press('Control+a');
  await panel.keyboard.press('Backspace');
  await expect(panel.locator('#result-box')).toBeHidden();
  await panel.close();
});

test('侧栏：右键菜单经 storage.session 交来的文字自动填入并翻译（侧栏已打开时也生效）', async () => {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(panel.locator('#source')).toBeFocused();
  await sw.evaluate(() => chrome.storage.session.set({ sidePanelPendingText: 'Pending text from the context menu.' }));
  await expect(panel.locator('#source')).toHaveValue('Pending text from the context menu.');
  await expect(panel.locator('#result')).toHaveText('【译】Pending text from the context menu.');
  // 取走后清除，下次打开侧栏不会重复翻译
  expect(await sw.evaluate(() => chrome.storage.session.get('sidePanelPendingText'))).toEqual({});
  await panel.close();
});

test('PDF 阅读器：渲染原文页与译文页；正文按段翻译（跨行合并），代码与竖排水印不翻；译文页画上了译文', async () => {
  const { SAMPLE_PDF_TEXT: t } = await import('./fixtures/sample-pdf');
  const before = server.batches.length;
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // 反复从 GPU 画布读回像素时 Chrome 会警告（会出现在扩展的「错误」列表里）
  page.on('console', (m) => {
    if (/willReadFrequently/.test(m.text())) errors.push(m.text());
  });
  await page.goto(`chrome-extension://${extensionId}/pdf.html?file=${encodeURIComponent(`${server.url}/sample.pdf`)}`);
  await expect(page.locator('#doc-title')).toHaveText('sample.pdf');
  const first = page.locator('.page[data-page="1"]');
  await expect(first.locator('canvas.original')).toBeVisible();
  await expect(first.locator('canvas.translated')).toBeVisible();
  await expect(page.locator('#progress')).toContainText('已翻译');

  await expect.poll(() => server.batches.slice(before).flat()).toEqual(
    expect.arrayContaining([t.title, t.paragraph1.join(' '), t.paragraph2.join(' ')]),
  );
  const sent = server.batches.slice(before).flat().join('\n');
  expect(sent).not.toContain('npm install');
  expect(sent).not.toContain('arXiv');
  // 风格与版面提示：普通文档用通用风格，并要求译文简洁
  expect(server.users.at(-1)).toContain('PDF');

  // 译文页与原文页的像素不同（原字形去掉、写上了译文）
  const differs = await first.evaluate((el) => {
    const [a, b] = [...el.querySelectorAll('canvas')].map((c) => c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data);
    let diff = 0;
    for (let i = 0; i < a!.length; i += 4) if (Math.abs(a![i]! - b![i]!) > 40) diff++;
    return diff;
  });
  expect(differs).toBeGreaterThan(500);

  await page.locator('#mode button[data-value="translation"]').click();
  await expect(page.locator('.page[data-page="1"] canvas.original')).toBeHidden();
  await expect(page.locator('.page[data-page="1"] canvas.translated')).toBeVisible();
  expect(errors).toEqual([]);
  await page.close();
});

test('PDF 阅读器：切换译文中文字体只重画、不重新请求翻译；手动输入的字体名保存到设置，刷新后仍选中；已授权时列出本机中文字体', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/pdf.html?file=${encodeURIComponent(`${server.url}/sample.pdf`)}`);
  const first = page.locator('.page[data-page="1"]');
  await expect(first).toHaveAttribute('data-translated', /[1-9]/);
  await expect(page.locator('#progress')).toContainText('已翻译 2 / 2 页');
  const requests = server.batches.length;
  const pixels = () =>
    first.locator('canvas.translated').evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i]!) | 0;
      return h;
    });
  const auto = await pixels();
  const font = page.locator('#cjk-font');
  await expect(font).toHaveValue('');

  await font.selectOption('@hei');
  await expect.poll(pixels).not.toBe(auto);
  expect(server.batches.length).toBe(requests);

  page.once('dialog', (d) => void d.accept('SimHei'));
  await font.selectOption('#custom');
  await expect(font).toHaveValue('SimHei');
  await expect.poll(() => sw.evaluate(async () => ((await chrome.storage.local.get('settings')).settings as { pdfCjkFont: string }).pdfCjkFont)).toBe('SimHei');

  // 已授权读取本机字体时，打开阅读器就列出能显示中文的字体，纯西文字体不在列表里
  await context.grantPermissions(['local-fonts']);
  await page.reload();
  await expect(page.locator('#cjk-font')).toHaveValue('SimHei');
  const installed = page.locator('#cjk-font optgroup[label="本机字体"] option');
  await expect.poll(() => installed.count(), { timeout: 15_000 }).toBeGreaterThan(1);
  expect(await installed.allTextContents()).not.toContain('Arial');
  await expect(page.locator('#cjk-font option[value="#load"]')).toHaveCount(0);
  await page.locator('#cjk-font').selectOption('');
  await expect.poll(() => sw.evaluate(async () => ((await chrome.storage.local.get('settings')).settings as { pdfCjkFont: string }).pdfCjkFont)).toBe('');
  await page.close();
});

test('PDF 阅读器：译文页文字可选中、复制；Ctrl+F 查找跨行的词；划词高亮保存在本机，刷新后仍在，可清除；强调面板列出、导出 Markdown、删除；原文页可选中复制、可查找原文', async () => {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const url = `chrome-extension://${extensionId}/pdf.html?file=${encodeURIComponent(`${server.url}/sample.pdf`)}`;
  await page.goto(url);
  await expect(page.locator('#progress')).toContainText('已翻译 2 / 2 页');
  const layer = page.locator('.page[data-page="1"] .slot.translated .text-layer');
  await expect(layer).toContainText('【译】A Study of Bilingual Reading');
  // 原文页也有文字层（原文，按阅读顺序）
  const originalLayer = page.locator('.page[data-page="1"] .slot.original .text-layer');
  await expect(originalLayer).toContainText('A Study of Bilingual Reading');
  await expect(originalLayer).not.toContainText('【译】');

  // Ctrl+F 打开阅读器自己的查找栏：标题在译文页上折成两行，跨行的短语也能找到
  await page.keyboard.press('Control+f');
  const find = page.locator('#find-input');
  await expect(find).toBeFocused();
  await find.fill('bilingual reading');
  await expect(page.locator('#find-count')).toHaveText('1 / 1');
  await expect(page.locator('.page[data-page="1"] .slot.translated .find-hit.current')).toHaveCount(2);
  // 切到「原文」：在原文页里找，命中框画在原文页上；译文特有的文字找不到
  await page.locator('#find-scope button[data-value="original"]').click();
  await expect(page.locator('#find-count')).toHaveText('1 / 1');
  await expect(page.locator('.page[data-page="1"] .slot.original .find-hit.current')).toHaveCount(1);
  await expect(page.locator('.slot.translated .find-hit')).toHaveCount(0);
  await find.fill('【译】');
  await expect(page.locator('#find-count')).toHaveText('无结果');
  await page.locator('#find-scope button[data-value="translated"]').click();
  await find.fill('【译】');
  await expect(page.locator('#find-count')).toHaveText('1 / 4');
  await find.press('Enter');
  await expect(page.locator('#find-count')).toHaveText('2 / 4');
  await find.press('Shift+Enter');
  await find.press('Shift+Enter');
  await expect(page.locator('#find-count')).toHaveText('4 / 4');
  await expect(page.locator('.page[data-page="2"] .find-hit.current')).toHaveCount(1);
  await find.press('Escape');
  await expect(page.locator('#find-bar')).toBeHidden();
  await expect(page.locator('.find-hit')).toHaveCount(0);

  /** 选中文字层里的标题（折成两行），松开鼠标，返回选中的文字 */
  const selectTitle = () =>
    page.evaluate(() => {
      const span = [...document.querySelectorAll('.page[data-page="1"] .slot.translated .text-layer span')].find((s) => s.textContent!.includes('A Study'))!;
      const range = document.createRange();
      range.selectNodeContents(span.closest('.tl-block')!);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      document.querySelector('#pages')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return sel.toString();
    });
  /** 标题那一行在译文画布上的黄色像素数 */
  const yellow = () =>
    page.evaluate(() => {
      const span = [...document.querySelectorAll('.page[data-page="1"] .slot.translated .text-layer span')].find((s) => s.textContent!.includes('A Study'))!;
      const canvas = document.querySelector<HTMLCanvasElement>('.page[data-page="1"] canvas.translated')!;
      const c = canvas.getBoundingClientRect();
      const r = span.getBoundingClientRect();
      const k = canvas.width / c.width;
      const d = canvas.getContext('2d')!.getImageData((r.left - c.left) * k, (r.top - c.top) * k, r.width * k, r.height * k).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i]! > 200 && d[i + 1]! > 180 && d[i + 2]! < 140) n++;
      return n;
    });

  // 查找时滚到了第 2 页：先滚回顶部，等滚动事件派发完（滚动会收起工具条）再选中
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  expect(await yellow()).toBe(0);
  const bar = page.locator('#hl-bar');
  // 原文页上选中：工具条只有「复制」（强调只存在译文页上）
  await page.evaluate(() => {
    const group = document.querySelector('.page[data-page="1"] .slot.original .tl-block')!;
    const range = document.createRange();
    range.selectNodeContents(group);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    document.querySelector('#pages')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('button', { name: '复制' })).toBeVisible();
  await expect(bar.locator('[data-style="yellow"]')).toBeHidden();
  await expect(bar.getByRole('button', { name: '清除' })).toBeHidden();

  expect(await selectTitle()).toContain('【译】A Study of Bilingual Reading');
  await expect(bar).toBeVisible();
  await expect(bar.locator('[data-style="yellow"]')).toBeVisible();
  await expect(bar.getByRole('button', { name: '清除' })).toBeHidden();
  await bar.locator('[data-style="yellow"]').click();
  await expect(bar).toBeHidden();
  await expect.poll(yellow).toBeGreaterThan(100);
  const stored = () =>
    sw.evaluate(async () => Object.entries(await chrome.storage.local.get(null)).filter(([k]) => k.startsWith('pdfHighlights:')).map(([, v]) => v as { quote: string; style: string }[]));
  await expect.poll(stored).toEqual([[expect.objectContaining({ quote: '【译】A Study of Bilingual Reading', style: 'yellow' })]]);

  // 换字体会重新断行、重画，强调仍落在原来的文字上
  await page.locator('#cjk-font').selectOption('@hei');
  await expect.poll(yellow).toBeGreaterThan(100);
  await page.locator('#cjk-font').selectOption('');

  // 强调面板：计数、列表、导出 Markdown（同一段附原文对照）
  const toggle = page.locator('#hl-toggle');
  await expect(toggle).toHaveText('强调 1');
  await toggle.click();
  const panel = page.locator('#hl-panel');
  await expect(panel.locator('.hl-quote')).toHaveText(['【译】A Study of Bilingual Reading']);
  await expect(panel.locator('.hl-page')).toHaveText(['第 1 页']);
  const [download] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: '导出 .md' }).click()]);
  expect(download.suggestedFilename()).toBe('sample.pdf-强调.md');
  const md = await download.createReadStream().then(async (s) => {
    let text = '';
    for await (const chunk of s) text += chunk;
    return text;
  });
  expect(md).toContain('# sample.pdf：强调');
  expect(md).toContain(`来源：${server.url}/sample.pdf`);
  expect(md).toContain('## 第 1 页\n\n- ==【译】A Study of Bilingual Reading==\n\n  > 原文：A Study of Bilingual Reading');
  await toggle.click();
  await expect(panel).toBeHidden();

  await page.reload();
  await expect(page.locator('#progress')).toContainText('已翻译 2 / 2 页');
  await expect.poll(yellow).toBeGreaterThan(100);

  await selectTitle();
  await expect(bar.getByRole('button', { name: '清除' })).toBeVisible();
  await bar.getByRole('button', { name: '清除' }).click();
  await expect.poll(yellow).toBe(0);
  await expect.poll(stored).toEqual([]);
  await expect(toggle).toHaveText('强调 0');

  // 在面板里删除单条强调
  await selectTitle();
  await bar.locator('[data-style="green"]').click();
  await expect(toggle).toHaveText('强调 1');
  await toggle.click();
  await panel.locator('.hl-item').click();
  await panel.getByRole('button', { name: '删除这条强调' }).click();
  await expect(toggle).toHaveText('强调 0');
  await expect(panel).toContainText('强调会列在这里');
  await expect.poll(stored).toEqual([]);
  expect(errors).toEqual([]);
  await page.close();
});

test('PDF 阅读器：两栏页面上拖选左栏两段，不会把夹在中间的右栏段落一起选上（文字层按阅读顺序排列）', async () => {
  const { TWO_COLUMN_TEXT: t } = await import('./fixtures/sample-pdf');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/pdf.html?file=${encodeURIComponent(`${server.url}/two-column.pdf`)}`);
  await expect(page.locator('#progress')).toContainText('已翻译 1 / 1 页');
  const layer = page.locator('.page[data-page="1"] .slot.translated .text-layer');
  await expect(layer).toContainText('Omega two');
  // 文字层的段落顺序：标题、左栏两段、右栏两段
  const order = await layer.locator('.tl-block').evaluateAll((gs) => gs.map((g) => /Alpha|Omega|Two Column/.exec(g.textContent!)![0] + /one|two|Layout/.exec(g.textContent!)![0]));
  expect(order).toEqual(['Two ColumnLayout', 'Alphaone', 'Alphatwo', 'Omegaone', 'Omegatwo']);

  // 真实鼠标拖选：从左栏第一段开头拖到左栏第二段第一行中间
  const lineBox = (text: string) => layer.locator('span', { hasText: text }).first().boundingBox();
  const from = (await lineBox(t.left[0]![0]!.slice(0, 15)))!;
  const to = (await lineBox(t.left[1]![0]!.slice(0, 15)))!;
  await page.mouse.move(from.x + 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  await page.mouse.up();
  const selected = await page.evaluate(() => getSelection()!.toString());
  expect(selected).toContain('Alpha one');
  expect(selected).toContain('Alpha two');
  expect(selected).not.toContain('Omega');
  await page.close();
});

test('PDF 自动打开：开关打开后，不带 .pdf 后缀的 PDF 地址直接进阅读器；「原文件」放行不再转回；关掉后规则删除', async () => {
  const setAutoOpen = (on: boolean) =>
    sw.evaluate(async (on) => {
      const s = ((await chrome.storage.local.get('settings')).settings ?? {}) as Record<string, unknown>;
      await chrome.storage.local.set({ settings: { ...s, pdfAutoOpen: on } });
    }, on);
  const dynamicRules = () => sw.evaluate(async () => (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id));
  await setAutoOpen(true);
  await expect.poll(dynamicRules).toEqual([1]);

  const page = await context.newPage();
  const pdf = `${server.url}/papers/sample?x=1&y=2`;
  await page.goto(pdf);
  // 原地址原样放在 hash 里（含查询串），阅读器照常打开、翻译
  await expect(page).toHaveURL(`chrome-extension://${extensionId}/pdf.html#${pdf}`);
  await expect(page.locator('#progress')).toContainText('已翻译 2 / 2 页');

  // 「原文件」：本标签页放行这个地址，交给浏览器自带的查看器，不会再被转回阅读器
  await page.locator('#original').click();
  await expect(page).toHaveURL(pdf);
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(pdf);
  // 放行只限那个标签页：别的标签页打开同一地址仍进阅读器
  const other = await context.newPage();
  await other.goto(pdf);
  await expect(other).toHaveURL(`chrome-extension://${extensionId}/pdf.html#${pdf}`);
  await other.close();
  await page.close();

  await setAutoOpen(false);
  await expect.poll(dynamicRules).toEqual([]);
});

test('PDF 阅读器：弹窗在 PDF 页面上显示「用双语阅读器打开此 PDF」，点击后本标签页换成阅读器', async () => {
  const page = await context.newPage();
  await page.goto(`${server.url}/fake.pdf`);
  await page.bringToFront();
  const popupPromise = context.waitForEvent('page');
  await sw.evaluate(async (target) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === target)!;
    await chrome.tabs.create({ windowId: tab.windowId, url: chrome.runtime.getURL('/popup.html'), active: false });
  }, page.url());
  const popup = await popupPromise;
  const button = popup.locator('#open-pdf');
  await expect(button).toHaveText('用双语阅读器打开此 PDF');
  await button.click();
  await expect(page).toHaveURL(new RegExp(`^chrome-extension://${extensionId}/pdf\\.html\\?file=.*fake\\.pdf`));
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
