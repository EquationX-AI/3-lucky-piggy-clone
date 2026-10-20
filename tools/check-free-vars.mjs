// 自由变量检查（基于 acorn AST，无正则误报）
// 用法: node tools/check-free-vars.mjs <file.js> [--json]
import fs from 'node:fs';
import * as acorn from 'acorn';

const file = process.argv[2];
if (!file) { console.error('用法: node tools/check-free-vars.mjs <file.js> [--json]'); process.exit(2); }
const src = fs.readFileSync(file, 'utf8');

const ast = acorn.parse(src, {
  ecmaVersion: 'latest',
  sourceType: 'script',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowHashBang: true,
});

// 作用域栈：每层收集声明名
const scopes = [{ names: new Set(), parent: null }];
const refs = new Map(); // name -> {count, samples}

const GLOBALS = new Set([
  'window','document','console','Math','JSON','Object','Array','String','Number','Boolean','Date','RegExp',
  'Error','TypeError','RangeError','SyntaxError','ReferenceError','EvalError','URIError','Promise','Map','Set',
  'WeakMap','WeakSet','Symbol','Reflect','Proxy','ArrayBuffer','SharedArrayBuffer','DataView','Atomics',
  'Uint8Array','Uint8ClampedArray','Int8Array','Uint16Array','Int16Array','Uint32Array','Int32Array',
  'Float32Array','Float64Array','BigInt','BigInt64Array','BigUint64Array','Function','eval','parseInt',
  'parseFloat','isNaN','isFinite','encodeURIComponent','decodeURIComponent','encodeURI','decodeURI',
  'escape','unescape','setTimeout','setInterval','clearTimeout','clearInterval','queueMicrotask',
  'requestAnimationFrame','cancelAnimationFrame','structuredClone','undefined','NaN','Infinity',
  'globalThis','performance','navigator','location','localStorage','sessionStorage','fetch','XMLHttpRequest',
  'WebSocket','TextEncoder','TextDecoder','Blob','URL','URLSearchParams','Headers','Request','Response',
  'FormData','Image','Audio','HTMLElement','HTMLCanvasElement','Event','CustomEvent','DOMParser','btoa','atob',
  'requestIdleCallback','crypto','self','top','parent','frames','screen','history','devicePixelRatio',
]);

function declareInCurrent(name) { scopes[scopes.length - 1].names.add(name); }

function isDeclared(name) {
  for (let s = scopes.length - 1; s >= 0; s--) if (scopes[s].names.has(name)) return true;
  return false;
}

function addRef(name, node) {
  if (!refs.has(name)) refs.set(name, { count: 0, samples: [] });
  const r = refs.get(name);
  r.count++;
  if (r.samples.length < 3) {
    r.samples.push({
      pos: node.start,
      line: node.loc ? node.loc.start.line : 0,
      code: src.slice(Math.max(0, node.start - 70), node.start + 100).replace(/\s+/g, ' '),
    });
  }
}

// 收集模式中的绑定名（var/let/const、参数、解构、catch）
function bindPattern(p) {
  if (!p) return;
  switch (p.type) {
    case 'Identifier': declareInCurrent(p.name); break;
    case 'ObjectPattern':
      for (const prop of p.properties) bindPattern(prop.type === 'RestElement' ? prop.argument : prop.value);
      break;
    case 'ArrayPattern': for (const el of p.elements) if (el) bindPattern(el); break;
    case 'AssignmentPattern': bindPattern(p.left); break;
    case 'RestElement': bindPattern(p.argument); break;
  }
}

function walk(node, parent) {
  if (!node || typeof node.type !== 'string') return;

  switch (node.type) {
    case 'Program':
      for (const c of node.body) walk(c, node);
      return;
    case 'VariableDeclaration':
      for (const d of node.declarations) {
        bindPattern(d.id);
        if (d.init) walk(d.init, d);
      }
      return;
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression': {
      if (node.id) declareInCurrent(node.id.name);
      scopes.push({ names: new Set(), parent: scopes[scopes.length - 1] });
      for (const p of node.params) bindPattern(p);
      if (node.body.type === 'BlockStatement') {
        for (const c of node.body.body) walk(c, node.body);
      } else {
        walk(node.body, node);
      }
      scopes.pop();
      return;
    }
    case 'ClassDeclaration':
    case 'ClassExpression':
      if (node.id) declareInCurrent(node.id.name);
      if (node.superClass) walk(node.superClass, node);
      walk(node.body, node);
      return;
    case 'CatchClause':
      scopes.push({ names: new Set(), parent: scopes[scopes.length - 1] });
      if (node.param) bindPattern(node.param);
      walk(node.body, node);
      scopes.pop();
      return;
    case 'BlockStatement': {
      scopes.push({ names: new Set(), parent: scopes[scopes.length - 1] });
      for (const c of node.body) walk(c, node);
      scopes.pop();
      return;
    }
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement': {
      scopes.push({ names: new Set(), parent: scopes[scopes.length - 1] });
      for (const k of ['init', 'left', 'right', 'test', 'update', 'body']) if (node[k]) walk(node[k], node);
      scopes.pop();
      return;
    }
    case 'Identifier':
      // 只统计"作为表达式被读取"的标识符
      if (parent && (
        (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
        (parent.type === 'Property' && parent.key === node && !parent.computed)
      )) return;
      if (!isDeclared(node.name) && !GLOBALS.has(node.name)) addRef(node.name, node);
      return;
    case 'LabeledStatement': walk(node.body, node); return;
    case 'BreakStatement': case 'ContinueStatement': return;
    case 'MetaProperty': return;
    default:
      for (const k of Object.keys(node)) {
        if (k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue;
        const v = node[k];
        if (Array.isArray(v)) {
          for (const c of v) { if (c && typeof c.type === 'string') walk(c, node); }
        } else if (v && typeof v.type === 'string') {
          walk(v, node);
        }
      }
  }
}

walk(ast, null);

// ---------- 分类 ----------
const out = [...refs.entries()]
  .map(([name, r]) => ({ name, count: r.count, guess: classify(name, r.samples), samples: r.samples }))
  .sort((a, b) => b.count - a.count);

function classify(name, samples) {
  const s = samples.map(x => x.code).join(' ');
  const esc = name.replace(/[$]/g, '\\$');
  if (new RegExp(esc + '\\s*\\[\\s*[\'"](register|import|get|set|entries|resolve|registerRegistry)[\'"]').test(s)) return 'System';
  if (new RegExp(esc + '\\s*\\[\\s*[\'"](location|document|navigator)[\'"]').test(s)) return 'window';
  if (new RegExp(esc + '\\.(location|document|navigator|setTimeout|clearTimeout|Math|JSON|cc|Astarte|localStorage|performance|addEventListener)').test(s)) return 'window';
  if (/\.register\s*\(/.test(s) && new RegExp(esc + '\\.register').test(s)) return 'System';
  return '?';
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`文件: ${file}`);
  console.log(`自由变量: ${out.length} 个\n`);
  for (const r of out.slice(0, 50)) {
    console.log(`${String(r.count).padStart(5)}  ${r.name.padEnd(16)} ${r.guess.padEnd(8)} L${r.samples[0].line}  ${r.samples[0].code.slice(0, 100)}`);
  }
  const unknown = out.filter(r => r.guess === '?');
  if (unknown.length) {
    console.log(`\n需人工判定 ${unknown.length} 个：`);
    for (const r of unknown.slice(0, 40)) console.log(`  ${r.name} ×${r.count}  L${r.samples[0].line}  ${r.samples[0].code.slice(0, 120)}`);
  }
}
