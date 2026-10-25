import { defineContentScript } from 'wxt/utils/define-content-script';
import { sendToBackground } from '@/lib/messages';

/**
 * 本地 PDF 自动用双语阅读器打开（D67）。file:// 不经过 declarativeNetRequest，页面自己也跳不到扩展页面，
 * 由后台换掉标签页；PDF 这条历史因此留着，前进 / 后退回到它时按后台给的方向接着走一步。
 * 只有用户打开了「允许访问文件网址」，内容脚本才会注入 file:// 页面；没开时什么都不发生（阅读器也读不到文件）。
 */
export default defineContentScript({
  matches: ['file:///*'],
  runAt: 'document_start',
  main() {
    // 不看后缀：浏览器按内容识别出的 PDF 都算
    if (document.contentType !== 'application/pdf') return;
    const loaded = async (traverse: boolean) => {
      const go = await sendToBackground({ type: 'local-pdf-loaded', url: location.href, traverse }).catch(() => null);
      if (go === 'back') history.back();
      if (go === 'forward') history.forward();
    };
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    void loaded(nav?.type === 'back_forward');
    // 从往返缓存恢复时脚本不会重新运行，只有 pageshow
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) void loaded(true);
    });
  },
});
