#!/usr/bin/env node
// 展开「入口态是运行时算出来的」CFF 状态机，并把拼接出来的字符串折叠回字面量。
//
// 背景（td109 外壳 other/bundle）：Jscrambler CFF 的常规展开器遇到
//   for (; X5ul !== 235;) { switch (X5ul) { case 312: …; X5ul = 340; break; … } }
// 时会跳过，因为循环前置是 `X5ul = z201` 而 `z201 = M0W7(-193,"o",44,24)`——入口态由运行时函数算出。
// 但这些 case 之间是**确定的线性链**：每个 case 末尾只有一句 `S = <数字>; break;`。
// 于是入口态可以纯结构化推出：在「case → 后继」图里找那个**从不作为后继出现**的 case，
// 且从它出发的走法要一次覆盖全部 case、不重复、最后走到没有后继的 case（或 return/throw）。
// 唯一解才动手，多个候选/有环/覆盖不全一律跳过并报告——不猜。
//
// 展开完再折叠字符串：
//   1) 单赋值字符串常量传播（var v; v = "x"; 全函数只有这一处赋值 → 读 v 换成 "x"）
//   2) 连续 `X = "a"; X += "b"; X += "c";` 合并成 `X = "abc";`
//
// 用法: node unflatten-opaque-entry.mjs <输入.js> [--out <输出.js>] [--report <report.json>]
//       不加 --out 时只报告、不改文件（先看 --report 再决定）
import fs from 'fs';
import * as babel from '@babel/core';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';

const traverse = _traverse.default ?? _traverse;
const generate = _generate.default ?? _generate;

// ---------- 状态机识别 ----------
const isNum = (n) => t.isNumericLiteral(n);

function matchLoop(path) {
  if (!path.isForStatement()) return null;
  const { test, body, init } = path.node;
  if (init) return null;                                   // for (;;) 只认空 init
  if (!t.isBinaryExpression(test, { operator: '!==' })) return null;
  const { left, right } = test;
  if (!t.isIdentifier(left) || !isNum(right)) return null;
  const S = left.name, TERM = right.value;
  if (!t.isBlockStatement(body) || body.body.length !== 1) return null;
  const sw = body.body[0];
  if (!t.isSwitchStatement(sw) || !t.isIdentifier(sw.discriminant, { name: S })) return null;
  return { S, TERM, sw };
}

// 从 case 体尾部取转移：`S = <num>;` / `S = <num>; break;` / 直接 return|throw
function tailOf(consequent, S, TERM) {
  const stmts = consequent.slice();
  // 去掉尾部 break
  while (stmts.length && t.isBreakStatement(stmts[stmts.length - 1])) stmts.pop();
  const last = stmts[stmts.length - 1];
  if (!last) return { kind: 'empty', body: stmts };
  if (t.isReturnStatement(last) || t.isThrowStatement(last)) return { kind: 'exit', body: stmts };
  if (t.isExpressionStatement(last) && t.isAssignmentExpression(last.expression, { operator: '=' })) {
    const a = last.expression;
    if (t.isIdentifier(a.left, { name: S }) && isNum(a.right)) {
      if (a.right.value === TERM) return { kind: 'exit', body: stmts.slice(0, -1) };
      return { kind: 'goto', next: a.right.value, body: stmts.slice(0, -1) };
    }
  }
  return { kind: 'other', body: stmts };
}

function planFrames(sw, S, TERM) {
  const cases = new Map();  // state -> {body, next|null, kind}
  let hasDefault = false;
  for (const c of sw.cases) {
    if (!c.test) { hasDefault = true; continue; }
    if (!isNum(c.test)) return { ok: false, why: 'case 不是数字字面量' };
    const tail = tailOf(c.consequent, S, TERM);
    if (tail.kind === 'other' || tail.kind === 'empty') return { ok: false, why: `case ${c.test.value} 的转移不是 S = 数字 / return / throw` };
    cases.set(c.test.value, { body: tail.body, next: tail.kind === 'goto' ? tail.next : null, kind: tail.kind });
  }
  if (hasDefault) return { ok: false, why: '有 default 分支' };
  if (cases.size < 1) return { ok: false, why: 'case 少于 1 个' };

  const successors = new Set([...cases.values()].map((v) => v.next).filter((v) => v !== null));
  const entries = [...cases.keys()].filter((k) => !successors.has(k));
  const complete = [];
  for (const e of entries) {
    const seen = new Set();
    let cur = e, cycle = false;
    while (cur !== null) {
      if (seen.has(cur)) { cycle = true; break; }
      seen.add(cur);
      if (!cases.has(cur)) break;
      cur = cases.get(cur).next;
    }
    if (!cycle && seen.size === cases.size) complete.push({ entry: e, order: [...seen] });
  }
  if (complete.length !== 1) return { ok: false, why: `入口候选 ${complete.length} 个（需唯一）：entries=${entries.join(',')}` };
  return { ok: true, entry: complete[0].entry, order: complete[0].order, cases };
}

