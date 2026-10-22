import './style.css';
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { FloatBall } from '@/content/float-ball';
import { setupHoverTrigger } from '@/content/hover';
import { SelectionTranslator } from '@/content/selection';
import { PageTranslator } from '@/content/translator';
import { showToast } from '@/content/ui/toast';
import { baseLang, getLanguage } from '@/lib/languages';
import { sendToBackground, type TabRequest } from '@/lib/messages';
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
    const isTop = window === window.top;
    // 太小的 iframe 多是广告或追踪像素，不翻译以免白花钱
    const tinyFrame = !isTop && (innerWidth < 120 || innerHeight < 60);
    const settings = await getSettings();
    const translator = new PageTranslator(settings);
    if (isTop) {
      translator.onNothingToTranslate = () =>
        void showToast(ctx, `没有找到需要翻译的内容（页面可能已经是${getLanguage(translator.settings.targetLang).name}）`);
      translator.onEnabledChange(
        (enabled) => void sendToBackground({ type: 'broadcast-enabled', enabled }).catch(() => undefined),
      );
    }
    const floatBall = new FloatBall(ctx, translator);
    void floatBall.sync(settings);
    onSettingsChanged((next) => {
      translator.updateSettings(next);
      void floatBall.sync(next);
    });
    setupHoverTrigger(
      () => translator.settings.hoverKey,
      (target, x, y) => translator.translateAt(target, x, y),
    );
    new SelectionTranslator(ctx, () => translator.settings);

    browser.runtime.onMessage.addListener((request: TabRequest, _sender, sendResponse) => {
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
    });

    if (!isTop) {
      // iframe 加载时顶层页面已在翻译，就一起开启；网站规则、自动翻译只由顶层页面决定
      const top = tinyFrame ? null : await sendToBackground({ type: 'top-frame-state' }).catch(() => null);
      if (top?.enabled) translator.enable();
      return;
    }

    translator.pageLang = await detectPageLang();

    const host = location.hostname;
    if (matchSite(host, settings.neverTranslateSites)) return;
    const foreign = translator.pageLang !== 'und' && baseLang(translator.pageLang) !== baseLang(settings.targetLang);
    if (matchSite(host, settings.alwaysTranslateSites) || (settings.autoTranslateForeign && foreign)) {
      translator.enable();
    }
  },
});
