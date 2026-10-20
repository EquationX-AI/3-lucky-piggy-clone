#!/usr/bin/env node
/**
 * replace-prop-aliases.mjs — 替换 Jscrambler 属性别名（prototype patching 产生的）。
 *
 * Jscrambler 在运行时通过 Object.defineProperty / prototype assignment 把标准方法名
 * 别名为字符串表里的随机名。CFF 还原后这些别名以字面量形式留在代码里，需要替换回真实名。
 *
 * 替换类型：
 *   1. 点号访问：.SSS_THOR(...)  →  .push(...)
 *   2. 括号访问：["da-DK"]      →  .length 或 ["length"]
 *   3. typeof 类型名：typeof x === "senugwabm"  →  typeof x === "number"
 *   4. 字符串字面量：在特定上下文中出现的别名字符串 → 真实名
 *
 * 用法：node replace-prop-aliases.mjs <input.js> [--out output.js] [--aliases map.json] [--dry-run]
 *
 * --aliases <path>  外部别名 JSON（{ "alias": "realName", ... }），
 *                   全部作为 dot-alias（.ALIAS → .REAL）添加到内置表之上。
 */
import fs from 'node:fs';

// ═══════════════════════════════════════════════════════════════
// 别名映射表
// ═══════════════════════════════════════════════════════════════

// --- 1. 点号访问的方法/属性别名 (obj.ALIAS → obj.REAL) ---
const DOT_ALIASES = {
  // Array/Object 原型方法
  'SSS_THOR': 'push',
  'Log': 'pop',
  'Platform': 'shift',
  'SPIN_REQ': 'stop',
  'bet_value': 'forEach',
  'SOUND_ON': 'filter',
  'ANDROID': 'map',
  'ce8e': 'finish',

  // regeneratorRuntime 状态机属性
  'PH_IPHONE_15_128G': 'next',
  'm_featureLogos': 'prev',
  'COMMON_TURNING': 'abrupt',
  'updateTextLength': 'wrap',

  // hasOwnProperty
  'FEATURES': 'hasOwnProperty',

  // protobuf Writer/Reader 类型方法
  'm_isLockNumControl': 'uint32',
  'SetDefaultOnCommandFunc': 'fork',
  'spinCoinError': 'string',
  'FREESPIN_BONUSNEED_REWARD': 'int64',
  'TOKEN': 'float',
};

// --- 2. 括号访问的属性别名 (obj["ALIAS"] → obj.REAL 或 obj["REAL"]) ---
const BRACKET_ALIASES = {
  'da-DK': { real: 'length', dot: true },   // ["da-DK"] → .length
  '.debris2proto.SingleOutput.Falls: array expected': { real: 'prototype', dot: true },
  '.debris2proto.SingleOutput.GameGroupList: array expected': { real: '_RF', dot: true },
  '5d23': { real: 'random', dot: true },
  '566c': { real: 'close', dot: true },
  ',k,value': { real: 'toString', dot: true },
  'U.S. Virgin Islands': { real: 'encode', dot: true },
  'com.lnw.gcm.setGameConfig': { real: 'pow', dot: true },
  'Falls.': { real: 'string', dot: true },   // protobuf Writer.string (bracket due to dot in name)
};

// --- 3. regenerator 参数字符串别名 ---
const REGEN_STRING_ALIASES = {
  'Line_Right': 'return',
  'RenderTexture': 'throw',
  'ScrollToBtnSeatSync': 'break',
};

// --- 4. typeof 类型名别名 ("ALIAS" in typeof context → "REAL") ---
const TYPEOF_ALIASES = {
  'senugwabm': 'number',
  'DF2EXC': 'undefined',
  'spinCoinError': 'string',
  'Zimbabwe': 'boolean',
  '{PH}': 'object',
  'MHBIconTemplate': 'function',
};

