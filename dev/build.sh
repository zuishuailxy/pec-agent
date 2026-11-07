#!/bin/sh
# 编译 pec-tools 的 TS 源码到 lib/（考场环境按 package.json 的 main 加载 lib/index.js）
# 注意：esbuild 不加 --bundle 时不会跟随 import，所有需要被 import 的文件都必须作为 entry 列出。
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
ESBUILD="$ROOT/dev/node_modules/.bin/esbuild"
[ -x "$ESBUILD" ] || { echo "missing esbuild: run (cd dev && npm i -D esbuild)" >&2; exit 1; }
"$ESBUILD" \
  plugins/pec-tools/src/index.ts \
  plugins/pec-tools/src/db.ts \
  plugins/pec-tools/src/errors.ts \
  plugins/pec-tools/src/core/money.ts \
  plugins/pec-tools/src/core/provenance.ts \
  plugins/pec-tools/src/policy/guard.ts \
  plugins/pec-tools/src/policy/identity.ts \
  plugins/pec-tools/src/policy/audit.ts \
  plugins/pec-tools/src/policy/masking.ts \
  plugins/pec-tools/src/policy/tool-surface.ts \
  plugins/pec-tools/src/tools/catalog.ts \
  plugins/pec-tools/src/tools/business.ts \
  plugins/pec-tools/src/tools/order-lookup.ts \
  plugins/pec-tools/src/tools/supplier-profile.ts \
  plugins/pec-tools/src/tools/pricing-quote.ts \
  plugins/pec-tools/src/tools/freight-calc.ts \
  plugins/pec-tools/src/tools/contract-search.ts \
  plugins/pec-tools/src/tools/ticket-similar.ts \
  plugins/pec-tools/src/tools/advice-card.ts \
  plugins/pec-tools/src/memory/store.ts \
  --outbase=plugins/pec-tools/src \
  --outdir=plugins/pec-tools/lib \
  --format=esm --platform=node --target=node22 --sourcemap
echo "built -> plugins/pec-tools/lib"
