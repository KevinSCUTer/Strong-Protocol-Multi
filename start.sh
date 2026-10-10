#!/usr/bin/env bash
# 卫戍协议：盟约 · 部署启动脚本（macOS / Linux，全新克隆与更新后的克隆通用）。文档：docs/DEPLOY.md
#
#   bash start.sh [--prepare-only] [--no-assets] [--offline] [--check] [--quiet]
#
#   1. 打印横幅，检查 Node.js ≥ 22（缺失/过旧给出安装提示后退出 1）。
#   2. node tools/deploy.mjs "$@"（幂等准备：npm ci 仅在依赖缺失或锁文件变化时、vendor 过期时刷新、
#      每次用当前游戏数据 + 上游索引重新计划素材并只补缺失（--add-only --download-only，不写
#      data/assets.json、不改任何已跟踪文件、不动共享 public/assets、public/fonts 软链接及其既有文件）、
#      必需素材/清单文件/贴图页/字体缺失即退出非 0）。任何参数原样传给它。
#   3. 前台 exec node server/index.js（tmux/systemd 友好：信号直达服务器进程；Ctrl+C 停止）。
#
#   --prepare-only  只做准备，不启动服务器（镜像构建 / 预热）。
#   --check         只读体检，报告就绪状态（不修改任何文件，不启动服务器）。
#   --no-assets     跳过素材与字体（离线重复启动的 documented 快捷方式；离线首装请先在有网机器准备好共享素材目录）。
#   --offline       素材步骤不联网（需要已有缓存索引与磁盘素材）。
#
#   环境变量原样继承、脚本不设置不覆盖：PORT（默认 3325）、MP3_FOLDER（BP 自定义音乐目录）、HOST、
#   SP_ASSET_SOURCE / SP_GITHUB_PROXY、SP_DEPLOY_INDEX_TTL_HOURS / SP_DEPLOY_REFRESH_INDEX。
#   Windows / 交互式玩家请用 scripts/start-windows.bat 或 scripts/start.sh（scripts/ 下的那份带浏览器自动打开）。
set -euo pipefail
cd "$(dirname "$0")"

echo '卫戍协议，启动！！！'

# 这些参数到此为止：--prepare-only 只做准备；--check 只读体检；--help 打印帮助（都不启动服务器）。
NO_SERVER=0
PREPARE_ONLY=0
REPORT_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --prepare-only) NO_SERVER=1; PREPARE_ONLY=1 ;;
    --check|--help|-h) NO_SERVER=1; REPORT_ONLY=1 ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js（需要 22 或更高，22 / 24 LTS）。Node.js not found."
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "  安装：brew install node@22   或   https://nodejs.org/zh-cn/download"
  else
    echo "  安装：https://nodejs.org/zh-cn/download （或发行版的包管理器 / nvm / fnm）"
  fi
  exit 1
fi
if ! node -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)"; then
  echo "Node.js $(node -v) 太旧，需要 22 或更高（22 / 24 LTS）：https://nodejs.org/zh-cn/download"
  exit 1
fi

# 幂等准备（依赖 / vendor / 素材 / 清单 / 字体门槛）；失败即以非 0 退出（set -e）。
node tools/deploy.mjs "$@"

if [ "$NO_SERVER" = "1" ]; then
  # --check / --help 的输出已经由 tools/deploy.mjs 打印；只有 --prepare-only 需要一句收尾。
  if [ "$PREPARE_ONLY" = "1" ] && [ "$REPORT_ONLY" = "0" ]; then
    echo '卫戍协议：部署准备完成（--prepare-only，不启动服务器）。'
  fi
  exit 0
fi

# 前台启动：exec 替换本 shell，tmux / systemd / docker 下信号直达 node，退出码就是服务器的退出码。
exec node server/index.js
