#!/usr/bin/env node
/**
 * dump-table-cdp.mjs — 带哨兵校验和陷阱检测的字符串表采集（CDP 直连版）
 * 
 * 逻辑：
 * 1. 导航到游戏页面，等命名空间就绪
 * 2. 采哨兵基准值（先解少量已知编号）
 * 3. 逐个编号解码，每解一个就校验哨兵
 * 4. 哨兵失败 → 记录陷阱编号 → 重载页面 → 跳过陷阱继续
 * 5. 产出：table（陷阱位置为 null）+ traps 列表
 * 
 * 用法：CDP_PORT=<端口> node dump-table-cdp.mjs <ns> <fn> <max> <gameUrl> <outFile>
 *   与 dump-table.mjs 的区别：不依赖 config.mjs/replica.json，直接连已开的 Chrome；适合沙箱页面和
 *   aeon 等"多命名空间 × 多解码函数"变体（每个 ns.fn 组合各跑一次）。
 *   SENTINEL_IDXS=逗号分隔编号：指定哨兵探测编号（默认一组分散编号；探测编号若恰是陷阱，重载后哨兵复验会失败退出）。
 *   来源：v3 lj500 机台（查出旧表从 #58 起错位）。
 * 日志只打印编号和长度。
 */
import fs from 'node:fs';

const PORT = Number(process.env.CDP_PORT || 18816);
const [ns, fn, maxS, gameUrl, outFile] = process.argv.slice(2);
const max = Number(maxS);
if (!ns || !fn || !max || !gameUrl || !outFile) {
  console.error('用法: node dump-table-cdp.mjs <ns> <fn> <max> <gameUrl> <outFile>');
  process.exit(1);
}

const progFile = outFile.replace(/\.json$/, '.progress.json');

async function connect() {
  const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = tabs.find(t => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}, timeout = 600000) => new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error('timeout ' + method)); } }, timeout);
  });
  return { send, close: () => ws.close() };
}

async function evalExpr(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const v = r.result?.result?.value;
  if (r.result?.exceptionDetails) throw new Error('eval exception');
  return v;
}

async function navigateAndWait(c) {
  await c.send('Page.enable');
  await c.send('Page.navigate', { url: gameUrl });
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const v = await evalExpr(c, `(function(){try{return typeof ${ns}!=="undefined"&&typeof ${ns}.${fn}==="function"}catch(e){return false}})()`);
      if (v === true) return true;
    } catch {}
  }
  return false;
}

// 找哨兵：从表的不同区域各取一些
async function findSentinels(c) {
  // 采几个分散的编号，记录基准值
  const probeIdxs = process.env.SENTINEL_IDXS ? process.env.SENTINEL_IDXS.split(',').map(Number) : [81, 84, 90, 100, 200, 350, 1000, 3000, 5000, 8000, 10000, 13000];
  const filtered = probeIdxs.filter(i => i <= max);
  const expr = `(function(){var ns=${ns},out=[];var idxs=${JSON.stringify(filtered)};for(var j=0;j<idxs.length;j++){try{var v=ns.${fn}(idxs[j]);out.push(v===undefined?null:typeof v==="string"?v:null)}catch(e){out.push(null)}}return JSON.stringify(out)})()`;
  const vals = JSON.parse(await evalExpr(c, expr));
  const sentinels = {};
  for (let j = 0; j < filtered.length; j++) {
    if (vals[j] !== null && vals[j].length > 0 && vals[j].length <= 30) {
      sentinels[filtered[j]] = vals[j];
    }
  }
  console.log(`哨兵: ${Object.keys(sentinels).length} 个 (编号: ${Object.keys(sentinels).map(k => '#' + k + ' len=' + sentinels[k].length).join(', ')})`);
  if (Object.keys(sentinels).length < 3) {
    console.error('哨兵太少，无法可靠检测陷阱');
    process.exit(2);
  }
  return sentinels;
}

