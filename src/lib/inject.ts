import { browser } from 'wxt/browser';

/**
 * 给已打开的标签页补注入内容脚本（安装前打开的页面里没有脚本；扩展更新 / 重载后只剩失效的旧脚本）。
 * 设计见 docs/specs/2026-10-23-inject-open-tabs-design.md。
 */

const NO_RECEIVER = /Receiving end does not exist/i;
/** 同一标签页的最短注入间隔：弹窗每秒查询一次状态，不能对注入不了的页面每秒都试 */
const INJECT_COOLDOWN_MS = 10_000;
/** 注入后内容脚本要先异步读设置才开始监听消息，重试发送的间隔与次数（约 3 秒） */
const RETRY_INTERVAL_MS = 100;
const RETRY_TIMES = 30;

const lastInjected = new Map<number, number>();

/** WXT 把 files 限定为已知的构建产物路径；这里的路径来自运行时 manifest，同样是构建产物 */
type ScriptFiles = NonNullable<Parameters<typeof browser.scripting.executeScript>[0]['files']>;

/** manifest 里网页内容脚本（匹配 <all_urls> 的那一条）的文件，不硬编码构建产物的文件名 */
function pageScriptFiles(): { js: string[]; css: string[] } {
  const entry = browser.runtime.getManifest().content_scripts?.find((s) => s.matches?.includes('<all_urls>'));
  return { js: entry?.js ?? [], css: entry?.css ?? [] };
}

export async function injectContentScript(tabId: number): Promise<void> {
  lastInjected.set(tabId, Date.now());
  const { js, css } = pageScriptFiles();
  const target = { tabId, allFrames: true };
  if (css.length > 0) await browser.scripting.insertCSS({ target, files: css });
  await browser.scripting.executeScript({ target, files: js as ScriptFiles });
}

const isNoReceiver = (err: unknown) => NO_RECEIVER.test(err instanceof Error ? err.message : String(err));

/** 给标签页发消息；页面里没有可用的内容脚本时注入后重试 */
export async function sendWithInject<T>(tabId: number, send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (err) {
    if (!isNoReceiver(err) || Date.now() - (lastInjected.get(tabId) ?? 0) < INJECT_COOLDOWN_MS) throw err;
  }
  await injectContentScript(tabId);
  for (let i = 0; ; i++) {
    try {
      return await send();
    } catch (err) {
      if (i >= RETRY_TIMES || !isNoReceiver(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
    }
  }
}

/**
 * 安装 / 更新后给所有已加载完的网页注入。跳过：被丢弃的标签页（恢复时会重新加载）、
 * 还在加载的（manifest 会注入）、浏览器内置页面（不允许注入）。
 * 必须并行：Chrome 会冻结后台标签页（省内存），往冻结的标签页注入要等它被唤醒，
 * 逐个注入时一个冻结的标签页会让排在后面的全部干等（实测一分钟以上）。
 */
export async function injectIntoOpenTabs(): Promise<void> {
  const tabs = await browser.tabs.query({ status: 'complete', discarded: false });
  await Promise.allSettled(
    tabs
      .filter((tab) => tab.id !== undefined && /^(https?|file):/.test(tab.url ?? ''))
      .map((tab) => injectContentScript(tab.id!)),
  );
}
