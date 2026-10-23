import './style.css';
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { FloatBall } from '@/content/float-ball';
import { setupHoverTrigger } from '@/content/hover';
import { InputTranslator } from '@/content/input';
import { onTeardown, takeOverPreviousInstance } from '@/content/lifecycle';
import { SelectionTranslator } from '@/content/selection';
import { PageTranslator } from '@/content/translator';
import { showToast } from '@/content/ui/toast';
import { baseLang, getLanguage } from '@/lib/languages';
import { sendToBackground, type TabRequest, type TabState } from '@/lib/messages';
import { getSettings, matchSite, onSettingsChanged, saveSettings } from '@/lib/settings';

async function detectPageLang(): Promise<string> {
  const sample = (document.body?.innerText ?? '').slice(0, 2000);
  try {
    const result = await browser.i18n.detectLanguage(sample);
    const top = result.languages[0];
    if (result.isReliable && top) return top.language;
  } catch {
    // 某些浏览器/页面不可用，退回 <html lang>
  }
  return document.documentElement.lang || 'und';
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  // iframe 里的正文（嵌入的文章、评论区等）也要翻译；iframe 跟随顶层页面的开关
  allFrames: true,
  async main(ctx) {
    // 扩展更新 / 重载后注入的新实例：让旧实例退场，记下它是否在翻译（见 docs/specs/2026-10-23-inject-open-tabs-design.md）
    const resume = takeOverPreviousInstance(ctx);
    const isTop = window === window.top;
    // 太小的 iframe 多是广告或追踪像素，不翻译以免白花钱
    const tinyFrame = !isTop && (innerWidth < 120 || innerHeight < 60);
    const settings = await getSettings();
    const translator = new PageTranslator(settings, ctx.signal);
    onTeardown(ctx, () => translator.shutdown());
    if (isTop) {
      translator.onNothingToTranslate = () =>
        void showToast(ctx, `没有找到需要翻译的内容（页面可能已经是${getLanguage(translator.settings.targetLang).name}）`);
      translator.onEnabledChange(
        (enabled) => void sendToBackground({ type: 'broadcast-enabled', enabled }).catch(() => undefined),
      );
    }
    const floatBall = new FloatBall(ctx, translator);
    void floatBall.sync(settings);
    const unwatchSettings = onSettingsChanged((next) => {
      translator.updateSettings(next);
      void floatBall.sync(next);
    });
    onTeardown(ctx, unwatchSettings);
    setupHoverTrigger(
      () => translator.settings.hoverKey,
      (target, x, y) => translator.translateAt(target, x, y),
      ctx.signal,
    );
    new SelectionTranslator(ctx, () => translator.settings);
    const input = new InputTranslator(ctx, () => translator.settings);

    const onMessage = (request: TabRequest, _sender: unknown, sendResponse: (state: TabState) => void) => {
      // 发给所有 frame，由拿着焦点的 frame 处理；不回复
      if (request.type === 'translate-input') {
        input.translateFocused();
        return false;
      }
      if (!isTop) {
        // iframe 只跟随顶层页面开关，不回复任何消息（弹窗拿到的状态始终来自顶层页面）
        if (request.type === 'set-enabled' && !tinyFrame) {
          if (request.enabled) translator.enable();
          else translator.disable();
        }
        return false;
      }
      if (request.type === 'set-enabled') return false;
      if (request.type === 'toggle') translator.toggle();
      if (request.type === 'translate-whole-page') translator.translateWholePage();
      if (request.type === 'toggle-mask') translator.toggleMask();
      if (request.type === 'toggle-display-mode') {
        const displayMode = translator.settings.displayMode === 'bilingual' ? 'translation' : 'bilingual';
        void saveSettings({ displayMode });
        // 当前页还没翻译时，切换模式顺便开启翻译，符合按快捷键的直觉
        if (!translator.enabled) translator.enable();
      }
      sendResponse(translator.state());
      return false;
    };
    browser.runtime.onMessage.addListener(onMessage);
    onTeardown(ctx, () => browser.runtime.onMessage.removeListener(onMessage));

    if (!isTop) {
      // iframe 加载时顶层页面已在翻译，就一起开启；网站规则、自动翻译只由顶层页面决定
      const top = tinyFrame ? null : await sendToBackground({ type: 'top-frame-state' }).catch(() => null);
      if (top?.enabled) translator.enable();
      return;
    }

    translator.pageLang = await detectPageLang();
    // 接续旧实例的翻译（段落都在缓存里，很快恢复且不产生费用）；这是用户自己开的，优先于网站规则
    if (resume) {
      translator.enable();
      return;
    }

    const host = location.hostname;
    if (matchSite(host, settings.neverTranslateSites)) return;
    const foreign = translator.pageLang !== 'und' && baseLang(translator.pageLang) !== baseLang(settings.targetLang);
    if (matchSite(host, settings.alwaysTranslateSites) || (settings.autoTranslateForeign && foreign)) {
      translator.enable();
    }
  },
});
