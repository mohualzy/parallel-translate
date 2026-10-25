import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, test } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { startMockServer } from '../e2e/mock-server';
import { SITES } from './sites';

// sw.evaluate 的回调运行在扩展的 Service Worker 里，那里有全局 chrome
declare const chrome: typeof browser;

/**
 * 多站点回归检查（由 tests/sweep/run.ts 调用，见 `just sweep`）：
 * 加载 SWEEP_EXT 指向的扩展构建，用 mock 翻译（不花 API 费用）在每个网站上跑仅译文模式，
 * 指标写到 test-results/sweep/<SWEEP_TAG>.json，截图写到 test-results/sweep/shots/。
 */

const EXTENSION = path.resolve(process.env.SWEEP_EXT ?? '.output/chrome-mv3-e2e');
const TAG = process.env.SWEEP_TAG ?? 'new';
const ONLY = (process.env.SWEEP_SITES ?? '').split(',').filter(Boolean);
const OUT = path.resolve('test-results/sweep');

export interface SiteMetrics {
  url: string;
  error?: string;
  /** 已渲染的译文数 */
  translations: number;
  /** 翻译失败的段 */
  errors: number;
  /** 仅译文模式下仍然原文、译文都显示的段 */
  bilingual: number;
  bilingualSamples: string[];
  /** 标了整段隐藏、字号却没归零的容器（被页面样式压过） */
  hideNotZero: number;
  /** 部分隐藏的元素里仍然显示的 */
  hideNodeVisible: number;
  /** 被我们藏掉的元素里含有按钮、表单控件、可聚焦或带点击处理的元素（藏了可能让页面功能失效） */
  hiddenControls: number;
  hiddenControlSamples: string[];
  /** 页面横向溢出的像素 */
  hOverflow: number;
}

test('sweep', async () => {
  test.setTimeout(30 * 60_000);
  mkdirSync(path.join(OUT, 'shots'), { recursive: true });
  const server = await startMockServer();
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    viewport: { width: 1400, height: 900 },
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
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
      settings: { activeProviderId: 'mock', targetLang: 'zh-CN', displayMode: 'translation', extractTerms: false, floatBall: false },
    });
  }, `${server.url}/v1`);

  const results: Record<string, Partial<SiteMetrics>> = {};
  for (const [name, url] of SITES.filter(([n]) => ONLY.length === 0 || ONLY.includes(n))) {
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(3000);
      // 内容脚本就绪前消息会失败，重试到发出去为止
      await sw.evaluate(async (target) => {
        const host = new URL(target).host;
        for (let i = 0; i < 50; i++) {
          const tab = (await chrome.tabs.query({})).find((t) => t.url && new URL(t.url).host === host);
          try {
            if (tab?.id !== undefined) return void (await chrome.tabs.sendMessage(tab.id, { type: 'translate-whole-page' }));
          } catch {
            // 内容脚本还没注入
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        throw new Error('content script not ready');
      }, page.url());
      // 等翻译基本完成：译文数连续两次不变
      let last = -1;
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(1500);
        const n = await page.evaluate(() => document.querySelectorAll('ptx-t:not(.ptx-pending):not(.ptx-loading)').length);
        if (n === last && n > 0) break;
        last = n;
      }
      results[name] = { url, ...(await page.evaluate(measure)) };
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(OUT, 'shots', `${name}-${TAG}-top.png`) });
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight * 0.35));
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(OUT, 'shots', `${name}-${TAG}-mid.png`) });
    } catch (err) {
      results[name] = { url, error: String(err).split('\n')[0]!.slice(0, 200) };
    }
    console.log(`${name}: ${results[name]!.error ?? `${results[name]!.translations} 段译文，${results[name]!.bilingual} 段双语`}`);
    await page.close();
  }
  writeFileSync(path.join(OUT, `${TAG}.json`), JSON.stringify(results, null, 1));
  await context.close();
  await server.close();
});

/** 在页面里运行：收集仅译文模式的各项指标 */
function measure(): Omit<SiteMetrics, 'url' | 'error'> {
  const desc = (el: Element | null) =>
    el ? `${el.localName}${el.id ? `#${el.id}` : ''}${el.classList[0] ? `.${el.classList[0]}` : ''}` : '';
  const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 50);
  const done = [...document.querySelectorAll('ptx-t')].filter(
    (t) => !t.matches('.ptx-pending, .ptx-loading, .ptx-error') && text(t),
  );
  const bilingual = done.filter((t) => !t.parentElement!.hasAttribute('data-ptx-hide') && !t.classList.contains('ptx-replace'));
  const hidden = [
    ...document.querySelectorAll('[data-ptx-hide-node]'),
    ...[...document.querySelectorAll('[data-ptx-hide]')].flatMap((el) => [...el.children].filter((c) => c.localName !== 'ptx-t')),
  ];
  const CONTROL = 'button, label, input, select, textarea, summary, [role], [tabindex], [onclick], [contenteditable]';
  // 有真实地址的链接藏了没关系：译文里的链接副本会把点击转给它（D65）
  const realLink = (el: Element) => el.localName === 'a' && /^(?!#?$|javascript:)/i.test(el.getAttribute('href') ?? '');
  const isControl = (el: Element) => el.matches(CONTROL) && !realLink(el);
  const controls = hidden.filter((el) => isControl(el) || [...el.querySelectorAll(CONTROL)].some(isControl));
  return {
    translations: done.length,
    errors: document.querySelectorAll('ptx-t.ptx-error').length,
    bilingual: bilingual.length,
    bilingualSamples: bilingual.slice(0, 10).map((t) => `${desc(t.parentElement)} | ${text(t)}`),
    hideNotZero: [...document.querySelectorAll('[data-ptx-hide]')].filter((el) => getComputedStyle(el).fontSize !== '0px').length,
    hideNodeVisible: [...document.querySelectorAll('[data-ptx-hide-node]')].filter((el) => getComputedStyle(el).display !== 'none').length,
    hiddenControls: controls.length,
    hiddenControlSamples: controls.slice(0, 10).map((el) => `${desc(el)} in ${desc(el.parentElement)} | ${text(el)}`),
    hOverflow: document.documentElement.scrollWidth - innerWidth,
  };
}
