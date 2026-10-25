import '@/ui/base.css';
import './style.css';
import { sendToBackground } from '@/lib/messages';
import { fileFromReaderUrl } from '@/lib/pdf/auto-open';
import { CJK_PRESETS, cjkFontLabel, isPreset } from '@/lib/pdf/fonts';
import { getProfile, PROFILES } from '@/lib/profiles';
import { getSettings, onSettingsChanged, saveSettings } from '@/lib/settings';
import { exportFileName, exportPdf, type ExportMode } from '@/pdf/export';
import { setupFindBar } from '@/pdf/find-bar';
import { setupHighlightBar } from '@/pdf/highlight-bar';
import { setupHighlightPanel } from '@/pdf/highlight-panel';
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
const findBar = setupFindBar(() => viewer);
/** 导出强调时的标题和来源（文件地址或本地文件名） */
let docMeta = { title: '', from: '' };
const highlightPanel = setupHighlightPanel($<HTMLButtonElement>('#hl-toggle'), () => {
  const v = viewer;
  return (
    v && {
      entries: () => v.highlightEntries(),
      reveal: (id) => v.revealHighlight(id),
      remove: (id) => void v.removeHighlight(id),
      clear: () => void v.clearHighlights(),
      meta: () => docMeta,
    }
  );
});
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

async function load(data: ArrayBuffer, fallbackTitle: string, from = fallbackTitle) {
  notice.hidden = true;
  $('#empty').hidden = true;
  pages.replaceChildren();
  const doc = await openPdf(data);
  const meta = (await doc.getMetadata().catch(() => undefined))?.info as { Title?: string } | undefined;
  const title = meta?.Title?.trim() || fallbackTitle;
  document.title = `${title} - PDF 双语阅读`;
  $('#doc-title').textContent = title;
  docMeta = { title, from };
  viewer = new PdfViewer(doc, pages, title, {
    onProgress: (done, total, failed) => {
      progress.textContent = `已翻译 ${done} / ${total} 页${failed ? `，${failed} 段失败` : ''}`;
      retry.hidden = failed === 0;
    },
    onError: showNotice,
    onNotice: showNotice,
  });
  viewer.onTextChange = () => {
    findBar.refresh();
    highlightPanel.refresh();
  };
  viewer.onHighlightsChange = () => highlightPanel.refresh();
  viewer.topInset = () => document.querySelector('.toolbar')?.getBoundingClientRect().bottom ?? 0;
  await viewer.init();
  highlightPanel.refresh();
  // 打开文件期间可能换过字体，以下拉框为准
  viewer.setCjkFont(cjkFont);
  renderControls();
  $<HTMLButtonElement>('#export').disabled = false;
  await viewer.restorePosition();
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
  // 读取本机字体要弹授权框，只能由用户点击触发；已授权过就直接读。
  // 页面不可见时读不了（报 Page needs to be visible）：在后台打开的阅读器等切到前台再读
  if (!(await localFontsGranted())) return;
  if (document.visibilityState === 'visible') await loadLocalFonts();
  else document.addEventListener('visibilitychange', () => void loadLocalFonts(), { once: true });
}

async function openFile(file: File) {
  // 换成本地文件后，「原文件」不再对应当前文档
  $('#original').hidden = true;
  try {
    await load(await file.arrayBuffer(), file.name);
  } catch (err) {
    showNotice(`打开失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 导出 PDF（D63）：选格式 → 逐页渲染、补翻 → 下载；导出中按钮变成「取消导出」 */
function setupExport() {
  const button = $<HTMLButtonElement>('#export');
  const dialog = $<HTMLDialogElement>('#export-dialog');
  let running = false;
  let cancelled = false;
  button.addEventListener('click', () => {
    if (!viewer) return;
    if (running) {
      cancelled = true;
      return;
    }
    const left = viewer.untranslatedPages();
    $('#export-info').textContent =
      left === 0 ? `共 ${viewer.pageCount} 页，都已翻译。` : `共 ${viewer.pageCount} 页，还有 ${left} 页没翻译，导出时会先翻译这些页（产生 API 费用）。`;
    dialog.showModal();
  });
  // 按钮直接处理点击，不等对话框的 close 事件：它异步派发，后台标签页里会被拖延
  dialog.addEventListener('click', async (e) => {
    const mode = (e.target as HTMLElement).closest<HTMLElement>('[data-mode]')?.dataset.mode as ExportMode | 'cancel' | undefined;
    if (!mode) return;
    dialog.close();
    const v = viewer;
    if (!v || mode === 'cancel' || running) return;
    running = true;
    cancelled = false;
    button.textContent = '取消导出';
    try {
      const result = await exportPdf(v, mode, docMeta.title, (done, total) => (progress.textContent = `正在导出 ${done} / ${total} 页…`), () => cancelled);
      if (!result) {
        progress.textContent = '已取消导出';
        return;
      }
      const url = URL.createObjectURL(new Blob([result.bytes as BlobPart], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = exportFileName(docMeta.title, mode);
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      progress.textContent = '已导出';
      if (result.failed > 0) showNotice(`有 ${result.failed} 段翻译失败，导出的文件里这些段落是原文`);
    } catch (err) {
      showNotice(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
      button.textContent = '导出 PDF';
    }
  });
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
  setupHighlightBar(pages, {
    apply: (ranges, style) =>
      void viewer?.setHighlight(ranges, style).catch((err: unknown) => showNotice(`保存强调失败：${err instanceof Error ? err.message : String(err)}`)),
    hasHighlight: (ranges) => viewer?.hasHighlight(ranges) ?? false,
  });
  setupExport();
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

  // ?file=（弹窗、右键菜单）或 #原地址（自动打开 PDF 的重定向，D61）
  const file = fileFromReaderUrl(location.href);
  if (!file) {
    $('#empty').hidden = false;
    return;
  }
  // 「原文件」：用浏览器自带的查看器看原 PDF（后台先放行这个地址，免得又被转回阅读器）
  const original = $<HTMLButtonElement>('#original');
  original.hidden = !/^(https?|file):/.test(file);
  original.addEventListener('click', () => void sendToBackground({ type: 'open-original-pdf', url: file }).catch((err: unknown) => showNotice(String(err))));
  // 自动打开的本地 PDF：告诉后台这个标签页正在看它，之后从这里后退到那个文件时，后台知道是在后退（D67）
  if (file.startsWith('file:') && !new URL(location.href).searchParams.has('file')) {
    window.addEventListener('pageshow', () => void sendToBackground({ type: 'local-pdf-shown', url: file }).catch(() => undefined));
  }
  progress.textContent = '正在打开…';
  fetchPdf(file)
    .then((data) => load(data, fileNameOf(file), file))
    .catch((err: unknown) => {
      progress.textContent = '';
      showNotice(err instanceof Error ? err.message : String(err));
      $('#empty').hidden = false;
    });
}

// 阅读位置由阅读器自己记（D62），不让浏览器在刷新时按旧的滚动距离恢复（页面是陆续撑开的，会对不上）
history.scrollRestoration = 'manual';

// 阅读器可被网页访问（自动打开 PDF 的重定向需要），被嵌进别人的页面时不加载，免得替别人消耗 API 额度
if (window.top === window) init();
else document.body.textContent = '双语阅读器不能嵌入其他页面使用';
