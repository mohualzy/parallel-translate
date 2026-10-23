import { defineConfig } from 'wxt';
import { YOUTUBE_MATCHES } from './src/lib/youtube';

// 文档：https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  hooks: {
    // e2e 构建（`wxt build --mode e2e`）让 YouTube 脚本额外匹配本地 mock 服务，
    // 用仿 YouTube 的测试页验证字幕功能；正式构建的 manifest 不受影响。
    'build:manifestGenerated': (wxt, manifest) => {
      if (wxt.config.mode !== 'e2e') return;
      for (const script of manifest.content_scripts ?? []) {
        // 多个脚本共用同一个 YOUTUBE_MATCHES 数组对象，必须赋新数组，不能 push
        if (script.matches?.some((m) => YOUTUBE_MATCHES.includes(m))) script.matches = [...script.matches, 'http://127.0.0.1/*'];
      }
    },
  },
  // 关闭 auto-imports：所有依赖显式 import，便于阅读（见 AGENTS.md 规则 3）
  imports: false,
  manifest: {
    name: '双语对照翻译',
    description: '网页双语对照翻译，使用你自己的大模型 API（OpenAI 兼容协议）',
    permissions: ['storage', 'contextMenus'],
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
