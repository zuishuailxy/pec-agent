#!/bin/sh
# 生成本项目专用的 DSH headless profile（.dsh-home/profiles/headless）。
# 用途：干净目录复现 / 换机复现时，把 pec-tools 与本地技能根按当前绝对路径写进 profile patch。
# 用法: ./dev/setup-profile.sh
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PROFILE="$ROOT/.dsh-home/profiles/headless"
mkdir -p "$PROFILE"

cat > "$PROFILE/package.json" <<'JSON'
{
  "name": "dsh-profile-headless",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-headless"
      ]
    }
  }
}
JSON

cat > "$PROFILE/cordis.yml" <<'YAML'
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
YAML

cat > "$PROFILE/pnpm-workspace.yaml" <<'YAML'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
YAML

cat > "$PROFILE/cordis.patch.yml" <<YAML
# 本文件由 dev/setup-profile.sh 按当前工作目录绝对路径生成（干净环境复现用）。
# 1) 把 pec-tools 挂进 headless profile；2) 隔离技能根，只看项目自己的 .dsh/skills
- insert:
    - id: pec-tools
      name: '$ROOT/plugins/pec-tools/lib/index.js'

- id: skill-filesystem
  config:
    includeDefaultRoots: false
    customSkillDirs:
      - '$ROOT/.dsh/skills'
YAML

echo "profile written -> $PROFILE"
echo "next: ./dev/build.sh && node dev/test-tools.mjs"
