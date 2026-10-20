// 从原版外壳提取"清洗时被删掉的运行时引导"，生成可直接粘进清洗产物的 prelude
//
// 背景：full-pipeline 的 strip 段把 `NS.C3jL = (function(){...})` 这类自包含解码器
// 当成"运行时语句"删掉了，导致清洗产物里解码入口全废（WASM chunk 永不注册）。
//
// 用法:
//   node tools/extract-bootstrap.mjs <原版.js> <清洗版.js> <命名空间,如 R7xpx> [--out prelude.js] [--json]
//
// 输出：缺失的函数声明 + 缺失的命名空间槽位赋值（已把 NS. 改写成 _global.）

import fs from 'node:fs';
import * as acorn from 'acorn';

const [origPath, cleanPath, nsName] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const outIdx = process.argv.indexOf('--out');
const outFile = outIdx > 0 ? process.argv[outIdx + 1] : null;
const asJson = process.argv.includes('--json');

if (!origPath || !cleanPath || !nsName) {
  console.error('用法: node tools/extract-bootstrap.mjs <原版.js> <清洗版.js> <命名空间> [--out prelude.js]');
  process.exit(2);
}

function parse(file) {
  const src = fs.readFileSync(file, 'utf8');
  const ast = acorn.parse(src, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
  });
  return { src, ast };
}

/** 收集：顶层函数声明 {name:{start,end}} 与命名空间槽位赋值 {slot:{start,end,rightStart,rightEnd}} */
function collect(src, ast, ns) {
  const fns = new Map();
  const slots = new Map();

  (function walk(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'FunctionDeclaration' && node.id) {
      if (!fns.has(node.id.name)) fns.set(node.id.name, { start: node.start, end: node.end });
    }
    if (node.type === 'AssignmentExpression' && node.left && node.left.type === 'MemberExpression') {
      const L = node.left;
      const objName = L.object && L.object.type === 'Identifier' ? L.object.name : null;
      if (objName === ns) {
        let prop = null;
        if (!L.computed && L.property.type === 'Identifier') prop = L.property.name;
        else if (L.computed && L.property.type === 'Literal' && (typeof L.property.value === 'string' || typeof L.property.value === 'number')) prop = String(L.property.value);
        if (prop && !slots.has(prop)) {
          slots.set(prop, {
            start: node.start,
            end: node.end,
            rightStart: node.right.start,
            rightEnd: node.right.end,
          });
        }
      }
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue;
      const v = node[k];
      if (Array.isArray(v)) { for (const c of v) { if (c && typeof c.type === 'string') walk(c); } }
      else if (v && typeof v.type === 'string') walk(v);
    }
  })(ast);

  return { fns, slots };
}

const O = parse(origPath);
const C = parse(cleanPath);
const oc = collect(O.src, O.ast, nsName);
const cc = collect(C.src, C.ast, nsName);

// 清洗产物里命名空间被改写成 _global，槽位赋值以 `_global.X =` 出现
const ccAlt = collect(C.src, C.ast, '_global');

const cleanSlots = new Set([...cc.slots.keys(), ...ccAlt.slots.keys()]);
const missingSlots = [...oc.slots.entries()].filter(([k]) => !cleanSlots.has(k));

const cleanFnNames = new Set(cc.fns.keys());
const missingFns = [...oc.fns.entries()].filter(([k]) => !cleanFnNames.has(k));

// 只保留"清洗产物里确实引用了"的缺失函数（避免把整份原版搬进来）
function referencedInClean(name) {
  const re = new RegExp('(^|[^.\\w$])' + name.replace(/[$]/g, '\\$') + '\\b');
  return re.test(C.src);
}


// ---------- 传递闭包：从清洗产物引用出发，把被引用到的缺失槽位/函数一起补 ----------
const esc = (n) => n.replace(/[$]/g, '\\$');
const refsNS = (code) => {
  const out = new Set();
  const re1 = new RegExp('\\b' + nsName + '\\.([A-Za-z_$][\\w$]*)', 'g');
  const re2 = new RegExp('\\b' + nsName + '\\[\\s*[\'"]?([A-Za-z_$0-9][\\w$]*)', 'g');
  for (const m of code.matchAll(re1)) out.add(m[1]);
  for (const m of code.matchAll(re2)) out.add(m[1]);
  return out;
};
const refsBare = (code, names) => {
  const out = new Set();
  for (const n of names) {
    if (new RegExp('(^|[^.\\w$])' + esc(n) + '\\b').test(code)) out.add(n);
  }
  return out;
};

