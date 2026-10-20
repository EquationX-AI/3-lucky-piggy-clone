#!/usr/bin/env node
// 把反混淆参考代码里的加密字符串还原成明文，便于阅读重写。
// 用法：node ../../tools/rewrite/decode-reference.mjs <in.deob.js> <strings.json> <pred-values.json> <out.js> [nsAlias...]
//  - X.d_1(n) / X.С_w(n)          → 字符串表 strings[n]
//  - X["C0o"]()（恒真/恒假判断）    → true / false，并折叠 if / 三元 / !
//  - 只被赋值一次字符串的变量别名     → 内联为字面量；obj["name"] → obj.name
// 结果只用于阅读，不保证能运行。
import fs from 'node:fs';
import { createRequire } from 'node:module';
// babel 用仓库里修复版反混淆工具自带的依赖
const require = createRequire(new URL('../jscrambler-deobfuscator-fixed/package.json', import.meta.url));
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const [inFile, strFile, predFile, outFile] = process.argv.slice(2);
const strings = JSON.parse(fs.readFileSync(strFile, 'utf8'));
const preds = JSON.parse(fs.readFileSync(predFile, 'utf8'));
const DECODERS = new Set((process.env.DECODERS || 'd_1,С_w').split(','));
// 外壳的字符串表在运行时导出时整体平移了（解码器状态推进），用 OFFSET 校正：真实值 = strings[n + OFFSET]
const OFFSET = Number(process.env.OFFSET || 0);
const isIdent = (s) => /^[A-Za-z_$][\w$]*$/.test(s) && !['default', 'class', 'new', 'delete', 'function', 'var', 'in', 'for', 'if', 'do', 'return'].includes(s);

const ast = parser.parse(fs.readFileSync(inFile, 'utf8'), { sourceType: 'script', errorRecovery: true });
const stats = { decoded: 0, preds: 0, folded: 0, inlined: 0, member: 0 };

const propName = (m) => !m.computed && t.isIdentifier(m.property) ? m.property.name
  : (t.isStringLiteral(m.property) ? m.property.value : null);

// 1) 解码调用
traverse(ast, {
  CallExpression(p) {
    const c = p.node.callee;
    if (t.isMemberExpression(c) && DECODERS.has(propName(c)) && p.node.arguments.length === 1 &&
        t.isNumericLiteral(p.node.arguments[0])) {
      const v = strings[p.node.arguments[0].value + OFFSET];
      if (typeof v === 'string') { p.replaceWith(t.stringLiteral(v)); stats.decoded++; }
    }
  },
});
// 2) 恒定判断 X["C0o"]()
traverse(ast, {
  CallExpression(p) {
    const c = p.node.callee;
    if (p.node.arguments.length === 0 && t.isMemberExpression(c)) {
      const n = propName(c);
      if (n && Object.prototype.hasOwnProperty.call(preds, n) && Array.isArray(preds[n])) {
        p.replaceWith(t.booleanLiteral(!!preds[n][0])); stats.preds++;
      }
    }
  },
});
// 3) 折叠
function fold(ast) {
  traverse(ast, {
    UnaryExpression: { exit(p) { if (p.node.operator === '!' && t.isBooleanLiteral(p.node.argument)) { p.replaceWith(t.booleanLiteral(!p.node.argument.value)); stats.folded++; } } },
    IfStatement: { exit(p) {
      const tst = p.node.test; if (!t.isBooleanLiteral(tst)) return;
      const keep = tst.value ? p.node.consequent : p.node.alternate;
      if (!keep) p.remove();
      else if (t.isBlockStatement(keep)) p.replaceWithMultiple(keep.body);
      else p.replaceWith(keep);
      stats.folded++;
    } },
    ConditionalExpression: { exit(p) { if (t.isBooleanLiteral(p.node.test)) { p.replaceWith(p.node.test.value ? p.node.consequent : p.node.alternate); stats.folded++; } } },
  });
}
fold(ast);
// 4) 内联只赋值一次字符串的别名（多轮，直到稳定）
for (let round = 0; round < 4; round++) {
  let changed = 0;
  traverse(ast, {
    Scope(p) {
      for (const [name, b] of Object.entries(p.scope.bindings)) {
        if (b.kind === 'param' || b.kind === 'module') continue;
        let value = null;
        const init = b.path.isVariableDeclarator() ? b.path.node.init : undefined;
        if (init && t.isStringLiteral(init) && b.constantViolations.length === 0) value = init.value;
        else if (!init && b.constantViolations.length === 1) {
          const v = b.constantViolations[0].node;
          if (t.isAssignmentExpression(v) && v.operator === '=' && t.isStringLiteral(v.right)) value = v.right.value;
        }
        if (value === null) continue;
        for (const r of b.referencePaths) {
          if (r.removed) continue;
          r.replaceWith(t.stringLiteral(value)); changed++;
        }
      }
    },
  });
  stats.inlined += changed;
  if (!changed) break;
}
// 5) obj["name"] → obj.name
traverse(ast, {
  MemberExpression(p) {
    if (p.node.computed && t.isStringLiteral(p.node.property) && isIdent(p.node.property.value)) {
      p.node.property = t.identifier(p.node.property.value); p.node.computed = false; stats.member++;
    }
  },
  ObjectProperty(p) {
    if (p.node.computed && t.isStringLiteral(p.node.key) && isIdent(p.node.key.value)) {
      p.node.key = t.identifier(p.node.key.value); p.node.computed = false;
    }
  },
});
fold(ast);
fs.writeFileSync(outFile, generate(ast, { comments: false, jsescOption: { minimal: true } }).code);
console.log(JSON.stringify(stats));
