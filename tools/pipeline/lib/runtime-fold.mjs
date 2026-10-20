// Jscrambler 运行时常量的静态求值：
//  1) 完整性常量 _global.r07(a, k, c, _global.N3U()[k]())
//     运行时是用调用处的堆栈列号自检，自检通过时返回值 = 对某一个参数依次做几步位运算（异或/循环移位）。
//     这几步变换写在完整性函数的 if 链里（由开头的 r07(4)/r07(1)/y8c(5)… 依次激活），这里直接从 AST 读出来静态计算。
//  2) 带 4 位十六进制键的不透明谓词 X.w63("5c32")（域名锁函数 X0gnGEw 的返回值）
//     域名锁通过时，返回值 = 键的每个字符按十六进制取最低位后异或的结果（已在 G1000 的外壳两个文件上逐条核对）。
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
import vm from 'node:vm';
import { propName } from './decode-strings.mjs';

const traverse = _traverse.default ?? _traverse;
const generate = _generate.default ?? _generate;

const isNsRef = (node, aliases) => t.isIdentifier(node) && aliases.has(node.name);

// 命名空间别名：_global 本身，以及 X = _global / var X = _global
export function findNsAliases(ast) {
  const aliases = new Set(['_global']);
  traverse(ast, { noScope: true,
    AssignmentExpression(p) { if (p.node.operator === '=' && t.isIdentifier(p.node.left) && t.isIdentifier(p.node.right, { name: '_global' })) aliases.add(p.node.left.name); },
    VariableDeclarator(p) { if (t.isIdentifier(p.node.id) && t.isIdentifier(p.node.init, { name: '_global' })) aliases.add(p.node.id.name); },
  });
  return aliases;
}

// _global.NAME = function F() { var a = _global[ID], b = a.FIELD; return F === _global.NAME && (...) }
export function findWrappers(ast) {
  const map = new Map();
  for (const st of ast.program.body) {
    if (!t.isExpressionStatement(st)) continue;
    const e = st.expression;
    if (!t.isAssignmentExpression(e) || !t.isMemberExpression(e.left) || !t.isIdentifier(e.left.object, { name: '_global' })) continue;
    const name = propName(e.left); const fn = e.right;
    if (!name || !t.isFunctionExpression(fn) || fn.body.body.length !== 2) continue;
    const d = fn.body.body[0];
    if (!t.isVariableDeclaration(d) || d.declarations.length !== 2) continue;
    const [a, b] = d.declarations;
    if (!t.isMemberExpression(a.init) || !t.isIdentifier(a.init.object, { name: '_global' })) continue;
    if (!t.isMemberExpression(b.init) || !t.isIdentifier(b.init.object, { name: a.id.name })) continue;
    const container = a.init.computed ? (t.isNumericLiteral(a.init.property) ? a.init.property.value : propName(a.init)) : a.init.property.name;
    map.set(name, { container: String(container), field: propName(b.init) });
  }
  return map;
}

// 找 _global[ID] = function(){...}() 或 _global.X = function(){...}() 的容器
function findContainer(ast, key) {
  let found = null;
  traverse(ast, { noScope: false, AssignmentExpression(p) {
    if (found) return p.skip();
    const l = p.node.left;
    if (!t.isMemberExpression(l) || !t.isIdentifier(l.object, { name: '_global' })) return;
    const k = l.computed ? (t.isNumericLiteral(l.property) ? String(l.property.value) : propName(l)) : l.property.name;
    if (k === key && p.parentPath.isExpressionStatement() && p.parentPath.parentPath.isProgram()) { found = p.get('right'); p.stop(); }
  } });
  return found;
}

function resolveNumber(path, name) {
  const b = path.scope.getBinding(name);
  if (!b) return undefined;
  const vals = new Set();
  if (b.path.isVariableDeclarator() && b.path.node.init) {
    if (t.isNumericLiteral(b.path.node.init)) vals.add(b.path.node.init.value); else return undefined;
  }
  for (const v of b.constantViolations) {
    const n = v.node;
    if (t.isAssignmentExpression(n) && n.operator === '=' && t.isNumericLiteral(n.right)) vals.add(n.right.value);
    else if (t.isAssignmentExpression(n) && n.operator === '+=') continue; // 计数器自增（K6L += 1），不是常量但这里只用作 if 的状态比较
    else return undefined;
  }
  return vals.size === 1 ? [...vals][0] : undefined;
}

