// 步骤 3：剥离 Jscrambler 保护代码。前提：字符串、完整性常量、不透明谓词都已静态求值，
// 业务代码不再需要运行时的返回值，所以运行时（字符串解码器、自检、MurmurHash、域名锁、通知上报）可以整段删除。
//  1) 顶层语句分成"运行时"和"业务"：给 _global 挂东西的、只用到内置对象/运行时自身变量的 → 运行时；
//     用到外部全局（System 之类）的 → 业务种子；业务引用到的顶层声明一并算业务（闭包）。
//  2) 删运行时语句；业务里还引用 _global 的属性记为"残留"（不删对应定义，原样保留并在报告里列出）。
//  3) 业务内部：删没人调用、只转调运行时的代码锁辅助函数（function M$J(a,b,c,d){ return _global.B7A(...) + a }），
//     删没人用的 var 声明和只剩 X = _global 的别名。
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
import { propName } from './decode-strings.mjs';

const traverse = _traverse.default ?? _traverse;
const generate = _generate.default ?? _generate;

const BROWSER_GLOBALS = ['window', 'self', 'top', 'parent', 'document', 'navigator', 'location', 'screen', 'history', 'localStorage',
  'sessionStorage', 'XMLHttpRequest', 'fetch', 'Image', 'HTMLElement', 'Element', 'Node', 'Event', 'MutationObserver', 'requestAnimationFrame',
  'cancelAnimationFrame', 'alert', 'performance', 'Blob', 'Worker', 'require', 'module', 'exports', 'process', 'global', 'globalThis', 'undefined',
  'arguments', 'Buffer', 'setImmediate'];
const BUILTINS = new Set([...Object.getOwnPropertyNames(globalThis), ...BROWSER_GLOBALS]);

function rootObject(node) {
  while (t.isMemberExpression(node)) node = node.object;
  return node;
}

// 一个顶层语句里引用到的自由标识符（不在语句内部声明的）
function freeIdentifiers(stPath) {
  const out = new Set();
  const visit = (p) => {
    const n = p.node.name;
    if (!p.isReferencedIdentifier()) return;
    const b = p.scope.getBinding(n);
    if (!b || b.scope.path.isProgram()) out.add(n);
  };
  if (stPath.isIdentifier()) visit(stPath);
  stPath.traverse({ Identifier: visit });
  return out;
}

function topLevelDeclaredNames(st) {
  if (t.isFunctionDeclaration(st) && st.id) return [st.id.name];
  if (t.isVariableDeclaration(st)) return st.declarations.flatMap((d) => Object.keys(t.getBindingIdentifiers(d.id)));
  if (t.isClassDeclaration(st) && st.id) return [st.id.name];
  return [];
}

