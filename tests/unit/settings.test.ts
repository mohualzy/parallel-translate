import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  createProvider,
  DEFAULT_SETTINGS,
  getActiveProvider,
  getProviders,
  getSettings,
  GOOGLE_PROVIDER_ID,
  matchSite,
  PROVIDER_PRESETS,
  saveProviders,
  saveSettings,
} from '@/lib/settings';

beforeEach(() => fakeBrowser.reset());

describe('settings storage', () => {
  it('未保存时返回默认值，保存后合并', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
    await saveSettings({ targetLang: 'ja' });
    expect((await getSettings()).targetLang).toBe('ja');
    expect((await getSettings()).displayMode).toBe(DEFAULT_SETTINGS.displayMode);
  });

  it('当前服务：按 activeProviderId 查找，找不到退回第一个', async () => {
    const a = { ...createProvider(), name: 'A' };
    const b = { ...createProvider(), name: 'B' };
    await saveProviders([a, b]);
    expect((await getActiveProvider())?.name).toBe('A');
    await saveSettings({ activeProviderId: b.id });
    expect((await getActiveProvider())?.name).toBe('B');
    await saveSettings({ activeProviderId: 'missing' });
    expect((await getActiveProvider())?.name).toBe('A');
  });

  it('内置 Google 翻译：没有模型时生效，有模型时排在后面，可以手动选中，不写入存储', async () => {
    expect((await getActiveProvider()).id).toBe(GOOGLE_PROVIDER_ID);

    const a = { ...createProvider(), name: 'A' };
    await saveProviders([...(await getProviders()), a]);
    expect((await getProviders()).map((p) => p.name)).toEqual(['A', 'Google 翻译']);
    expect((await getActiveProvider()).name).toBe('A');
    expect(((await fakeBrowser.storage.local.get('providers')).providers as unknown[]).length).toBe(1);

    await saveSettings({ activeProviderId: GOOGLE_PROVIDER_ID });
    expect((await getActiveProvider()).id).toBe(GOOGLE_PROVIDER_ID);
  });
});

describe('createProvider', () => {
  it('从预设创建时带上预设的地址和额外参数', () => {
    const deepseek = PROVIDER_PRESETS.find((p) => p.label === 'DeepSeek')!;
    const p = createProvider(deepseek);
    expect(p.baseURL).toBe('https://api.deepseek.com/v1');
    expect(JSON.parse(p.extraBody)).toEqual({ thinking: { type: 'disabled' } });
    expect(createProvider().extraBody).toBe('');
  });

  it('本地 llama.cpp 预设的并发数与服务端并发槽一致', () => {
    const llama = PROVIDER_PRESETS.find((p) => p.label === 'llama.cpp（本地）')!;
    expect(createProvider(llama).maxConcurrent).toBe(2);
    expect(createProvider().maxConcurrent).toBe(3);
  });
});

describe('matchSite', () => {
  it('匹配域名及其子域名，不误伤相似域名', () => {
    expect(matchSite('example.com', ['example.com'])).toBe(true);
    expect(matchSite('www.example.com', ['example.com'])).toBe(true);
    expect(matchSite('www.example.com', ['*.example.com'])).toBe(true);
    expect(matchSite('badexample.com', ['example.com'])).toBe(false);
    expect(matchSite('example.com', ['', '  '])).toBe(false);
  });
});
