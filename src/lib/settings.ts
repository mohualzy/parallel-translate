import { browser } from 'wxt/browser';

export type DisplayMode = 'bilingual' | 'translation';
export type TranslationStyle = 'none' | 'dashed' | 'underline' | 'highlight' | 'weak' | 'blur';
export type HoverKey = 'Control' | 'Alt' | 'Shift' | 'off';
/** 划词翻译：icon 选区旁出现按钮，点了再翻；direct 选中即翻；off 关闭 */
export type SelectionMode = 'icon' | 'direct' | 'off';
export type ProviderType = 'openai';

/** 通用偏好：内容脚本可读（不含任何密钥） */
export interface Settings {
  targetLang: string;
  activeProviderId: string;
  displayMode: DisplayMode;
  translationStyle: TranslationStyle;
  hoverKey: HoverKey;
  selectionMode: SelectionMode;
  /** 页面右侧的悬浮球 */
  floatBall: boolean;
  /** 悬浮球纵向位置（占视口高度的比例 0~1），所有网站共用 */
  floatBallTop: number;
  floatBallHiddenSites: string[];
  /** 译文中保留链接、加粗、行内代码 */
  richText: boolean;
  /** 不自动翻译按钮、标签页、导航链接等短界面文字 */
  skipShortUI: boolean;
  /** 译文被省略号 / 行数限制截断时解除容器截断 */
  unclamp: boolean;
  /** 翻译时把标签页标题换成译文 */
  translateTitle: boolean;
  /** YouTube 打开字幕时显示双语字幕 */
  youtubeSubtitles: boolean;
  /** 输入框翻译（Alt+I / 连按三次空格）的目标语言，与网页翻译的目标语言无关 */
  inputTargetLang: string;
  /** 输入框末尾连按三次空格触发翻译 */
  inputSpaceTrigger: boolean;
  /** 页面语言不是目标语言时自动翻译 */
  autoTranslateForeign: boolean;
  alwaysTranslateSites: string[];
  neverTranslateSites: string[];
  /** 额外排除的 CSS 选择器（命中的元素及其子树不翻译） */
  excludeSelectors: string[];
  /** 用户术语表原文：每行 `原文 = 译法`（见 lib/glossary.ts） */
  glossary: string;
  batchMaxChars: number;
  batchMaxSegments: number;
}

/** 翻译服务配置：含 API Key，只有 background / 设置页 / 弹窗可读 */
export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  baseURL: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxConcurrent: number;
  timeoutMs: number;
  stream: boolean;
  /** 自定义翻译风格要求，留空使用默认；格式约束由程序固定追加，用户改不坏 */
  prompt: string;
  /** 合并进请求体的额外参数（JSON 对象文本），如 {"enable_thinking": false} */
  extraBody: string;
}

export const DEFAULT_SETTINGS: Settings = {
  targetLang: 'zh-CN',
  activeProviderId: '',
  displayMode: 'bilingual',
  translationStyle: 'none',
  hoverKey: 'Control',
  selectionMode: 'icon',
  floatBall: true,
  floatBallTop: 0.6,
  floatBallHiddenSites: [],
  richText: true,
  skipShortUI: true,
  unclamp: true,
  translateTitle: true,
  youtubeSubtitles: true,
  inputTargetLang: 'en',
  inputSpaceTrigger: true,
  autoTranslateForeign: false,
  alwaysTranslateSites: [],
  neverTranslateSites: [],
  excludeSelectors: [],
  glossary: '',
  batchMaxChars: 2000,
  batchMaxSegments: 12,
};

export interface ProviderPreset {
  label: string;
  baseURL: string;
  /** 模型名示例，仅作输入框占位提示 */
  modelHint: string;
  /** 新建该服务时默认填入的额外请求参数 */
  extraBody?: string;
}

/** 常见 OpenAI 兼容服务的 Base URL；模型名不写死（会过时），用「获取模型列表」拉取 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  // DeepSeek 当前模型默认开启推理；翻译不需要，关闭后实测输出 token 减少约 75%（2026-10-22）
  {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    modelHint: 'deepseek-flash',
    extraBody: '{"thinking": {"type": "disabled"}}',
  },
  { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', modelHint: 'gpt-4o-mini' },
  { label: '通义千问 (DashScope)', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelHint: 'qwen-plus' },
  { label: 'Kimi (Moonshot)', baseURL: 'https://api.moonshot.cn/v1', modelHint: 'moonshot-v1-8k' },
  { label: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', modelHint: 'glm-4-flash' },
  { label: '硅基流动 SiliconFlow', baseURL: 'https://api.siliconflow.cn/v1', modelHint: 'Qwen/Qwen2.5-7B-Instruct' },
  { label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', modelHint: 'google/gemini-2.0-flash-001' },
  { label: 'Google Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', modelHint: 'gemini-2.0-flash' },
  { label: 'Ollama（本地）', baseURL: 'http://localhost:11434/v1', modelHint: 'qwen2.5:7b' },
  { label: '自定义', baseURL: '', modelHint: '' },
];

export function createProvider(preset?: ProviderPreset): ProviderConfig {
  return {
    id: crypto.randomUUID(),
    name: preset && preset.label !== '自定义' ? preset.label : '我的模型',
    type: 'openai',
    baseURL: preset?.baseURL ?? '',
    apiKey: '',
    model: '',
    temperature: 0.3,
    maxConcurrent: 3,
    timeoutMs: 90_000,
    stream: true,
    prompt: '',
    extraBody: preset?.extraBody ?? '',
  };
}

const SETTINGS_KEY = 'settings';
const PROVIDERS_KEY = 'providers';

export async function getSettings(): Promise<Settings> {
  const stored = (await browser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export function onSettingsChanged(cb: (settings: Settings) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== 'local' || !changes[SETTINGS_KEY]) return;
    cb({ ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue as Partial<Settings>) });
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

export async function getProviders(): Promise<ProviderConfig[]> {
  const stored = (await browser.storage.local.get(PROVIDERS_KEY))[PROVIDERS_KEY] as ProviderConfig[] | undefined;
  // 与默认值合并，兼容旧版本缺字段的配置
  return (stored ?? []).map((p) => ({ ...createProvider(), ...p }));
}

export async function saveProviders(providers: ProviderConfig[]): Promise<void> {
  await browser.storage.local.set({ [PROVIDERS_KEY]: providers });
}

/** 当前生效的服务：优先 activeProviderId，找不到时退回第一个 */
export async function getActiveProvider(): Promise<ProviderConfig | undefined> {
  const [settings, providers] = await Promise.all([getSettings(), getProviders()]);
  return providers.find((p) => p.id === settings.activeProviderId) ?? providers[0];
}

/** 站点规则匹配：`example.com` 同时匹配 example.com 与 *.example.com */
export function matchSite(hostname: string, patterns: string[]): boolean {
  const host = hostname.toLowerCase();
  return patterns.some((raw) => {
    const p = raw.trim().toLowerCase().replace(/^\*\./, '');
    return p !== '' && (host === p || host.endsWith(`.${p}`));
  });
}
