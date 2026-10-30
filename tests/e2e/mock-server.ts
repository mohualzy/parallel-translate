import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { samplePdf, twoColumnPdf } from './fixtures/sample-pdf';

/**
 * 本地 mock：同时提供测试页面和 OpenAI 兼容接口。
 * 「翻译」规则：每段原样加上前缀【译】，占位标签原样保留，便于断言。
 */
export interface MockServer {
  url: string;
  /** 每次 chat/completions 请求收到的段落 */
  batches: string[][];
  /** 与 batches 一一对应的 system prompt 与 user 消息 */
  systems: string[];
  users: string[];
  /** 非空时下一批请求都返回该状态码 */
  failWith: number | null;
  /** 划词翻译请求：选中文本、是否词典模式、带上的语境 */
  selections: { text: string; word: boolean; context: string }[];
  /** 输入框翻译请求的原文 */
  inputs: string[];
  /** 侧栏文本翻译请求：原文与 system prompt */
  texts: { text: string; system: string }[];
  /** 大于 0 时每个请求先等这么久再响应（模拟慢模型） */
  delayMs: number;
  /** 术语抽取请求收到的正文，以及要返回的术语行（`原文 = 译法`） */
  extractions: string[];
  termsOutput: string;
  /** 视频全片预读请求收到的字幕，以及要返回的内容（摘要行 + 术语行） */
  briefs: string[];
  briefOutput: string;
  /** LRCLIB 请求的查询串，以及要返回的结果 */
  lyricsRequests: string[];
  lyricsRecords: { duration: number; syncedLyrics: string }[];
  /** 匹配的段原样返回（模拟模型对人名、产品名不做翻译） */
  echoWhen: ((segment: string) => boolean) | null;
  /** 多段请求时故意漏掉匹配的段，模拟模型漏段 */
  dropWhen: ((segment: string) => boolean) | null;
  close(): Promise<void>;
}

const FIXTURES = path.resolve('tests/e2e/fixtures');
const PREFIX = '【译】';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
}

/** 仿 YouTube json3 字幕：前三条紧挨着开头，最后一条在 5 分钟处（用来验证按进度翻译） */
export const MOCK_CUES = [
  { start: 0, end: 3000, text: 'Hello and welcome to the channel.' },
  { start: 3000, end: 6000, text: 'Today we talk about translation.' },
  { start: 6000, end: 120_000, text: 'This line stays on screen for a long time.' },
  { start: 300_000, end: 303_000, text: 'A far away line near the end of the video.' },
];

/** 长视频：30 条字幕，每条 3 秒，用来验证分批时的上下文和全片预读 */
const LONG_CUES = Array.from({ length: 30 }, (_, i) => ({
  start: i * 3000,
  end: (i + 1) * 3000,
  text: `Line ${i}: the agent keeps working on the translation task.`,
}));

/** 音乐视频的同步歌词：比自动字幕早 2 秒，3 句 */
export const MOCK_LYRICS = '[00:00.00]朝が来て渋谷の街に光が降る\n[00:06.00]いつもの道を歩いて行く\n[00:12.00]好きなものを好きだと言う\n[00:18.00]';

function timedtext(videoId: string, lang: string, asr: boolean, tlang: string | null) {
  // 音乐视频的自动字幕：比歌词晚 2 秒，夹着听错的碎片
  if (asr && videoId.startsWith('mv-')) {
    const line = (tStartMs: number, utf8: string) => ({ tStartMs, dDurationMs: 3000, segs: [{ utf8 }] });
    return {
      wireMagic: 'pb3',
      events: [line(2000, '朝が来て渋谷の町に光'), line(5000, 'ni'), line(8000, 'いつもの道を歩いて'), line(14_000, '好きなものを好き言う')],
    };
  }
  // 自动生成字幕：逐词带时间偏移（英文词自带前导空格）
  if (asr) {
    const words = ['auto', ' generated', ' words', ' here.'];
    return {
      wireMagic: 'pb3',
      events: [{ tStartMs: 0, dDurationMs: 120_000, wWinId: 1, segs: words.map((utf8, i) => ({ utf8, tOffsetMs: i * 200 })) }],
    };
  }
  const cues =
    tlang?.startsWith('zh')
      ? [{ start: 0, end: 120_000, text: '这一行已经被 YouTube 自动翻译成了中文。' }]
      : tlang === 'ko'
      ? [{ start: 0, end: 120_000, text: '이 줄은 YouTube가 한국어로 자동 번역했습니다.' }]
      : lang === 'ja'
      ? [{ start: 0, end: 120_000, text: '朝が来て渋谷の街に。' }]
      : videoId.startsWith('long-talk')
      ? LONG_CUES
      : videoId === 'second'
      ? [{ start: 0, end: 120_000, text: 'Second video subtitle line.' }]
      : videoId === 'mixed'
        ? [{ start: 0, end: 120_000, text: 'Manual caption line for the mixed video.' }]
        : MOCK_CUES;
  return {
    wireMagic: 'pb3',
    events: [
      { tStartMs: 0, dDurationMs: 999_999, id: 1, wpWinPosId: 1 },
      ...cues.map((c) => ({ tStartMs: c.start, dDurationMs: c.end - c.start, segs: [{ utf8: c.text }] })),
    ],
  };
}

