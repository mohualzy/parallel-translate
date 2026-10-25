/**
 * 多站点回归检查入口（`just sweep <提交> [网站,…]`，Node 直接运行 TS）：
 * 1. 构建当前代码的 e2e 版；给了 base 时，在临时 git worktree 里装依赖、构建 base 的 e2e 版
 * 2. 分别用两个构建跑 tests/sweep/sweep.spec.ts（真实网站 + mock 翻译）
 * 3. 逐站对比，写 test-results/sweep/report.md；有疑似退化时退出码为 1
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SiteMetrics } from './sweep.spec';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=')];
  }),
);
const BASE = args.base ?? '';
const SITES = args.sites ?? '';
const ROOT = process.cwd();
const OUT = path.join(ROOT, 'test-results/sweep');
const WORKTREE = path.join(os.tmpdir(), 'ptx-sweep-base');

function run(command: string, cwd = ROOT, env: Record<string, string> = {}) {
  const r = spawnSync(command, { cwd, shell: true, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`命令失败（${r.status}）：${command}`);
}

function git(...gitArgs: string[]): string {
  const r = spawnSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${gitArgs.join(' ')} 失败：${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** 删掉临时 worktree。用 rmSync 而不是 git worktree remove：前者不顺着 node_modules 里的联接删到外面 */
function dropWorktree() {
  if (existsSync(WORKTREE)) rmSync(WORKTREE, { recursive: true, force: true });
  git('worktree', 'prune');
}

function sweep(tag: string, extension: string) {
  console.log(`\n=== ${tag}：${extension}`);
  run('pnpm exec playwright test -c playwright.sweep.config.ts', ROOT, {
    SWEEP_EXT: extension,
    SWEEP_TAG: tag,
    SWEEP_SITES: SITES,
  });
  return JSON.parse(readFileSync(path.join(OUT, `${tag}.json`), 'utf8')) as Record<string, Partial<SiteMetrics>>;
}

/** 新版相对基线的疑似退化；没有基线时只报绝对异常 */
function flags(n: Partial<SiteMetrics>, b?: Partial<SiteMetrics>): string[] {
  if (n.error) return b && !b.error ? [`失败：${n.error}`] : b ? [] : [`失败：${n.error}`];
  if (!b || b.error) {
    const out: string[] = [];
    if (n.hideNotZero) out.push(`${n.hideNotZero} 个隐藏容器字号没归零`);
    if (n.hideNodeVisible) out.push(`${n.hideNodeVisible} 个部分隐藏的元素仍显示`);
    return out;
  }
  const out: string[] = [];
  const more = (k: 'bilingual' | 'hideNotZero' | 'hideNodeVisible' | 'hiddenControls', slack: number) =>
    (n[k] ?? 0) > (b[k] ?? 0) + slack;
  if (more('bilingual', 2)) out.push(`双语 ${b.bilingual}→${n.bilingual}`);
  if (more('hideNotZero', 0)) out.push(`字号没归零 ${b.hideNotZero}→${n.hideNotZero}`);
  if (more('hideNodeVisible', 0)) out.push(`部分隐藏仍显示 ${b.hideNodeVisible}→${n.hideNodeVisible}`);
  if (more('hiddenControls', 0)) out.push(`藏掉的控件 ${b.hiddenControls}→${n.hiddenControls}`);
  if ((n.hOverflow ?? 0) > Math.max(0, b.hOverflow ?? 0) + 2) out.push(`横向溢出 ${b.hOverflow}→${n.hOverflow}px`);
  if ((n.translations ?? 0) < (b.translations ?? 0) * 0.7) out.push(`译文 ${b.translations}→${n.translations}`);
  return out;
}

function report(next: Record<string, Partial<SiteMetrics>>, base?: Record<string, Partial<SiteMetrics>>): { text: string; flagged: number } {
  const cell = (k: keyof SiteMetrics, n: Partial<SiteMetrics>, b?: Partial<SiteMetrics>) =>
    n.error ? '—' : b && !b.error ? `${b[k]} → ${n[k]}` : `${n[k]}`;
  const lines = [
    `# 多站点回归检查`,
    '',
    `- 时间：${new Date().toLocaleString('zh-CN')}`,
    `- 新版：当前工作区（${git('rev-parse', '--short', 'HEAD')}${git('status', '--porcelain') ? ' + 未提交改动' : ''}）`,
    base ? `- 基线：${BASE}（${git('rev-parse', '--short', BASE)}）` : '- 基线：无（只跑了当前代码）',
    '- 网站是真实的、会变，网络也有波动：标出的退化先看截图再下结论（`shots/<网站>-<new|base>-<top|mid>.png`）。',
    '',
    '| 网站 | 译文 | 双语 | 字号没归零 | 部分隐藏仍显示 | 藏掉的控件 | 横向溢出 | 疑似退化 |',
    '|---|---|---|---|---|---|---|---|',
  ];
  let flagged = 0;
  const details: string[] = [];
  for (const [name, n] of Object.entries(next)) {
    const b = base?.[name];
    const f = flags(n, b);
    if (f.length) flagged++;
    lines.push(
      `| ${name} | ${(['translations', 'bilingual', 'hideNotZero', 'hideNodeVisible', 'hiddenControls', 'hOverflow'] as const)
        .map((k) => cell(k, n, b))
        .join(' | ')} | ${f.join('；') || (n.error ? `失败（基线也失败）` : '')} |`,
    );
    if (n.bilingualSamples?.length || n.hiddenControlSamples?.length) {
      details.push(`### ${name}`, '', n.url ?? '', '');
      if (n.bilingualSamples?.length) details.push('双语残留（父元素 | 译文）：', '', ...n.bilingualSamples.map((s) => `- \`${s}\``), '');
      if (n.hiddenControlSamples?.length) details.push('藏掉的控件（元素 in 父元素 | 文字）：', '', ...n.hiddenControlSamples.map((s) => `- \`${s}\``), '');
    }
  }
  lines.push('', `疑似退化：${flagged} 个网站`, '', '## 新版样例', '', ...details);
  return { text: lines.join('\n'), flagged };
}

rmSync(OUT, { recursive: true, force: true });
run('pnpm build:e2e');
let baseResults: Record<string, Partial<SiteMetrics>> | undefined;
if (BASE) {
  git('rev-parse', '--verify', `${BASE}^{commit}`);
  dropWorktree();
  git('worktree', 'add', '--detach', WORKTREE, BASE);
  try {
    // 临时目录的上层可能有别的 pnpm workspace（如用户主目录），不加 --ignore-workspace 会去装整个 workspace
    run('pnpm install --ignore-workspace --frozen-lockfile --prefer-offline', WORKTREE);
    run('pnpm build:e2e', WORKTREE);
    baseResults = sweep('base', path.join(WORKTREE, '.output/chrome-mv3-e2e'));
  } finally {
    dropWorktree();
  }
}
const { text, flagged } = report(sweep('new', path.join(ROOT, '.output/chrome-mv3-e2e')), baseResults);
writeFileSync(path.join(OUT, 'report.md'), text);
console.log(`\n${text.split('\n## ')[0]}\n\n完整报告：${path.join(OUT, 'report.md')}`);
process.exitCode = flagged ? 1 : 0;
