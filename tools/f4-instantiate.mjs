// F4 探针：在页面里实例化 Prefab/MainGame(918)，报告节点树与 GameView 组件
// 用法: node tools/f4-instantiate.mjs <url> <cdpPort> <waitMs> <outPng>
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const url = process.argv[2];
const PORT = Number(process.argv[3] || 9305);
const WAIT = Number(process.argv[4] || 22000);
const OUT = process.argv[5] || '/tmp/f4.png';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/f4-${Date.now()}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 100; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const p = l.find(t => t.type === 'page');
    if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch {}
  await sleep(200);
}
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pend = new Map(); const logs = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') logs.push('[' + m.params.type + '] ' + m.params.args.map(a => a.value ?? a.description ?? a.type).join(' ').slice(0, 300));
  if (m.method === 'Runtime.exceptionThrown') logs.push('[EXC] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 300));
};
const send = (method, params = {}, ms = 20000) => new Promise(r => {
  const i = ++id; const t = setTimeout(() => { pend.delete(i); r({ __timeout: true }); }, ms);
  pend.set(i, m => { clearTimeout(t); r(m); });
  try { ws.send(JSON.stringify({ id: i, method, params })); } catch (e) { clearTimeout(t); r({ __err: String(e) }); }
});
const ev = async (expr, ms) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms);
  if (r.__timeout) return { __timeout: true };
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
  return r.result?.result?.value;
};

await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url });
await sleep(WAIT);

const before = await ev(`(function(){
  var s = cc.director.getScene();
  var names = [];
  function walk(n,d){ if(d>3) return; names.push(n.name); (n.children||[]).forEach(function(c){walk(c,d+1)}); }
  if (s) walk(s,0);
  var bundle = cc.assetManager.getBundle('game');
  return { scene: s && s.name, nodeCount: names.length, sample: names.slice(0,12), bundle: bundle ? 'loaded' : 'missing' };
})()`, 15000);

const inst = await ev(`new Promise(function(resolve){
  function done(o){ resolve(o); }
  try {
    var bundle = cc.assetManager.getBundle('game');
    var go = function(b){
      b.load('Prefab/MainGame', cc.Prefab, function(err, prefab){
        if (err) return done({ step:'load', error: String(err && (err.message||err)) });
        try {
          var node = cc.instantiate(prefab);
          node.name = (node.name||'MainGame') + '_F4';
          cc.director.getScene().addChild(node);
          var cnt = 0, gv = null;
          (function walk(n){ var cs = n._components||[]; for (var i=0;i<cs.length;i++){ cnt++; if (cs[i] && cs[i].m_spinAck !== undefined && !gv) gv = n.name + '#' + (cs[i].constructor && cs[i].constructor.name); } (n.children||[]).forEach(walk); })(node);
          done({ step:'ok', name: node.name, children: (node.children||[]).length, compCount: cnt, gameView: gv, active: node.activeInHierarchy });
        } catch(e){ done({ step:'instantiate', error: String(e) }); }
      });
    };
    if (bundle) go(bundle);
    else cc.assetManager.loadBundle('game', function(e,b){ if (e) return done({step:'loadBundle', error:String(e)}); go(b); });
  } catch(e){ done({ step:'outer', error:String(e) }); }
})`, 40000);

await sleep(3000);

const after = await ev(`(function(){
  var s = cc.director.getScene();
  var found = null, count = 0;
  function walk(n){ count++; if (!found && /_F4$/.test(n.name)) found = n.name; (n.children||[]).forEach(walk); }
  if (s) walk(s,0);
  var gv = null, comps = 0;
  function walk2(n){ var cs=n._components||[]; for(var i=0;i<cs.length;i++){ comps++; if(cs[i] && cs[i].m_spinAck!==undefined && !gv) gv = n.name; } (n.children||[]).forEach(walk2); }
  if (s) walk2(s);
  return { scene: s && s.name, totalNodes: count, f4Node: found, spinAckComp: gv, scannedComps: comps, frames: cc.director.getTotalFrames ? cc.director.getTotalFrames() : null };
})()`, 15000);

const shot = await send('Page.captureScreenshot', { format: 'png' }, 20000);
if (shot.result?.data) fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));

console.log('=== BEFORE ==='); console.log(JSON.stringify(before, null, 1));
console.log('=== INSTANTIATE ==='); console.log(JSON.stringify(inst, null, 1));
console.log('=== AFTER ==='); console.log(JSON.stringify(after, null, 1));
console.log('=== LOGS (last 8) ==='); console.log(logs.slice(-8).join('\n'));

ws.close(); try { chrome.kill('SIGKILL'); } catch {}
process.exit(0);
