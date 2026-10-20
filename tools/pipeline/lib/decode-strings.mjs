// 步骤 2：字符串还原（参考 slot-replication/tools/rewrite/decode-reference.mjs 的做法）
//  - X.dec(N) / X["dec"](N)          → 字符串表 table[N]（解码函数名自动识别，或显式指定）
//  - X.pred()（已知恒真/恒假的零参判断）  → true / false
//  - 折叠：!true、if(true)、a ? b : c、"a" + "b"、V = "a"; V += "b";
//  - 只被赋值一次字符串的变量 → 内联为字面量
//  - obj["name"] → obj.name
// 产物只用于阅读，不保证能运行。
import _traverse from '@babel/traverse';
import * as t from '@babel/types';

const traverse = _traverse.default ?? _traverse;

const RESERVED = new Set(['default', 'class', 'new', 'delete', 'function', 'var', 'in', 'for', 'if', 'do', 'return',
  'let', 'const', 'typeof', 'void', 'this', 'null', 'true', 'false', 'while', 'switch', 'case', 'break', 'continue',
  'try', 'catch', 'finally', 'throw', 'instanceof', 'with', 'else', 'export', 'import', 'super', 'extends', 'yield',
  'enum', 'debugger', 'await', 'static', 'implements', 'interface', 'package', 'private', 'protected', 'public']);
export const isIdent = (s) => /^[A-Za-z_$][\w$]*$/.test(s) && !RESERVED.has(s);

export const propName = (m) => (!m.computed && t.isIdentifier(m.property)) ? m.property.name
  : (t.isStringLiteral(m.property) ? m.property.value : null);

// 统计 X.p(数字) 单参调用，出现次数够多的属性名就是解码函数
export function detectDecoders(ast, min = 100) {
  const cnt = new Map();
  traverse(ast, { noScope: true, CallExpression(p) {
    const c = p.node.callee;
    if (!t.isMemberExpression(c) || p.node.arguments.length !== 1 || !t.isNumericLiteral(p.node.arguments[0])) return;
    const n = propName(c); if (n) cnt.set(n, (cnt.get(n) || 0) + 1);
  } });
  const sorted = [...cnt].sort((a, b) => b[1] - a[1]);
  const top = sorted[0]?.[1] || 0;
  return sorted.filter(([, c]) => c >= min && c >= top * 0.2).map(([n]) => n);
}

// 表格式：数组（下标即编号）或 {编号: 字符串}
export function loadTable(json) {
  if (Array.isArray(json)) return (n) => json[n];
  if (json && typeof json === 'object') {
    const tbl = json.table && Array.isArray(json.table) ? json.table : json;
    return Array.isArray(tbl) ? (n) => tbl[n] : (n) => tbl[String(n)];
  }
  throw new Error('无法识别的字符串表格式');
}

// 谓词表：{名字: true|false|[true,...]}；其它值（采集失败的）忽略
export function loadPreds(json) {
  const out = new Map();
  for (const [k, v] of Object.entries(json || {})) {
    if (typeof v === 'boolean') out.set(k, v);
    else if (Array.isArray(v) && v.length && v.every((x) => x === v[0]) && typeof v[0] === 'boolean') out.set(k, v[0]);
  }
  return out;
}

function fold(ast, stats) {
  traverse(ast, {
    UnaryExpression: { exit(p) {
      const a = p.node.argument;
      if (p.node.operator === '!' && t.isBooleanLiteral(a)) { p.replaceWith(t.booleanLiteral(!a.value)); stats.folded++; }
      else if (p.node.operator === 'typeof' && (t.isStringLiteral(a) || t.isBooleanLiteral(a) || t.isNumericLiteral(a))) {
        p.replaceWith(t.stringLiteral(t.isStringLiteral(a) ? 'string' : t.isBooleanLiteral(a) ? 'boolean' : 'number')); stats.folded++;
      }
    } },
    BinaryExpression: { exit(p) {
      const { left: l, right: r, operator: op } = p.node;
      if (op === '+' && t.isStringLiteral(l) && t.isStringLiteral(r)) { p.replaceWith(t.stringLiteral(l.value + r.value)); stats.concat++; return; }
      // "a" + "b" + x 的左结合链：(x + "a") + "b" 不动；("a" + y) 不动
      if (['===', '!==', '==', '!='].includes(op) && t.isStringLiteral(l) && t.isStringLiteral(r)) {
        const eq = l.value === r.value; p.replaceWith(t.booleanLiteral(op.startsWith('!') ? !eq : eq)); stats.folded++;
      }
    } },
    LogicalExpression: { exit(p) {
      const l = p.node.left; if (!t.isBooleanLiteral(l)) return;
      const op = p.node.operator;
      if (op === '&&') p.replaceWith(l.value ? p.node.right : l);
      else if (op === '||') p.replaceWith(l.value ? l : p.node.right);
      else return;
      stats.folded++;
    } },
    IfStatement: { exit(p) {
      const tst = p.node.test; if (!t.isBooleanLiteral(tst)) return;
      const keep = tst.value ? p.node.consequent : p.node.alternate;
      if (!keep) p.remove();
      else if (t.isBlockStatement(keep) && (p.parentPath.isBlockStatement() || p.parentPath.isProgram())) {
        // 块里有 let/const/function 声明时保留块，避免作用域冲突
        if (keep.body.some((s) => t.isFunctionDeclaration(s) || (t.isVariableDeclaration(s) && s.kind !== 'var'))) p.replaceWith(keep);
        else p.replaceWithMultiple(keep.body);
      } else p.replaceWith(keep);
      stats.folded++;
    } },
    ConditionalExpression: { exit(p) {
      if (t.isBooleanLiteral(p.node.test)) { p.replaceWith(p.node.test.value ? p.node.consequent : p.node.alternate); stats.folded++; }
    } },
  });
}