export function stripProtection(ast, { nsName } = {}) {
  traverse.cache.clear();
  const stats = { runtimeStatements: 0, runtimeBytes: 0, businessStatements: 0, residue: {}, keptForResidue: 0, deadHelpers: 0, deadVars: 0, aliasesRemoved: 0 };
  let progPath = null;
  traverse(ast, { Program(p) { progPath = p; p.stop(); } });
  const body = progPath.get('body');
  const declOf = new Map(); // 顶层名字 → 语句下标
  body.forEach((s, i) => topLevelDeclaredNames(s.node).forEach((n) => declOf.set(n, i)));
  const free = body.map((s) => freeIdentifiers(s));

  const kind = body.map((s, i) => {
    const n = s.node;
    if (t.isVariableDeclaration(n) && n.declarations.some((d) => t.isIdentifier(d.id, { name: '_global' }))) return 'global-decl';
    if (t.isExpressionStatement(n) && t.isAssignmentExpression(n.expression) && t.isIdentifier(rootObject(n.expression.left), { name: '_global' })) return 'runtime';
    if (t.isFunctionDeclaration(n) && nsName && n.id?.name === nsName) return 'runtime';
    if (t.isFunctionDeclaration(n)) return 'undecided';
    const external = [...free[i]].filter((x) => x !== '_global' && !BUILTINS.has(x) && !declOf.has(x));
    return external.length ? 'business' : 'undecided';
  });
  // 业务闭包
  const isBiz = kind.map((k) => k === 'business');
  let grew = true;
  while (grew) {
    grew = false;
    body.forEach((s, i) => {
      if (!isBiz[i]) return;
      for (const x of free[i]) {
        const j = declOf.get(x);
        if (j !== undefined && !isBiz[j] && kind[j] !== 'global-decl') { isBiz[j] = true; grew = true; }
      }
    });
  }
  stats.businessStatements = isBiz.filter(Boolean).length;

  // 先在业务里清理代码锁辅助函数、转发别名，再统计残留
  cleanupBusiness(progPath, body.filter((_, i) => isBiz[i]), stats);

  // 残留：业务里仍引用的 _global 属性
  const residueProps = new Set();
  let usesGlobal = false;
  body.forEach((s, i) => {
    if (!isBiz[i] || s.removed) return;
    s.traverse({ Identifier(p) {
      if (p.node.name !== '_global' || !p.isReferencedIdentifier()) return;
      usesGlobal = true;
      const par = p.parentPath;
      if (par.isMemberExpression() && par.node.object === p.node) {
        const k = propName(par.node) ?? (t.isNumericLiteral(par.node.property) ? String(par.node.property.value) : generate(par.node.property).code);
        residueProps.add(k);
        stats.residue[k] = (stats.residue[k] || 0) + 1;
      } else stats.residue['(_global 本身)'] = (stats.residue['(_global 本身)'] || 0) + 1;
    } });
  });

  // 删除运行时语句；残留属性的定义语句保留
  const definesResidue = (n) => t.isExpressionStatement(n) && t.isAssignmentExpression(n.expression) && t.isMemberExpression(n.expression.left) &&
    t.isIdentifier(n.expression.left.object, { name: '_global' }) && residueProps.has(propName(n.expression.left) ?? String(n.expression.left.property?.value));
  body.forEach((s, i) => {
    if (isBiz[i] || s.removed) return;
    if (kind[i] === 'global-decl') { if (usesGlobal) return; }
    else if (residueProps.size && definesResidue(s.node)) { stats.keptForResidue++; return; }
    stats.runtimeStatements++;
    stats.runtimeBytes += (s.node.end ?? 0) - (s.node.start ?? 0);
    s.remove();
  });
  return stats;
}

