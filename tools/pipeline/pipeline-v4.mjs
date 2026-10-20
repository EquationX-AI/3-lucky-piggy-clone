// 流水线 v4：最小侵入 deprotect → prepare → CFF(v2) → final → deprotect(补漏) → 生成
// 核心变化：deprotect 不再清空 selfCheck wrapper、MurmurHash 工厂、自检容器 IIFE
// 只中和处罚效果（掩码、违规码、处罚 if），保留校验函数原始实现
// 这样 r07/y8c/B7A/K1L 的返回值在运行时保持正确，不透明谓词能正确求值
//
// 用法: node pipeline-v4.mjs <bundle|other|main> <输出路径> <命名空间>
import * as babel from '@babel/core';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const traverse = _traverse.default ?? _traverse;
const generate = _generate.default ?? _generate;

// CFF 实现与 deob-parallel.mjs / full-pipeline.mjs 共用，放在兄弟目录 tools/jscrambler-deobfuscator-fixed/。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEOB_SIBLING = path.resolve(HERE, '../jscrambler-deobfuscator-fixed');
function deobPath(rel) {
  const local = path.join(HERE, rel);
  if (fs.existsSync(local)) return local;
  const sibling = path.join(DEOB_SIBLING, rel);
  if (fs.existsSync(sibling)) return sibling;
  throw new Error(`找不到反混淆实现 ${rel}：既不在 ${HERE}，也不在 ${DEOB_SIBLING}`);
}
const M = process.env.HOME + '/.dsh/dora/worktree/fuke-g1000/mirror';
const NAMED = {
    bundle: M + '/shell/src/chunks/bundle.ad349.js',
    other: M + '/shell/assets/other/index.28b75.js',
    main: M + '/game/assets/main/index.0c911.js',
};
const NS_MAP = { bundle: 'w3Qmi', other: 'g0fHR', main: 'H6уCk' };
const which = process.argv[2];
const input = NAMED[which] || which;
const output = process.argv[3];
const ns = process.argv[4] || NS_MAP[which];

const origLog = console.log, origWarn = console.warn;
const quiet = !process.env.CFF_VERBOSE;
if (quiet) { console.log = () => {}; console.warn = () => {}; }
const say = (...a) => origLog(...a);

const t0 = Date.now();
const code = fs.readFileSync(input, 'utf8');
let ast = babel.parseSync(code, { sourceType: 'script' });
say(`[v4] parse ${Date.now() - t0}ms  (${path.basename(input)})`);

