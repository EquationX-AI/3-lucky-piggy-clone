#!/usr/bin/env node
// 片段数组 + 拼接 折叠（Jscrambler「片段数组变体」专用，见 slot-replication skill 的变体清单）
//
// 背景：astarte2 3.6 的外壳（td109/td223/td300 同 sha）不是「编号→明文」字符串表，
// 而是 `var X=[arguments]; X[3]="C"; X[5]="O"; …` 然后 `y=X[3]; y+=X[5]; …` 拼出来的。
// CFF 展开后这些拼接变成顺序语句，本工具把能静态确定的部分折成字面量：
//
//   1) 片段数组的字面量槽：`X[3]="C"` → 把读取位置 `X[3]` 换成 "C"（赋值左侧不动）
//   2) 连续拼接：`y="a"; y+="b"; y+="c";` → `y="abc"`（只合并相邻语句、只处理字符串字面量）
//   3) 常量二元拼接：`"a"+"b"` → `"ab"`
//
// 用法：
//   node tools/rewrite/fold-array-fragments.mjs <输入.js> <输出.js>
// 输出里会打印统计；折叠后仍必须能解析（工具自己跑一次 parse 校验，失败就非零退出）。
import fs from 'node:fs';
import path from 'node:path';
import * as babel from '@babel/core';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';

const traverse = _traverse.default ?? _traverse;
const generate = _generate.default ?? _generate;

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error('用法: node fold-array-fragments.mjs <输入.js> <输出.js>');
  process.exit(2);
}

const code = fs.readFileSync(src, 'utf8');
const ast = babel.parseSync(code, { sourceType: 'script' });

const stats = { fragmentArrays: 0, literalSlots: 0, readsReplaced: 0, concatMerged: 0, binaryFolded: 0 };

// ---- 1) 收集片段数组：var X = [arguments] ----
const fragmentArrays = new Set();
traverse(ast, {
  VariableDeclarator(p) {
    const { id, init } = p.node;
    if (!t.isIdentifier(id) || !t.isArrayExpression(init)) return;
    if (init.elements.length === 1 && t.isIdentifier(init.elements[0], { name: 'arguments' })) {
      fragmentArrays.add(id.name);
    }
  },
});
stats.fragmentArrays = fragmentArrays.size;

// ---- 2) 收集字面量槽：X[3] = "C" ----
const slots = new Map(); // name -> Map(index -> value)
traverse(ast, {
  AssignmentExpression(p) {
    const { left, right, operator } = p.node;
    if (operator !== '=' || !t.isMemberExpression(left) || !t.isIdentifier(left.object) || left.computed === false) return;
    if (!fragmentArrays.has(left.object.name)) return;
    const idx = t.isNumericLiteral(left.property) ? left.property.value
      : t.isStringLiteral(left.property) ? Number(left.property.value) : null;
    if (idx == null || !Number.isFinite(idx)) return;
    if (!t.isStringLiteral(right)) return;
    if (!slots.has(left.object.name)) slots.set(left.object.name, new Map());
    slots.get(left.object.name).set(idx, right.value);
    stats.literalSlots++;
  },
});

// ---- 3) 替换读取位置 ----
traverse(ast, {
  MemberExpression(p) {
    const { object, property, computed } = p.node;
    if (!computed || !t.isIdentifier(object) || !fragmentArrays.has(object.name)) return;
    const idx = t.isNumericLiteral(property) ? property.value
      : t.isStringLiteral(property) ? Number(property.value) : null;
    if (idx == null || !Number.isFinite(idx)) return;
    const v = slots.get(object.name)?.get(idx);
    if (v === undefined) return;
    // 赋值左侧 / delete 目标不动
    const parent = p.parent;
    if (t.isAssignmentExpression(parent) && parent.left === p.node) return;
    if (t.isUpdateExpression(parent)) return;
    if (t.isUnaryExpression(parent, { operator: 'delete' })) return;
    p.replaceWith(t.stringLiteral(v));
    stats.readsReplaced++;
  },
});

// ---- 4) 折叠常量二元拼接 ----
const foldBinary = {
  BinaryExpression: {
    exit(p) {
      const { left, right, operator } = p.node;
      if (operator !== '+') return;
      if (t.isStringLiteral(left) && t.isStringLiteral(right)) {
        p.replaceWith(t.stringLiteral(left.value + right.value));
        stats.binaryFolded++;
      }
    },
  },
};
traverse(ast, foldBinary);

// ---- 5) 折叠相邻的字符串累积：x="a"; x+="b"; … ----
traverse(ast, {
  BlockStatement(p) {
    for (const stmtPath of p.get('body')) {
      // 找 `x = "..."` 的起点
      if (!stmtPath.isExpressionStatement()) continue;
      const assign = stmtPath.get('expression');
      if (!assign.isAssignmentExpression({ operator: '=' })) continue;
      const left = assign.get('left');
      const right = assign.get('right');
      if (!left.isIdentifier() || !right.isStringLiteral()) continue;
      const name = left.node.name;
      let acc = right.node.value;
      const group = [stmtPath];
      let i = p.node.body.indexOf(stmtPath.node);
      // 向后合并相邻的 `x += "..."`
      while (true) {
        const next = p.node.body[i + 1];
        if (!next || !t.isExpressionStatement(next)) break;
        const e = next.expression;
        if (!t.isAssignmentExpression(e, { operator: '+=' })) break;
        if (!t.isIdentifier(e.left, { name }) || !t.isStringLiteral(e.right)) break;
        acc += e.right.value;
        group.push(p.get('body')[i + 1]);
        i++;
      }
      if (group.length > 1) {
        assign.get('right').replaceWith(t.stringLiteral(acc));
        for (let k = 1; k < group.length; k++) group[k].remove();
        stats.concatMerged += group.length - 1;
      }
    }
  },
});

const out = generate(ast, { comments: false, compact: false }).code;
// 自检：产物必须能解析
babel.parseSync(out, { sourceType: 'script' });
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, out);

const leftConcat = (out.match(/\+=\s*["']/g) || []).length;
const leftArgs = (out.match(/=\s*\[arguments\]/g) || []).length;
console.log(JSON.stringify({
  src, dst, srcBytes: Buffer.byteLength(code), outBytes: Buffer.byteLength(out),
  ...stats, leftConcat, leftArgs,
}, null, 1));
