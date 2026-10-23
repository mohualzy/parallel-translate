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
  // 视口外的段落也被翻译
  await expect(translation(page, '#p-far')).toContainText('【译】This paragraph is far below the fold.');
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
