import '@/ui/base.css';
import './style.css';
import { browser } from 'wxt/browser';
import { getLanguage, LANGUAGES } from '@/lib/languages';
import type { SelectionEvent } from '@/lib/messages';
import { PROFILES } from '@/lib/profiles';
import { getProviders, getSettings, type Settings } from '@/lib/settings';
import { PENDING_TEXT_KEY } from '@/lib/side-panel';
import { resolveTextTarget, TEXT_PORT, type TextRequest } from '@/lib/text-translate';
import { $, fillSelect } from '@/ui/labels';

/**
 * 侧栏文本翻译（设计见 docs/specs/2026-10-23-side-panel-design.md）：
 * 服务、风格、目标语言只影响侧栏，不改全局设置；目标语言「自动」在两个方向间切换。
 */

const source = $<HTMLTextAreaElement>('#source');
const providerSelect = $<HTMLSelectElement>('#provider');
const profileSelect = $<HTMLSelectElement>('#profile');
const targetSelect = $<HTMLSelectElement>('#target');
const resultBox = $('#result-box');
const result = $('#result');
const direction = $('#direction');
const errorEl = $('#error');

type Port = ReturnType<typeof browser.runtime.connect>;

let settings: Settings;
let port: Port | undefined;

function currentTarget(): string {
  return resolveTextTarget(source.value, targetSelect.value, settings.targetLang, settings.inputTargetLang);
}

/** 「自动」后面显示按当前输入解析出的方向 */
function renderAutoLabel() {
  const auto = targetSelect.querySelector<HTMLOptionElement>('option[value="auto"]');
  if (auto) auto.textContent = `自动（→ ${getLanguage(currentTarget()).name}）`;
}

function showError(message: string) {
  errorEl.hidden = false;
  errorEl.textContent = message;
  result.dataset.state = 'error';
}

function translate() {
  const text = source.value.trim();
  if (!text) return;
  // 再次翻译时中止上一个请求（断开长连接，后台随之中止）
  port?.disconnect();
  const targetLang = currentTarget();
  errorEl.hidden = true;
  resultBox.hidden = false;
  result.textContent = '';
  result.dataset.state = 'loading';
  direction.textContent = `译成 ${getLanguage(targetLang).name}`;

  const current = browser.runtime.connect({ name: TEXT_PORT });
  port = current;
  current.onMessage.addListener((event: SelectionEvent) => {
    if (port !== current) return;
    if (event.type === 'delta') result.textContent += event.delta;
    else if (event.type === 'done') {
      // 流式片段可能带着模型照抄的标签，以后台清理过的完整译文为准
      result.textContent = event.text;
      result.dataset.state = 'done';
      current.disconnect();
    } else {
      showError(event.error);
      current.disconnect();
    }
  });
  const request: TextRequest = {
    text,
    targetLang,
    profile: profileSelect.value,
    providerId: providerSelect.value || undefined,
  };
  current.postMessage(request);
}

/** 右键菜单「在侧栏中翻译选中文字」经 storage.session 交过来的文字：填入并立即翻译 */
async function takePendingText() {
  const pending = (await browser.storage.session.get(PENDING_TEXT_KEY))[PENDING_TEXT_KEY] as string | undefined;
  if (!pending) return;
  await browser.storage.session.remove(PENDING_TEXT_KEY);
  source.value = pending;
  renderAutoLabel();
  translate();
}

async function init() {
  const [s, providers] = await Promise.all([getSettings(), getProviders()]);
  settings = s;
  const activeId = providers.find((p) => p.id === settings.activeProviderId)?.id ?? providers[0]?.id ?? '';
  fillSelect(
    providerSelect,
    providers.map((p) => [p.id, p.model ? `${p.name} · ${p.model}` : p.name]),
    activeId,
  );
  if (providers.length === 0) showError('还没有配置翻译服务：请在扩展设置页添加一个模型 API');
  fillSelect(profileSelect, PROFILES.map((p): [string, string] => [p.id, p.name]), 'general');
  fillSelect(targetSelect, [['auto', '自动'], ...LANGUAGES.map((l): [string, string] => [l.code, l.name])], 'auto');
  renderAutoLabel();

  $('#translate').addEventListener('click', translate);
  $('#clear').addEventListener('click', () => {
    port?.disconnect();
    port = undefined;
    source.value = '';
    resultBox.hidden = true;
    errorEl.hidden = true;
    renderAutoLabel();
    source.focus();
  });
  $('#copy').addEventListener('click', async (e) => {
    const button = e.currentTarget as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText(result.textContent ?? '');
      button.textContent = '已复制';
    } catch {
      button.textContent = '复制失败';
    }
    setTimeout(() => (button.textContent = '复制'), 1500);
  });
  source.addEventListener('input', renderAutoLabel);
  // 粘贴即翻译：paste 事件触发时输入框的值还没更新，等这一轮事件处理完再读
  source.addEventListener('paste', () => {
    setTimeout(() => {
      renderAutoLabel();
      translate();
    }, 0);
  });
  // 已经翻译过时，改服务、风格、目标语言直接按新设置重翻
  for (const select of [providerSelect, profileSelect, targetSelect]) {
    select.addEventListener('change', () => {
      if (!resultBox.hidden) translate();
    });
  }
  source.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      translate();
    }
  });

  // 侧栏已经打开时，右键菜单再次送来文字
  browser.storage.session.onChanged.addListener((changes) => {
    if (changes[PENDING_TEXT_KEY]?.newValue) void takePendingText();
  });
  await takePendingText();
  source.focus();
}

void init();
