import { readdirSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'wxt';
import { YOUTUBE_MATCHES } from './src/lib/youtube';

/** PDF 阅读器在本机运行 pdf.js：CJK 字符映射、标准字体、图片解码 wasm 从 node_modules 复制进扩展（约 2.8 MB） */
const PDFJS_DIR = path.resolve('node_modules/pdfjs-dist');
const PDFJS_ASSETS: { dir: string; keep?: RegExp }[] = [
  { dir: 'cmaps' },
  { dir: 'standard_fonts' },
  // 只要图片解码用的 wasm；quickjs-eval（执行 PDF 内嵌脚本）和 wasm 的 JS 回退版都不打包
  { dir: 'wasm', keep: /^(jbig2|openjpeg|qcms_bg)\.wasm$|^LICENSE/ },
];

// 文档：https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  hooks: {
    'build:publicAssets': (_wxt, files) => {
      for (const { dir, keep } of PDFJS_ASSETS) {
        for (const name of readdirSync(path.join(PDFJS_DIR, dir))) {
          if (keep && !keep.test(name)) continue;
          files.push({ absoluteSrc: path.join(PDFJS_DIR, dir, name), relativeDest: `pdfjs/${dir}/${name}` });
        }
      }
      // MIT 和 Apache-2.0 都要求分发时附带许可全文
      files.push(
        { absoluteSrc: path.resolve('LICENSE'), relativeDest: 'LICENSE' },
        { absoluteSrc: path.join(PDFJS_DIR, 'LICENSE'), relativeDest: 'pdfjs/LICENSE' },
        { absoluteSrc: path.resolve('node_modules/katex/LICENSE'), relativeDest: 'katex/LICENSE' },
      );
    },
    // e2e 构建（`wxt build --mode e2e`）让 YouTube 脚本额外匹配本地 mock 服务，用仿 YouTube 的测试页验证字幕功能；
    // 网页内容脚本不匹配 preinstalled.html，模拟安装扩展前就打开的页面。正式构建的 manifest 不受影响。
    'build:manifestGenerated': (wxt, manifest) => {
      if (wxt.config.mode !== 'e2e') return;
      for (const script of manifest.content_scripts ?? []) {
        // 多个脚本共用同一个 YOUTUBE_MATCHES 数组对象，必须赋新数组，不能 push
        if (script.matches?.some((m) => YOUTUBE_MATCHES.includes(m))) script.matches = [...script.matches, 'http://127.0.0.1/*'];
        if (script.matches?.includes('<all_urls>')) script.exclude_matches = ['*://*/preinstalled.html'];
      }
    },
  },
  // 关闭 auto-imports：所有依赖显式 import，便于阅读
  imports: false,
  manifest: {
    name: '双语对照翻译',
    description: '网页双语对照翻译，使用你自己的大模型 API（OpenAI 兼容协议）',
    // declarativeNetRequest：按响应头把 PDF 转进双语阅读器（D61，设置里打开才生效）
    permissions: ['storage', 'contextMenus', 'scripting', 'declarativeNetRequest'],
    // 自动打开 PDF 要从网页重定向到阅读器，阅读器必须可被网页访问；动态地址让网页猜不到、
    // 不能用 iframe 嵌入或自己跳过来（否则任意网站都能让阅读器翻译 PDF，消耗用户的 API 额度）
    web_accessible_resources: [{ resources: ['pdf.html'], matches: ['<all_urls>'], use_dynamic_url: true }],
    // PDF 阅读器：pdf.js 用 wasm 解码 JPEG 2000 / JBIG2 图片，扩展页面默认 CSP 不允许实例化 wasm
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    // 需要向任意 Base URL 发请求，内容脚本也要在所有页面运行
    host_permissions: ['<all_urls>'],
    commands: {
      'toggle-translate': {
        suggested_key: { default: 'Alt+A' },
        description: '翻译 / 还原当前页面',
      },
      // Alt+W 立即翻译整页（不等滚动到）
      'translate-whole-page': {
        suggested_key: { default: 'Alt+W' },
        description: '立即翻译整页 / 还原',
      },
      // Alt+I 把输入框里的内容译成「输入框翻译」的目标语言
      'translate-input': {
        suggested_key: { default: 'Alt+I' },
        description: '翻译当前输入框',
      },
      // Alt+S 打开侧栏（文本翻译）
      'open-side-panel': {
        suggested_key: { default: 'Alt+S' },
        description: '打开侧栏（文本翻译）',
      },
      // 以下不设默认按键，避免与网页或其他扩展冲突，可在 chrome://extensions/shortcuts 自行绑定
      'toggle-display-mode': {
        description: '切换双语对照 / 仅译文',
      },
      'toggle-mask': {
        description: '切换学习遮罩（译文模糊，悬停显示）',
      },
    },
  },
});
