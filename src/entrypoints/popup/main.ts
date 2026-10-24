import '@/ui/base.css';
import './style.css';
import { browser } from 'wxt/browser';
import { sendToTab, type TabState } from '@/lib/messages';
import { getProfile, PROFILES } from '@/lib/profiles';
import { openSidePanel } from '@/lib/side-panel';
import { getProviders, getSettings, saveSettings, type DisplayMode, type Settings } from '@/lib/settings';
import { $, fillSelect, languageOptions, styleOptions } from '@/ui/labels';

const toggleBtn = $<HTMLButtonElement>('#toggle');
const retryBtn = $<HTMLButtonElement>('#retry');
const profileSelect = $<HTMLSelectElement>('#profile');
const termsBox = $<HTMLDetailsElement>('#terms');
const statusEl = $('#status');
const noticeEl = $('#notice');

let tabId: number | undefined;
let windowId: number | undefined;
let host = '';

/** 本文术语：AI 抽取的术语和译法，让用户知道为什么某个词这样译（不对就写进术语表纠正） */
function renderTerms(terms: TabState['terms']) {
  termsBox.hidden = terms.length === 0;
  termsBox.querySelector('summary')!.textContent = `本文术语 ${terms.length} 条（AI 抽取，保证前后译法一致）`;
  // 弹窗每秒刷新一次状态，内容没变就不重建，免得打断滚动
  const text = terms.map((t) => `${t.source} → ${t.target}`);
  const list = termsBox.querySelector('ul')!;
  if (list.dataset.text === text.join('|')) return;
  list.dataset.text = text.join('|');
  list.replaceChildren(
    ...text.map((t) => Object.assign(document.createElement('li'), { textContent: t })),
  );
}

function renderState(state: TabState | undefined) {
  retryBtn.hidden = !state?.enabled || state.failed === 0;
  // 「自动」后面显示当前页面自动选中的风格（论文页的判断依赖页面内容，只有内容脚本知道）
  profileSelect.disabled = !state;
  renderTerms(state?.terms ?? []);
  const auto = profileSelect.querySelector<HTMLOptionElement>('option[value="auto"]');
  if (auto) auto.textContent = state ? `自动（${getProfile(state.autoProfile).name}）` : '自动';
  if (state) retryBtn.textContent = `重试失败的 ${state.failed} 段`;
  if (!state) {
    toggleBtn.disabled = true;
    toggleBtn.textContent = '此页面无法翻译';
    statusEl.textContent = '浏览器内置页面、扩展商店等不允许运行扩展。';
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
  windowId = tab?.windowId;
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
  fillSelect(profileSelect, [['auto', '自动'], ...PROFILES.map((p): [string, string] => [p.id, p.name])], settings.siteProfiles[host] ?? 'auto');
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
  profileSelect.addEventListener('change', async () => {
    if (!host) return;
    // 只对当前网站生效；选「自动」即清除指定。页面收到设置变化后按新风格重翻
    const siteProfiles = { ...settings.siteProfiles };
    if (profileSelect.value === 'auto') delete siteProfiles[host];
    else siteProfiles[host] = profileSelect.value;
    settings = await saveSettings({ siteProfiles });
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
  retryBtn.addEventListener('click', async () => {
    if (tabId === undefined) return;
    renderState(await sendToTab(tabId, { type: 'retry-failed' }).catch(() => undefined));
  });
  $('#open-options').addEventListener('click', () => browser.runtime.openOptionsPage());
  // 同步调用以保住用户手势（见 lib/side-panel.ts），打开后关掉弹窗
  $('#open-side-panel').addEventListener('click', () => {
    void openSidePanel(windowId).then(() => window.close(), () => undefined);
  });
  $('#shortcuts').addEventListener('click', () => browser.tabs.create({ url: 'chrome://extensions/shortcuts' }));

  const commands = await browser.commands.getAll();
  const key = (name: string) => commands.find((c) => c.name === name)?.shortcut || '未设置';
  $('#shortcut-hint').textContent = `翻译 ${key('toggle-translate')} · 整页 ${key('translate-whole-page')}`;
  const sideKey = commands.find((c) => c.name === 'open-side-panel')?.shortcut;
  if (sideKey) $('#open-side-panel').textContent = `在侧栏翻译文本（${sideKey}）`;

  renderState(await queryState());
  // 弹窗打开期间刷新进度
  setInterval(async () => renderState(await queryState()), 1000);
}

void init();