// ---------- 变换 ----------
function expandOnce(ast, stats) {
  let changed = 0;
  traverse(ast, {
    ForStatement(path) {
      const m = matchLoop(path);
      if (!m) return;
      if (path.parentPath.isLabeledStatement()) { stats.skip.labeled++; return; }
      const plan = planFrames(m.sw, m.S, m.TERM);
      if (!plan.ok) { stats.skip[plan.why] = (stats.skip[plan.why] || 0) + 1; return; }
      const out = [];
      for (const st of plan.order) {
        const c = plan.cases.get(st);
        out.push(...c.body);
      }
      path.replaceWith(t.blockStatement(out));
      changed++; stats.expanded++;
      path.skip();
    },
  });
  return changed;
}

function constPropPass(ast, stats) {
  // 两遍线性扫描（早期版本用嵌套 traverse，6.8MB 文件下退化成平方复杂度，跑十几分钟没结果）：
  // pass1 按「最近的外层函数」统计每个名字的赋值次数与值；pass2 只替换同一函数内、赋值之后的读。
  const info = new Map();   // functionNode|ast -> Map<name, {count, start, value}>
  const keyOf = (p) => { const fn = p.getFunctionParent(); return fn ? fn.node : ast; };
  traverse(ast, {
    AssignmentExpression(p) {
      if (p.node.operator !== '=') return;
      const l = p.node.left;
      if (!t.isIdentifier(l)) return;
      const key = keyOf(p);
      let m = info.get(key);
      if (!m) { m = new Map(); info.set(key, m); }
      const e = m.get(l.name) || { count: 0, start: 0, value: null };
      e.count++;
      e.start = p.node.start ?? 0;
      e.value = t.isStringLiteral(p.node.right) ? p.node.right.value : null;
      m.set(l.name, e);
    },
  });
  let changed = 0;
  traverse(ast, {
    Identifier(p) {
      if (!p.isReferencedIdentifier()) return;
      const m = info.get(keyOf(p));
      if (!m) return;
      const e = m.get(p.node.name);
      if (!e || e.count !== 1 || e.value === null || e.value === '') return;
      if ((p.node.start ?? 0) <= e.start) return;
      p.replaceWith(t.stringLiteral(e.value));
      changed++;
    },
  });
  if (changed) stats.constProp++;
  return changed;
}

function mergeConcatPass(ast, stats) {
  let changed = 0;
  traverse(ast, {
    BlockStatement(path) {
      const stmts = path.get('body');
      for (let i = 0; i < stmts.length; i++) {
        const st = stmts[i];
        if (!st.isExpressionStatement()) continue;
        const e = st.node.expression;
        if (!t.isAssignmentExpression(e, { operator: '=' })) continue;
        if (!t.isIdentifier(e.left) || !t.isStringLiteral(e.right)) continue;
        const name = e.left.name;
        let acc = e.right.value;
        const absorbed = [];
        for (let j = i + 1; j < stmts.length; j++) {
          const nx = stmts[j];
          if (!nx.isExpressionStatement()) break;
          const ne = nx.node.expression;
          if (!t.isAssignmentExpression(ne, { operator: '+=' })) break;
          if (!t.isIdentifier(ne.left, { name })) break;
          if (!t.isStringLiteral(ne.right)) break;
          acc += ne.right.value; absorbed.push(nx);
        }
        if (!absorbed.length) continue;
        e.right = t.stringLiteral(acc);
        for (const a of absorbed) a.remove();
        changed++; stats.concatRuns++;
        i += 0;
      }
    },
  });
  return changed;
}

function countLoops(ast) {
  let n = 0;
  traverse(ast, { ForStatement(p) { if (matchLoop(p)) n++; } });
  return n;
}

// ---------- 主流程 ----------
function parseArgs(argv) {
  const o = { input: null, out: null, report: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a === '--report') o.report = argv[++i];
    else if (!o.input) o.input = a;
    else throw new Error('多余参数: ' + a);
  }
  if (!o.input) { console.error('用法: node unflatten-opaque-entry.mjs <输入.js> [--out <输出.js>] [--report <r.json>]'); process.exit(2); }
  return o;
}

const o = parseArgs(process.argv.slice(2));
const code = fs.readFileSync(o.input, 'utf8');
const ast = babel.parseSync(code, { sourceType: 'script' });

const stats = { file: o.input, expanded: 0, constProp: 0, concatRuns: 0, skip: {}, loopsBefore: 0, loopsAfter: 0 };
stats.loopsBefore = countLoops(ast);
let rounds = 0;
while (rounds++ < 20) {
  const a = expandOnce(ast, stats);
  const b = constPropPass(ast, stats);
  const c = mergeConcatPass(ast, stats);
  if (!a && !b && !c) break;
}
stats.rounds = rounds;
stats.loopsAfter = countLoops(ast);

const outCode = o.out ? generate(ast, { comments: false, compact: false, jsescOption: { minimal: true } }).code : null;
if (o.out) fs.writeFileSync(o.out, outCode);
if (o.report) fs.writeFileSync(o.report, JSON.stringify(stats, null, 1) + '\n');
console.log(JSON.stringify(stats, null, 1));
