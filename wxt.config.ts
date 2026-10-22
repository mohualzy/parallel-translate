import { defineConfig } from 'wxt';

// 文档：https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
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
      'toggle-display-mode': {
        suggested_key: { default: 'Alt+W' },
        description: '切换双语对照 / 仅译文',
      },
    },
  },
});