// 分析完整性函数：返回 { encodedIndex, transforms:[fn...] } 或 null
function analyzeIntegrityFn(fnPath) {
  const params = fnPath.node.params.map((p) => p.name);
  let encodedIndex = -1;
  const steps = [];
  let fail = null;
  fnPath.traverse({
    AssignmentExpression(p) {
      const n = p.node;
      if (n.operator === '=' && t.isIdentifier(n.left) && params.includes(n.left.name) && t.isCallExpression(n.right) &&
          n.right.arguments.length === 1 && t.isIdentifier(n.right.arguments[0], { name: n.left.name })) encodedIndex = params.indexOf(n.left.name);
    },
    IfStatement(p) {
      const tst = p.node.test;
      if (!t.isLogicalExpression(tst, { operator: '&&' }) || !t.isBinaryExpression(tst.right, { operator: '===' })) return;
      const sel = tst.right.left; if (!t.isIdentifier(sel) || !params.includes(sel.name)) return;
      // consequent 里的 f(arr, function (z) { return EXPR; })
      let tf = null;
      p.get('consequent').traverse({ FunctionExpression(q) { if (!tf && q.node.params.length === 1) { tf = q; q.stop(); } } });
      if (!tf) return;
      let selVal = t.isNumericLiteral(tst.right.right) ? tst.right.right.value : resolveNumber(p, tst.right.right.name);
      if (selVal === undefined) { fail = '无法解析变换参数 ' + generate(tst.right.right).code; return; }
      // 变换里用到的辅助函数（循环移位）
      const helpers = [];
      tf.traverse({ CallExpression(q) {
        if (t.isIdentifier(q.node.callee)) {
          const b = q.scope.getBinding(q.node.callee.name);
          if (b && b.path.isFunctionDeclaration()) helpers.push(b.path);
        }
      } });
      steps.push({ sel: sel.name, selVal, fn: tf.node, helpers });
    },
  });
  if (fail || encodedIndex < 0 || !steps.length) return { error: fail || (encodedIndex < 0 ? '找不到被解码的参数' : '找不到变换 if 链') };
  // 把每一步编译成独立的 JS 函数（辅助函数里的常量也要解析：k9d = 32 这种在函数内部赋值，原样带上即可）
  const transforms = steps.map((s) => {
    const helperSrc = s.helpers.map((h) => generate(h.node).code).join('\n');
    const src = `(function(${s.sel}){ ${helperSrc}\n return (${generate(s.fn).code}); })(${s.selVal})`;
    return { fn: vm.runInNewContext(src, {}, { timeout: 1000 }), desc: `${s.sel}=${s.selVal}` };
  });
  return { encodedIndex, transforms };
}

/**
 * 把完整性常量折叠成数字。
 * @param validate (fnName, value) => boolean|null：用解码表校验（解码函数参数位置的值应该命中字符串表）
 */
