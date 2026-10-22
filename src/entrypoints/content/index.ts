import './style.css';
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { FloatBall } from '@/content/float-ball';
import { setupHoverTrigger } from '@/content/hover';
import { SelectionTranslator } from '@/content/selection';
import { PageTranslator } from '@/content/translator';
import { baseLang } from '@/lib/languages';
import type { TabRequest } from '@/lib/messages';
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
  async main(ctx) {
    const settings = await getSettings();
    const translator = new PageTranslator(settings);
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

    translator.pageLang = await detectPageLang();

    const host = location.hostname;
    if (matchSite(host, settings.neverTranslateSites)) return;
    const foreign = translator.pageLang !== 'und' && baseLang(translator.pageLang) !== baseLang(settings.targetLang);
    if (matchSite(host, settings.alwaysTranslateSites) || (settings.autoTranslateForeign && foreign)) {
      translator.enable();
    }
  },
});
