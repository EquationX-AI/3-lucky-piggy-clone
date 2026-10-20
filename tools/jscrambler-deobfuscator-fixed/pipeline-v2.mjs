// 完整流水线：prepare → CFF(v2, 含动态初值) → final → 整文件生成
// 用法: node pipeline-v2.mjs <bundle|other|main> <输出路径>
// v2 需要 configure({ sourceCode }) 才能启用动态初值求解
import * as babel from '@babel/core';
import _traverse from '@babel/traverse';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const traverse = _traverse.default ?? _traverse;
const M = process.env.HOME + '/.dsh/dora/worktree/fuke-g1000/mirror';
const NAMED = {
    bundle: M + '/shell/src/chunks/bundle.ad349.js',
    other: M + '/shell/assets/other/index.28b75.js',
    main: M + '/game/assets/main/index.0c911.js',
};
const which = process.argv[2];
const input = NAMED[which] || which;
const output = process.argv[3];

const quiet = !process.env.CFF_VERBOSE;
const origLog = console.log;
if (quiet) console.log = (...a) => { const s = String(a[0] ?? ''); if (s.startsWith('[') || s.startsWith('去保护')) origLog(...a); };

const t0 = Date.now();
const code = fs.readFileSync(input, 'utf8');
const ast = babel.parseSync(code, { sourceType: 'script' });
origLog(`[pipe] parse ${Date.now() - t0}ms  (${path.basename(input)})`);

// ---- 1. prepare ----
const prepDir = new URL('./src/transformers/', import.meta.url).pathname;
const prepMod = await import(pathToFileURL(path.join(prepDir, 'prepare.js')).href);
const prepExp = prepMod.default || prepMod[Object.keys(prepMod)[0]];
let ts = Date.now();
traverse(ast, prepExp.visitor);
origLog(`[pipe] prepare ${Date.now() - ts}ms`);

// ---- 2. CFF (v2) ----
const cffPath = new URL('./cff-versions/v2-local-dyninit.js', import.meta.url).pathname;
const cffMod = await import(pathToFileURL(cffPath).href);
const cffExp = cffMod.default || cffMod[Object.keys(cffMod).find(k => cffMod[k] && cffMod[k].visitor)];
// configure 启用动态初值求解
if (cffMod.configure) {
    cffMod.configure({ sourceCode: code, dynamicInit: true, hostname: 'localhost' });
}
ts = Date.now();
traverse(ast, cffExp.visitor);
const cffMs = Date.now() - ts;
const dyn = cffMod.dynInitStats || {};
origLog(`[pipe] CFF ${cffMs}ms  (dyn-init: ${dyn.resolved || 0}/${dyn.tried || 0})`);

// ---- 3. final ----
const finMod = await import(pathToFileURL(path.join(prepDir, 'final.js')).href);
const finExp = finMod.default || finMod[Object.keys(finMod)[0]];
ts = Date.now();
traverse(ast, finExp.visitor);
origLog(`[pipe] final ${Date.now() - ts}ms`);

// ---- 4. generate ----
ts = Date.now();
const result = babel.transformFromAstSync(ast, null, { sourceType: 'script', code: true });
fs.writeFileSync(output, result.code, 'utf8');
origLog(`[pipe] generate ${Date.now() - ts}ms  out ${result.code.length} chars  total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
