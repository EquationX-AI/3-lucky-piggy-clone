#!/usr/bin/env node
// 并发反混淆：每个文件一个独立子进程同时跑（原来是一个循环串行跑三个文件）。
// 用法：node tools/rewrite/deob-parallel.mjs <输出目录> <混淆文件1> [混淆文件2 ...]
//   输出：<输出目录>/<原文件名去掉 .js>.deob.js，以及 timing.json（每个文件用时 + 总用时 + 串行估算）
// 工具：tools/jscrambler-deobfuscator-fixed（worstperson fork 的 all-fixes 分支，commit e95ff95）。
// 反混淆是纯 CPU 计算、文件之间没有依赖，所以按文件并发；总用时 ≈ 最慢的那个文件，而不是三个相加。
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEOB = path.resolve(HERE, '../jscrambler-deobfuscator-fixed/src/deobfuscator.js');

// 反混淆器遇到解不开的东西时只打一行 "Aborting …" 就跳过那一步，processSample 仍然返回 true
// 并照常写出文件。只看返回值 + 文件存在会把这种"没真正反混淆完"的产物报成完成（假成功）。
const ABORT_RE = /Aborting/;

if (process.argv[2] === '--child') {
  const [, , , src, dst] = process.argv;
  const { processSample } = await import(DEOB);
  const t0 = Date.now();
  // 把子进程的 console 输出接一份下来，用来识别 Aborting（输出照旧转发）
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const tee = (fn) => (...a) => { try { lines.push(a.map(String).join(' ')); } catch { /* 忽略 */ } fn.apply(console, a); };
  console.log = tee(orig.log); console.warn = tee(orig.warn); console.error = tee(orig.error);
  let ret = false, err = null;
  try { ret = await processSample(src, dst); } catch (e) { err = e; console.error(e); }
  console.log = orig.log; console.warn = orig.warn; console.error = orig.error;
  const aborts = lines.filter((l) => ABORT_RE.test(l));
  const ok = ret !== false && !err && aborts.length === 0 && fs.existsSync(dst);
  const msg = { src, dst, ok, ms: Date.now() - t0, abortCount: aborts.length, aborts: aborts.slice(0, 3),
    error: err ? String(err).slice(0, 300) : undefined };
  // process.send 是异步的，发完立刻 exit 会丢掉消息；等回调回来再退出
  const done = () => process.exit(0);
  if (typeof process.send === 'function') { const guard = setTimeout(done, 10000); process.send(msg, () => { clearTimeout(guard); done(); }); }
  else done();
} else {
  await runParent();
}

async function runParent() {
  const [out, ...files] = process.argv.slice(2);
  if (!out || !files.length) { console.error('用法：deob-parallel.mjs <输出目录> <混淆文件...>'); process.exit(2); }
  fs.mkdirSync(out, { recursive: true });
  const t0 = Date.now();
  const results = await Promise.all(files.map((f) => new Promise((resolve) => {
    const src = path.resolve(f);
    const dst = path.join(path.resolve(out), path.basename(f).replace(/\.js$/, '') + '.deob.js');
    console.log(`开始 ${path.basename(f)}`);
    const child = fork(fileURLToPath(import.meta.url), ['--child', src, dst], { execArgv: ['--max-old-space-size=8192', '--stack-size=65500'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    let res = null;
    child.on('message', (m) => { res = m; });
    child.on('exit', (code) => {
      const r = res || { src, dst, ok: false, ms: Date.now() - t0, exit: code };
      if (r.ok) console.log(`完成 ${path.basename(f)} ${(r.ms / 1000).toFixed(0)} 秒`);
      else console.log(`失败 ${path.basename(f)} ${(r.ms / 1000).toFixed(0)} 秒：${r.error || (r.abortCount ? `反混淆中止 ${r.abortCount} 处（${r.aborts[0]}）` : `子进程没有返回结果，退出码 ${code}`)}`);
      resolve(r);
    });
  })));
  const total = Date.now() - t0;
  const serial = results.reduce((a, r) => a + r.ms, 0);
  const timing = { files: results, parallelMs: total, serialEstimateMs: serial };
  fs.writeFileSync(path.join(out, 'timing.json'), JSON.stringify(timing, null, 1));
  console.log(`并发总用时 ${(total / 1000).toFixed(0)} 秒；按文件相加（相当于串行）${(serial / 1000).toFixed(0)} 秒`);
  const bad = results.filter((r) => !r.ok);
  if (bad.length) console.log(`有 ${bad.length} 个文件没反混淆成功：${bad.map((r) => path.basename(r.src)).join('、')}——产物即使写出了也不要当成功用`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
