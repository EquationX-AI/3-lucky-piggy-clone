#!/usr/bin/env bash
# 从镜像生成原版资源目录（hostroot，只读）：<gamePath>/ = 镜像 game/（bundle 的 zip 原地解压），
# astarte2/<shellVersion>/web-mobile/ = 镜像 shell/，smallicon/ = 镜像 smallicon/。镜像本身不改。
# 镜像布局两种都认：固定名（<镜像>/game + <镜像>/shell）或 URL 路径布局
# （parse-netlog.mjs 默认产出：<镜像>/<gamePath>/ + <镜像>/astarte2/<shellVersion>/web-mobile/）。
# 用法：（在 replicas/<slug> 下）bash ../../tools/rewrite/make-hostroot.sh [镜像目录，缺省取 replica.json 的 mirror]
set -euo pipefail
TOOLS="$(cd "$(dirname "$0")" && pwd)"; DIR="$(cd "${REPLICA_DIR:-$PWD}" && pwd)"; cd "$DIR"
[ -f replica.json ] || { echo "请在复刻游戏目录（replicas/<slug>）下运行，或设置 REPLICA_DIR" >&2; exit 2; }
cfg() { node "$TOOLS/config.mjs" "$1"; }
M="${1:-$(cfg mirror)}"; GP=$(cfg gamePath); SV=$(cfg shellVersion); OUT="$(cfg hostroot)"
case "$OUT" in /*) ;; *) OUT="$DIR/$OUT";; esac
GAME_SRC="$M/game"; [ -d "$GAME_SRC" ] || GAME_SRC="$M/$GP"
SHELL_SRC="$M/shell"; [ -d "$SHELL_SRC" ] || SHELL_SRC="$M/astarte2/$SV/web-mobile"
if [ ! -d "$GAME_SRC" ] || [ ! -d "$SHELL_SRC" ]; then
  echo "镜像结构不对：找不到游戏根（$M/game 或 $M/$GP）或外壳根（$M/shell 或 $M/astarte2/$SV/web-mobile）" >&2
  exit 2
fi
rm -rf "$OUT"; mkdir -p "$OUT/astarte2/$SV"
cp -R "$GAME_SRC" "$OUT/$GP"
cp -R "$SHELL_SRC" "$OUT/astarte2/$SV/web-mobile"
[ -d "$M/smallicon" ] && cp -R "$M/smallicon" "$OUT/smallicon"
# Cocos 远程 bundle 打成 zip 时，引擎按目录请求解压后的文件：原地解压（zip 保留）
find "$OUT/$GP/assets" -maxdepth 2 -name '*.zip' | while read -r z; do unzip -q -o "$z" -d "$(dirname "$z")"; done
# 镜像里缺、厂商源站也 404、但引擎会请求的贴图：按 runtime/placeholder-png.txt 补 1x1 透明 PNG（只为避免加载报错）
if [ -f runtime/placeholder-png.txt ]; then
  while read -r p; do [ -n "$p" ] && [ ! -f "$OUT/$p" ] && mkdir -p "$(dirname "$OUT/$p")" && printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\x0bIDATx\x9cc`\x00\x02\x00\x00\x05\x00\x01z^\xab?\x00\x00\x00\x00IEND\xaeB`\x82' > "$OUT/$p"; done < runtime/placeholder-png.txt
fi
echo "hostroot: ${OUT} ($(du -sh "$OUT" | cut -f1))"
