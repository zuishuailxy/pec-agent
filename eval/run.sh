#!/bin/sh
# golden set 批跑入口：headless 逐条执行，输出到 runs/eval/<id>/
# 用法：bash eval/run.sh [--only g-01,g-09]
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
exec node eval/run.mjs "$@"
