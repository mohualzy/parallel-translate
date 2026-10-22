import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

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

function extractSegments(content: string): string[] {
  return [...content.matchAll(/<s id="(\d+)">([\s\S]*?)<\/s>/g)].map((m) => m[2]!);
}

export async function startMockServer(): Promise<MockServer> {
  const state: Omit<MockServer, 'url' | 'close'> = { batches: [], systems: [], users: [], selections: [], failWith: null, dropWhen: null };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname.endsWith('.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(path.join(FIXTURES, path.basename(url.pathname))));
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
      const user = body.messages.at(-1).content as string;
      const segments = extractSegments(user);
      // 划词翻译：<text> 包着选中文本
      const selected = segments.length === 0 ? /<text>([\s\S]*?)<\/text>/.exec(user)?.[1] : undefined;
      if (selected !== undefined) {
        state.selections.push({
          text: selected,
          word: (body.messages[0].content as string).includes('词典'),
          context: /<context>([\s\S]*?)<\/context>/.exec(user)?.[1] ?? '',
        });
      } else {
        state.batches.push(segments);
        state.systems.push(body.messages[0].content as string);
        state.users.push(user);
      }
      const output = selected !== undefined ? `${PREFIX}${selected}` : segments
        .map((s, i) => (segments.length > 1 && state.dropWhen?.(s) ? '' : `<s id="${i}">${PREFIX}${s}</s>`))
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
