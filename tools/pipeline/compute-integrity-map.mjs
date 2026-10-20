#!/usr/bin/env node
/**
 * compute-integrity-map.mjs — 从原始 minified 源码的列位置推算完整性常量值。
 *
 * 背景：Jscrambler 完整性函数 (V0Q/D6k/Y71/r2z 等) 的返回值取决于 Error().stack 列位置。
 * CFF 展开后列位置变了，静态 XOR/rotate 分析产出错误的值。
 * 本工具扫描原始源码的完整性调用，用公式 `result = col - colArg - K - (12 + len(str(idxArg)))` 反推正确值。
 * K 值通过暴力搜索 + 字符串表命中率确定。
 *
 * 用法：
 *   node compute-integrity-map.mjs <origFile> <stringsJson> <wrapperNames> [--out mapFile.json]
 *
 *   origFile:     原始 minified 源码（镜像里的 .js）
 *   stringsJson:  该文件的字符串表（inspect/strings/xxx.strings.json）
 *   wrapperNames: 逗号分隔的 wrapper 函数名，如 V0Q,D6k
 *   --anchor name=index  用已知正确值锚定 K（如 register=3315）
 *   --out        输出 JSON 路径（默认 stdout）
 *
 * 输出 JSON: { "V0Q:3:512:55983": 1234, ... }  可直接传给 full-pipeline --integrity-map
 *
 * 需要 @babel/core, @babel/traverse, @babel/types（从 tools/rewrite/ 目录跑即可）。
 */
import * as babel from '@babel/core';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';
import fs from 'node:fs';

const traverse = _traverse.default ?? _traverse;

function parseArgs() {
  const args = process.argv.slice(2);
  const o = { origFile: null, stringsJson: null, wrapperNames: [], out: null, anchors: [] };
  let i = 0;
  while (i < args.length) {
    if (args[i] === '--out') { o.out = args[++i]; i++; continue; }
    if (args[i] === '--anchor') { o.anchors.push(args[++i]); i++; continue; }
    if (!o.origFile) { o.origFile = args[i]; }
    else if (!o.stringsJson) { o.stringsJson = args[i]; }
    else if (!o.wrapperNames.length) { o.wrapperNames = args[i].split(','); }
    i++;
  }
  if (!o.origFile || !o.stringsJson || !o.wrapperNames.length) {
    console.error('用法: node compute-integrity-map.mjs <origFile> <stringsJson> V0Q,D6k [--anchor register=3315] [--out map.json]');
    process.exit(2);
  }
  return o;
}

const cfg = parseArgs();
const origCode = fs.readFileSync(cfg.origFile, 'utf8');
const table = JSON.parse(fs.readFileSync(cfg.stringsJson, 'utf8'));
const wrapperSet = new Set(cfg.wrapperNames);

console.error(`解析原始源码 ${cfg.origFile} (${(origCode.length / 1024 / 1024).toFixed(1)} MB)...`);
const ast = babel.parseSync(origCode, { sourceType: 'script' });

// 检测参数布局：main.js 是 (expr, idx, encoded, colCheck)，other.js 是 (colCheck, idx, encoded, expr)
// 通过检查哪个 numeric arg 的值最大（接近列位置）来自动判断
const allCalls = [];
traverse(ast, { noScope: true, CallExpression(path) {
  const n = path.node;
  if (!t.isMemberExpression(n.callee)) return;
  const prop = n.callee.computed ? null : n.callee.property?.name;
  if (!wrapperSet.has(prop)) return;
  if (n.arguments.length !== 4) return;
  const numArgs = [];
  for (let i = 0; i < 4; i++) {
    numArgs.push(t.isNumericLiteral(n.arguments[i]) ? n.arguments[i].value : null);
  }
  // 至少 3 个 numeric 参数
  if (numArgs.filter(v => v !== null).length < 3) return;
  allCalls.push({ fn: prop, numArgs, col: n.loc.start.column });
}});
console.error(`找到 ${allCalls.length} 个完整性调用`);

if (!allCalls.length) { console.error('没有找到完整性调用'); process.exit(1); }

// 自动检测 colArg 位置：哪个参数值最接近 call site column？
const argDistances = [0, 1, 2, 3].map(i => {
  let total = 0, count = 0;
  for (const c of allCalls) {
    if (c.numArgs[i] !== null) { total += Math.abs(c.col - c.numArgs[i]); count++; }
  }
  return count ? total / count : Infinity;
});
const colArgIdx = argDistances.indexOf(Math.min(...argDistances));
console.error(`colArg 位置: args[${colArgIdx}]（平均距离 ${argDistances[colArgIdx].toFixed(0)} vs ${argDistances.map(d => d.toFixed(0)).join('/')}）`);

// idxArg 位置：通常是紧邻 colArg 的小数字（< 1000）
const idxArgIdx = [0, 1, 2, 3].find(i => {
  if (i === colArgIdx) return false;
  const vals = allCalls.map(c => c.numArgs[i]).filter(v => v !== null);
  return vals.length > 0 && Math.max(...vals) < 5000;
});
console.error(`idxArg 位置: args[${idxArgIdx}]`);

