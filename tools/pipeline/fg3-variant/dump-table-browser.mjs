#!/usr/bin/env node
// 在真 Chrome（无头、临时 profile）里导出"命名空间字符串表"变体的字符串表，并可交叉核对。
//
// 用法：
//   node tools/rewrite/fg3-variant/dump-table-browser.mjs <混淆文件.js> <输出.strings.json> [--verify] [--cdp-port N] [--chrome 路径]
//
// 为什么必须在真浏览器里：表工厂拼编码大串时会做环境探测，Node vm 里拼出来的是另一张表
// （fg3 main 实测 5201 项里 4708 项不同，Math/Date 都缺）。真 Chrome 里拿到的表，
// 程序自己按真实顺序访问的 154 次全部对得上。
//
// 做法：
//   1. scan-variant 识别：命名空间、表属性号、基址、哨兵编号、旋转编号。
//   2. 切骨架：表工厂之前的源码原样保留（偏移不变，自校验不触发），补上后面声明的顶层函数。
//   3. 本地起 HTTP，无头 Chrome 打开骨架页：先按顺序调哨兵编号，再跳过旋转编号逐个取值。
//   4. --verify：把访问器包装函数等长替换成记录版，整份原文件在浏览器里跑，
//      程序真实访问到的每个编号都和导出表比对，有一处不一致就报失败（退出码 1）。
// 产出：数组，下标=编号，取不到为 null，格式同 tools/rewrite/dump-table.mjs，可直喂 full-pipeline.mjs --strings。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { scanVariant } from './scan-variant.mjs';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const [file, outFile] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--cdp-port', '--chrome'].includes(args[i - 1])));
const VERIFY = args.includes('--verify');
const CHROME = flag('--chrome') || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!file || !outFile) { console.error('用法：dump-table-browser.mjs <混淆文件.js> <输出.strings.json> [--verify] [--cdp-port N]'); process.exit(2); }

const src = fs.readFileSync(file, 'utf-8');
const cfg = scanVariant(src);
if (cfg.variant !== 'jscrambler-namespace-string-table') {
  console.error('不是"命名空间字符串表"变体：标准 Jscrambler 走 deob-parallel.mjs（solveStringArray），外壳陷阱表走 dump-table.mjs');
  process.exit(1);
}
const { namespace: ns, tableProperty, tableFactoryStmtEnd, sentinelCalls = [], rotationIds = [], pureIds = [] } = cfg;
// 代码里实际用到的最大编号（访问器包装名 + 数字字面量）
const names = (cfg.accessorWrappers || []).flatMap((g) => g.names);
let maxId = 0;
for (const n of names) {
  const re = new RegExp(`\\.${n.replace(/\$/g, '\\$')}\\((\\d+)\\)`, 'gu');
  for (const m of src.matchAll(re)) maxId = Math.max(maxId, Number(m[1]));
}
if (!maxId) maxId = Math.max(...pureIds.slice(0, 6000));
console.log(`识别：${ns}[${tableProperty}]，访问器 ${names.join('/')}，哨兵 [${sentinelCalls}]，旋转编号 [${rotationIds}]，代码用到的最大编号 ${maxId}`);

// ---- 骨架：表工厂之前原样保留 + 之后的顶层函数声明（脚本开头会调用它们，函数声明会提升） ----
function buildSkeleton(code, cutAt) {
  const fns = [];
  const re = /(^|[;}])\s*function\s+[\p{L}\p{N}_$]+\s*\(/gu;
  const tail = code.slice(cutAt);
  for (const m of tail.matchAll(re)) {
    let start = cutAt + m.index + m[1].length;
    while (/\s/.test(code[start])) start++;
    let j = code.indexOf('(', start), d = 0;
    for (; j < code.length; j++) { if (code[j] === '(') d++; else if (code[j] === ')' && --d === 0) break; }
    j = code.indexOf('{', j); d = 0;
    for (; j < code.length; j++) { if (code[j] === '{') d++; else if (code[j] === '}' && --d === 0) break; }
    fns.push(code.slice(start, j + 1));
  }
  return code.slice(0, cutAt) + '\n;\n' + fns.join('\n;\n') + '\n';
}

