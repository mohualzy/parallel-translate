import { describe, expect, it } from 'vitest';
import { SpaceTrigger, textForSpaceTrigger, type InputEventInfo } from '@/lib/input-trigger';

const space = (timeStamp: number, extra: Partial<InputEventInfo> = {}): InputEventInfo => ({
  inputType: 'insertText',
  data: ' ',
  isComposing: false,
  isTrusted: true,
  timeStamp,
  ...extra,
});

describe('SpaceTrigger', () => {
  it('连续三次空格触发，触发后清零', () => {
    const t = new SpaceTrigger();
    expect([space(0), space(100), space(200)].map((e) => t.feed(e))).toEqual([false, false, true]);
    expect(t.feed(space(300))).toBe(false);
  });

  it('中间夹着其他输入、停顿太久都会清零', () => {
    const t = new SpaceTrigger();
    t.feed(space(0));
    t.feed(space(100));
    t.feed({ ...space(150), data: 'a' });
    expect(t.feed(space(200))).toBe(false);
    expect(t.feed(space(300))).toBe(false);
    expect(t.feed(space(2000))).toBe(false); // 间隔超过 800ms，重新计数
    t.feed(space(2100));
    expect(t.feed(space(2200))).toBe(true);
  });

  it('输入法组合输入、上屏、合成事件都不计数', () => {
    const t = new SpaceTrigger();
    t.feed(space(0));
    t.feed(space(100));
    expect(t.feed(space(200, { isComposing: true }))).toBe(false);
    const t2 = new SpaceTrigger();
    t2.feed(space(0));
    t2.feed(space(100));
    expect(t2.feed(space(200, { inputType: 'insertCompositionText' }))).toBe(false);
    const t3 = new SpaceTrigger();
    t3.feed(space(0));
    t3.feed(space(100));
    expect(t3.feed(space(200, { isTrusted: false }))).toBe(false);
  });
});

describe('textForSpaceTrigger', () => {
  it('末尾三个空格（含 nbsp）时返回去掉空格的全文', () => {
    expect(textForSpaceTrigger('你好世界   ', '')).toBe('你好世界');
    expect(textForSpaceTrigger('第一行\n第二行 \u00a0 ', '')).toBe('第一行\n第二行');
  });

  it('光标后还有内容、行首缩进、空内容、不足三个空格时不触发', () => {
    expect(textForSpaceTrigger('你好   ', '后面还有')).toBeNull();
    expect(textForSpaceTrigger('你好   ', '  \n')).toBe('你好');
    expect(textForSpaceTrigger('function f() {\n   ', '')).toBeNull();
    expect(textForSpaceTrigger('   ', '')).toBeNull();
    expect(textForSpaceTrigger('你好  ', '')).toBeNull();
  });
});
