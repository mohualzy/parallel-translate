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

function timedtext(videoId: string, asr: boolean, tlang: string | null) {
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
  const state: Omit<MockServer, 'url' | 'close'> = { batches: [], systems: [], users: [], selections: [], inputs: [], texts: [], delayMs: 0, extractions: [], termsOutput: '', failWith: null, echoWhen: null, dropWhen: null };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname.endsWith('.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(path.join(FIXTURES, path.basename(url.pathname))));
      return;
    }

    // PDF 阅读器：运行时生成的测试 PDF；fake.pdf 是地址像 PDF 的普通网页（测弹窗按钮，无头浏览器没有自带 PDF 阅读器）
    if (req.method === 'GET' && (url.pathname === '/sample.pdf' || url.pathname === '/two-column.pdf')) {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(url.pathname === '/sample.pdf' ? samplePdf() : twoColumnPdf());
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
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify(timedtext(url.searchParams.get('v') ?? '', url.searchParams.get('kind') === 'asr', url.searchParams.get('tlang'))),
      );
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
