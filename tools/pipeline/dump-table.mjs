#!/usr/bin/env node
// 导出 Jscrambler 字符串表（外壳专用：解码器里埋了"陷阱编号"，一旦解码就会改变内部状态、让后面全部错位）。
// 做法：每解一个编号就检查若干哨兵（已知正确的编号→值），哨兵变了就记下陷阱编号，重载页面后跳过陷阱继续。
// 用法：node ../../tools/rewrite/dump-table.mjs <name> <ns> <dec> <max> <哨兵JSON {"3684":"register"}> [已知陷阱,逗号分隔]
// 前提：../../tools/rewrite/start-ref.sh 已起；本脚本会反复执行 cdp.mjs boot 重载游戏（会注入替身外壳，只适合本地对照环境）。
// 在沙箱/厂商页面采表时设 DUMP_RELOAD_URL=<沙箱游戏地址>，改为 cdp.mjs nav <地址> 重载，不注入替身外壳。
// 注意：有的解码器按调用次序推进内部状态（aeon 的 V1j/f1D），多个解码器要各自独占一个干净页面采，不能在同一页面交替调用。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { ROOT } from './config.mjs';
process.chdir(ROOT);

const [name, ns, dec, maxS, sentS, trapsS] = process.argv.slice(2);
const max = Number(maxS), sentinels = JSON.parse(sentS);
const traps = new Set((trapsS || '').split(',').filter(Boolean).map(Number));
const outFile = `inspect/strings/${name}.strings.json`;
const progFile = `inspect/strings/${name}.progress.json`;
let prog = fs.existsSync(progFile) ? JSON.parse(fs.readFileSync(progFile, 'utf8')) : { table: [], traps: [], next: 0 };
for (const t of prog.traps) traps.add(t);
const sh = (args) => execFileSync('node', [decodeURIComponent(new URL('./cdp.mjs', import.meta.url).pathname), ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reload() {
  if (process.env.DUMP_RELOAD_URL) sh(['nav', process.env.DUMP_RELOAD_URL]); else sh(['boot']);
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    try {
      const v = sh(['eval', '-e', `(function(){try{return typeof ${ns}!=="undefined" && ${ns}.${dec}(${Object.keys(sentinels)[0]})}catch(e){return "E"}})()`]).trim();
      if (v === Object.values(sentinels)[0]) return true;
    } catch { /* 继续等 */ }
  }
  return false;
}

while (prog.next <= max) {
  if (!(await reload())) { console.error('reload failed / sentinel not ready'); process.exit(2); }
  const expr = `(function(){var S=${JSON.stringify(sentinels)},T=${JSON.stringify([...traps])},out=[],ns=${ns};
    function ok(){for(var k in S){if(ns.${dec}(+k)!==S[k])return false}return true}
    for(var i=${prog.next};i<=${max};i++){ if(T.indexOf(i)>=0){out.push(null);continue}
      var v;try{v=ns.${dec}(i)}catch(e){v=null}
      if(!ok()) return JSON.stringify({trap:i,out:out});
      out.push(v===undefined?null:v); }
    return JSON.stringify({done:true,out:out})})()`;
  const r = JSON.parse(sh(['eval', '-e', expr]).trim());
  prog.table.push(...r.out);
  prog.next += r.out.length;
  if (r.trap !== undefined) {
    traps.add(r.trap); prog.traps = [...traps]; prog.table.push(null); prog.next += 1;
    console.log(`trap at ${r.trap}; progress ${prog.next}/${max}`);
  }
  fs.writeFileSync(progFile, JSON.stringify(prog));
  if (r.done) break;
}
fs.writeFileSync(outFile, JSON.stringify(prog.table));
console.log(`done ${name}: ${prog.table.length} entries, traps=${[...traps].join(',')}`);
