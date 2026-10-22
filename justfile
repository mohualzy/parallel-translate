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

# 构建后跑 E2E（加载真实扩展 + mock 模型服务）
e2e: build
    pnpm e2e

# 打包 zip
zip:
    pnpm zip
