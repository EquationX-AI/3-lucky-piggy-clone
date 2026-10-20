#!/usr/bin/env node
// 识别 Jscrambler"命名空间字符串表"变体（fg3 main 用的那种：没有"大字符串函数 + 解码 IIFE"）。
//
// 用法：node tools/rewrite/fg3-variant/scan-variant.mjs <混淆文件.js> [配置输出.json]
//
// 这个变体的形状（fg3 main 为例，注释里的名字各文件随机）：
//   1. `NS[数字] = (function(){ ... })();` —— 表工厂。内部用 CFF 循环做
//      fromCharCode(charCodeAt(大串,i) ^ charCodeAt(密钥,j))，再 split('`') 得到字符串数组，
//      并把访问器挂到返回对象的某个随机属性上。
//   2. `NS.甲 = function q(){var o=NS[数字],e=o.属性;return q===NS.甲 && (...)}` —— 访问器包装。
//   3. 守卫：`X === k && Y === <哨兵编号> ? ...` 链。程序的前 7 次访问必须是这些编号，
//      每次调用会就地改写字符串数组；不先走这 7 次，整张表都是诱饵单词。
//   4. 索引函数：`E0_ === 阈值 ? ...` / `E0_ > 阈值 ? ...`。碰到"旋转编号"会把数组左旋若干位，
//      所以 编号→明文 不是静态映射，必须跳过旋转编号、按连续下标枚举。
//
// 输出：配置 JSON（给 dump-table-node.mjs / hook-accessor.mjs 用）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as babel from '@babel/core';

// 标识符里混了西里尔/希腊字母，不能用 \w，要用 Unicode 字母类
const ID = String.raw`[\p{L}\p{N}_$]+`;

