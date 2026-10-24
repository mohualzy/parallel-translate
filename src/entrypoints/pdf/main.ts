import '@/ui/base.css';
import './style.css';
import { getProfile, PROFILES } from '@/lib/profiles';
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
let viewer: PdfViewer | undefined;

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
