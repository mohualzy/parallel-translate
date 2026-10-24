import '@/ui/base.css';
import './style.css';
import { browser } from 'wxt/browser';
import { sendToBackground } from '@/lib/messages';
import { getProfile } from '@/lib/profiles';
import { parseExtraBody } from '@/lib/providers/openai';
import {
  createProvider,
  DEFAULT_SETTINGS,
  getProviders,
  getSettings,
  PROVIDER_PRESETS,
  saveProviders,
  saveSettings,
  type ProviderConfig,
  type Settings,
} from '@/lib/settings';
import { $, fillSelect, hoverKeyOptions, languageOptions, selectionModeOptions, styleOptions } from '@/ui/labels';

let providers: ProviderConfig[] = [];
let settings: Settings;
let selectedId = '';
let dirty = false;

const form = $<HTMLFormElement>('#provider-form');
const field = <T extends HTMLElement = HTMLInputElement>(name: string) => $<T>(`[name="${name}"]`, form);

// ---------- 通用 ----------

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: string) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2200);
}

function activeId(): string {
  return providers.find((p) => p.id === settings.activeProviderId)?.id ?? providers[0]?.id ?? '';
}

// ---------- 翻译服务 ----------

function renderProviderList() {
  const list = $('#provider-list');
  list.replaceChildren(
    ...providers.map((p) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.setAttribute('aria-selected', String(p.id === selectedId));
      if (p.id === activeId()) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.title = '当前使用';
        chip.append(dot);
      }
      chip.append(p.name || '未命名');
      chip.addEventListener('click', () => selectProvider(p.id));
      return chip;
    }),
  );
  $('#no-provider').hidden = providers.length > 0;
  form.hidden = !providers.some((p) => p.id === selectedId);
}

function fillForm(p: ProviderConfig) {
  field('name').value = p.name;
  field('baseURL').value = p.baseURL;
  field('apiKey').value = p.apiKey;
  field('model').value = p.model;
  field('temperature').value = String(p.temperature);
  field('maxConcurrent').value = String(p.maxConcurrent);
  field('timeoutSec').value = String(Math.round(p.timeoutMs / 1000));
  field('stream').checked = p.stream;
  field<HTMLTextAreaElement>('prompt').value = p.prompt;
  field<HTMLTextAreaElement>('extraBody').value = p.extraBody;
  const preset = PROVIDER_PRESETS.find((x) => x.baseURL && x.baseURL === p.baseURL);
  field('model').placeholder = preset?.modelHint ? `例如 ${preset.modelHint}` : '模型名';
  $('#model-list').replaceChildren();
  $('#models-status').textContent = '';
  $('#test-result').hidden = true;
  $<HTMLButtonElement>('#activate-provider').disabled = p.id === activeId();
  dirty = false;
}

function readForm(): ProviderConfig {
  const base = providers.find((p) => p.id === selectedId) ?? createProvider();
  const num = (name: string, fallback: number) => {
    const v = Number(field(name).value);
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    ...base,
    name: field('name').value.trim() || '未命名',
    baseURL: field('baseURL').value.trim(),
    apiKey: field('apiKey').value.trim(),
    model: field('model').value.trim(),
    temperature: num('temperature', base.temperature),
    maxConcurrent: Math.max(1, Math.round(num('maxConcurrent', base.maxConcurrent))),
    timeoutMs: Math.max(10, num('timeoutSec', base.timeoutMs / 1000)) * 1000,
    stream: field('stream').checked,
    prompt: field<HTMLTextAreaElement>('prompt').value.trim(),
    extraBody: field<HTMLTextAreaElement>('extraBody').value.trim(),
  };
}

function selectProvider(id: string) {
  if (id === selectedId) return;
  if (dirty && !confirm('当前服务有未保存的修改，确定放弃吗？')) return;
  selectedId = id;
  const p = providers.find((x) => x.id === id);
  if (p) fillForm(p);
  renderProviderList();
}

async function persistProviders() {
  await saveProviders(providers);
  // 第一个服务自动设为当前
  if (!providers.some((p) => p.id === settings.activeProviderId) && providers[0]) {
    settings = await saveSettings({ activeProviderId: providers[0].id });
  }
}

