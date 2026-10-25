set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

# 列出所有命令
default:
    @just --list

# 开发模式（HMR）
dev:
    pnpm dev

# 构建 Chrome/Edge 版到 .output/chrome-mv3
build:
    pnpm build

# 构建 Firefox 版
build-firefox:
    pnpm build:firefox

# 类型检查 + 单元测试 + 构建（每次改完必须跑）
check:
    pnpm typecheck
    pnpm test
    pnpm build

# e2e 构建：YouTube 脚本额外匹配本地 mock 服务，输出到 .output/chrome-mv3-e2e
build-e2e:
    pnpm build:e2e

# 构建后跑 E2E（加载真实扩展 + mock 模型服务）
e2e: build-e2e
    pnpm e2e

# 用真实 DeepSeek API 实测（需要环境变量 DEEPSEEK_API_KEY，会产生少量费用）
e2e-live: build-e2e
    pnpm exec playwright test -c playwright.live.config.ts

# 多站点回归检查：真实网站 + mock 翻译跑仅译文模式，与 base 提交的构建逐站对比（需联网；省略 base 只跑当前代码；sites 用逗号分隔，名字见 tests/sweep/sites.ts）
sweep base="" sites="":
    node tests/sweep/run.ts --base={{base}} --sites={{sites}}

# 打包 zip
zip:
    pnpm zip
