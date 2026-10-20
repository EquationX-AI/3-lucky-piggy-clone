// CFF 抽象等价检查器
// 思路：把真实文件里每个状态机的"控制流骨架"抽出来——case 体换成打点 __T(id)，
// 条件换成预言 __C(id)，体内的嵌套 return/throw/break 换成 if(__R(id)) ...；
// 用被测的 CFF 变换器展开这个骨架程序，再用同一串随机预言分别执行原版和展开版，
// 比较执行轨迹（打点序列 + 结束方式）。轨迹不同 = 展开不等价。
//
// 用法: node cff-equiv-test.mjs <cff变换器路径> <bundle|other|main|all> [--seeds=N] [--only=序号] [--dump=dir]
import * as babel from '@babel/core';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { pathToFileURL, fileURLToPath } from 'url';

const traverse = _traverse.default ?? _traverse;
const generate = _generate.default ?? _generate;

// ---------------- worker：只负责跑变换器 ----------------
if (!isMainThread) {
    const mod = await import(pathToFileURL(workerData.transformer).href);
    const exp = mod.default || mod[Object.keys(mod).find((k) => mod[k] && mod[k].visitor)];
    console.log = () => {};
    console.warn = () => {};
    parentPort.on('message', (msg) => {
        try {
            const ast = babel.parseSync(msg.code, { sourceType: 'script' });
            traverse(ast, exp.visitor);
            const out = generate(ast).code;
            parentPort.postMessage({ id: msg.id, out });
        } catch (e) {
            parentPort.postMessage({ id: msg.id, error: String(e && e.stack || e).slice(0, 500) });
        }
    });
}

// ---------------- 抽取状态机骨架 ----------------
function containsJump(node, kinds) {
    // 在不进入嵌套函数的前提下，找 return/throw；break/continue 只算跳出本 case 的
    let found = false;
    const walk = (n, loopDepth, switchDepth, labels) => {
        if (!n || found || typeof n !== 'object') return;
        if (Array.isArray(n)) { for (const x of n) walk(x, loopDepth, switchDepth, labels); return; }
        if (!n.type) return;
        if (t.isFunction(n) || t.isClass(n)) return;
        if (kinds.includes('return') && t.isReturnStatement(n)) { found = true; return; }
        if (kinds.includes('throw') && t.isThrowStatement(n)) { found = true; return; }
        if (kinds.includes('break') && t.isBreakStatement(n)) {
            if (n.label ? !labels.includes(n.label.name) : (loopDepth === 0 && switchDepth === 0)) { found = true; return; }
        }
        if (kinds.includes('continue') && t.isContinueStatement(n)) {
            if (n.label ? !labels.includes(n.label.name) : loopDepth === 0) { found = true; return; }
        }
        let ld = loopDepth, sd = switchDepth, lb = labels;
        if (t.isLoop(n)) ld++;
        if (t.isSwitchStatement(n)) sd++;
        if (t.isLabeledStatement(n)) lb = [...labels, n.label.name];
        for (const k of t.VISITOR_KEYS[n.type] || []) walk(n[k], ld, sd, lb);
    };
    walk(node, 0, 0, []);
    return found;
}

