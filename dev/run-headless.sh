#!/bin/sh
# 本地 headless 运行器：和考场一样从项目根启动，加载 pec-tools。
# 用法: ./dev/run-headless.sh --json "任务文本"
# 需要: pec-agent/.env 里 DEEPSEEK_API_KEY=...（或已导出到环境）
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
# 注意：开发会话的环境里可能已继承 DSH_HOME=~/.dsh，这里必须强制指向项目内的 profile
export DSH_HOME="$ROOT/.dsh-home"
exec "$ROOT/dev/node_modules/.bin/dsh" --profile headless "$@"