export function foldIntegrityConstants(ast, { decoders = [], table = null, runtimeMap = null } = {}) {
  const stats = { families: [], folded: 0, unresolved: 0, order: null, validation: null, error: null };
  const wrappers = findWrappers(ast);
  const byContainer = new Map();
  for (const [name, w] of wrappers) {
    const k = w.container + '.' + w.field;
    if (!byContainer.has(k)) byContainer.set(k, { ...w, names: [] });
    byContainer.get(k).names.push(name);
  }
  // 找出含 "j-014-00003" 的完整性函数
  const fams = [];
  for (const [, c] of byContainer) {
    const cont = findContainer(ast, c.container);
    if (!cont) continue;
    let fnPath = null;
    cont.traverse({ AssignmentExpression(p) {
      if (fnPath) return;
      if (t.isIdentifier(p.node.left, { name: c.field }) && t.isFunctionExpression(p.node.right) && p.node.right.params.length === 4) {
        const src = generate(p.node.right).code;
        if (src.includes('j-014-00003')) { fnPath = p.get('right'); p.stop(); }
      }
    } });
    if (!fnPath) continue;
    const a = analyzeIntegrityFn(fnPath);
    if (a.error) { stats.error = a.error; continue; }
    fams.push({ names: c.names, ...a });
  }
  if (!fams.length) return stats;
  stats.families = fams.map((f) => ({ names: f.names, encodedArg: f.encodedIndex, steps: f.transforms.map((x) => x.desc) }));

  const nameToFam = new Map(); for (const f of fams) for (const n of f.names) nameToFam.set(n, f);
  const isIntegrityCall = (n) => t.isCallExpression(n) && t.isMemberExpression(n.callee) && t.isIdentifier(n.callee.object, { name: '_global' }) &&
    nameToFam.has(propName(n.callee)) && n.arguments.length === 4;
  const encodedOf = (n) => { const f = nameToFam.get(propName(n.callee)); const a = n.arguments[f.encodedIndex]; return t.isNumericLiteral(a) ? a.value : undefined; };
  const compute = (f, v, order) => (order === 'reverse' ? [...f.transforms].reverse() : f.transforms).reduce((acc, x) => x.fn(acc), v);

  // 用"解码函数(完整性常量)"的调用点决定变换顺序（正序 / 倒序）
  const dec = new Set(decoders);
  const samples = [];
  traverse(ast, { noScope: true, CallExpression(p) {
    const n = p.node;
    if (t.isMemberExpression(n.callee) && dec.has(propName(n.callee)) && n.arguments.length === 1 && isIntegrityCall(n.arguments[0])) {
      const v = encodedOf(n.arguments[0]); if (v !== undefined) samples.push([nameToFam.get(propName(n.arguments[0].callee)), v]);
    }
  } });
  let order = 'reverse';
  if (table && samples.length) {
    const score = (o) => samples.filter(([f, v]) => typeof table(compute(f, v, o)) === 'string').length;
    const r = score('reverse'), fw = score('forward');
    order = r >= fw ? 'reverse' : 'forward';
    stats.validation = { samples: samples.length, hitReverse: r, hitForward: fw };
    if (Math.max(r, fw) < samples.length * 0.9) stats.error = `变换顺序校验不足：${JSON.stringify(stats.validation)}`;
  }
  stats.order = order;

  // 校验不通过且没有 runtimeMap 时，跳过静态折叠
  const validationFailed = stats.error && stats.error.includes('校验不足');
  const skipStaticFold = validationFailed && !runtimeMap;
  if (skipStaticFold) {
    stats.error += '（无运行时映射表，跳过静态折叠）';
  }

  traverse(ast, { noScope: true, CallExpression: { exit(p) {
    if (!isIntegrityCall(p.node)) return;
    const n = p.node;
    const fnName = propName(n.callee);

    // 优先从 runtimeMap 查表替换
    if (runtimeMap) {
      const args = n.arguments;
      const nums = args.map((a) => t.isNumericLiteral(a) ? a.value : undefined);
      // 尝试多种 key 格式：先 fn:a1:a2:a3（标准 4 参数），再 fn:所有numeric参数（other.js colCheck 在 args[0] 时 args[3] 不是数字）
      const candidates = [];
      if (nums[1] !== undefined && nums[2] !== undefined && nums[3] !== undefined) {
        candidates.push(`${fnName}:${nums[1]}:${nums[2]}:${nums[3]}`);
      }
      if (nums[0] !== undefined && nums[1] !== undefined && nums[2] !== undefined) {
        candidates.push(`${fnName}:${nums[1]}:${nums[2]}:${nums[0]}`);
      }
      for (const key of candidates) {
        if (key in runtimeMap) {
          const r = runtimeMap[key];
          p.replaceWith(r < 0 ? t.unaryExpression('-', t.numericLiteral(-r)) : t.numericLiteral(r));
          stats.folded++;
          return;
        }
      }
    }

    // fallback 到静态计算（校验失败时跳过）
    if (skipStaticFold) { stats.unresolved++; return; }
    const v = encodedOf(n);
    if (v === undefined) { stats.unresolved++; return; }
    const r = compute(nameToFam.get(fnName), v, order);
    p.replaceWith(r < 0 ? t.unaryExpression('-', t.numericLiteral(-r)) : t.numericLiteral(r));
    stats.folded++;
  } } });
  // -(-5) / -5 这类由折叠产生的一元负号保持原样即可
  return stats;
}

// 键控谓词：对 4 位十六进制键求值
export function keyedPredValue(key) {
  let acc;
  for (let i = 0; i < key.length; i++) {
    const b = parseInt(key.charAt(i), 16).toString(2);
    const d = b.charAt(b.length - 1);
    acc = i === 0 ? d : acc ^ d;
  }
  return !!acc;
}

const HEX4 = /^[0-9a-f]{4}$/;

/**
 * 折叠 ALIAS.pred("5c32") 形式的键控谓词，并删除业务代码里 "ALIAS.x = function (a) { if (ALIAS && a) return ALIAS.pred(a); }" 这类转发定义。
 */
