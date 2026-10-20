#!/usr/bin/env node
/**
 * replace-prop-aliases-ast.mjs — AST 级别的属性别名替换
 *
 * 只替换 MemberExpression 属性位置：
 *   obj.alias       → obj.realName          (computed=false, Identifier)
 *   obj["alias"]    → obj.realName 或 obj["realName"]  (computed=true, StringLiteral)
 *
 * 不动变量名、参数名、声明名、对象键名等其他位置。
 *
 * 用法:
 *   node replace-prop-aliases-ast.mjs <input.js> <aliases.json> <output.js> [--dry-run]
 *
 * aliases.json: { "混淆别名": "真实属性名", ... }
 */
import * as babel from '@babel/core';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';
import _generate from '@babel/generator';
import fs from 'fs';

const traverse = _traverse.default ?? _traverse;
const generate = _generate.default ?? _generate;

// CLI
const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');

if (positional.length < 2) {
  console.error('用法: node replace-prop-aliases-ast.mjs <input.js> <aliases.json> [output.js] [--dry-run]');
  process.exit(2);
}

const inputFile = positional[0];
const aliasFile = positional[1];
const outputFile = positional[2] || inputFile;

// 加载别名
const aliasMap = JSON.parse(fs.readFileSync(aliasFile, 'utf8'));
console.log(`[aliases] 加载 ${Object.keys(aliasMap).length} 个别名`);

// 判断是否是合法 JS 标识符
function isValidIdentifier(s) {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s);
}

// 解析
console.log(`[parse] 读入 ${inputFile} ...`);
const code = fs.readFileSync(inputFile, 'utf8');
console.log(`[parse] ${code.length} 字符, 开始 AST 解析 ...`);
const ast = babel.parseSync(code, {
  sourceType: 'script',
  plugins: [],
  // 允许宽松解析
  parserOpts: { allowReturnOutsideFunction: true, errorRecovery: true }
});
console.log(`[parse] AST 解析完成`);

// 遍历替换
const stats = {};
let total = 0;

traverse(ast, {
  MemberExpression(path) {
    const { node } = path;
    let aliasKey = null;

    if (!node.computed && t.isIdentifier(node.property)) {
      // obj.alias
      aliasKey = node.property.name;
    } else if (node.computed && t.isStringLiteral(node.property)) {
      // obj["alias"]
      aliasKey = node.property.value;
    }

    if (aliasKey && Object.prototype.hasOwnProperty.call(aliasMap, aliasKey)) {
      const real = aliasMap[aliasKey];
      const label = `${aliasKey} → ${real}`;
      stats[label] = (stats[label] || 0) + 1;
      total++;

      if (isValidIdentifier(real)) {
        // 替换为 obj.realName
        node.property = t.identifier(real);
        node.computed = false;
      } else {
        // 替换为 obj["realName"]
        node.property = t.stringLiteral(real);
        node.computed = true;
      }
    }
  }
});

// 报告
console.log(`\n=== AST 属性别名替换报告 ===`);
console.log(`输入: ${inputFile}`);
const sorted = Object.entries(stats).sort((a, b) => b[1] - a[1]);
for (const [label, count] of sorted) {
  console.log(`  ${String(count).padStart(5)}  ${label}`);
}
console.log(`  ─────`);
console.log(`  ${String(total).padStart(5)}  总计 (${sorted.length} 个别名命中)`);

if (!dryRun) {
  console.log(`\n[generate] 生成代码 ...`);
  const out = generate(ast, {
    retainLines: false,
    compact: false,
    jsescOption: { minimal: true },
  });
  fs.writeFileSync(outputFile, out.code);
  console.log(`[output] 写入 ${outputFile} (${out.code.length} 字符)`);
} else {
  console.log(`\n(dry-run 模式，不写文件)`);
}