export function scanVariant(src) {
  const out = { variant: null };

  // ---- 1. 表工厂 ----
  const ast = babel.parseSync(src, { sourceType: 'script' });
  let factory = null;
  for (const st of ast.program.body) {
    if (st.type !== 'ExpressionStatement') continue;
    const ex = st.expression;
    if (ex.type !== 'AssignmentExpression') continue;
    const { left, right } = ex;
    if (left.type !== 'MemberExpression' || left.object.type !== 'Identifier') continue;
    if (right.type !== 'CallExpression' || right.callee.type !== 'FunctionExpression') continue;
    const p = left.property;
    const id = p.type === 'NumericLiteral' ? p.value
      : (p.type === 'StringLiteral' && /^\d+$/.test(p.value) ? Number(p.value) : null);
    if (id === null) continue;
    const body = src.slice(right.callee.start, right.callee.end);
    // 注册基址槽位 `('F', 49)`，且索引函数会把它读回来 `[485014].xsr('F')`
    if (/\(['"`]F['"`]\s*,\s*\d+\)/.test(body) && /\[\d+\]\.\w+\(['"`]F['"`]\)/.test(body)) {
      factory = { ns: left.object.name, tableId: id, span: [right.callee.start, right.callee.end], stmtEnd: st.end, body };
      break;
    }
  }
  if (!factory) return out;
  const { ns, tableId, span, body } = factory;
  out.variant = 'jscrambler-namespace-string-table';
  out.namespace = ns;
  out.tableProperty = tableId;
  out.tableFactorySpan = span;
  out.tableFactoryStmtEnd = factory.stmtEnd;

  // ---- 2. 基址偏移 ----
  const b = body.match(/\(['"`]F['"`]\s*,\s*(\d+)\)/);
  out.baseOffset = b ? Number(b[1]) : null;

  // ---- 3. 守卫：前 7 次必须访问的哨兵编号（按步序） ----
  const sentRe = new RegExp(`(${ID})\\s*===\\s*(\\d+)\\s*&&\\s*(${ID})\\s*===\\s*(\\d+)\\s*\\?`, 'gu');
  const sent = [...body.matchAll(sentRe)].map((m) => ({ step: Number(m[2]), id: Number(m[4]), counter: m[1] }));
  if (sent.length) {
    sent.sort((a, x) => a.step - x.step);
    out.sentinelCalls = sent.map((s) => s.id);
    out.sentinelCounter = sent[0].counter;
  }

  // ---- 4. 索引函数：旋转编号 + 下标补偿阈值 ----
  const decRe = new RegExp(`(${ID})\\s*-=\\s*${ID}\\[\\d+\\]\\.\\p{L}+\\(['"\`]F['"\`]\\)`, 'u');
  const dec = body.match(decRe);
  if (dec) {
    const v = dec[1];
    const eq = [...body.matchAll(new RegExp(`${v}\\s*===\\s*(\\d+)\\s*\\?`, 'gu'))].map((m) => Number(m[1]));
    const gt = [...body.matchAll(new RegExp(`${v}\\s*>\\s*(\\d+)\\s*\\?`, 'gu'))].map((m) => Number(m[1]));
    const thresholds = [...new Set([...eq, ...gt])].sort((a, x) => a - x);
    if (thresholds.length && out.baseOffset !== null) {
      out.indexVar = v;
      out.indexThresholds = thresholds;
      out.rotationIds = thresholds.map((t) => t + out.baseOffset);
      const rotationIds = new Set(out.rotationIds);
      const adjustCount = (off) => thresholds.filter((t) => off > t).length;
      // 只记一段够用的编号序列，订阅号→下标由消费者用 baseOffset + indexThresholds 现算，
      // 免得配置里塞两万条映射
      const pureIds = [];
      for (let off = 0; off <= 12000; off++) {
        if (rotationIds.has(off + out.baseOffset)) continue;
        pureIds.push(off + out.baseOffset);
      }
      out.pureIds = pureIds;
      void adjustCount;
    }
  }

  // ---- 5. 访问器包装函数区间（hook-accessor 做等长替换用） ----
  // 组：2=包装名 3=第一个局部变量 4=表属性号 5=第二个局部变量 6=表上的访问器属性名
  // 同一个文件里其它命名空间成员（例如防调试函数）也是同样的包装形状，必须按表属性号过滤
  const wrapRe = new RegExp(
    `(${ns}\\.(${ID})\\s*=\\s*function\\s+${ID}\\s*\\(\\s*\\)\\s*\\{\\s*var\\s+(${ID})\\s*=\\s*` +
    `${ns}\\[(\\d+)\\]\\s*,\\s*(${ID})\\s*=\\s*${ID}\\.([^\\s;]+)\\s*;\\s*return\\s+${ID}\\s*===\\s*` +
    `${ns}\\.\\2\\s*&&\\s*\\(typeof\\s+\\5\\s*===\\s*'function'\\s*\\?\\s*\\5\\.apply\\(\\3\\s*,\\s*arguments\\)\\s*:\\s*\\5\\)\\s*;?\\s*\\}\\s*;)`,
    'gu');
  const wraps = [...src.matchAll(wrapRe)]
    .filter((m) => Number(m[4]) === tableId)
    .map((m) => ({ start: m.index, end: m.index + m[0].length, name: m[2], tableProp: m[6] }));
  const groups = [];
  for (const w of wraps) {
    const last = groups[groups.length - 1];
    if (last && last.prop === w.tableProp && last.span[1] === w.start) { last.span[1] = w.end; last.names.push(w.name); }
    else groups.push({ prop: w.tableProp, span: [w.start, w.end], names: [w.name] });
  }
  if (groups.length) {
    out.accessorWrappers = groups.map((g) => ({ prop: g.prop, span: g.span, length: g.span[1] - g.span[0], names: g.names }));
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const file = process.argv[2];
  if (!file) { console.error('用法：scan-variant.mjs <混淆文件.js> [配置输出.json]'); process.exit(2); }
  const cfg = scanVariant(fs.readFileSync(file, 'utf-8'));
  cfg.file = file;
  const outPath = process.argv[3] || file.replace(/\.js$/, '') + '.variant.json';
  fs.writeFileSync(outPath, JSON.stringify(cfg, null, 2));
  const brief = { ...cfg, pureIds: cfg.pureIds ? `${cfg.pureIds.length} 个` : null, indexThresholds: cfg.indexThresholds };
  console.log(JSON.stringify(brief, null, 2));
  if (cfg.variant !== 'jscrambler-namespace-string-table') {
    console.error('未识别为该变体（可能是标准"大字符串函数 + 解码 IIFE"，走 solveStringArray 即可）');
    process.exit(1);
  }
  console.log(`配置写入 ${outPath}`);
}
