import '@/ui/base.css';
import './style.css';
import { CJK_PRESETS, cjkFontLabel, isPreset } from '@/lib/pdf/fonts';
import { getProfile, PROFILES } from '@/lib/profiles';
import { getSettings, onSettingsChanged, saveSettings } from '@/lib/settings';
import { listCjkFonts, localFontsGranted, localFontsSupported } from '@/pdf/local-fonts';
import { fetchPdf, openPdf } from '@/pdf/loader';
import { PdfViewer, type ViewMode } from '@/pdf/viewer';
import { $, fillSelect } from '@/ui/labels';

/**
 * PDF 双语阅读器页面：?file=<地址> 打开远程或本地 PDF；没有参数时可拖放或选择本地文件。
 * 文件只在本机解析（AGENTS.md 硬性规则 7）。
 */

const pages = $('#pages');
const notice = $('#notice');
const progress = $('#progress');
const retry = $<HTMLButtonElement>('#retry');
const profileSelect = $<HTMLSelectElement>('#profile');
const fontSelect = $<HTMLSelectElement>('#cjk-font');
let viewer: PdfViewer | undefined;
/** 当前的译文中文字体（设置值）；本机字体列表读取后缓存 */
let cjkFont = '';
let localFonts: string[] | undefined;
/** 本页自己写入、还没收到变化通知的次数：连续切换时，旧的通知不能把下拉框拨回去 */
let ownSaves = 0;
const LOAD_FONTS = '#load';
const CUSTOM_FONT = '#custom';

function showNotice(message: string) {
  notice.hidden = false;
  notice.textContent = message;
}

function fileNameOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? url);
  } catch {
    return url;
  }
}

async function load(data: ArrayBuffer, fallbackTitle: string) {
  notice.hidden = true;
  $('#empty').hidden = true;
  pages.replaceChildren();
  const doc = await openPdf(data);
  const meta = (await doc.getMetadata().catch(() => undefined))?.info as { Title?: string } | undefined;
  const title = meta?.Title?.trim() || fallbackTitle;
  document.title = `${title} - PDF 双语阅读`;
  $('#doc-title').textContent = title;
  viewer = new PdfViewer(doc, pages, title, {
    onProgress: (done, total, failed) => {
      progress.textContent = `已翻译 ${done} / ${total} 页${failed ? `，${failed} 段失败` : ''}`;
      retry.hidden = failed === 0;
    },
    onError: showNotice,
    onNotice: showNotice,
  });
  await viewer.init();
  // 打开文件期间可能换过字体，以下拉框为准
  viewer.setCjkFont(cjkFont);
  renderControls();
}

function renderControls() {
  if (!viewer) return;
  fillSelect(
    profileSelect,
    [['auto', `自动（${getProfile(viewer.autoProfile).name}）`], ...PROFILES.map((p): [string, string] => [p.id, p.name])],
    viewer.profile === viewer.autoProfile ? 'auto' : viewer.profile,
  );
  for (const btn of $('#mode').querySelectorAll('button')) btn.setAttribute('aria-pressed', String(btn.dataset.value === viewer.mode));
  $('#zoom-label').textContent = `${Math.round(viewer.zoom * 100)}%`;
}

function option(value: string, label: string): HTMLOptionElement {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label;
  return opt;
}

function group(label: string, options: HTMLOptionElement[]): HTMLOptGroupElement {
  const g = document.createElement('optgroup');
  g.label = label;
  g.append(...options);
  return g;
}

/** 字体下拉框：自动、预设、本机字体（当前值不在列表里时也列出）、读取 / 手动输入 */
function renderFontSelect() {
  const installed = [...(localFonts ?? [])];
  if (cjkFont !== '' && !isPreset(cjkFont) && !installed.includes(cjkFont)) installed.unshift(cjkFont);
  fontSelect.replaceChildren(
    option('', '自动（随原文选宋体 / 黑体）'),
    group('预设', Object.entries(CJK_PRESETS).map(([v, label]) => option(v, label))),
    ...(installed.length > 0 ? [group('本机字体', installed.map((f) => option(f, f)))] : []),
    group('更多', [
      ...(localFonts === undefined && localFontsSupported() ? [option(LOAD_FONTS, '读取本机字体…')] : []),
      option(CUSTOM_FONT, '手动输入…'),
    ]),
  );
  fontSelect.value = cjkFont;
  fontSelect.title = `译文里的中文用 ${cjkFontLabel(cjkFont)}；英文仍用 PDF 原字体`;
}

