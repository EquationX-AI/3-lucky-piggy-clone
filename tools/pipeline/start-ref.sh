#!/usr/bin/env bash
# 原版对照环境：厂商域名 + 原始（混淆）文件，静态服务换成 tools/rewrite/serve.mjs，便于覆盖/屏蔽单个文件做实验。
#
# **只在需要"原版 vs 清洗后"对照时用**：
#   - S1 采完镜像，想用厂商原始文件跑一遍、确认镜像本身能加载
#   - S1.5 / S3 采字符串表：dump-table.mjs 经 cdp.mjs boot 导航到 replica.json 的 refUrl，需要这个 Chrome + 域名映射
# 剥离版的日常验收（S5）走 `tools/strip/server-example/server.cjs` + 本地镜像，不需要本脚本。
#
# 用法：（在 replicas/<slug> 下）bash ../../tools/rewrite/start-ref.sh [serve.mjs 的额外参数，如 --block 'bundle\.ad349\.js$']
#
# 环境变量（都有合理默认）：
#   REPLICA_DIR      复刻目录，缺省当前目录
#   NODE_BIN         node 可执行文件，缺省从 PATH 找
#   CHROME           Chrome/Chromium 可执行文件，缺省自动找（PATH → /Applications → Playwright 缓存）
#   CDP_PORT         远程调试端口，缺省 9688（cdp.mjs 也读这个）
#   PROFILE_SUFFIX   Chrome profile 后缀，缺省空
#   OVERLAY          覆盖目录：里面的文件优先于 hostroot，缺省不启用
#   HEADLESS=1       以 headless 模式启动 Chrome，缺省 0（有界面）
#
# 起三个本地服务 + 一个 Chrome：
#   serve.mjs（静态，端口 replica.json:refPorts.serve）→ tls-front（TLS，refPorts.tls）→ Chrome 把厂商页面域名指到 TLS
#   stub-api-v2.cjs（接口桩，HTTPS，refPorts.stub）→ Chrome 把 replica.json:vendorHosts.api 指到这里
set -euo pipefail

TOOLS="$(cd "$(dirname "$0")" && pwd)"
DIR="$(cd "${REPLICA_DIR:-$PWD}" && pwd)"
cd "$DIR"

[ -f replica.json ] || { echo "请在复刻游戏目录（replicas/<slug>）下运行，或设置 REPLICA_DIR" >&2; exit 2; }

if [ -n "${NODE_BIN:-}" ]; then
  NODE="$NODE_BIN"
else
  NODE="$(command -v node || true)"
fi
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "找不到 node：设置 NODE_BIN=/path/to/node" >&2; exit 2; }
export PATH="$(dirname "$NODE"):$PATH"

# 先让 config.mjs 校验 replica.json（缺键会带着逐条原因 exit 2），后面取值就不会拿到 undefined
"$NODE" "$TOOLS/config.mjs" --check
cfg() { "$NODE" "$TOOLS/config.mjs" "$1"; }

RT="$DIR/runtime"
SP=$(cfg refPorts.serve)
TP=$(cfg refPorts.tls)
BP=$(cfg refPorts.stub)
HOSTROOT="$(cfg hostroot)"
case "$HOSTROOT" in /*) ;; *) HOSTROOT="$DIR/$HOSTROOT" ;; esac
GAME_HOST=$(cfg vendorHosts.game)
API_HOSTS=$(cfg vendorHosts.api)
CDP="${CDP_PORT:-9688}"

[ -f "$TOOLS/serve.mjs" ] || { echo "缺 $TOOLS/serve.mjs" >&2; exit 2; }
[ -f "$TOOLS/runtime/tls-front.cjs" ] || { echo "缺 $TOOLS/runtime/tls-front.cjs" >&2; exit 2; }
[ -f "$TOOLS/runtime/stub-api-v2.cjs" ] || { echo "缺 $TOOLS/runtime/stub-api-v2.cjs" >&2; exit 2; }
[ -f "$TOOLS/gen-cert.sh" ] || { echo "缺 $TOOLS/gen-cert.sh" >&2; exit 2; }
[ -d "$HOSTROOT" ] || { echo "hostroot 不存在：$HOSTROOT"; echo "  先跑 bash $TOOLS/make-hostroot.sh" >&2; exit 2; }

# ---------- Chrome 查找 ----------
find_chrome() {
  if [ -n "${CHROME:-}" ]; then printf '%s\n' "$CHROME"; return; fi
  local c p last=""
  for c in google-chrome-stable google-chrome chromium chromium-browser; do
    p="$(command -v "$c" 2>/dev/null || true)"
    [ -n "$p" ] && { printf '%s\n' "$p"; return; }
  done
  for p in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    [ -x "$p" ] && { printf '%s\n' "$p"; return; }
  done
  for p in "$HOME"/Library/Caches/ms-playwright/chromium-*/chrome-mac-*/Google*Chrome*Testing.app/Contents/MacOS/Google*Chrome*Testing; do
    [ -x "$p" ] && last="$p"
  done
  [ -n "$last" ] && { printf '%s\n' "$last"; return; }
  printf '\n'
}
CHROME_EXE="$(find_chrome)"
[ -n "$CHROME_EXE" ] && [ -x "$CHROME_EXE" ] || {
  echo "找不到 Chrome：设置 CHROME=/path/to/chrome，或把 Chrome 装到 /Applications" >&2
  exit 2
}