function showTestResult(text: string, ok: boolean) {
  const el = $('#test-result');
  el.hidden = false;
  el.className = `test-result ${ok ? 'ok' : 'error'}`;
  el.textContent = text;
}

function initProviders() {
  fillSelect(
    $<HTMLSelectElement>('#preset'),
    PROVIDER_PRESETS.map((p, i) => [String(i), p.label]),
    '0',
  );

  form.addEventListener('input', () => (dirty = true));

  $('#add-provider').addEventListener('click', async () => {
    const preset = PROVIDER_PRESETS[Number($<HTMLSelectElement>('#preset').value)];
    const p = createProvider(preset);
    providers.push(p);
    await persistProviders();
    dirty = false;
    selectProvider(p.id);
    field('apiKey').focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const next = readForm();
    if (!next.baseURL || !next.model) {
      toast('请填写接口地址和模型名');
      return;
    }
    try {
      parseExtraBody(next.extraBody);
    } catch (err) {
      toast((err as Error).message);
      return;
    }
    providers = providers.map((p) => (p.id === next.id ? next : p));
    await persistProviders();
    dirty = false;
    renderProviderList();
    toast('已保存');
  });

  $('#toggle-key').addEventListener('click', () => {
    const input = field('apiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('#toggle-key').textContent = show ? '隐藏' : '显示';
  });

  $('#fetch-models').addEventListener('click', async () => {
    const status = $('#models-status');
    status.className = 'muted';
    status.textContent = '正在获取…';
    try {
      const models = await sendToBackground({ type: 'list-models', provider: readForm() });
      $('#model-list').replaceChildren(
        ...models.map((id) => {
          const opt = document.createElement('option');
          opt.value = id;
          return opt;
        }),
      );
      status.textContent = models.length ? `共 ${models.length} 个模型，点击模型输入框即可选择` : '服务没有返回模型列表，请手动填写';
      if (models.length) field('model').focus();
    } catch (err) {
      status.className = 'error';
      status.textContent = (err as Error).message;
    }
  });

  $('#test-provider').addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('#test-provider');
    btn.disabled = true;
    showTestResult('正在测试…', true);
    try {
      const { text, ms } = await sendToBackground({ type: 'test-provider', provider: readForm() });
      showTestResult(`✓ 连接成功（${ms} ms）\n译文示例：${text}`, true);
    } catch (err) {
      showTestResult(`✗ ${(err as Error).message}`, false);
    } finally {
      btn.disabled = false;
    }
  });

  $('#activate-provider').addEventListener('click', async () => {
    settings = await saveSettings({ activeProviderId: selectedId });
    $<HTMLButtonElement>('#activate-provider').disabled = true;
    renderProviderList();
    toast('已设为当前使用的服务');
  });

  $('#delete-provider').addEventListener('click', async () => {
    const p = providers.find((x) => x.id === selectedId);
    if (!p || !confirm(`确定删除「${p.name}」吗？`)) return;
    providers = providers.filter((x) => x.id !== selectedId);
    await persistProviders();
    dirty = false;
    selectedId = '';
    if (providers[0]) selectProvider(providers[0].id);
    else renderProviderList();
    toast('已删除');
  });

  selectedId = activeId();
  const current = providers.find((p) => p.id === selectedId);
  if (current) fillForm(current);
  renderProviderList();
}

// ---------- 偏好与网站规则：修改即保存 ----------

function initPreferences() {
  fillSelect($<HTMLSelectElement>('#pref-target'), languageOptions(), settings.targetLang);
  fillSelect($<HTMLSelectElement>('#pref-style'), styleOptions(), settings.translationStyle);
  fillSelect($<HTMLSelectElement>('#pref-hover'), hoverKeyOptions(), settings.hoverKey);
  fillSelect($<HTMLSelectElement>('#pref-selection'), selectionModeOptions(), settings.selectionMode);
  fillSelect($<HTMLSelectElement>('#pref-input-target'), languageOptions(), settings.inputTargetLang);

  for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-setting]')) {
    const key = el.dataset.setting as keyof Settings;
    const value = settings[key];
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(value);
    else el.value = Array.isArray(value) ? value.join('\n') : String(value);

    el.addEventListener('change', async () => {
      let next: unknown;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') next = el.checked;
      else if (el instanceof HTMLInputElement && el.type === 'number') {
        const n = Number(el.value);
        next = Number.isFinite(n) && n > 0 ? n : DEFAULT_SETTINGS[key];
      } else if ('list' in el.dataset) {
        next = el.value
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
      } else next = el.value;
      settings = await saveSettings({ [key]: next });
      toast('已保存');
    });
  }
}