function refsName(node, name) {
    let found = false;
    const walk = (n) => {
        if (!n || found || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (!n.type) return;
        if (t.isIdentifier(n) && n.name === name) { found = true; return; }
        for (const k of t.VISITOR_KEYS[n.type] || []) walk(n[k]);
    };
    walk(node);
    return found;
}

function extractMachines(code, dynMap = null) {
    const ast = babel.parseSync(code, { sourceType: 'script' });
    const machines = [];
    traverse(ast, {
        ForStatement(p) {
            const n = p.node;
            if (n.update) return;
            if (!t.isBinaryExpression(n.test, { operator: '!==' })) return;
            let sv, termNode;
            if (t.isIdentifier(n.test.left)) { sv = n.test.left.name; termNode = n.test.right; }
            else if (t.isIdentifier(n.test.right)) { sv = n.test.right.name; termNode = n.test.left; }
            else return;
            if (!t.isNumericLiteral(termNode)) return;
            let sw;
            if (t.isBlockStatement(n.body) && n.body.body.length === 1 && t.isSwitchStatement(n.body.body[0])) sw = n.body.body[0];
            else if (t.isSwitchStatement(n.body)) sw = n.body;
            else return;
            if (!t.isIdentifier(sw.discriminant, { name: sv })) return;
            // 初值
            let init = null, initSrc = null;
            const fromNode = (nd) => {
                if (t.isVariableDeclaration(nd)) {
                    for (const d of nd.declarations) if (t.isIdentifier(d.id, { name: sv }) && d.init) return d.init;
                } else if (t.isExpressionStatement(nd) && t.isAssignmentExpression(nd.expression, { operator: '=' }) && t.isIdentifier(nd.expression.left, { name: sv })) return nd.expression.right;
                return null;
            };
            if (n.init) { init = fromNode(n.init); initSrc = 'for-init'; }
            if (!init && typeof p.key === 'number') {
                for (let i = p.key - 1; i >= 0; i--) {
                    const s = p.getSibling(i).node;
                    if (!s) continue;
                    const v = fromNode(s);
                    if (v) { init = v; initSrc = 'sibling'; break; }
                    if (t.isForStatement(s) || t.isWhileStatement(s) || t.isDoWhileStatement(s) || t.isIfStatement(s) || t.isReturnStatement(s) || t.isSwitchStatement(s)) break;
                }
            }
            // --dyninit：初值是标识符且被变换器动态求出时，用求出的值
            let dynInit = null;
            if (dynMap && init && t.isIdentifier(init)) {
                const b = p.scope.getBinding(init.name);
                if (b && b.path.node && dynMap.has(b.path.node.start)) dynInit = dynMap.get(b.path.node.start);
            }
            const fn = p.getFunctionParent();
            const name = fn && fn.node.id ? fn.node.id.name : '';
            machines.push({
                loc: n.loc ? n.loc.start.line + ':' + n.loc.start.column : '?',
                start: n.start,
                fnName: name,
                stateVar: sv,
                term: termNode.value,
                init: init && t.isNumericLiteral(init) ? init.value : dynInit,
                dynInit: dynInit !== null,
                initKind: init ? init.type : 'none',
                initSrc,
                cases: sw.cases.map((c) => ({ test: c.test ? (t.isNumericLiteral(c.test) ? c.test.value : '?' + c.test.type) : 'default', body: c.consequent })),
            });
        },
    });
    return machines;
}

// 把一个状态机变成骨架程序
function buildSkeleton(m) {
    const sv = 'S';
    const lines = [];
    let flags = [];
    for (const c of m.cases) {
        const head = c.test === 'default' ? 'default:' : `case ${typeof c.test === 'number' ? c.test : JSON.stringify(c.test)}:`;
        const id = c.test === 'default' ? 'D' : String(c.test);
        const stmts = c.body;
        const out = [];
        stmts.forEach((s, idx) => {
            const isLast = idx === stmts.length - 1;
            if (t.isBreakStatement(s) && !s.label) { out.push('break;'); return; }
            if (t.isReturnStatement(s)) { out.push(`return "R${id}";`); return; }
            if (t.isThrowStatement(s)) { out.push(`throw "T${id}";`); return; }
            const absUpdate = (rhs) => {
                if (t.isNumericLiteral(rhs)) return `${sv} = ${rhs.value}`;
                if (t.isConditionalExpression(rhs) && t.isNumericLiteral(rhs.consequent) && t.isNumericLiteral(rhs.alternate))
                    return `${sv} = __C("${id}") ? ${rhs.consequent.value} : ${rhs.alternate.value}`;
                flags.push('nonliteral-update');
                return `${sv} = __X("${id}")`;
            };
            // 状态赋值（可能在逗号表达式末尾）
            if (t.isExpressionStatement(s)) {
                const e = s.expression;
                const parts = t.isSequenceExpression(e) ? e.expressions : [e];
                const absParts = parts.map((pe) => {
                    if (t.isAssignmentExpression(pe, { operator: '=' }) && t.isIdentifier(pe.left, { name: m.stateVar })) {
                        if (refsName(pe.right, m.stateVar)) flags.push('state-read');
                        return absUpdate(pe.right);
                    }
                    if (refsName(pe, m.stateVar)) flags.push('state-read');
                    return containsJump(pe, ['return', 'throw']) ? `(__R("${id}") ? (function(){throw "r${id}"})() : 0)` : `__T("${id}")`;
                });
                out.push((absParts.length > 1 ? absParts.join(', ') : absParts[0]) + ';');
                return;
            }
            if (t.isVariableDeclaration(s)) {
                const decls = s.declarations.map((d) => {
                    if (t.isIdentifier(d.id, { name: m.stateVar }) && d.init) return `${sv} = ${absUpdate(d.init).split(' = ').slice(1).join(' = ')}`;
                    if (d.init && refsName(d.init, m.stateVar)) flags.push('state-read');
                    return `__T("${id}")`;
                });
                if (s.kind !== 'var') flags.push('let-const');
                out.push(decls.join(', ') + ';');
                return;
            }
            if (refsName(s, m.stateVar)) flags.push('state-read');
            if (t.isFunctionDeclaration(s) || t.isClassDeclaration(s)) flags.push('decl-in-case');
            const hasRet = containsJump(s, ['return', 'throw']);
            const hasBrk = containsJump(s, ['break']);
            const hasCont = containsJump(s, ['continue']);
            if (hasBrk) flags.push('nested-break');
            if (hasCont) flags.push('nested-continue');
            let a = `__T("${id}");`;
            if (hasRet) a += ` if (__R("${id}")) return "r${id}";`;
            if (hasBrk) a += ` if (__R("${id}")) break;`;
            if (hasCont) a += ` if (__R("${id}")) continue;`;
            out.push(a);
        });
        lines.push(head + ' ' + out.join(' '));
    }
    const initExpr = m.init !== null ? String(m.init) : `__X("init")`;
    const code = `function sk(__T, __C, __R, __X) {\n  var ${sv} = ${initExpr};\n  for (; ${sv} !== ${m.term};) {\n    switch (${sv}) {\n      ${lines.join('\n      ')}\n    }\n  }\n  return "END";\n}`;
    return { code, flags: [...new Set(flags)] };
}

// ---------------- 执行与比对 ----------------
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let r = Math.imul(a ^ (a >>> 15), 1 | a);
        r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}
