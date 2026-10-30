import { describe, expect, it } from 'vitest';
import {
  activeCueIndex,
  batchContext,
  cleanCueText,
  nextBatch,
  parseJson3,
  parseTimedtextUrl,
  pickSourceTrack,
  sourceTrackUrl,
  type Cue,
} from '@/lib/subtitles';

describe('parseTimedtextUrl', () => {
  it('读取视频 ID、语言、是否自动字幕、是否已被 YouTube 机器翻译', () => {
    expect(parseTimedtextUrl('https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=json3&kind=asr')).toEqual({
      videoId: 'abc',
      lang: 'en',
      asr: true,
      translatedTo: '',
    });
    expect(parseTimedtextUrl('/api/timedtext?v=abc&lang=en&tlang=zh-Hans').translatedTo).toBe('zh-Hans');
  });
});

describe('cleanCueText', () => {
  it('去掉环境音标注、换人标记，压缩换行与空白', () => {
    expect(cleanCueText('[Music]\n>> Hello  (laughs) there')).toBe('Hello there');
    expect(cleanCueText('[Applause]')).toBe('');
  });
});

describe('parseJson3：普通字幕', () => {
  it('每个事件是一条字幕，跳过窗口定义和空事件', () => {
    const body = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 999999, id: 1, wpWinPosId: 1 },
        { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Hello and\nwelcome.' }] },
        { tStartMs: 3000, dDurationMs: 1500, segs: [{ utf8: '[Music]' }] },
        { tStartMs: 4500, dDurationMs: 2000, segs: [{ utf8: 'Second line' }] },
      ],
    });
    expect(parseJson3(body, false)).toEqual([
      { start: 1000, end: 3000, text: 'Hello and welcome.' },
      { start: 4500, end: 6500, text: 'Second line' },
    ]);
  });

  it('非法 JSON 返回空', () => {
    expect(parseJson3('<transcript/>', false)).toEqual([]);
  });
});

describe('parseJson3：自动字幕合句', () => {
  const words = (start: number, list: [string, number][]) => ({
    tStartMs: start,
    dDurationMs: 4000,
    wWinId: 1,
    segs: list.map(([utf8, tOffsetMs]) => ({ utf8, tOffsetMs })),
  });

  it('按句末标点和停顿断句，跳过换行追加事件', () => {
    const body = JSON.stringify({
      events: [
        words(1000, [['so', 0], [' today', 200], [' we', 400], [' start.', 600]]),
        { tStartMs: 1900, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] },
        words(2000, [['next', 0], [' part', 300]]),
        // 停顿 2 秒
        words(4300, [['after', 0], [' pause', 200]]),
      ],
    });
    expect(parseJson3(body, true)).toEqual([
      { start: 1000, end: 2000, text: 'so today we start.' },
      { start: 2000, end: 4300, text: 'next part' },
      { start: 4300, end: 6500, text: 'after pause' },
    ]);
  });

  it('日文、中文自动字幕的词之间不加空格', () => {
    const body = JSON.stringify({
      events: [words(0, [['これ', 0], ['で', 100], ['いい', 200], ['[音楽]', 300]])],
    });
    expect(parseJson3(body, true)).toEqual([{ start: 0, end: 2200, text: 'これでいい' }]);
  });

  it('没有标点也没有停顿时，按最大词数断句', () => {
    const list = Array.from({ length: 30 }, (_, i): [string, number] => [`${i ? ' ' : ''}w${i}`, i * 100]);
    const cues = parseJson3(JSON.stringify({ events: [words(0, list)] }), true);
    expect(cues.map((c) => c.text.split(' ').length)).toEqual([18, 12]);
  });
});