// ---------- 数据 ----------

async function refreshCacheCount() {
  try {
    $('#cache-count').textContent = String(await sendToBackground({ type: 'cache-count' }));
  } catch {
    $('#cache-count').textContent = '?';
  }
}

function download(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function importConfig(file: File) {
  const data = JSON.parse(await file.text()) as { settings?: Partial<Settings>; providers?: ProviderConfig[] };
  if (data.settings && typeof data.settings === 'object') {
    // 只接受已知字段
    const patch = Object.fromEntries(Object.entries(data.settings).filter(([k]) => k in DEFAULT_SETTINGS));
    settings = await saveSettings(patch);
  }
  if (Array.isArray(data.providers)) {
    const merged = new Map(providers.map((p) => [p.id, p]));
    for (const raw of data.providers) {
      if (!raw?.id || !raw.baseURL) continue;
      const existing = merged.get(raw.id);
      // 导入文件不含 Key 时保留本机已有的 Key
      merged.set(raw.id, { ...createProvider(), ...raw, apiKey: raw.apiKey || existing?.apiKey || '' });
    }
    providers = [...merged.values()];
    await persistProviders();
  }
}

function initData() {
  void refreshCacheCount();
  $('#clear-cache').addEventListener('click', async () => {
    if (!confirm('确定清空所有翻译缓存吗？之后再次翻译会重新计费。')) return;
    await sendToBackground({ type: 'clear-cache' });
    await refreshCacheCount();
    toast('缓存已清空');
  });

  $('#export').addEventListener('click', () => {
    const withKeys = $<HTMLInputElement>('#export-keys').checked;
    const data = {
      app: 'parallel-translate',
      version: 1,
      settings,
      providers: providers.map((p) => (withKeys ? p : { ...p, apiKey: '' })),
    };
    download(`parallel-translate-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2));
  });

  const fileInput = $<HTMLInputElement>('#import-file');
  $('#import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      await importConfig(file);
      toast('导入成功，正在刷新…');
      setTimeout(() => location.reload(), 600);
    } catch (err) {
      toast(`导入失败：${(err as Error).message}`);
    }
  });

  $('#edit-shortcuts').addEventListener('click', () => browser.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  void browser.commands.getAll().then((commands) => {
    $('#shortcut-list').textContent = commands
      .filter((c) => c.description)
      .map((c) => `${c.description}：${c.shortcut || '未设置'}`)
      .join('　·　');
  });
}

// ---------- 翻译风格：已为网站指定的档案 ----------

function renderSiteProfiles() {
  const list = $('#site-profiles');
  const entries = Object.entries(settings.siteProfiles);
  if (entries.length === 0) {
    list.innerHTML = '<li class="muted">还没有为任何网站指定风格</li>';
    return;
  }
  list.replaceChildren(
    ...entries.map(([host, id]) => {
      const li = document.createElement('li');
      const name = document.createElement('b');
      name.textContent = host;
      const profile = document.createElement('span');
      profile.textContent = getProfile(id).name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn';
      remove.textContent = '改回自动';
      remove.addEventListener('click', async () => {
        const siteProfiles = { ...settings.siteProfiles };
        delete siteProfiles[host];
        settings = await saveSettings({ siteProfiles });
        renderSiteProfiles();
        toast('已保存');
      });
      li.append(name, profile, remove);
      return li;
    }),
  );
}

async function init() {
  [settings, providers] = await Promise.all([getSettings(), getProviders()]);
  initProviders();
  initPreferences();
  renderSiteProfiles();
  initData();
}

void init();