const LIMIT = 400;
function runTrace(fnSrc, seed, pCond, pR) {
    const rnd = mulberry32(seed);
    const trace = [];
    const push = (e) => { trace.push(e); if (trace.length > LIMIT) throw { __limit: true }; };
    const api = {
        __T: (id) => push('t' + id),
        __C: (id) => { const v = rnd() < pCond; push('c' + id + (v ? '+' : '-')); return v; },
        __R: (id) => { const v = rnd() < pR; push('r' + id + (v ? '+' : '-')); return v; },
        __X: (id) => { push('x' + id); throw { __nonliteral: true }; },
    };
    let outcome;
    try {
        const f = vm.runInNewContext('(' + fnSrc + ')', {}, { timeout: 2000 });
        outcome = 'ret:' + vm.runInNewContext('f(a.__T,a.__C,a.__R,a.__X)', { f, a: api }, { timeout: 2000 });
    } catch (e) {
        if (e && e.__limit) outcome = 'LIMIT';
        else if (e && e.__nonliteral) outcome = 'NONLIT';
        else if (typeof e === 'string') outcome = 'throw:' + e;
        else outcome = 'ERR:' + String(e && e.message || e).slice(0, 80);
    }
    return { trace: trace.join(' '), outcome };
}

function compare(origSrc, newSrc, seeds) {
    const probs = [0.5, 0.1, 0.9, 0.3, 0.7];
    for (let s = 1; s <= seeds; s++) {
        const pc = probs[s % probs.length];
        const pr = s % 3 === 0 ? 0.3 : 0.05;
        const a = runTrace(origSrc, s, pc, pr);
        const b = runTrace(newSrc, s, pc, pr);
        if (a.outcome === 'LIMIT' && b.outcome === 'LIMIT') {
            // 两边都没结束：比较前缀即可
            if (a.trace !== b.trace) return { ok: false, seed: s, a, b };
            continue;
        }
        if (a.outcome !== b.outcome || a.trace !== b.trace) return { ok: false, seed: s, a, b };
    }
    return { ok: true };
}