// ═══════════════════════════════════════════════════════════════
// 替换逻辑
// ═══════════════════════════════════════════════════════════════

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function run(inputFile, outputFile, dryRun) {
  let code = fs.readFileSync(inputFile, 'utf8');
  const stats = {};
  let totalChanges = 0;

  function replace(category, pattern, replacement) {
    const re = typeof pattern === 'string' ? new RegExp(escapeRegex(pattern), 'g') : pattern;
    const before = code;
    code = code.replace(re, replacement);
    const count = (before.length - code.length + replacement.length * (code.split(replacement).length - 1));
    // Count actual replacements
    const matches = before.match(re);
    const n = matches ? matches.length : 0;
    if (n > 0) {
      stats[category] = (stats[category] || 0) + n;
      totalChanges += n;
    }
    return n;
  }

  // 1. typeof 类型名替换（先做，避免与其他替换冲突）
  //    typeof X === "ALIAS" → typeof X === "REAL"
  //    "ALIAS" === typeof X → "REAL" === typeof X
  for (const [alias, real] of Object.entries(TYPEOF_ALIASES)) {
    const escaped = escapeRegex(alias);
    // 正向: typeof VAR OP "ALIAS"
    const re1 = new RegExp(`(typeof\\s+[\\w$.]+\\s*[!=]==?\\s*)"${escaped}"`, 'g');
    replace(`typeof:${alias}→${real}`, re1, `$1"${real}"`);
    // 反向: "ALIAS" OP typeof VAR
    const re2 = new RegExp(`"${escaped}"(\\s*[!=]==?\\s*typeof\\s+)`, 'g');
    replace(`typeof:${alias}→${real}`, re2, `"${real}"$1`);
  }

  // 2. 括号访问替换: ["ALIAS"] → .REAL 或 ["REAL"]
  for (const [alias, { real, dot }] of Object.entries(BRACKET_ALIASES)) {
    const escaped = escapeRegex(alias);
    const target = dot ? `.${real}` : `["${real}"]`;
    const re = new RegExp(`\\["${escaped}"\\]`, 'g');
    replace(`bracket:["${alias.substring(0, 30)}"]→${target}`, re, target);
  }

  // 3. 点号访问替换: .ALIAS → .REAL
  //    注意：只替换属性访问上下文，不替换字符串字面量中的出现
  for (const [alias, real] of Object.entries(DOT_ALIASES)) {
    const escaped = escapeRegex(alias);
    // .ALIAS 后面跟 ( [ . , ; ) } = ! < > ? : \n 空格 等
    const re = new RegExp(`\\.${escaped}\\b`, 'g');
    replace(`dot:.${alias}→.${real}`, re, `.${real}`);
  }

  // 4. typeof 别名的字符串字面量残留（opaque predicate 包裹的 typeof、protobuf 类型注册表等）
  //    全局替换 "ALIAS" → "REAL"，因为这些别名字符串是唯一的，不会误伤
  for (const [alias, real] of Object.entries(TYPEOF_ALIASES)) {
    const escaped = escapeRegex(alias);
    const re = new RegExp(`"${escaped}"`, 'g');
    replace(`strlit:"${alias}"→"${real}"`, re, `"${real}"`);
  }

  // 5. regenerator 参数字符串别名（abrupt 的第一个参数等）
  for (const [alias, real] of Object.entries(REGEN_STRING_ALIASES)) {
    const escaped = escapeRegex(alias);
    // 只在 .abrupt("ALIAS" 上下文中替换，确保安全
    const re = new RegExp(`(\\.abrupt\\s*\\()("${escaped}")`, 'g');
    replace(`regen:abrupt("${alias}")→abrupt("${real}")`, re, `$1"${real}"`);
  }

  // 报告
  console.log(`\n=== 属性别名替换报告 ===`);
  console.log(`输入: ${inputFile}`);
  const categories = Object.entries(stats).sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of categories) {
    console.log(`  ${count.toString().padStart(5)}  ${cat}`);
  }
  console.log(`  ─────`);
  console.log(`  ${totalChanges.toString().padStart(5)}  总计`);

  if (!dryRun) {
    fs.writeFileSync(outputFile, code);
    console.log(`\n写入: ${outputFile}`);
  } else {
    console.log(`\n(dry-run 模式，不写文件)`);
  }

  return { stats, totalChanges };
}

// ═══════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const inputFile = positional[0];
const outputFile = args.includes('--out') ? args[args.indexOf('--out') + 1] : (positional[1] || inputFile);
const aliasesFile = args.includes('--aliases') ? args[args.indexOf('--aliases') + 1] : null;
const dryRun = args.includes('--dry-run');

if (!inputFile) {
  console.error('用法: node replace-prop-aliases.mjs <input.js> [output.js] [--out output.js] [--aliases map.json] [--dry-run]');
  process.exit(2);
}

// 外部别名 JSON 合入内置 DOT_ALIASES
if (aliasesFile) {
  const ext = JSON.parse(fs.readFileSync(aliasesFile, 'utf8'));
  let added = 0;
  for (const [alias, real] of Object.entries(ext)) {
    if (!DOT_ALIASES[alias]) {
      DOT_ALIASES[alias] = real;
      added++;
    }
  }
  console.log(`[aliases] 从 ${aliasesFile} 加载 ${Object.keys(ext).length} 个，新增 ${added} 个到 DOT_ALIASES`);
}

run(inputFile, outputFile, dryRun);