export function foldKeyedPredicates(ast, { minCount = 20 } = {}) {
  const aliases = findNsAliases(ast);
  const stats = { names: [], folded: 0, forwarders: 0, plausibility: null };
  // 1) 统计被"命名空间别名.名字(4位十六进制)"调用的名字
  const cnt = new Map();
  traverse(ast, { noScope: true, CallExpression(p) {
    const n = p.node;
    if (t.isMemberExpression(n.callee) && isNsRef(n.callee.object, aliases) && n.arguments.length === 1 &&
        t.isStringLiteral(n.arguments[0]) && HEX4.test(n.arguments[0].value)) {
      const nm = propName(n.callee); cnt.set(nm, (cnt.get(nm) || 0) + 1);
    }
  } });
  const preds = new Set([...cnt].filter(([, c]) => c >= minCount).map(([n]) => n));
  // 2) 转发定义：ALIAS.x = function (a) { if (ALIAS [&& a]) return ALIAS.pred(a); }
  const fwd = new Set();
  const isForwarder = (asg) => {
    if (!t.isMemberExpression(asg.left) || !isNsRef(asg.left.object, aliases) || !t.isFunctionExpression(asg.right)) return null;
    const f = asg.right; if (f.params.length !== 1) return null;
    // 允许前面带代码锁辅助函数声明 / 空 var 声明（function X(a,b,c,d){ return _global.Q6y(...) + a }）
    const rest = f.body.body.filter((x) => !t.isFunctionDeclaration(x) && !(t.isVariableDeclaration(x) && x.declarations.every((d) => !d.init || t.isNumericLiteral(d.init))));
    if (rest.length !== 1) return null;
    const s = rest[0]; if (!t.isIfStatement(s) || s.alternate) return null;
    const ret = t.isReturnStatement(s.consequent) ? s.consequent : (t.isBlockStatement(s.consequent) && s.consequent.body.length === 1 ? s.consequent.body[0] : null);
    if (!t.isReturnStatement(ret) || !t.isCallExpression(ret.argument)) return null;
    const c = ret.argument;
    if (!t.isMemberExpression(c.callee) || !isNsRef(c.callee.object, aliases) || c.arguments.length !== 1 || !t.isIdentifier(c.arguments[0], { name: f.params[0].name })) return null;
    return { name: propName(asg.left), target: propName(c.callee) };
  };
  // 只被转发函数调用的底层谓词（如 H6c / b3$，直接调用次数少）：是转发目标且至少有一次 4 位十六进制键调用，也算
  // 底层谓词（如 H6c / b3$）可能只经转发函数调用：转发函数本身被 4 位十六进制键调用过，就把它的目标也算进来
  traverse(ast, { noScope: true, AssignmentExpression(p) {
    const r = isForwarder(p.node);
    if (r && (cnt.get(r.target) >= 1 || cnt.get(r.name) >= 1)) preds.add(r.target);
  } });
  let grew = true;
  while (grew) {
    grew = false;
    traverse(ast, { noScope: true, AssignmentExpression(p) {
      const r = isForwarder(p.node);
      if (r && (preds.has(r.target) || fwd.has(r.target)) && !fwd.has(r.name) && !preds.has(r.name)) { fwd.add(r.name); grew = true; }
    } });
  }
  const all = new Set([...preds, ...fwd]);
  stats.names = [...all];
  if (!all.size) return stats;
  // 3) 折叠调用；用"选中分支的字符串在文件别处是否也出现过"估算可信度
  const literalCount = new Map();
  traverse(ast, { noScope: true, StringLiteral(p) { literalCount.set(p.node.value, (literalCount.get(p.node.value) || 0) + 1); } });
  let checked = 0, plausible = 0; const doubt = [];
  traverse(ast, { noScope: true, CallExpression: { exit(p) {
    const n = p.node;
    if (!t.isMemberExpression(n.callee) || !isNsRef(n.callee.object, aliases) || !all.has(propName(n.callee))) return;
    if (n.arguments.length !== 1 || !t.isStringLiteral(n.arguments[0]) || !HEX4.test(n.arguments[0].value)) return;
    const v = keyedPredValue(n.arguments[0].value);
    const par = p.parentPath;
    if (par.isConditionalExpression() && par.node.test === n && t.isStringLiteral(par.node.consequent) && t.isStringLiteral(par.node.alternate)) {
      const keep = v ? par.node.consequent.value : par.node.alternate.value;
      const drop = v ? par.node.alternate.value : par.node.consequent.value;
      if (keep.length >= 3 || drop.length >= 3) {
        checked++;
        if ((literalCount.get(keep) || 0) >= (literalCount.get(drop) || 0)) plausible++;
        else if (doubt.length < 5) doubt.push({ key: n.arguments[0].value, keep, drop });
      }
    }
    p.replaceWith(t.booleanLiteral(v)); stats.folded++;
    // 立刻折叠 "谓词 ? a : b"，这样外层 转发函数(谓词 ? "x" : "5376") 的参数在它自己的 exit 时已经是字面量
    const cp = p.parentPath;
    if (cp && cp.isConditionalExpression() && cp.node.test === p.node) cp.replaceWith(v ? cp.node.consequent : cp.node.alternate);
  } } });
  stats.plausibility = checked ? { checked, plausible, ratio: +(plausible / checked).toFixed(3), doubt } : null;
  // 4) 删掉转发定义语句
  traverse(ast, { noScope: true, ExpressionStatement(p) {
    const e = p.node.expression;
    if (t.isAssignmentExpression(e) && isForwarder(e) && fwd.has(propName(e.left))) { p.remove(); stats.forwarders++; }
  } });
  return stats;
}