// V = "a"; V += "b"; V += "c";  →  V = "abc";（只合并紧挨着的语句）
function mergeConcatRuns(ast, stats) {
  const asg = (s) => t.isExpressionStatement(s) && t.isAssignmentExpression(s.expression) && t.isIdentifier(s.expression.left)
    ? s.expression : null;
  traverse(ast, { noScope: true, 'BlockStatement|Program'(p) {
    const body = p.node.body; const out = [];
    for (const s of body) {
      const prev = out[out.length - 1];
      const a = asg(s), pa = prev && asg(prev);
      if (a && pa && a.operator === '+=' && t.isStringLiteral(a.right) && pa.left.name === a.left.name &&
          (pa.operator === '=' || pa.operator === '+=') && t.isStringLiteral(pa.right) && pa.right !== a.right) {
        pa.right = t.stringLiteral(pa.right.value + a.right.value); stats.concat++; continue;
      }
      out.push(s);
    }
    if (out.length !== body.length) p.node.body = out;
  } });
}

// 只被赋值一次字符串的变量 → 内联
function inlineStringAliases(ast, stats) {
  traverse.cache.clear();
  let changed = 0;
  traverse(ast, {
    Scope(p) {
      for (const [, b] of Object.entries(p.scope.bindings)) {
        if (b.kind === 'param' || b.kind === 'module') continue;
        let value = null, asgPath = null;
        const init = b.path.isVariableDeclarator() ? b.path.node.init : undefined;
        if (init && t.isStringLiteral(init) && b.constantViolations.length === 0) value = init.value;
        else if (!init && b.constantViolations.length === 1) {
          const v = b.constantViolations[0].node;
          if (t.isAssignmentExpression(v) && v.operator === '=' && t.isStringLiteral(v.right)) { value = v.right.value; asgPath = b.constantViolations[0]; }
        }
        if (value === null) continue;
        for (const r of b.referencePaths) {
          if (r.removed || !r.node) continue;
          r.replaceWith(t.stringLiteral(value)); changed++;
        }
        // 赋值本身已无人读：删掉 "V = 'x';" 语句和声明里的初值，让代码更短
        if (asgPath && asgPath.parentPath?.isExpressionStatement() && !asgPath.removed) { asgPath.parentPath.remove(); stats.deadAssign++; }
      }
    },
  });
  stats.inlined += changed;
  return changed;
}

function dotMembers(ast, stats) {
  traverse(ast, { noScope: true,
    MemberExpression(p) {
      if (p.node.computed && t.isStringLiteral(p.node.property) && isIdent(p.node.property.value)) {
        p.node.property = t.identifier(p.node.property.value); p.node.computed = false; stats.member++;
      }
    },
    'ObjectProperty|ObjectMethod|ClassMethod|ClassProperty'(p) {
      const k = p.node.key;
      if (t.isStringLiteral(k) && isIdent(k.value)) { p.node.key = t.identifier(k.value); p.node.computed = false; }
    },
  });
}

export function newStats() {
  return { decoders: [], decoded: 0, missed: 0, missIdx: {}, dynamicArg: 0, preds: 0, folded: 0, concat: 0, inlined: 0, deadAssign: 0, member: 0 };
}

// 2a. 解码调用 → 字面量
export function replaceDecoderCalls(ast, { table, decoders }, stats) {
  const dec = new Set(decoders && decoders.length ? decoders : detectDecoders(ast));
  stats.decoders = [...dec];
  traverse(ast, { noScope: true, CallExpression: { exit(p) {
    const c = p.node.callee;
    if (!t.isMemberExpression(c) || !dec.has(propName(c)) || p.node.arguments.length !== 1) return;
    const a = p.node.arguments[0];
    if (!t.isNumericLiteral(a)) { stats.dynamicArg++; return; }
    const v = table(a.value);
    if (typeof v === 'string') { p.replaceWith(t.stringLiteral(v)); stats.decoded++; }
    else { stats.missed++; stats.missIdx[a.value] = (stats.missIdx[a.value] || 0) + 1; }
  } } });
  return dec;
}

// 2b. 已知恒真/恒假的零参判断 X.pred() / X["pred"]()
export function replacePreds(ast, preds, stats) {
  if (!preds || !preds.size) return;
  traverse(ast, { noScope: true, CallExpression: { exit(p) {
    const c = p.node.callee;
    if (p.node.arguments.length === 0 && t.isMemberExpression(c)) {
      const n = propName(c);
      if (n && preds.has(n)) { p.replaceWith(t.booleanLiteral(preds.get(n))); stats.preds++; }
    }
  } } });
}

// 2c. 折叠、拼接合并、别名内联、点号访问
export function simplify(ast, stats) {
  fold(ast, stats);
  for (let round = 0; round < 6; round++) {
    mergeConcatRuns(ast, stats);
    fold(ast, stats);
    if (!inlineStringAliases(ast, stats)) break;
    fold(ast, stats);
  }
  dotMembers(ast, stats);
  fold(ast, stats);
}

export { fold };