const emittedSlots = [];
const emittedFns = [];
const seenSlot = new Set();
const seenFn = new Set();

// 起点：清洗产物里以 _global.<name> 引用、但没赋值的
const cleanAssigned = cleanSlots;
const startSlots = [];
for (const m of C.src.matchAll(/_global\.([A-Za-z_$][\w$]*)/g)) {
  const n = m[1];
  if (!cleanAssigned.has(n)) startSlots.push(n);
}

const fnNamesMissing = new Set(missingFns.map(([k]) => k));

const queue = [...new Set(startSlots)];
while (queue.length) {
  const name = queue.shift();
  if (seenSlot.has(name)) continue;
  seenSlot.add(name);
  const loc = oc.slots.get(name);
  if (!loc) continue;                     // 原版也没有 -> 不是被删的引导
  emittedSlots.push([name, loc]);
  const code = O.src.slice(loc.rightStart, loc.rightEnd);
  // 这个槽位的实现引用了哪些其它槽位 / 缺失函数
  for (const r of refsNS(code)) if (!seenSlot.has(r)) queue.push(r);
  for (const r of refsBare(code, fnNamesMissing)) if (!seenFn.has(r)) { seenFn.add(r); emittedFns.push(r); }
}
// 起点里也可能直接引用了缺失函数
for (const n of refsBare(C.src, fnNamesMissing)) if (!seenFn.has(n)) { seenFn.add(n); emittedFns.push(n); }

const usedMissingSlots = emittedSlots;
const usedMissingFns = emittedFns
  .map(n => [n, oc.fns.get(n)])
  .filter(([, loc]) => !!loc)
  .sort((a, b) => a[1].start - b[1].start);
// 槽位按原版出现顺序，保证定义顺序与原版一致
usedMissingSlots.sort((a, b) => a[1].start - b[1].start);

// ---------- 生成 prelude ----------
const parts = [];
parts.push('/* ===== AUTO-GENERATED by tools/extract-bootstrap.mjs =====');
parts.push(` * 原版: ${origPath}`);
parts.push(` * 清洗: ${cleanPath}`);
parts.push(` * 命名空间: ${nsName} → _global`);
parts.push(` * 补：函数 ${usedMissingFns.length} 个 / 槽位 ${usedMissingSlots.length} 个（含传递依赖）`);
parts.push(' * 只补"原版有、清洗版缺"的部分，不改其它代码。');
parts.push(' */');

const rewrite = (code) => code.replace(new RegExp('\\b' + nsName + '\\b', 'g'), '_global');
for (const [name, loc] of usedMissingFns) {
  if (name === nsName) continue;          // 命名空间函数本身不搬
  parts.push(`/* --- function ${name} --- */`);
  parts.push(rewrite(O.src.slice(loc.start, loc.end)));
}
for (const [slot, loc] of usedMissingSlots) {
  parts.push(`/* --- ${nsName}.${slot} --- */`);
  const lhs = /^\d+$/.test(String(slot)) ? `_global[${slot}]` : `_global.${slot}`;
  parts.push(lhs + ' = ' + rewrite(O.src.slice(loc.rightStart, loc.rightEnd)) + ';');
}
const prelude = parts.join('\n') + '\n';

if (asJson) {
  console.log(JSON.stringify({
    ns: nsName,
    origFunctions: oc.fns.size,
    cleanFunctions: cc.fns.size,
    missingFunctions: missingFns.length,
    usedMissingFunctions: usedMissingFns.map(([k]) => k),
    missingSlots: missingSlots.map(([k]) => k),
    usedMissingSlots: missingSlots.filter(([k]) => referencedSlotInClean(k)).map(([k]) => k),
    preludeBytes: Buffer.byteLength(prelude),
  }, null, 2));
} else {
  console.log(`原版函数 ${oc.fns.size} / 清洗函数 ${cc.fns.size}`);
  console.log(`缺失函数 ${missingFns.length}（清洗里确实引用的 ${usedMissingFns.length}）: ${usedMissingFns.map(([k]) => k).join(', ') || '无'}`);
  console.log(`缺失槽位 ${missingSlots.length}（清洗里引用的 ${missingSlots.filter(([k]) => referencedInClean(k)).length}）`);
  console.log(`prelude 大小: ${(Buffer.byteLength(prelude) / 1024).toFixed(1)} KB`);
}

if (outFile) {
  fs.writeFileSync(outFile, prelude);
  console.log('已写入 ' + outFile);
}