describe('pickSourceTrack', () => {
  const track = (languageCode: string, auto = false) => ({
    languageCode,
    vssId: `${auto ? 'a' : ''}.${languageCode}`,
    kind: auto ? 'asr' : '',
    name: languageCode,
    baseUrl: `/api/timedtext?v=x&lang=${languageCode}${auto ? '&kind=asr' : ''}`,
  });
  const pick = (tracks: ReturnType<typeof track>[], lang: string, asr = false, text = '') =>
    pickSourceTrack(tracks, { lang, asr }, 'zh-CN', text)?.vssId;

  it('有自动字幕时按它判断语音语言：同语言人工字幕 → 英文 → 任意人工字幕 → 自动字幕', () => {
    expect(pick([track('ja', true), track('en'), track('ja')], 'ja', true)).toBe('.ja');
    expect(pick([track('ja', true), track('fr'), track('en')], 'ja', true)).toBe('.en');
    expect(pick([track('ja', true), track('fr')], 'ja', true)).toBe('.fr');
    expect(pick([track('ja', true)], 'ja', true)).toBe('a.ja');
  });

  it('没有自动字幕时按标题和简介判断语音语言（日语歌在韩语偏好下播放器加载的是英语轨）', () => {
    const tracks = [track('en'), track('ja')];
    expect(pick(tracks, 'en', false, 'YOASOBI - 群青 / THE FIRST TAKE\nこんにちは、今日は一発撮りで')).toBe('.ja');
    // 判断不出来：用播放器加载的那条
    expect(pick([track('fr'), track('de')], 'de')).toBe('.de');
  });

  it('不选目标语言的轨；视频语音就是目标语言时不翻译', () => {
    expect(pick([track('ja', true), track('zh-Hans')], 'ja', true)).toBe('a.ja');
    expect(pick([track('zh-Hans', true), track('en')], 'en')).toBeUndefined();
    expect(pick([track('en'), track('zh-Hans')], 'en', false, '今天我们来聊聊翻译这件事')).toBeUndefined();
  });
});

describe('sourceTrackUrl', () => {
  it('另一条轨的 baseUrl 补上播放器请求里的令牌参数，不继承自动翻译和轨道参数', () => {
    const played = 'https://www.youtube.com/api/timedtext?v=x&sig=1&lang=en&kind=asr&pot=TOKEN&fmt=json3&tlang=ko&c=WEB';
    const url = new URL(
      sourceTrackUrl({ languageCode: 'ja', vssId: '.ja', kind: '', name: '', baseUrl: 'https://www.youtube.com/api/timedtext?v=x&sig=2&lang=ja' }, played),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({ v: 'x', sig: '2', lang: 'ja', pot: 'TOKEN', fmt: 'json3', c: 'WEB' });
  });
});

describe('activeCueIndex', () => {
  const cues: Cue[] = [
    { start: 0, end: 2000, text: 'a' },
    { start: 2000, end: 4000, text: 'b' },
    { start: 6000, end: 8000, text: 'c' },
  ];

  it('找到当前时间的条目；间隙中返回 -1', () => {
    expect(activeCueIndex(cues, 0)).toBe(0);
    expect(activeCueIndex(cues, 2500)).toBe(1);
    expect(activeCueIndex(cues, 5000)).toBe(-1);
    expect(activeCueIndex(cues, 7999)).toBe(2);
    expect(activeCueIndex(cues, 9000)).toBe(-1);
  });

  it('时间重叠：最近开始的条目已结束、更早的长条目还在显示时返回长条目', () => {
    const overlap: Cue[] = [
      { start: 0, end: 5000, text: 'long' },
      { start: 1000, end: 2000, text: 'short' },
    ];
    expect(activeCueIndex(overlap, 1500)).toBe(1);
    expect(activeCueIndex(overlap, 3000)).toBe(0);
    expect(activeCueIndex(overlap, 5000)).toBe(-1);
  });
});

describe('batchContext', () => {
  const cues: Cue[] = ['a', 'b', 'c', 'd', 'e'].map((text, i) => ({ start: i, end: i + 1, text }));

  it('取本批前后的台词，前文带已有译文；到头到尾时能取多少取多少', () => {
    expect(batchContext(cues, [2, 3], ['甲', undefined], { before: 2, after: 2 })).toEqual({
      before: [
        { text: 'a', translation: '甲' },
        { text: 'b', translation: undefined },
      ],
      after: ['e'],
    });
    expect(batchContext(cues, [0], [], { before: 2, after: 1 })).toEqual({ before: [], after: ['b'] });
  });
});

describe('nextBatch', () => {
  const cues: Cue[] = Array.from({ length: 10 }, (_, i) => ({ start: i * 60_000, end: i * 60_000 + 5000, text: `${i}` }));
  const opts = { aheadMs: 120_000, behindMs: 5000, max: 25 };

  it('只挑当前时间附近、尚未翻译的条目', () => {
    expect(nextBatch(cues, 0, () => true, opts)).toEqual([0, 1, 2]);
    expect(nextBatch(cues, 300_000, (i) => i !== 6, opts)).toEqual([5, 7]);
  });

  it('受每批上限约束', () => {
    expect(nextBatch(cues, 0, () => true, { ...opts, aheadMs: 1e9, max: 4 })).toEqual([0, 1, 2, 3]);
  });
});
