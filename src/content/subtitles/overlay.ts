import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { mountPageUi, type PageUi } from '../ui/mount';
import overlayCss from './overlay.css?inline';

/** 字号占播放器高度的比例（与 YouTube 原生字幕接近） */
const FONT_RATIO = 0.042;

/**
 * 双语字幕层：挂在播放器元素里（全屏时也可见），Shadow DOM 隔离样式，不拦截鼠标。
 */
export class SubtitleOverlay {
  private ui?: PageUi;
  private player?: Element;
  private mounting?: Promise<void>;
  private layer?: HTMLElement;
  private original?: HTMLElement;
  private translated?: HTMLElement;
  private resize?: ResizeObserver;

  constructor(private readonly ctx: ContentScriptContext) {}

  /** 确保字幕层挂在当前播放器里（YouTube 切换页面可能重建播放器） */
  async attach(player: Element): Promise<void> {
    if (this.player === player && this.ui?.host.isConnected) return;
    if (this.mounting) return this.mounting;
    this.mounting = this.mount(player).finally(() => (this.mounting = undefined));
    return this.mounting;
  }

  private async mount(player: Element) {
    this.detach();
    this.player = player;
    this.ui = await mountPageUi(this.ctx, 'subtitles', overlayCss, player);
    this.ui.root.innerHTML = `
      <div class="layer" hidden>
        <div class="box"><div class="original"></div><div class="translated"></div></div>
      </div>`;
    this.layer = this.ui.root.querySelector<HTMLElement>('.layer')!;
    this.original = this.ui.root.querySelector<HTMLElement>('.original')!;
    this.translated = this.ui.root.querySelector<HTMLElement>('.translated')!;
    const layer = this.layer;
    this.resize = new ResizeObserver(() => {
      layer.style.setProperty('--ptx-sub-size', `${Math.max(12, Math.round(player.clientHeight * FONT_RATIO))}px`);
    });
    this.resize.observe(player);
  }

  get ready(): boolean {
    return this.ui?.host.isConnected === true;
  }

  show(original: string, translated: string | undefined, showOriginal: boolean, controlsVisible: boolean) {
    if (!this.layer || !this.original || !this.translated) return;
    this.layer.hidden = false;
    this.layer.dataset.controls = String(controlsVisible);
    this.original.hidden = !showOriginal;
    this.original.textContent = original;
    // 译文还没回来时只显示原文；仅译文模式下先显示原文占位，避免空白
    this.translated.textContent = translated ?? '';
    if (!showOriginal && !translated) {
      this.original.hidden = false;
    }
  }

  hide() {
    if (this.layer) this.layer.hidden = true;
  }

  detach() {
    this.resize?.disconnect();
    this.ui?.remove();
    this.ui = this.layer = this.original = this.translated = this.player = undefined;
  }
}
