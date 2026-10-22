import { describe, expect, it } from 'vitest';
import { sameText } from '@/content/richtext';

describe('sameText', () => {
  it('忽略占位标签、空白、大小写与实体转义', () => {
    expect(sameText('<g0>Oleksandr</g0>  Tarasiuk', 'oleksandr tarasiuk')).toBe(true);
    expect(sameText('AT&amp;T <x1/>', 'AT&amp;T')).toBe(true);
  });

  it('真正翻译过的文本不相同', () => {
    expect(sameText('敏捷的狐狸', 'The quick fox')).toBe(false);
  });
});
