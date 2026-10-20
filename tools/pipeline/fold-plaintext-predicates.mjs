#!/usr/bin/env node
/**
 * fold-plaintext-predicates.mjs — 用频率启发折叠明文键的 opaque predicate。
 *
 * 处理 G6rp.W_Uh("plaintext") ? A : B 和 G6rp.T9Ey("plaintext") ? A : B
 * 
 * 启发规则（从高到低优先级）：
 *   1. 如果一个分支是 typeof 关键字（object/function/string/number/undefined/boolean），选它
 *   2. 如果一个分支的字符串在文件中出现更多次，选它（频率法）
 *   3. 如果一个分支是合理的数值（0, 1, void 0 等），另一个异常大或诡异，选合理的
 *   4. 无法判断的不处理，保留原样
 *
 * 用法：node fold-plaintext-predicates.mjs <input.js> [--out output.js] [--dry-run]
 */
import * as babel from '@babel/core';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
import fs from 'node:fs';

const traverse = _traverse.default ?? _traverse;
const generate = _generate.default ?? _generate;

// ════════════════════════════════════════════════════════════
// CLI
// ════════════════════════════════════════════════════════════
const args = process.argv.slice(2);
const inputFile = args.find(a => !a.startsWith('--'));
const outIdx = args.indexOf('--out');
const outputFile = outIdx >= 0 ? args[outIdx + 1] : inputFile;
const dryRun = args.includes('--dry-run');
const predNamesArg = args.find(a => a.startsWith('--preds='));
const predNames = predNamesArg ? predNamesArg.split('=')[1].split(',') : ['W_Uh', 'T9Ey'];

if (!inputFile) {
  console.error('用法: node fold-plaintext-predicates.mjs <input.js> [--out output.js] [--preds=W_Uh,T9Ey] [--dry-run]');
  process.exit(2);
}

// ════════════════════════════════════════════════════════════
// Parse & analyze
// ════════════════════════════════════════════════════════════
const code = fs.readFileSync(inputFile, 'utf8');
console.error(`解析 ${inputFile} (${(code.length/1024/1024).toFixed(1)} MB)...`);
const ast = babel.parseSync(code, { sourceType: 'script' });

// 1. Build string literal frequency map
const litCount = new Map();
traverse(ast, { noScope: true, StringLiteral(p) {
  litCount.set(p.node.value, (litCount.get(p.node.value) || 0) + 1);
}});

// 2. Known NS aliases (G6rp etc)
const nsAliases = new Set(['_global']);
traverse(ast, { noScope: true,
  AssignmentExpression(p) {
    if (p.node.operator === '=' && t.isIdentifier(p.node.left) && t.isIdentifier(p.node.right, { name: '_global' }))
      nsAliases.add(p.node.left.name);
  },
  VariableDeclarator(p) {
    if (t.isIdentifier(p.node.id) && t.isIdentifier(p.node.init, { name: '_global' }))
      nsAliases.add(p.node.id.name);
  },
});

const predNameSet = new Set(predNames);

function isPredCall(node) {
  return t.isCallExpression(node) &&
    t.isMemberExpression(node.callee) &&
    t.isIdentifier(node.callee.object) && nsAliases.has(node.callee.object.name) &&
    !node.callee.computed && predNameSet.has(node.callee.property?.name) &&
    node.arguments.length === 1 && t.isStringLiteral(node.arguments[0]);
}

// ════════════════════════════════════════════════════════════
// Heuristics
// ════════════════════════════════════════════════════════════
const TYPEOF_KEYWORDS = new Set(['object', 'function', 'string', 'number', 'undefined', 'boolean', 'symbol', 'bigint']);

function nodeToString(node) {
  if (t.isStringLiteral(node)) return node.value;
  if (t.isNumericLiteral(node)) return String(node.value);
  return null;
}

/**
 * Given a ternary pred ? consequent : alternate, determine which branch to keep.
 * Returns 'consequent', 'alternate', or null (can't determine).
 * parentPath is the ConditionalExpression's parent, used for context analysis.
 */
