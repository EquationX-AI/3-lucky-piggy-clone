// 读当前复刻游戏的配置：游戏目录 = $REPLICA_DIR，缺省为当前目录；配置文件 = <游戏目录>/replica.json
// 命令行：
//   node tools/rewrite/config.mjs <键>       → 打印该键（嵌套用点，如 refPorts.serve），供 shell 脚本取值
//   node tools/rewrite/config.mjs localUrl   → 打印本地游戏 URL
//   node tools/rewrite/config.mjs --check    → 只校验必填键；通过打一行摘要，缺键打清单并 exit 2
// 加载时就校验必填键：缺一个立即 exit 2 并指明是哪个键，不让脚本带着字面量 "undefined" 继续跑。
// 键表、各阶段填法、缺键后果见 skill/references/replica-json.md；模板 skill/templates/replica.json。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(process.env.REPLICA_DIR || process.cwd());
const file = path.join(ROOT, 'replica.json');

const USAGE = `用法：
  node tools/rewrite/config.mjs <键>       打印一个配置值（嵌套用点，如 refPorts.serve）
  node tools/rewrite/config.mjs localUrl   打印本地游戏 URL
  node tools/rewrite/config.mjs --check    校验必填键

配置文件：<复刻游戏目录>/replica.json（目录缺省为当前目录，可用 REPLICA_DIR 指定）
键表与各阶段填法：skill/references/replica-json.md
模板：skill/templates/replica.json`;

// 必填键：[点路径, 类型, 谁在读 / 该填什么, 允许空串]
// 类型对应下面 checkValue 的分支；query 允许空串（本地 URL 可以不带参数）。
const REQUIRED = [
  ['gamePath', 'string', 'make-hostroot.sh 拷贝目标、cdp.mjs(REPLICA_SHELL=ts) 的 overlay 路径；游戏根的目录名'],
  ['localPort', 'port', 'config.mjs localUrl 读；本地静态服务端口'],
  ['query', 'string', 'config.mjs localUrl 读；本地 URL 的 query', true],
  ['refUrl', 'url', 'cdp.mjs boot/nav 的默认导航地址（dump-table.mjs 经它重载）'],
  ['mirror', 'string', 'make-hostroot.sh 的镜像目录缺省值'],
  ['shellVersion', 'string', 'make-hostroot.sh 生成 astarte2/<版本>/web-mobile/ 用'],
  ['hostroot', 'string', 'make-hostroot.sh 输出目录、start-ref.sh 静态根'],
  ['refPorts.serve', 'port', 'start-ref.sh 静态服务端口'],
  ['refPorts.tls', 'port', 'start-ref.sh TLS 前端端口'],
  ['refPorts.stub', 'port', 'start-ref.sh 接口桩端口'],
  ['vendorHosts.game', 'host', 'start-ref.sh 域名映射、gen-cert.sh 的 SAN'],
  ['vendorHosts.api', 'hosts', 'start-ref.sh 域名映射、gen-cert.sh 的 SAN'],
];

const pick = (obj, dotted) => dotted.split('.').reduce((v, k) => (v == null ? v : v[k]), obj);
const show = (v) => (v === undefined ? 'undefined' : JSON.stringify(v));

function checkValue(key, type, v) {
  if (type === 'port') {
    return Number.isInteger(v) && v > 0 && v < 65536
      ? null
      : `${key} 应为 1-65535 的整数（不要加引号），实际 ${show(v)}`;
  }
  if (type === 'url') {
    return typeof v === 'string' && /^https?:\/\/\S+$/i.test(v)
      ? null
      : `${key} 应为 http:// 或 https:// 开头的地址，实际 ${show(v)}`;
  }
  if (type === 'host') {
    return typeof v === 'string' && /^[A-Za-z0-9.-]+$/.test(v)
      ? null
      : `${key} 应为域名（如 uat-wbgame.tadagaming.com），实际 ${show(v)}`;
  }
  if (type === 'hosts') {
    if (typeof v === 'string') {
      return v.trim() ? null : `${key} 应为域名数组，如 ["uat-api.tadagaming.com"]，实际 ${show(v)}`;
    }
    return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.trim())
      ? null
      : `${key} 应为非空的域名数组，如 ["uat-api.tadagaming.com"]，实际 ${show(v)}`;
  }
  return typeof v === 'string' ? null : `${key} 应为字符串，实际 ${show(v)}`;
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
const cliArgs = process.argv.slice(2);
if (isCli && (cliArgs[0] === '--help' || cliArgs[0] === '-h' || !cliArgs[0])) {
  console.log(USAGE);
  process.exit(0);
}

if (!fs.existsSync(file)) {
  console.error(`找不到 ${file}：请在复刻游戏目录（replicas/<slug>）下运行，或设置 REPLICA_DIR`);
  process.exit(2);
}
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`replica.json 不是合法 JSON：${file}\n  ${e.message}\n  提示：JSON 里不能写 // 注释；模板见 skill/templates/replica.json`);
  process.exit(2);
}

const problems = [];
for (const [key, type, why, allowEmpty] of REQUIRED) {
  const v = pick(cfg, key);
  const empty = v === undefined || v === null || (!allowEmpty && typeof v === 'string' && !v.trim());
  if (empty) {
    problems.push(`缺 ${key} —— ${why}`);
    continue;
  }
  const bad = checkValue(key, type, v);
  if (bad) problems.push(`${bad} —— ${why}`);
}
if (problems.length) {
  console.error(`replica.json 校验失败：${problems.length} 个必填键有问题 → ${file}`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('  键表与各阶段填法：skill/references/replica-json.md');
  console.error('  模板：skill/templates/replica.json');
  process.exit(2);
}

export const CFG = cfg;
export const expand = (p) => (p || '').replace(/^~(?=\/)/, os.homedir());
export const localUrl = () => `http://127.0.0.1:${CFG.localPort}/${CFG.gamePath}/?${CFG.query}`;
export const shellFile = () => path.join(ROOT, 'dist/overlay', CFG.gamePath, 'replica-shell.js');

if (isCli) {
  const k = cliArgs[0];
  if (k === '--check') {
    console.log(`replica.json 校验通过：${file}`);
    console.log(`  必填键 ${REQUIRED.length} 个齐全；本地 URL ${localUrl()}`);
  } else if (k === 'localUrl') {
    console.log(localUrl());
  } else {
    let v = CFG;
    for (const p of k.split('.')) v = v == null ? v : v[p];
    console.log(Array.isArray(v) ? v.join(' ') : typeof v === 'string' ? expand(v) : JSON.stringify(v));
  }
}