function applyFont(font: string) {
  if (font === cjkFont) return;
  cjkFont = font;
  renderFontSelect();
  viewer?.setCjkFont(font);
  ownSaves++;
  saveSettings({ pdfCjkFont: font }).catch((err: unknown) => {
    ownSaves--;
    showNotice(`保存字体设置失败：${err instanceof Error ? err.message : String(err)}`);
  });
}

async function loadLocalFonts() {
  try {
    localFonts = await listCjkFonts();
  } catch (err) {
    showNotice(`读取本机字体失败：${err instanceof Error ? err.message : String(err)}`);
  }
  renderFontSelect();
}

async function initFonts() {
  cjkFont = (await getSettings()).pdfCjkFont;
  renderFontSelect();
  // 其他阅读器标签页换了字体时同步
  onSettingsChanged((s) => {
    if (ownSaves > 0) {
      ownSaves--;
      return;
    }
    if (s.pdfCjkFont === cjkFont) return;
    cjkFont = s.pdfCjkFont;
    renderFontSelect();
    viewer?.setCjkFont(cjkFont);
  });
  // 读取本机字体要弹授权框，只能由用户点击触发；已授权过就直接读
  if (await localFontsGranted()) await loadLocalFonts();
}

async function openFile(file: File) {
  try {
    await load(await file.arrayBuffer(), file.name);
  } catch (err) {
    showNotice(`打开失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

function init() {
  $('#mode').addEventListener('click', (e) => {
    const value = (e.target as HTMLElement).closest('button')?.dataset.value as ViewMode | undefined;
    if (!viewer || !value) return;
    viewer.setMode(value);
    renderControls();
  });
  profileSelect.addEventListener('change', () => {
    if (!viewer) return;
    viewer.setProfile(profileSelect.value === 'auto' ? viewer.autoProfile : profileSelect.value);
    renderControls();
  });
  $('#zoom-in').addEventListener('click', () => {
    viewer?.setZoom(viewer.zoom + 0.1);
    renderControls();
  });
  $('#zoom-out').addEventListener('click', () => {
    viewer?.setZoom(viewer.zoom - 0.1);
    renderControls();
  });
  fontSelect.addEventListener('change', () => {
    const value = fontSelect.value;
    fontSelect.value = cjkFont;
    if (value === LOAD_FONTS) {
      void loadLocalFonts();
    } else if (value === CUSTOM_FONT) {
      const name = prompt('输入已安装字体的名称（字体族名，如 LXGW WenKai）', isPreset(cjkFont) ? '' : cjkFont)?.trim();
      if (name) applyFont(name);
    } else {
      applyFont(value);
    }
  });
  void initFonts();
  retry.addEventListener('click', () => {
    notice.hidden = true;
    viewer?.retryFailed();
  });
  const input = $<HTMLInputElement>('#file');
  $('#open').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void openFile(file);
  });
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (file) void openFile(file);
  });
  // 窗口宽度变化时按新宽度重排（只看宽度：高度变化不影响页面尺寸）
  let width = window.innerWidth;
  let timer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener('resize', () => {
    if (window.innerWidth === width) return;
    width = window.innerWidth;
    clearTimeout(timer);
    timer = setTimeout(() => viewer?.layoutPages(), 300);
  });

  const file = new URLSearchParams(location.search).get('file');
  if (!file) {
    $('#empty').hidden = false;
    return;
  }
  progress.textContent = '正在打开…';
  fetchPdf(file)
    .then((data) => load(data, fileNameOf(file)))
    .catch((err: unknown) => {
      progress.textContent = '';
      showNotice(err instanceof Error ? err.message : String(err));
      $('#empty').hidden = false;
    });
}

init();
