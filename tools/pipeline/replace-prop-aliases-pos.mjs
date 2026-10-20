#!/usr/bin/env node
/**
 * replace-prop-aliases-pos.mjs — AST 属性别名替换（位置替换，保留原始格式）
 * 
 * 用 babel parse + traverse 找到 MemberExpression 属性位置，
 * 然后直接按字符位置替换源码，不用 babel generate（避免格式/语法差异）。
 */
import * as babel from '@babel/core';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';
import fs from 'fs';

const traverse = _traverse.default ?? _traverse;

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');

if (positional.length < 2) {
  console.error('用法: node replace-prop-aliases-pos.mjs <input.js> <aliases.json> [output.js] [--dry-run]');
  process.exit(2);
}

const [inputFile, aliasFile, outputFile = inputFile] = positional;
const aliasMap = JSON.parse(fs.readFileSync(aliasFile, 'utf8'));
console.log(`[aliases] 加载 ${Object.keys(aliasMap).length} 个别名`);

function isValidIdent(s) { return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s); }

console.log(`[parse] 读入 ${inputFile} ...`);
const code = fs.readFileSync(inputFile, 'utf8');
console.log(`[parse] ${code.length} 字符, AST 解析 ...`);
const ast = babel.parseSync(code, {
  sourceType: 'script',
  parserOpts: { allowReturnOutsideFunction: true, errorRecovery: true }
});

// 收集替换位置
const edits = []; // [start, end, replacement]
const stats = {};
let total = 0;

traverse(ast, {
  MemberExpression(path) {
    const { node } = path;
    let aliasKey = null;

    if (!node.computed && t.isIdentifier(node.property)) {
      aliasKey = node.property.name;
    } else if (node.computed && t.isStringLiteral(node.property)) {
      aliasKey = node.property.value;
    }

    if (!aliasKey || !Object.prototype.hasOwnProperty.call(aliasMap, aliasKey)) return;

    const real = aliasMap[aliasKey];
    const label = `${aliasKey} → ${real}`;
    stats[label] = (stats[label] || 0) + 1;
    total++;

    if (!node.computed && t.isIdentifier(node.property)) {
      // .alias → .real (just replace the identifier name)
      edits.push([node.property.start, node.property.end, real]);
    } else if (node.computed && t.isStringLiteral(node.property)) {
      if (isValidIdent(real)) {
        // ["alias"] → .real (replace from [ to ], including brackets)
        // Find the [ before the string and ] after
        // property.start points to the string literal (including quote)
        // But we need the [ bracket which is at node.property.start - 1
        // Actually for computed, the brackets are part of the MemberExpression
        // Use the computed access range: from the [ to the ]
        // The [ is right after the object, and ] is at the end
        const objEnd = node.object.end;
        const propEnd = node.end; // includes the ]
        edits.push([objEnd, propEnd, '.' + real]);
      } else {
        // ["alias"] → ["real"] (replace the string content)
        edits.push([node.property.start + 1, node.property.end - 1, real]);
      }
    }
  }
});

// 按位置倒序替换
edits.sort((a, b) => b[0] - a[0]);
let result = code;
for (const [start, end, rep] of edits) {
  result = result.slice(0, start) + rep + result.slice(end);
}

// 报告
console.log(`\n=== AST 属性别名替换报告 (位置替换) ===`);
const sorted = Object.entries(stats).sort((a, b) => b[1] - a[1]);
for (const [label, count] of sorted) {
  console.log(`  ${String(count).padStart(5)}  ${label}`);
}
console.log(`  ─────`);
console.log(`  ${String(total).padStart(5)}  总计 (${sorted.length} 个别名命中)`);

if (!dryRun) {
  fs.writeFileSync(outputFile, result);
  console.log(`\n写入 ${outputFile} (${result.length} 字符)`);
} else {
  console.log(`\n(dry-run)`);
}