function chooseBranch(consequent, alternate, parentPath) {
  const cStr = nodeToString(consequent);
  const aStr = nodeToString(alternate);
  
  // Rule 0: void(pred ? N : M) → value is discarded, void always returns undefined
  if (parentPath && parentPath.isUnaryExpression({ operator: 'void' })) {
    return 'consequent';
  }
  
  // Rule 1: typeof keyword wins
  if (cStr !== null && aStr !== null) {
    const cIsType = TYPEOF_KEYWORDS.has(cStr);
    const aIsType = TYPEOF_KEYWORDS.has(aStr);
    if (cIsType && !aIsType) return 'consequent';
    if (aIsType && !cIsType) return 'alternate';
  }
  
  // Rule 2: frequency — string that appears more often elsewhere is more likely correct
  if (t.isStringLiteral(consequent) && t.isStringLiteral(alternate)) {
    const cCount = litCount.get(consequent.value) || 0;
    const aCount = litCount.get(alternate.value) || 0;
    // Require clear margin (at least 2x or +3 difference)
    if (cCount > aCount && (cCount >= aCount * 2 || cCount >= aCount + 3)) return 'consequent';
    if (aCount > cCount && (aCount >= cCount * 2 || aCount >= cCount + 3)) return 'alternate';
  }
  
  // Rule 3: numeric ternaries
  if (t.isNumericLiteral(consequent) && t.isNumericLiteral(alternate)) {
    const cv = consequent.value, av = alternate.value;
    
    // 3a. Same truthiness → either branch is fine (boolean coercion gives same result)
    // Both truthy (e.g., 4 vs 1, 64 vs 87) or both falsy (0 vs 0) → pick consequent
    if ((!!cv) === (!!av)) return 'consequent';
    
    // 3b. Common code constants vs uncommon
    const commonNums = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 16, 26, 32, 52, 62, 64, 123, 128, 255, 256]);
    const cCommon = commonNums.has(cv);
    const aCommon = commonNums.has(av);
    if (cCommon && !aCommon) return 'consequent';
    if (aCommon && !cCommon) return 'alternate';
  }
  
  // Rule 4: !(pred ? N : M) → if both branches have same truthiness, pick either
  if (parentPath && parentPath.isUnaryExpression({ operator: '!' })) {
    if (t.isNumericLiteral(consequent) && t.isNumericLiteral(alternate)) {
      if ((!!consequent.value) === (!!alternate.value)) return 'consequent';
    }
  }
  
  // Rule 5: long string (>30 chars) is likely Jscrambler junk
  if (t.isStringLiteral(consequent) && t.isStringLiteral(alternate)) {
    if (consequent.value.length > 30 && alternate.value.length <= 30) return 'alternate';
    if (alternate.value.length > 30 && consequent.value.length <= 30) return 'consequent';
  }
  
  // Rule 7: for string ties (both count=1), use secondary heuristics:
  //   - Jscrambler junk is often short random lowercase (4-8 chars) like "husa", "ijodipse"
  //   - Real strings contain underscores, CamelCase, dots, slashes, spaces, or are error messages
  if (t.isStringLiteral(consequent) && t.isStringLiteral(alternate)) {
    const cCount = litCount.get(consequent.value) || 0;
    const aCount = litCount.get(alternate.value) || 0;
    if (Math.abs(cCount - aCount) <= 2) {
      const isJunk = (s) => /^[a-z]{3,10}$/.test(s) && !TYPEOF_KEYWORDS.has(s);
      const isReal = (s) => /[_./\s]/.test(s) || /[A-Z].*[a-z]|[a-z].*[A-Z]/.test(s) || s.includes('expected') || s.includes('Error') || s.includes('require');
      const cJunk = isJunk(consequent.value), cReal = isReal(consequent.value);
      const aJunk = isJunk(alternate.value), aReal = isReal(alternate.value);
      if (cJunk && !aJunk) return 'alternate';
      if (aJunk && !cJunk) return 'consequent';
      if (cReal && !aReal) return 'consequent';
      if (aReal && !cReal) return 'alternate';
    }
  }
  
  return null; // can't determine
}

// ════════════════════════════════════════════════════════════
// Fold
// ════════════════════════════════════════════════════════════
let folded = 0, skipped = 0, checked = 0, plausible = 0;
const doubt = [];

traverse(ast, { noScope: true, ConditionalExpression: { exit(p) {
  const node = p.node;
  if (!isPredCall(node.test)) return;
  
  const choice = chooseBranch(node.consequent, node.alternate, p.parentPath);
  if (!choice) { skipped++; return; }
  
  const keep = choice === 'consequent' ? node.consequent : node.alternate;
  const drop = choice === 'consequent' ? node.alternate : node.consequent;
  
  // Plausibility check: does the kept string appear more in the file?
  const keepStr = nodeToString(keep);
  const dropStr = nodeToString(drop);
  if (keepStr !== null && dropStr !== null && (keepStr.length >= 3 || dropStr.length >= 3)) {
    checked++;
    const keepCount = litCount.get(keepStr) || 0;
    const dropCount = litCount.get(dropStr) || 0;
    if (keepCount >= dropCount) plausible++;
    else if (doubt.length < 10) doubt.push({
      key: node.test.arguments[0].value,
      keep: keepStr.substring(0, 30),
      drop: dropStr.substring(0, 30),
      keepCount, dropCount,
    });
  }
  
  p.replaceWith(keep);
  folded++;
}}});

// ════════════════════════════════════════════════════════════
// Output
// ════════════════════════════════════════════════════════════
console.error(`\n=== 明文谓词折叠报告 ===`);
console.error(`折叠: ${folded}`);
console.error(`跳过（无法判断）: ${skipped}`);
console.error(`可信度: ${plausible}/${checked} (${checked ? (plausible/checked*100).toFixed(1) : 0}%)`);
if (doubt.length) {
  console.error(`疑似误判:`);
  for (const d of doubt) {
    console.error(`  key="${d.key}" keep="${d.keep}"(${d.keepCount}) drop="${d.drop}"(${d.dropCount})`);
  }
}

if (!dryRun) {
  const output = generate(ast, { retainLines: true, compact: false }, code).code;
  fs.writeFileSync(outputFile, output);
  console.error(`写入: ${outputFile}`);
} else {
  console.error(`(dry-run 模式)`);
}