// ---------------- 主流程 ----------------
async function main() {
    const args = process.argv.slice(2);
    const transformer = path.resolve(args[0]);
    const which = args[1] || 'all';
    const seeds = Number((args.find((a) => a.startsWith('--seeds=')) || '--seeds=200').split('=')[1]);
    const only = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1];
    const dumpDir = (args.find((a) => a.startsWith('--dump=')) || '').split('=')[1];
    const dynOnly = args.includes('--dyn-only');
    const useDyn = args.includes('--dyninit') || dynOnly;
    const timeoutMs = Number((args.find((a) => a.startsWith('--timeout=')) || '--timeout=20000').split('=')[1]);
    const M = process.env.HOME + '/.dsh/dora/worktree/fuke-g1000/mirror';
    const FILES = {
        bundle: M + '/shell/src/chunks/bundle.ad349.js',
        other: M + '/shell/assets/other/index.28b75.js',
        main: M + '/game/assets/main/index.0c911.js',
    };
    const names = which === 'all' ? Object.keys(FILES) : which.split(',');
    if (dumpDir) fs.mkdirSync(dumpDir, { recursive: true });

    let worker = null;
    let pendingResolve = null;
    let msgId = 0;
    const startWorker = () => {
        worker = new Worker(fileURLToPath(import.meta.url), { workerData: { transformer } });
        worker.on('message', (m) => { if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r(m); } });
        worker.on('error', (e) => { worker = null; if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r({ error: 'worker error ' + e }); } });
    };
    const transform = (code) => new Promise((resolve) => {
        if (!worker) startWorker();
        const id = ++msgId;
        const timer = setTimeout(() => {
            if (pendingResolve) { pendingResolve = null; worker.terminate(); worker = null; resolve({ timeout: true }); }
        }, timeoutMs);
        pendingResolve = (m) => { clearTimeout(timer); resolve(m); };
        worker.postMessage({ id, code });
    });

    const report = {};
    for (const name of names) {
        const src = fs.readFileSync(FILES[name], 'utf8');
        let dynMap = null;
        if (useDyn) {
            // 在主线程里用被测变换器跑一遍原文件，拿到它动态求出的初值（按声明节点起点对应）
            const mod = await import(pathToFileURL(transformer).href);
            const exp = mod.default || mod[Object.keys(mod).find((k) => mod[k] && mod[k].visitor)];
            if (mod.configure && mod.dynInitStats) {
                const ol = console.log, ow = console.warn; console.log = () => {}; console.warn = () => {};
                try { mod.configure({ sourceCode: src }); traverse(babel.parseSync(src, { sourceType: 'script' }), exp.visitor); }
                finally { console.log = ol; console.warn = ow; }
                dynMap = new Map(mod.dynInitStats.list.map((x) => [x.declStart, x.value]));
                console.log(`[${name}] 变换器动态求出初值 ${dynMap.size} 个`);
            }
        }
        let machines = extractMachines(src, dynMap);
        if (dynOnly) machines = machines.filter((m) => m.dynInit);
        const r = { total: machines.length, unflattened: 0, kept: 0, equivalent: 0, NOT_EQUIVALENT: 0, timeout: 0, toolError: 0, flags: {}, bad: [], keptList: [] };
        for (let i = 0; i < machines.length; i++) {
            if (only !== undefined && only !== '' && String(i) !== only) continue;
            const m = machines[i];
            const sk = buildSkeleton(m);
            for (const f of sk.flags) r.flags[f] = (r.flags[f] || 0) + 1;
            const res = await transform(sk.code);
            if (res.timeout) { r.timeout++; r.bad.push({ i, loc: m.loc, sv: m.stateVar, why: 'timeout', cases: m.cases.length }); continue; }
            if (res.error) { r.toolError++; r.bad.push({ i, loc: m.loc, why: 'tool error ' + res.error.slice(0, 120) }); continue; }
            if (process.env.DEBUG_SM) console.log(sk.code + '\n// ---- out ----\n' + res.out);
            const stillFlat = /switch \(S\)/.test(res.out);
            if (stillFlat) { r.kept++; r.keptList.push({ i, loc: m.loc, sv: m.stateVar, cases: m.cases.length, flags: sk.flags }); }
            else r.unflattened++;
            const cmp = compare(sk.code, res.out, seeds);
            if (process.env.DEBUG_SM) { console.log('CMP', JSON.stringify(cmp).slice(0,300)); console.log('T1', JSON.stringify(runTrace(sk.code, 3, 0.5, 0.05))); console.log('T2', JSON.stringify(runTrace(res.out, 3, 0.5, 0.05))); }
            if (cmp.ok) r.equivalent++;
            else {
                r.NOT_EQUIVALENT++;
                r.bad.push({ i, loc: m.loc, sv: m.stateVar, cases: m.cases.length, flags: sk.flags, seed: cmp.seed, orig: cmp.a.outcome + ' | ' + cmp.a.trace.slice(0, 200), got: cmp.b.outcome + ' | ' + cmp.b.trace.slice(0, 200) });
                if (dumpDir) fs.writeFileSync(path.join(dumpDir, `${name}-${i}.txt`), sk.code + '\n\n// ===== 展开后 =====\n' + res.out);
            }
        }
        report[name] = r;
        console.log(`[${name}] 状态机 ${r.total} | 展开 ${r.unflattened} | 保留原样 ${r.kept} | 等价 ${r.equivalent} | 不等价 ${r.NOT_EQUIVALENT} | 超时 ${r.timeout} | 工具报错 ${r.toolError}`);
        if (Object.keys(r.flags).length) console.log(`   骨架标记: ${JSON.stringify(r.flags)}`);
        for (const b of r.bad.slice(0, 8)) console.log('   ✗ ' + JSON.stringify(b).slice(0, 400));
    }
    if (worker) worker.terminate();
    const outFile = process.env.EQUIV_OUT;
    if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 1));
}

if (isMainThread) await main();