// 厂商（TaDa）源码里自带的自毁函数：X.opener = null; X.open("", "_self"); X.close(); ... X.location.href = "about:blank"; getScene().destroy()
// 不是 Jscrambler 注入的，但属于保护代码：清空函数体，保留函数名（触发它的时间/环境检查原样保留，清空后不再有效果）
export function neutralizeSelfDestruct(ast) {
  let n = 0;
  traverse(ast, { noScope: true, Function(p) {
    const b = p.node.body; if (!t.isBlockStatement(b) || !b.body.length) return;
    const src = generate(b).code;
    if (!/\.opener = null/.test(src) || !/location\.href = "about:blank/.test(src) || src.length > 2000) return;
    p.node.body = t.blockStatement([]);
    t.addComment(p.node.body, 'inner', ' 已清空：厂商自毁函数（关窗、跳空白页、销毁场景） ', false);
    n++;
  } });
  return n;
}

// 混淆器把对象字面量改写成 function () { var V; V = {}; V.a = x; V.b = y; return V; }.apply(this, arguments)
// 还原成 { a: x, b: y }。条件：函数体只有这几种语句，属性值里不引用 V，没有 getter 等复杂情况。
// .apply(this, arguments) 让函数内的 this / arguments 与外层一致，所以值表达式可以原样搬出来。
export function restoreObjectLiterals(ast) {
  let n = 0;
  traverse(ast, { noScope: true, CallExpression: { exit(p) {
    const c = p.node.callee;
    if (!t.isMemberExpression(c) || propName(c) !== 'apply' || !t.isFunctionExpression(c.object)) return;
    const a = p.node.arguments;
    if (a.length !== 2 || !t.isThisExpression(a[0]) || !t.isIdentifier(a[1], { name: 'arguments' })) return;
    const fn = c.object; if (fn.params.length || fn.async || fn.generator) return;
    const body = fn.body.body; if (body.length < 3) return;
    const d = body[0];
    if (!t.isVariableDeclaration(d) || d.declarations.length !== 1 || d.declarations[0].init || !t.isIdentifier(d.declarations[0].id)) return;
    const V = d.declarations[0].id.name;
    const init = body[1];
    if (!t.isExpressionStatement(init) || !t.isAssignmentExpression(init.expression, { operator: '=' }) || !t.isIdentifier(init.expression.left, { name: V }) ||
        !t.isObjectExpression(init.expression.right) || init.expression.right.properties.length) return;
    const last = body[body.length - 1];
    if (!t.isReturnStatement(last) || !t.isIdentifier(last.argument, { name: V })) return;
    const props = [];
    const seen = new Set();
    for (const st of body.slice(2, -1)) {
      if (!t.isExpressionStatement(st) || !t.isAssignmentExpression(st.expression, { operator: '=' })) return;
      const l = st.expression.left;
      if (!t.isMemberExpression(l) || !t.isIdentifier(l.object, { name: V })) return;
      const key = propName(l) ?? (t.isNumericLiteral(l.property) ? l.property.value : null);
      if (key === null || seen.has(key)) return;
      let refsV = false;
      t.traverseFast(st.expression.right, (x) => { if (t.isIdentifier(x, { name: V })) refsV = true; });
      if (refsV || t.isIdentifier(st.expression.right, { name: V })) return;
      seen.add(key);
      const k = typeof key === 'number' ? t.numericLiteral(key) : (/^[A-Za-z_$][\w$]*$/.test(key) ? t.identifier(key) : t.stringLiteral(key));
      props.push(t.objectProperty(k, st.expression.right));
    }
    p.replaceWith(t.objectExpression(props));
    n++;
  } } });
  return n;
}

const callsRuntime = (fnPath) => {
  let hit = false;
  fnPath.traverse({ MemberExpression(p) { if (t.isIdentifier(p.node.object, { name: '_global' })) { hit = true; p.stop(); } } });
  return hit;
};

function cleanupBusiness(progPath, bizPaths, stats) {
  for (let round = 0; round < 3; round++) {
    traverse.cache.clear();
    progPath.scope.crawl();
    let changed = 0;
    for (const s of bizPaths) {
      if (s.removed) continue;
      s.traverse({
        FunctionDeclaration(p) {
          const b = p.parentPath.scope.getBinding(p.node.id?.name);
          if (b && !b.referenced && b.constantViolations.length === 0 && callsRuntime(p)) { p.remove(); stats.deadHelpers++; changed++; }
        },
        VariableDeclarator(p) {
          if (!t.isIdentifier(p.node.id)) return;
          const b = p.scope.getBinding(p.node.id.name);
          if (!b || b.referenced) return;
          const init = p.node.init;
          // X = _global 的别名：没人读时连同赋值一起删
          const pureInit = !init || t.isIdentifier(init) || t.isLiteral(init) || t.isFunctionExpression(init);
          if (!pureInit) return;
          const viol = b.constantViolations;
          const violsRemovable = viol.every((v) => v.isAssignmentExpression() && v.parentPath.isExpressionStatement() &&
            (t.isIdentifier(v.node.right) || t.isLiteral(v.node.right)));
          if (!violsRemovable) return;
          for (const v of viol) { if (t.isIdentifier(v.node.right, { name: '_global' })) stats.aliasesRemoved++; if (!v.removed) v.parentPath.remove(); }
          const decl = p.parentPath;
          if (decl.node.declarations.length === 1) decl.remove(); else p.remove();
          stats.deadVars++; changed++;
        },
      });
    }
    if (!changed) break;
  }
}

// 关键字扫描：剥离后还有没有保护代码的痕迹
export const PROTECTION_PATTERNS = [
  ['jscrambler', /jscrambler/i],
  ['notification', /notification\.jscrambler|Real time notification|Code violation/],
  ['违规码 j-0xx', /"j-0\d\d-\d+"/],
  ['Function.prototype.toString', /Function\.prototype\.toString/],
  ['MurmurHash 常量', /3432918353|2971072446|461845907/],
  ['SendJscramblerLog / GameTampering', /SendJscramblerLog|GameTampering/],
  ['域名锁 X0gnGEw', /X0gnGEw/],
  ['自毁 about:blank', /about:blank/],
  ['_global 运行时引用', /\b_global\b/],
];

export function scanProtection(code) {
  const lines = code.split('\n');
  const out = {};
  for (const [name, re] of PROTECTION_PATTERNS) {
    const hits = [];
    lines.forEach((l, i) => { if (re.test(l)) hits.push({ line: i + 1, text: l.trim().slice(0, 160) }); });
    out[name] = { count: hits.length, samples: hits.slice(0, 5) };
  }
  return out;
}
