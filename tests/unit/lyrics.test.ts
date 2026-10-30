import { describe, expect, it } from 'vitest';
import { alignLyrics, lyricsToCues, parseLrc, pickLyrics, songQuery, type LyricLine } from '@/lib/lyrics';
import type { Cue } from '@/lib/subtitles';

describe('songQuery', () => {
  it('Artist「Title」：括号里是歌名，频道名是歌手', () => {
    expect(songQuery('YOASOBI「群青」Official Music Video', 'YOASOBI')).toEqual({ artist: 'YOASOBI', track: '群青' });
  });

  it('Artist - Title：去掉官方视频之类的说明', () => {
    expect(songQuery('Rick Astley - Never Gonna Give You Up (Official Music Video)', 'Rick Astley')).toEqual({
      artist: 'Rick Astley',
      track: 'Never Gonna Give You Up',
    });
    expect(songQuery('Adele - Hello [HD]', 'AdeleVEVO')).toEqual({ artist: 'Adele', track: 'Hello' });
  });

  it('Title - Artist：频道名在右边时左边是歌名', () => {
    expect(songQuery('Hello - Adele', 'Adele')).toEqual({ artist: 'Adele', track: 'Hello' });
  });

  it('自动生成的 Topic 频道：标题就是歌名', () => {
    expect(songQuery('群青', 'YOASOBI - Topic')).toEqual({ artist: 'YOASOBI', track: '群青' });
  });

  it('标题里带着频道名、没有分隔符：去掉频道名', () => {
    expect(songQuery('米津玄師 Lemon MV', '米津玄師')).toEqual({ artist: '米津玄師', track: 'Lemon' });
  });
});

describe('parseLrc', () => {
  it('解析时间戳，一行多个时间戳展开，空行保留作结束标记，按时间排序', () => {
    expect(parseLrc('[ar:YOASOBI]\n[00:10.50]two\n[00:01.00][00:20.00]one\n[00:30.00]')).toEqual([
      { start: 1000, text: 'one' },
      { start: 10500, text: 'two' },
      { start: 20000, text: 'one' },
      { start: 30000, text: '' },
    ]);
  });
});

describe('pickLyrics', () => {
  const synced = (text: string) => `[00:01.00]${text}`;

  it('只要带时间轴的；时长最接近的优先', () => {
    const records = [{ duration: 200, syncedLyrics: null }, { duration: 300, syncedLyrics: synced('far') }, { duration: 245, syncedLyrics: synced('near') }];
    expect(pickLyrics(records, 250, 'en')).toEqual({ lines: [{ start: 1000, text: 'near' }], seconds: 245 });
  });

  it('日语歌排除罗马音版本；全部不符合时返回 undefined', () => {
    const records = [{ duration: 250, syncedLyrics: synced('asa ga kita') }, { duration: 200, syncedLyrics: synced('朝が来た') }];
    expect(pickLyrics(records, 250, 'ja')?.lines[0]?.text).toBe('朝が来た');
    expect(pickLyrics([records[0]!], 250, 'ja')).toBeUndefined();
  });
});

describe('alignLyrics', () => {
  const lines: LyricLine[] = [
    { start: 0, text: '朝が来て渋谷の街に光が降る' },
    { start: 6000, text: 'いつもの道を歩いて行く' },
    { start: 12000, text: '好きなものを好きだと言う' },
    { start: 18000, text: '' },
  ];
  const cue = (start: number, text: string): Cue => ({ start, end: start + 1000, text });
  const lyrics = { lines, seconds: 200 };

  it('自动字幕有错也能按多数票得到偏移', () => {
    const cues = [cue(2100, '朝が来て渋谷の町に光'), cue(8000, 'いつもの道を歩いて'), cue(14200, '好きなものを好き言う')];
    expect(alignLyrics(cues, lyrics, 260)).toBe(2100);
  });

  it('重复的副歌投给错误偏移的票不影响结果', () => {
    const chorus: LyricLine[] = [
      { start: 10_000, text: '好きなものを好きだと言う' },
      { start: 20_000, text: 'いつもの道を歩いて行く' },
      { start: 30_000, text: '朝が来て渋谷の街に光が降る' },
      { start: 60_000, text: '好きなものを好きだと言う' },
    ];
    const cues = [cue(15_000, '好きなものを好きだと言う'), cue(25_000, 'いつもの道を歩いて行く'), cue(35_000, '朝が来て渋谷の街に光が降る'), cue(65_000, '好きなものを好きだと言う')];
    expect(alignLyrics(cues, { lines: chorus, seconds: 200 }, 260)).toBe(5000);
  });

  it('票数不够：时长相近时用偏移 0，否则放弃', () => {
    const cues = [cue(100, '全然違う言葉ばかり')];
    expect(alignLyrics(cues, { lines, seconds: 262 }, 260)).toBe(0);
    expect(alignLyrics(cues, { lines, seconds: 200 }, 260)).toBeNull();
    expect(alignLyrics(cues, { lines, seconds: null }, 260)).toBeNull();
  });
});

describe('lyricsToCues', () => {
  it('加上偏移，到下一行或结束标记结束，长间奏时最多显示 8 秒，跳过结束标记本身', () => {
    const lines = [
      { start: 1000, text: 'a' },
      { start: 3000, text: 'b' },
      { start: 30_000, text: '' },
      { start: 40_000, text: 'c' },
    ];
    expect(lyricsToCues(lines, 500)).toEqual([
      { start: 1500, end: 3500, text: 'a' },
      { start: 3500, end: 11_500, text: 'b' },
      { start: 40_500, end: 48_500, text: 'c' },
    ]);
  });
});
