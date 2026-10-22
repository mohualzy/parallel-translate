import { describe, expect, it } from 'vitest';
import { contextOf } from '@/content/selection';

function rangeOver(el: Element, needle: string): Range {
  const node = el.firstChild!;
  const start = node.textContent!.indexOf(needle);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + needle.length);
  return range;
}

describe('contextOf', () => {
  it('取选区所在段落的文字，跳过已插入的译文', () => {
    document.body.innerHTML = '<p id="p">The quick brown fox.<ptx-t>【译】敏捷的棕色狐狸。</ptx-t></p>';
    const p = document.getElementById('p')!;
    expect(contextOf(rangeOver(p, 'brown'), 'brown')).toBe('The quick brown fox.');
  });

  it('选中整段时不重复带语境', () => {
    document.body.innerHTML = '<p id="p">Whole sentence.</p>';
    const p = document.getElementById('p')!;
    expect(contextOf(rangeOver(p, 'Whole sentence.'), 'Whole sentence.')).toBe('');
  });

  it('段落过长时截取选区附近 600 字', () => {
    const long = `${'a '.repeat(600)}TARGET${' b'.repeat(600)}`;
    document.body.innerHTML = `<p id="p">${long}</p>`;
    const ctx = contextOf(rangeOver(document.getElementById('p')!, 'TARGET'), 'TARGET');
    expect(ctx.length).toBe(600);
    expect(ctx).toContain('TARGET');
  });
});
