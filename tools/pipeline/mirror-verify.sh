#!/usr/bin/env bash
# 校验镜像完整性：
#   1. 读 source-manifest.json，逐根校验文件数和字节数
#   2. 统计三个根（game / shell / cocos-js）的文件数和总字节
#   3. 任一项不通过则非零退出
set -euo pipefail
MIRROR="${1:?用法: mirror-verify.sh <mirror目录>}"
echo "=== 镜像校验: $MIRROR ==="
ERRORS=0
MANIFEST="$MIRROR/source-manifest.json"

# ---- 1. source-manifest.json ----
if [ -f "$MANIFEST" ]; then
  echo "✓ source-manifest.json 存在"
  # 逐根校验：读 manifest 里每个 root 的 fileCount 和 totalBytes
  ROOTS=$(node -e "
    const m = JSON.parse(require('fs').readFileSync('$MANIFEST','utf8'));
    // roots 支持两种写法：数组 [{dir, fileCount, totalBytes}] 或对象 {game: {localDir, fileCount, bytes}}
    let roots = m.roots || m.entries || [];
    if (!Array.isArray(roots)) roots = Object.entries(roots).map(([k, v]) => ({ dir: v.localDir || v.dir || k, ...v }));
    for (const r of roots) {
      const dir = r.dir || r.localDir || r.path || '';
      console.log([dir, r.fileCount || r.files || 0, r.totalBytes || r.bytes || 0].join('\t'));
    }
  " 2>/dev/null || true)
  if [ -n "$ROOTS" ]; then
    while IFS=$'\t' read -r dir expect_count expect_bytes; do
      [ -z "$dir" ] && continue
      full="$MIRROR/$dir"
      if [ ! -d "$full" ]; then
        echo "✗ manifest 声明的 $dir/ 不存在"
        ERRORS=$((ERRORS + 1))
        continue
      fi
      actual_count=$(find "$full" -type f -not -name '.DS_Store' | wc -l | tr -d ' ')
      if [ "$expect_count" -gt 0 ] && [ "$actual_count" -ne "$expect_count" ]; then
        echo "✗ $dir/: manifest 声明 $expect_count 文件，实际 $actual_count"
        ERRORS=$((ERRORS + 1))
      else
        echo "✓ $dir/: $actual_count 文件（manifest: ${expect_count}）"
      fi
    done <<< "$ROOTS"
  else
    echo "✗ source-manifest.json 格式无法解析或没有 roots，无法逐根校验"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "✗ source-manifest.json 不存在"
  ERRORS=$((ERRORS + 1))
fi

# ---- 2. 三个根的存在性和统计 ----
for d in game shell cocos-js; do
    if [ -d "$MIRROR/$d" ]; then
        COUNT=$(find "$MIRROR/$d" -type f -not -name '.DS_Store' | wc -l | tr -d ' ')
        SIZE=$(du -sh "$MIRROR/$d" 2>/dev/null | cut -f1)
        echo "✓ $d/: $COUNT 文件, $SIZE"
    else
        echo "⚠ $d/ 不存在（部分框架不使用此根）"
    fi
done
TOTAL=$(find "$MIRROR" -type f -not -name '.DS_Store' | wc -l | tr -d ' ')
echo "总计: $TOTAL 文件"

# ---- 3. 退出 ----
if [ $ERRORS -gt 0 ]; then
  echo "校验失败：$ERRORS 项不通过"
  exit 1
fi
echo "校验通过"
exit 0