async function checkSentinels(c, sentinels) {
  const keys = Object.keys(sentinels).map(Number);
  const expr = `(function(){var ns=${ns},out={};var idxs=${JSON.stringify(keys)};for(var j=0;j<idxs.length;j++){try{var v=ns.${fn}(idxs[j]);out[idxs[j]]=v===undefined?null:v}catch(e){out[idxs[j]]=null}}return JSON.stringify(out)})()`;
  const vals = JSON.parse(await evalExpr(c, expr));
  for (const k of keys) {
    if (vals[k] !== sentinels[k]) return false;
  }
  return true;
}

async function main() {
  const c = await connect();
  
  // 恢复进度
  let prog;
  if (fs.existsSync(progFile)) {
    prog = JSON.parse(fs.readFileSync(progFile, 'utf8'));
    console.log(`恢复进度: next=${prog.next}, traps=${prog.traps.length}`);
  } else {
    prog = { table: [], traps: [], next: 0, sentinels: null };
  }
  const traps = new Set(prog.traps);

  // 导航并等待
  console.log('导航到游戏页面...');
  if (!(await navigateAndWait(c))) { console.error('页面加载失败'); process.exit(2); }
  
  // 采哨兵
  if (!prog.sentinels) {
    prog.sentinels = await findSentinels(c);
    fs.writeFileSync(progFile, JSON.stringify(prog));
  }
  const sentinels = prog.sentinels;

  // 逐段采集：每段 STEP 个编号，解完检查哨兵
  const STEP = 100; // 每 100 个编号检查一次哨兵
  
  while (prog.next <= max) {
    const batchEnd = Math.min(prog.next + STEP - 1, max);
    const trapsJSON = JSON.stringify([...traps]);
    
    const expr = `(function(){var ns=${ns},S=${JSON.stringify(sentinels)},T=${trapsJSON},out=[];
      function ok(){for(var k in S){if(ns.${fn}(+k)!==S[k])return false}return true}
      for(var i=${prog.next};i<=${batchEnd};i++){
        if(T.indexOf(i)>=0){out.push(null);continue}
        var v;try{v=ns.${fn}(i)}catch(e){v=null}
        if(!ok())return JSON.stringify({trap:i,out:out});
        out.push(v===undefined?null:v);
      }
      return JSON.stringify({done:${batchEnd>=max},out:out})})()`;
    
    let result;
    try {
      result = JSON.parse(await evalExpr(c, expr));
    } catch (e) {
      console.error(`eval 错误 at ${prog.next}: ${e.message}`);
      fs.writeFileSync(progFile, JSON.stringify(prog));
      process.exit(3);
    }
    
    prog.table.push(...result.out);
    prog.next += result.out.length;
    
    if (result.trap !== undefined) {
      traps.add(result.trap);
      prog.traps = [...traps];
      prog.table.push(null); // 陷阱位置填 null
      prog.next += 1;
      console.log(`陷阱 #${result.trap}; progress ${prog.next}/${max}, traps=${prog.traps.length}`);
      
      // 重载页面
      fs.writeFileSync(progFile, JSON.stringify(prog));
      console.log('重载页面...');
      if (!(await navigateAndWait(c))) { console.error('重载失败'); process.exit(2); }
      // 确认哨兵在干净页面上OK
      if (!(await checkSentinels(c, sentinels))) {
        console.error('重载后哨兵仍然失败');
        process.exit(4);
      }
      continue;
    }
    
    if (prog.next % 2000 < STEP) {
      console.log(`progress ${prog.next}/${max}, traps=${prog.traps.length}`);
    }
    fs.writeFileSync(progFile, JSON.stringify(prog));
    
    if (result.done) break;
  }
  
  fs.writeFileSync(outFile, JSON.stringify(prog.table));
  const nonNull = prog.table.filter(x => x !== null).length;
  console.log(`\n完成 ${ns}.${fn}: ${prog.table.length} entries, ${nonNull} non-null, traps=[${[...traps].join(',')}]`);
  
  c.close();
  setTimeout(() => process.exit(0), 200);
}

main().catch(e => { console.error(e); process.exit(1); });