// ---- 0. 最小侵入 deprotect ----
// 只中和处罚效果，不清空任何函数体（selfCheck/MurmurHash/容器IIFE保留原样）
function runMinimalDeprotect(ast, sourceCode, ns, label) {
    let changes = 0;
    
    // 找违规码变量（被 = xxx || yyy 赋值的）
    const violVars = new Set();
    traverse(ast, { noScope: true, AssignmentExpression(p) {
        if (!t.isIdentifier(p.node.left)) return;
        if (t.isLogicalExpression(p.node.right, { operator: '||' }) &&
            t.isIdentifier(p.node.right.left, { name: p.node.left.name }))
            violVars.add(p.node.left.name);
    }});
    
    // 找掩码变量（被 ^= 自身清零的）
    const maskVars = new Set();
    traverse(ast, { noScope: true, AssignmentExpression(p) {
        if (p.node.operator === '^=' && t.isIdentifier(p.node.left) && t.isIdentifier(p.node.right) &&
            p.node.left.name === p.node.right.name) maskVars.add(p.node.left.name);
    }});

    // 中和掩码清零：VAR ^= VAR → VAR = VAR
    traverse(ast, { noScope: true, AssignmentExpression(p) {
        if (p.node.operator !== '^=') return;
        if (t.isIdentifier(p.node.left) && t.isIdentifier(p.node.right) &&
            p.node.left.name === p.node.right.name && maskVars.has(p.node.left.name)) {
            p.node.operator = '='; changes++;
        }
    }});

    // or-assign 中和：VIOL = VIOL || xxx → 保留兜底对象或设 null
    traverse(ast, { noScope: true, AssignmentExpression(p) {
        if (p.node.operator !== '=') return;
        if (!t.isIdentifier(p.node.left) || !violVars.has(p.node.left.name)) return;
        if (t.isLogicalExpression(p.node.right, { operator: '||' }) &&
            t.isIdentifier(p.node.right.left, { name: p.node.left.name })) {
            const rhs = p.node.right.right;
            if (t.isObjectExpression(rhs) || t.isFunctionExpression(rhs) || t.isArrowFunctionExpression(rhs)) {
                p.get('right').replaceWith(t.cloneNode(rhs, true));
            } else {
                p.get('right').replaceWith(t.nullLiteral());
            }
            changes++;
        }
    }});

    // 追踪派生违规码变量
    const extViolVars = new Set(violVars);
    traverse(ast, { noScope: true, AssignmentExpression(p) {
        if (p.node.operator !== '=') return;
        if (!t.isIdentifier(p.node.left)) return;
        const rhs = p.node.right;
        if (t.isLogicalExpression(rhs, { operator: '||' }) && t.isIdentifier(rhs.left) && extViolVars.has(rhs.left.name))
            extViolVars.add(p.node.left.name);
        if (t.isIdentifier(rhs) && extViolVars.has(rhs.name))
            extViolVars.add(p.node.left.name);
    }});

    // 处罚 if 删除
    traverse(ast, { noScope: true, IfStatement(p) {
        const test = p.node.test;
        if (t.isLogicalExpression(test, { operator: '&&' }) &&
            t.isIdentifier(test.left) && extViolVars.has(test.left.name)) {
            p.remove(); changes++;
        }
    }});

    // *** 关键区别：不清空 selfCheck wrapper、MurmurHash 工厂、自检容器 IIFE ***
    // 校验函数保持原始实现，r07/y8c/B7A/K1L 能返回正确的值

    // X0gnGEw 域名锁 → return true（这是唯一清空的函数）
    traverse(ast, { noScope: true, FunctionDeclaration(p) {
        if (!p.node.id) return;
        if (p.node.id.name === 'X0gnGEw') {
            p.get('body').replaceWith(t.blockStatement([t.returnStatement(t.booleanLiteral(true))]));
            changes++;
        }
    }});

    // u36hk03 通知函数清空
    traverse(ast, { noScope: true, ObjectProperty(p) {
        if ((t.isIdentifier(p.node.key, { name: 'u36hk03' }) || t.isStringLiteral(p.node.key, { value: 'u36hk03' })) &&
            t.isFunctionExpression(p.node.value)) {
            p.get('value').replaceWith(t.functionExpression(null, p.node.value.params, t.blockStatement([])));
            changes++;
        }
    }});
    
    // 命名空间修复
    if (ns) {
        const firstStmt = ast.program.body[0];
        if (t.isVariableDeclaration(firstStmt)) {
            const decl = firstStmt.declarations[0];
            if (t.isIdentifier(decl.id, { name: '_global' }) && t.isIdentifier(decl.init, { name: 'globalThis' })) {
                firstStmt.kind = 'var';
                decl.init = t.identifier(ns);
                changes++;
            }
        }
    }

    say(`[v4] ${label}: violVars=${violVars.size}(+${extViolVars.size - violVars.size}) mask=${maskVars.size} changes=${changes}`);
    return changes;
}

let ts = Date.now();
const deprot1 = runMinimalDeprotect(ast, code, ns, 'deprotect-1(原始)');
say(`[v4] deprotect-1 ${Date.now() - ts}ms  (${deprot1} 处)`);

// ---- 1. prepare ----
const prepDir = deobPath('src/transformers');
const prepMod = await import(pathToFileURL(path.join(prepDir, 'prepare.js')).href);
const prepExp = prepMod.default || prepMod[Object.keys(prepMod)[0]];
ts = Date.now();
traverse(ast, prepExp.visitor);
say(`[v4] prepare ${Date.now() - ts}ms`);

// ---- 2. CFF (v2) ----
const cffPath = path.join(deobPath('cff-versions'), 'v2-local-dyninit.js');
const cffMod = await import(pathToFileURL(cffPath).href);
const cffExp = cffMod.default || cffMod[Object.keys(cffMod).find(k => cffMod[k] && cffMod[k].visitor)];
if (cffMod.configure) cffMod.configure({ sourceCode: code, dynamicInit: true, hostname: 'localhost' });
ts = Date.now();
traverse(ast, cffExp.visitor);
const dyn = cffMod.dynInitStats || {};
say(`[v4] CFF ${Date.now() - ts}ms  (dyn-init: ${dyn.resolved || 0}/${dyn.tried || 0})`);

// ---- 3. final ----
const finMod = await import(pathToFileURL(path.join(prepDir, 'final.js')).href);
const finExp = finMod.default || finMod[Object.keys(finMod)[0]];
ts = Date.now();
traverse(ast, finExp.visitor);
say(`[v4] final ${Date.now() - ts}ms`);

// ---- 4. 第二轮 deprotect（CFF 后，补漏） ----
ts = Date.now();
const deprot2 = runMinimalDeprotect(ast, null, null, 'deprotect-2(CFF后)');
say(`[v4] deprotect-2 ${Date.now() - ts}ms  (${deprot2} 处)`);

// ---- 5. generate ----
ts = Date.now();
const result = babel.transformFromAstSync(ast, null, { sourceType: 'script', code: true });
fs.writeFileSync(output, result.code, 'utf8');
say(`[v4] generate ${Date.now() - ts}ms  out ${result.code.length} chars  total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