// ---- 等长替换访问器包装（--verify 用；长度必须完全不变，否则自校验会把程序带进诱饵分支） ----
function hookedFull(code) {
  const g = (cfg.accessorWrappers || [])[0];
  if (!g) throw new Error('没找到访问器包装函数区间');
  const [A, B] = g.span;
  const h = `${ns}.${g.names.join(`=${ns}.`)}=function(a){var t=${ns}[${tableProperty}],k=t[Object.keys(t)[0]],r=k.apply(t,arguments);(${ns}.__L||(${ns}.__L=[])).push([a,r]);return r;};`;
  if (h.length > B - A) throw new Error(`挂钩代码比原区间长 ${h.length - (B - A)} 字符`);
  const out = code.slice(0, A) + h + ' '.repeat(B - A - h.length) + code.slice(B);
  if (out.length !== code.length) throw new Error('等长替换后长度变了');
  return out;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jsvariant-'));
fs.writeFileSync(path.join(work, 'skeleton.js'), buildSkeleton(src, tableFactoryStmtEnd));
fs.writeFileSync(path.join(work, 'skel.html'), `<!doctype html><meta charset="utf-8">
<script>window.__ERR=null;addEventListener('error',function(e){window.__ERR=String(e.message);});</script>
<script src="skeleton.js"></script>
<script>(function(){try{var o=${ns}[${tableProperty}],acc=o[Object.keys(o)[0]];
var S=${JSON.stringify(sentinelCalls)},R=${JSON.stringify(Object.fromEntries(rotationIds.map((r) => [r, 1])))},P=[],T=[];
for(var i=0;i<S.length;i++){try{P.push(acc(S[i]));}catch(e){P.push('ERR');}}
for(var id=0;id<=${maxId};id++){if(R[id]){T.push(null);continue;}var v;try{v=acc(id);}catch(e){v=null;}T.push(v===undefined?null:v);}
window.__PRIM=P;window.__TABLE=T;}catch(e){window.__DUMPERR=String(e);}window.__DONE=1;})();</script>`);
if (VERIFY) {
  fs.writeFileSync(path.join(work, 'main.hooked.js'), hookedFull(src));
  fs.writeFileSync(path.join(work, 'full.html'), `<!doctype html><meta charset="utf-8">
<script>window.__ERR=null;addEventListener('error',function(e){window.__ERR=String(e.message)+' @'+e.lineno+':'+e.colno;});</script>
<script src="main.hooked.js"></script><script>window.__DONE=1;</script>`);
}

const server = http.createServer((req, res) => {
  const f = path.join(work, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, ''));
  if (!f.startsWith(work) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const httpPort = server.address().port;

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
let cdpPort = Number(flag('--cdp-port')) || 0, chrome = null, profile = null;
if (!cdpPort) {
  cdpPort = await freePort();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jsvariant-chrome-'));
  chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`,
    '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function cdpReady() { for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${cdpPort}/json/version`); return; } catch { await sleep(500); } } throw new Error(`连不上 Chrome DevTools 端口 ${cdpPort}`); }

async function runPage(page, expr, settleMs = 0) {
  const t = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true }); return r.result?.result?.value; };
  await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/${page}` });
  let done = false;
  for (let i = 0; i < 240 && !done; i++) { await sleep(500); done = (await ev('window.__DONE||0')) === 1; }
  if (!done) throw new Error(`${page} 4 分钟内没跑完`);
  if (settleMs) await sleep(settleMs);
  const v = JSON.parse(await ev(expr));
  ws.close();
  await fetch(`http://127.0.0.1:${cdpPort}/json/close/${t.id}`).catch(() => {});
  return v;
}

let exitCode = 0;
try {
  await cdpReady();
  const r = await runPage('skel.html', 'JSON.stringify({err:window.__ERR,dumperr:window.__DUMPERR,prim:window.__PRIM,table:window.__TABLE,wd:navigator.webdriver})');
  if (r.dumperr || !Array.isArray(r.table)) throw new Error(`导出失败（页面脚本报错，详情在浏览器控制台）`);
  const okPrim = r.prim.every((x, i) => x === i + 1);
  console.log(`哨兵返回 ${JSON.stringify(r.prim)}${okPrim ? '（守卫按预期解除）' : '（不是 1..N，守卫没按预期走，表可能是诱饵）'}`);
  const table = r.table;
  fs.writeFileSync(outFile, JSON.stringify(table));
  const nonNull = table.filter((x) => x !== null).length;
  console.log(`写入 ${outFile}：${table.length} 项，非空 ${nonNull}`);
  // 代码用到的编号是否都有值
  const used = new Set();
  for (const n of names) for (const m of src.matchAll(new RegExp(`\\.${n.replace(/\$/g, '\\$')}\\((\\d+)\\)`, 'gu'))) used.add(Number(m[1]));
  const missing = [...used].filter((i) => table[i] === null || table[i] === undefined);
  const hitRot = [...used].filter((i) => rotationIds.includes(i));
  console.log(`代码用到 ${used.size} 个编号，表里缺 ${missing.length} 个${missing.length ? '：' + missing.slice(0, 10).join(',') : ''}`);
  if (hitRot.length) { console.log(`警告：代码会访问旋转编号 ${hitRot}，之后的映射会变，这张静态表不可直接替换`); exitCode = 1; }
  if (!okPrim || missing.length) exitCode = 1;

  if (VERIFY) {
    const v = await runPage('full.html', `JSON.stringify({err:window.__ERR,calls:(window.${ns}&&window.${ns}.__L)||null})`, 8000);
    const calls = (v.calls || []).slice(sentinelCalls.length);
    const bad = calls.filter(([id, val]) => table[id] !== val);
    // 安全规则：字符串表内容来自厂商代码，日志只打编号和长度，不打内容
    const stopAt = v.err ? (String(v.err).match(/@\d+:\d+$/) || ['（位置未知）'])[0] : '（正常跑完）';
    console.log(`核对：原文件在浏览器里停在 ${stopAt}；程序真实访问 ${calls.length} 次（去掉哨兵），与导出表不一致 ${bad.length} 次`);
    if (bad.length) { console.log('不一致的编号：', bad.slice(0, 10).map(([id, val]) => `${id}(实际长${String(val).length}/表长${String(table[id]).length})`).join(' ')); exitCode = 1; }
    if (calls.length < 20) { console.log('真实访问太少，核对不充分（程序过早停住），结果仅供参考'); }
  }
} catch (e) {
  console.error('失败：', e.message); exitCode = 1;
} finally {
  server.close();
  if (chrome) { chrome.kill(); await sleep(300); }
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
}
process.exit(exitCode);