# ---------- 清端口 ----------
kill_port() {
  local p="$1" pid
  command -v lsof >/dev/null 2>&1 || return 0
  pid="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
}
# KEEP_PORTS=1 时不清端口：某些款把 controller/server 跑在 refPorts 里，被这里 kill 会造成
# "accept 环境里那个口永远是 stub"（td51 实测）。controller 请用 refPorts 之外的端口。
if [ "${KEEP_PORTS:-0}" != "1" ]; then
  for p in "$SP" "$TP" "$BP" "$CDP"; do kill_port "$p"; done
else
  echo "KEEP_PORTS=1：跳过端口清理（$SP $TP $BP $CDP）" >&2
fi
sleep 1

mkdir -p "$DIR/.run"
: > "$DIR/.run/serve.log"
: > "$DIR/.run/serve.out"

# ---------- 证书（必须早于 tls-front / stub-api） ----------
if [ ! -f "$RT/key.pem" ] || [ ! -f "$RT/cert.pem" ]; then
  bash "$TOOLS/gen-cert.sh" "$RT" "$GAME_HOST" $API_HOSTS
fi

# ---------- 静态服务 ----------
# 覆盖目录在前：同一个文件 OVERLAY 里有的优先，方便"只换一个 bundle"做对照
SERVE_ARGS=(--port "$SP" --log "$DIR/.run/serve.log" --stub-api)
if [ -n "${OVERLAY:-}" ]; then SERVE_ARGS+=(--root "$OVERLAY"); fi
SERVE_ARGS+=(--root "$HOSTROOT")
nohup "$NODE" "$TOOLS/serve.mjs" "${SERVE_ARGS[@]}" "$@" > "$DIR/.run/serve.out" 2>&1 &
sleep 0.5

# ---------- TLS 前端 + 接口桩 ----------
env KEY="$RT/key.pem" CERT="$RT/cert.pem" BACK="$SP" LPORT="$TP" \
  nohup "$NODE" "$TOOLS/runtime/tls-front.cjs" > "$DIR/.run/tls.out" 2>&1 &
env PORT="$BP" KEY="$RT/key.pem" CERT="$RT/cert.pem" LOG="$DIR/.run/stub.log" \
  nohup "$NODE" "$TOOLS/runtime/stub-api-v2.cjs" > "$DIR/.run/stub.out" 2>&1 &
sleep 0.5

# ---------- Chrome ----------
PROFILE="$DIR/.chrome-profile${PROFILE_SUFFIX:-}"
rm -rf "$PROFILE/Default/Cache" "$PROFILE/Default/Code Cache" "$PROFILE/Default/Service Worker" 2>/dev/null || true
RULES="MAP $GAME_HOST 127.0.0.1:$TP"
for h in $API_HOSTS; do RULES="$RULES, MAP $h 127.0.0.1:$BP"; done
RULES="$RULES, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"
CHROME_FLAGS=(
  --no-first-run --no-default-browser-check --no-proxy-server --ignore-certificate-errors
  --disable-backgrounding-occluded-windows --disable-renderer-backgrounding
  --disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion
  --use-gl=angle --enable-unsafe-swiftshader
  --disk-cache-size=1 --media-cache-size=1
  --user-data-dir="$PROFILE" --window-size=1440,900
  --host-resolver-rules="$RULES" --remote-debugging-port="$CDP" about:blank
)
if [ "${HEADLESS:-0}" = "1" ]; then CHROME_FLAGS=(--headless=new "${CHROME_FLAGS[@]}"); fi
nohup "$CHROME_EXE" "${CHROME_FLAGS[@]}" > "$DIR/.run/chrome.out" 2>&1 &

for _ in $(seq 1 40); do
  curl -s -m 1 "http://127.0.0.1:$CDP/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done

echo "ref env up: serve=$SP tls=$TP stub=$BP cdp=$CDP"
echo "  chrome:  $CHROME_EXE"
echo "  hostroot:$HOSTROOT"
echo "  refUrl:  $(cfg refUrl)"
echo "  logs:    $DIR/.run/{serve,stub,tls,chrome}.out  $DIR/.run/serve.log"
echo "  静态 404: grep '\"miss\":true' $DIR/.run/serve.log"
echo "  额外 serve 参数: $*"