function extractSegments(content: string): string[] {
  return [...content.matchAll(/<s id="(\d+)">([\s\S]*?)<\/s>/g)].map((m) => m[2]!);
}

export async function startMockServer(): Promise<MockServer> {
  const state: Omit<MockServer, 'url' | 'close'> = { batches: [], systems: [], users: [], selections: [], inputs: [], texts: [], delayMs: 0, extractions: [], termsOutput: '', briefs: [], briefOutput: '', lyricsRequests: [], lyricsRecords: [], failWith: null, echoWhen: null, dropWhen: null };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname.endsWith('.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(path.join(FIXTURES, path.basename(url.pathname))));
      return;
    }

    // PDF 阅读器：运行时生成的测试 PDF；fake.pdf 是地址像 PDF 的普通网页（测弹窗按钮，无头浏览器没有自带 PDF 阅读器）
    // /papers/sample：不带 .pdf 后缀的 PDF（像 arXiv 的 /pdf/…），测按响应头自动打开
    if (req.method === 'GET' && (url.pathname === '/sample.pdf' || url.pathname === '/papers/sample' || url.pathname === '/two-column.pdf')) {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(url.pathname === '/two-column.pdf' ? twoColumnPdf() : samplePdf());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/fake.pdf') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>fake pdf</title><p>Pretend this is a PDF document.</p>');
      return;
    }

    // 仿 YouTube：视频页与字幕接口
    if (req.method === 'GET' && url.pathname === '/watch') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(path.join(FIXTURES, 'youtube.html')));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/timedtext') {
      const p = url.searchParams;
      // 和真实接口一样：没有播放器的 pot 令牌拿不到字幕
      if (p.get('pot') !== 'mock-token' || p.get('fmt') !== 'json3') {
        res.writeHead(403);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(timedtext(p.get('v') ?? '', p.get('lang') ?? '', p.get('kind') === 'asr', p.get('tlang'))));
      return;
    }

    // 仿 LRCLIB：测试里把后台对 lrclib.net 的请求转到这里
    if (req.method === 'GET' && url.pathname === '/api/search') {
      state.lyricsRequests.push(url.search);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(state.lyricsRecords));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'another-model' }] }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      if (req.headers.authorization !== 'Bearer test-key') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad key' } }));
        return;
      }
      if (state.failWith) {
        res.writeHead(state.failWith, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `mock failure ${state.failWith}` } }));
        return;
      }
      const body = JSON.parse(await readBody(req));
      if (state.delayMs > 0) await new Promise((r) => setTimeout(r, state.delayMs));
      const user = body.messages.at(-1).content as string;
      const system = body.messages[0].content as string;
      // 文章术语抽取：<article> 包着正文，返回预设的术语行（稍晚返回，模拟首屏先于术语翻译完）
      const article = /<article>([\s\S]*?)<\/article>/.exec(user)?.[1];
      if (article !== undefined) {
        state.extractions.push(article);
        await new Promise((r) => setTimeout(r, 300));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: state.termsOutput } }] }));
        return;
      }
      // 视频全片预读：<transcript> 包着字幕（稍晚返回，模拟第一批先于预读翻译完）
      const transcript = /<transcript>([\s\S]*?)<\/transcript>/.exec(user)?.[1];
      if (transcript !== undefined) {
        state.briefs.push(transcript);
        await new Promise((r) => setTimeout(r, 300));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: state.briefOutput } }] }));
        return;
      }
      const segments = extractSegments(user);
      // 划词翻译：<text> 包着选中文本
      const selected = segments.length === 0 ? /<text>([\s\S]*?)<\/text>/.exec(user)?.[1] : undefined;
      // 输入框翻译与划词一样用 <text>，按 system prompt 区分
      if (selected !== undefined && /message the user wrote|用户写的消息/.test(system)) {
        state.inputs.push(selected);
      } else if (selected !== undefined && /Preserve paragraphs|保留原文的段落/.test(system)) {
        state.texts.push({ text: selected, system });
      } else if (selected !== undefined) {
        state.selections.push({
          text: selected,
          word: system.includes('词典'),
          context: /<context>([\s\S]*?)<\/context>/.exec(user)?.[1] ?? '',
        });
      } else {
        state.batches.push(segments);
        state.systems.push(system);
        state.users.push(user);
      }
      const output = selected !== undefined ? `${state.echoWhen?.(selected) ? '' : PREFIX}${selected}` : segments
        .map((s, i) => (segments.length > 1 && state.dropWhen?.(s) ? '' : `<s id="${i}">${state.echoWhen?.(s) ? '' : PREFIX}${s}</s>`))
        .join('\n');

      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // 切成小块发送，覆盖跨 chunk 解析
        for (let i = 0; i < output.length; i += 7) {
          const delta = { choices: [{ delta: { content: output.slice(i, i + 7) } }] };
          res.write(`data: ${JSON.stringify(delta)}\n\n`);
        }
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: output } }] }));
      }
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}