// 构建有效调用列表
const validCalls = allCalls.filter(c => c.numArgs[colArgIdx] !== null && c.numArgs[idxArgIdx] !== null).map(c => ({
  fn: c.fn, col: c.col,
  colArg: c.numArgs[colArgIdx],
  idxArg: c.numArgs[idxArgIdx],
  allArgs: c.numArgs,
}));

// 解析 anchor
const anchorMap = new Map();
for (const a of cfg.anchors) {
  const m = a.match(/^(.+)=(\d+)$/);
  if (m) anchorMap.set(m[1], Number(m[2]));
}

// 暴力搜索 K
function computeResult(c, K) {
  const n6 = 12 + String(c.idxArg).length;
  return c.col - c.colArg - K - n6;
}

function scoreK(K) {
  let hits = 0;
  for (const c of validCalls) {
    const r = computeResult(c, K);
    if (r >= 0 && r < table.length && typeof table[r] === 'string') hits++;
  }
  return hits;
}

let bestK = 0, bestScore = 0;

// 如果有 anchor，先用 anchor 确定 K
if (anchorMap.size > 0) {
  // 找 decoder(integrity) 调用来匹配 anchor
  const decCalls = [];
  traverse(ast, { noScope: true, CallExpression(path) {
    const n = path.node;
    if (!t.isMemberExpression(n.callee) || n.arguments.length !== 1 || !t.isCallExpression(n.arguments[0])) return;
    const inner = n.arguments[0];
    if (!t.isMemberExpression(inner.callee)) return;
    const prop = inner.callee.computed ? null : inner.callee.property?.name;
    if (!wrapperSet.has(prop)) return;
    if (inner.arguments.length !== 4) return;
    const numArgs = inner.arguments.map(a => t.isNumericLiteral(a) ? a.value : null);
    if (numArgs[colArgIdx] === null || numArgs[idxArgIdx] === null) return;
    decCalls.push({
      col: inner.loc.start.column,
      colArg: numArgs[colArgIdx],
      idxArg: numArgs[idxArgIdx],
    });
  }});

  for (const [anchorStr, anchorIdx] of anchorMap) {
    for (const dc of decCalls) {
      const n6 = 12 + String(dc.idxArg).length;
      const K = dc.col - dc.colArg - anchorIdx - n6;
      const score = scoreK(K);
      if (score > bestScore) { bestK = K; bestScore = score; }
    }
  }
  console.error(`Anchor 搜索: K=${bestK}, 命中 ${bestScore}/${validCalls.length}`);
} else {
  // 无 anchor：扫描 K 范围
  for (let K = -5000; K <= 0; K++) {
    const score = scoreK(K);
    if (score > bestScore) { bestK = K; bestScore = score; }
  }
  console.error(`暴力搜索: K=${bestK}, 命中 ${bestScore}/${validCalls.length}`);
}

if (bestScore < validCalls.length * 0.9) {
  console.error(`⚠ 命中率太低 (${bestScore}/${validCalls.length})，结果可能不可靠`);
}

// 生成 mapping
const mapping = {};
let valid = 0, invalid = 0;
for (const c of validCalls) {
  const r = computeResult(c, bestK);
  // key 格式需要与 runtime-fold.mjs 的查找逻辑对齐。
  // runtime-fold 尝试两种 key：
  //   1. fn:args[1]:args[2]:args[3]  (main layout: colCheck 在 args[3])
  //   2. fn:args[1]:args[2]:args[0]  (other layout: colCheck 在 args[0], args[3] 非 numeric)
  const args = c.allArgs;
  let key;
  if (colArgIdx === 3) {
    // main layout: key = fn:args[1]:args[2]:args[3]
    key = `${c.fn}:${args[1]}:${args[2]}:${args[3]}`;
  } else if (colArgIdx === 0) {
    // other layout: key = fn:args[1]:args[2]:args[0] (runtime-fold 的 fallback candidate)
    key = `${c.fn}:${args[1]}:${args[2]}:${args[0]}`;
  } else {
    key = `${c.fn}:${args.filter(a => a !== null).join(':')}`;
  }

  if (r >= 0 && r < table.length && typeof table[r] === 'string') {
    mapping[key] = r;
    valid++;
  } else {
    invalid++;
    if (invalid <= 3) console.error(`  无效: ${key} → ${r} (超出表范围)`);
  }
}

console.error(`\n结果: ${valid} 有效, ${invalid} 无效, K=${bestK}`);
console.error(`  公式: result = col - args[${colArgIdx}] - (${bestK}) - (12 + len(str(args[${idxArgIdx}])))`);

const output = JSON.stringify(mapping, null, 2);
if (cfg.out) {
  fs.writeFileSync(cfg.out, output);
  console.error(`写入 ${cfg.out}`);
} else {
  process.stdout.write(output + '\n');
}
