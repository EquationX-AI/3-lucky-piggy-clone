#!/usr/bin/env bash
# 统一启动器：每款 games 都在 replicas/<slug>/launch.sh 里调它。
# 用法：（在 replicas/<slug> 下）bash ../../tools/rewrite/launch-game.sh
#   HEADLESS=1    headless 模式（验收/CI 用）
#   CDP_PORT=xxxx 覆盖调试端口（缺省取 replica.json:refPorts.cdp 或 9688）
#   BLOCK='re'    传给 serve.mjs 的 --block（屏蔽某个文件做实验）
#
# 做的事：按 replica.json 起本地静态服务 + TLS 前端 + 接口桩 + Chrome（厂商域名映射，不改 hosts），
# 然后用 refUrl 打开页面。游戏跑的是 replicas/<slug>/game/ 里的产物。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="$(cd "${REPLICA_DIR:-$PWD}" && pwd)"

[ -f "$DIR/replica.json" ] || { echo "请在 replicas/<slug> 目录下运行，或设置 REPLICA_DIR" >&2; exit 2; }

GP=$(python3 -c "import json;d=json.load(open('$DIR/replica.json'));print(d.get('gamePath',''))")
[ -n "$GP" ] || { echo "replica.json 缺 gamePath" >&2; exit 2; }
[ -d "$DIR/game/$GP" ] || { echo "game/$GP 不存在：镜像或清洗产物未入库" >&2; exit 2; }

# 统一目录布局检查：本地运行件必须在 game/<gamePath>/ctrl/
if [ ! -f "$DIR/game/$GP/ctrl/controller.js" ] && [ ! -f "$DIR/game/$GP/controller/controller.js" ]; then
  echo "警告：game/$GP 下没有 ctrl/controller.js——启动后可能不走 Controller，请先按 references/launch-and-layout.md 补齐" >&2
fi

# hostroot 是静态服务根：干净 clone 里没有，按 mirrors/ 现生成（约 1 分钟）
if [ ! -d "$DIR/hostroot" ]; then
  echo "hostroot 不存在，从 mirrors/ 生成（首次约 1 分钟）…"
  REPLICA_DIR="$DIR" bash "$HERE/make-hostroot.sh"
fi

OVERLAY="$DIR/game" REPLICA_DIR="$DIR" \
  bash "$HERE/start-ref.sh" ${BLOCK:+--block "$BLOCK"} "$@"

# start-ref.sh 只把 Chrome 起在 about:blank；这里用 refUrl 打开页面
URL=$(python3 -c "import json;print(json.load(open('$DIR/replica.json')).get('refUrl',''))")
CDP="${CDP_PORT:-$(python3 -c "import json;print(json.load(open('$DIR/replica.json')).get('refPorts',{}).get('cdp',9688))")}"
if [ -n "$URL" ] && command -v node >/dev/null 2>&1; then
  node - "$URL" "$CDP" <<'NODE' || echo "提示：页面导航失败，可手动打开 refUrl" >&2
const [url, cdp] = process.argv.slice(2);
(async () => {
  const tabs = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json();
  const page = tabs.find((t) => t.type === 'page') || tabs[0];
  if (!page) throw new Error('没有可用页面');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url } }));
  await new Promise((r) => setTimeout(r, 800));
  ws.close();
  console.log('已在 Chrome 中打开：' + url);
})().catch((e) => { console.error(e.message); process.exit(1); });
NODE
fi
