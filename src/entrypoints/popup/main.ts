import '@/ui/base.css';
import './style.css';
import { browser } from 'wxt/browser';
import { sendToTab, type TabState } from '@/lib/messages';
import { getProviders, getSettings, saveSettings, type DisplayMode, type Settings } from '@/lib/settings';
import { $, fillSelect, languageOptions, styleOptions } from '@/ui/labels';

const toggleBtn = $<HTMLButtonElement>('#toggle');
const statusEl = $('#status');
const noticeEl = $('#notice');

let tabId: number | undefined;
let host = '';

function renderState(state: TabState | undefined) {
  if (!state) {
    toggleBtn.disabled = true;
    toggleBtn.textContent = '此页面无法翻译';
    statusEl.textContent = '浏览器内置页面、扩展商店等不允许运行扩展；刚安装扩展时请先刷新页面。';
    return;
  }
  toggleBtn.disabled = false;
  toggleBtn.textContent = state.enabled ? '显示原文' : '翻译此页面';
  if (!state.enabled) {
    statusEl.textContent = state.pageLang && state.pageLang !== 'und' ? `检测到页面语言：${state.pageLang}` : '';
    return;
  }
  const failed = state.failed > 0 ? `，失败 ${state.failed} 段` : '';
  statusEl.textContent = `已翻译 ${state.done} / ${state.total} 段${failed}（只翻译滚动到的部分）`;
}

async function queryState(): Promise<TabState | undefined> {
  if (tabId === undefined) return undefined;
  try {
    return await sendToTab(tabId, { type: 'get-state' });
  } catch {
    return undefined;
  }
}

function renderDisplayMode(mode: DisplayMode) {
  for (const btn of $('#display-mode').querySelectorAll('button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.value === mode));
  }
}

async function updateSiteList(key: 'alwaysTranslateSites' | 'neverTranslateSites', on: boolean, settings: Settings) {
  const list = settings[key].filter((h) => h !== host);
  if (on) list.push(host);
  return saveSettings({ [key]: list });
}

async function init() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  try {
    host = tab?.url ? new URL(tab.url).hostname : '';
  } catch {
    host = '';
  }

  let settings = await getSettings();
  const providers = await getProviders();

  if (providers.length === 0) {
    noticeEl.hidden = false;
    noticeEl.innerHTML = '还没有配置翻译服务。<a id="go-setup">去设置 →</a>';
    $('#go-setup').addEventListener('click', () => browser.runtime.openOptionsPage());
  }

  fillSelect($<HTMLSelectElement>('#target-lang'), languageOptions(), settings.targetLang);
  fillSelect($<HTMLSelectElement>('#style'), styleOptions(), settings.translationStyle);
  const activeId = providers.find((p) => p.id === settings.activeProviderId)?.id ?? providers[0]?.id ?? '';
  fillSelect(
    $<HTMLSelectElement>('#provider'),
    providers.map((p) => [p.id, p.model ? `${p.name} · ${p.model}` : p.name]),
    activeId,
  );
  $<HTMLSelectElement>('#provider').disabled = providers.length === 0;
  renderDisplayMode(settings.displayMode);

  for (const el of document.querySelectorAll('.host')) el.textContent = host || '（无）';
  const always = $<HTMLInputElement>('#always');
  const never = $<HTMLInputElement>('#never');
  always.checked = settings.alwaysTranslateSites.includes(host);
  never.checked = settings.neverTranslateSites.includes(host);
  always.disabled = never.disabled = !host;

  // ---------- 事件 ----------
  $<HTMLSelectElement>('#target-lang').addEventListener('change', async (e) => {
    settings = await saveSettings({ targetLang: (e.target as HTMLSelectElement).value });
  });
  $<HTMLSelectElement>('#style').addEventListener('change', async (e) => {
    settings = await saveSettings({ translationStyle: (e.target as HTMLSelectElement).value as Settings['translationStyle'] });
  });
  $<HTMLSelectElement>('#provider').addEventListener('change', async (e) => {
    settings = await saveSettings({ activeProviderId: (e.target as HTMLSelectElement).value });
  });
  $('#display-mode').addEventListener('click', async (e) => {
    const value = (e.target as HTMLElement).closest('button')?.dataset.value as DisplayMode | undefined;
    if (!value) return;
    renderDisplayMode(value);
    settings = await saveSettings({ displayMode: value });
  });
  always.addEventListener('change', async () => {
    settings = await updateSiteList('alwaysTranslateSites', always.checked, settings);
    if (always.checked && never.checked) {
      never.checked = false;
      settings = await updateSiteList('neverTranslateSites', false, settings);
    }
  });
  never.addEventListener('change', async () => {
    settings = await updateSiteList('neverTranslateSites', never.checked, settings);
    if (never.checked && always.checked) {
      always.checked = false;
      settings = await updateSiteList('alwaysTranslateSites', false, settings);
    }
  });

  toggleBtn.addEventListener('click', async () => {
    if (tabId === undefined) return;
    renderState(await sendToTab(tabId, { type: 'toggle' }).catch(() => undefined));
  });
  $('#open-options').addEventListener('click', () => browser.runtime.openOptionsPage());
  $('#shortcuts').addEventListener('click', () => browser.tabs.create({ url: 'chrome://extensions/shortcuts' }));

  const commands = await browser.commands.getAll();
  const key = (name: string) => commands.find((c) => c.name === name)?.shortcut || '未设置';
  $('#shortcut-hint').textContent = `翻译 ${key('toggle-translate')} · 切换显示 ${key('toggle-display-mode')}`;

  renderState(await queryState());
  // 弹窗打开期间刷新进度
  setInterval(async () => renderState(await queryState()), 1000);
}

void init();
