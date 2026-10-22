import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { getSettings, matchSite, saveSettings, type Settings } from '@/lib/settings';
import type { PageTranslator } from './translator';
import floatBallCss from './ui/float-ball.css?inline';
import { mountPageUi, type PageUi } from './ui/mount';

/** 超过这个位移才算拖拽，否则按点击处理 */
const DRAG_THRESHOLD = 6;

// 与扩展图标一致：两组「原文 / 译文」横条
const ICON = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <rect x="4" y="5" width="16" height="2.6" rx="1.3"/><rect x="4" y="9.2" width="11" height="2.6" rx="1.3" opacity=".6"/>
  <rect x="4" y="13.4" width="16" height="2.6" rx="1.3"/><rect x="4" y="17.6" width="9" height="2.6" rx="1.3" opacity=".6"/>
</svg>`;

/**
 * 页面悬浮球：右侧边缘的翻译开关。可上下拖动（位置所有网站共用），悬停时可在当前网站隐藏。
 * 只在顶层页面显示。
 */
export class FloatBall {
  private ui?: PageUi;
  private dock?: HTMLElement;
  private ball?: HTMLButtonElement;

  constructor(
    private readonly ctx: ContentScriptContext,
    private readonly translator: PageTranslator,
  ) {
    translator.onEnabledChange((enabled) => this.ball?.setAttribute('aria-pressed', String(enabled)));
  }

  private shouldShow(settings: Settings): boolean {
    return window === window.top && settings.floatBall && !matchSite(location.hostname, settings.floatBallHiddenSites);
  }

  /** 根据设置显示/隐藏/更新位置；设置变化时调用 */
  async sync(settings: Settings) {
    if (!this.shouldShow(settings)) {
      this.ui?.remove();
      this.ui = this.dock = this.ball = undefined;
      return;
    }
    if (!this.ui) await this.mount();
    if (this.dock && !this.dock.classList.contains('dragging')) this.dock.style.top = `${settings.floatBallTop * 100}vh`;
  }

  private async mount() {
    this.ui = await mountPageUi(this.ctx, 'float-ball', floatBallCss);
    this.ui.root.innerHTML = `
      <div class="dock">
        <button class="ball" type="button" title="翻译 / 显示原文（可上下拖动）" aria-label="翻译此页面">${ICON}</button>
        <button class="hide" type="button">在此网站隐藏</button>
      </div>`;
    this.dock = this.ui.root.querySelector<HTMLElement>('.dock')!;
    this.ball = this.ui.root.querySelector<HTMLButtonElement>('.ball')!;
    this.ball.setAttribute('aria-pressed', String(this.translator.enabled));
    this.ball.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.ui.root.querySelector('.hide')!.addEventListener('click', () => void this.hideOnSite());
  }

  private onPointerDown(e: PointerEvent) {
    const { dock, ball } = this;
    if (!dock || !ball || e.button !== 0) return;
    e.preventDefault();
    ball.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startTop = dock.getBoundingClientRect().top + dock.offsetHeight / 2;
    let dragging = false;

    const move = (ev: PointerEvent) => {
      if (!dragging && Math.abs(ev.clientY - startY) <= DRAG_THRESHOLD) return;
      dragging = true;
      dock.classList.add('dragging');
      const top = Math.min(Math.max(startTop + ev.clientY - startY, 40), innerHeight - 40);
      dock.style.top = `${top}px`;
    };
    const up = (ev: PointerEvent) => {
      ball.removeEventListener('pointermove', move);
      ball.removeEventListener('pointerup', up);
      ball.removeEventListener('pointercancel', up);
      dock.classList.remove('dragging');
      if (!dragging) {
        this.translator.toggle();
        return;
      }
      const center = Math.min(Math.max(startTop + ev.clientY - startY, 40), innerHeight - 40);
      void saveSettings({ floatBallTop: Number((center / innerHeight).toFixed(3)) });
    };
    ball.addEventListener('pointermove', move);
    ball.addEventListener('pointerup', up);
    ball.addEventListener('pointercancel', up);
  }

  private async hideOnSite() {
    const host = location.hostname;
    const settings = await getSettings();
    if (!settings.floatBallHiddenSites.includes(host)) {
      await saveSettings({ floatBallHiddenSites: [...settings.floatBallHiddenSites, host] });
    }
  }
}
