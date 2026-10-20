#!/usr/bin/env node
// 最小 CDP 工具：只开 Page 域，Runtime.evaluate 直接调（不 Runtime.enable，避免触发反调试）
// 用法：
//   node ../../tools/rewrite/cdp.mjs boot [extraInjectFile...]  注入 combined-shell.js (+额外脚本) 并导航到游戏
//   node ../../tools/rewrite/cdp.mjs eval <file.js|-e expr>     在页面里执行（awaitPromise）并打印结果
//   node ../../tools/rewrite/cdp.mjs shot <out.png>             截图
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT, CFG, shellFile } from './config.mjs';
const PORT = Number(process.env.CDP_PORT || 9688);
const GAME_URL = process.env.GAME_URL ||
  CFG.refUrl;

async function connect() {
  const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = tabs.find(t => t.type === 'page' && (!process.env.CDP_PAGE_MATCH || (t.url || '').includes(process.env.CDP_PAGE_MATCH)));
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}, timeout = 120000) => new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error('timeout ' + method)); } }, timeout);
  });
  return { send, close: () => ws.close() };
}

const [cmd, ...args] = process.argv.slice(2);
const c = await connect();
try {
  if (cmd === 'boot') {
    await c.send('Page.enable');
    // REPLICA_SHELL=ts：注入我们构建的 TS 外壳（dist/overlay/<gamePath>/replica-shell.js），否则注入原 JS 替身外壳
    const shellFile = process.env.SHELL_JS_FILE || (process.env.REPLICA_SHELL === 'ts' ? shellFile() : path.join(ROOT, 'runtime/combined-shell.js'));
    const sources = [shellFile, ...args];
    for (const f of sources) {
      await c.send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(f, 'utf8') });
      console.log('injected', f);
    }
    await c.send('Page.navigate', { url: GAME_URL });
    console.log('navigated');
  } else if (cmd === 'nav') {
    await c.send('Page.enable');
    await c.send('Page.navigate', { url: args[0] });
    await new Promise(r => setTimeout(r, 2500));
    console.log('navigated', args[0]);
  } else if (cmd === 'eval') {
    const expr = args[0] === '-e' ? args[1] : fs.readFileSync(args[0], 'utf8');
    const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, 900000);
    const res = r.result || {};
    if (res.exceptionDetails) console.log('EXCEPTION', JSON.stringify(res.exceptionDetails).slice(0, 2000));
    const v = res.result && res.result.value;
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
  } else if (cmd === 'click') {
    // node ../../tools/rewrite/cdp.mjs click <节点路径尾段，如 Btn/btn_comm>：按节点中心发真实鼠标点击
    const want = args[0];
    const expr = `(function(){var want=${JSON.stringify(want)},hits=[];
      (function w(n,p){var path=p+'/'+n.name;if(n.activeInHierarchy&&(path===want||path.endsWith('/'+want)))hits.push(n);n.children.forEach(function(c){w(c,path)})})(cc.director.getScene(),'');
      if(hits.length!==1)return JSON.stringify({err:'hits='+hits.length});
      var ut=hits[0].getComponent("cc.UITransform");var r=ut.getBoundingBoxToWorld();var vis=cc.view.getVisibleSize();
      var b=cc.game.canvas.getBoundingClientRect();var cx=r.x+r.width/2,cy=r.y+r.height/2;
      return JSON.stringify({x:b.left+cx/vis.width*b.width,y:b.top+(1-cy/vis.height)*b.height})})()`;
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    const pos = JSON.parse(r.result.result.value);
    if (pos.err) { console.log(want, pos.err); process.exit(5); }
    if (process.env.TOUCH === '1') {
      // 移动端：真实触摸（touchStart → touchEnd）
      await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pos.x, y: pos.y, id: 1 }] });
      await new Promise((res) => setTimeout(res, 80));
      await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await c.send('Input.dispatchMouseEvent', { type, x: pos.x, y: pos.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
      await new Promise((res) => setTimeout(res, 80));
    }
    console.log('clicked', want, JSON.stringify(pos));
  } else if (cmd === 'shot') {
    // 不调 bringToFront（会卡住）；Chrome 已关闭遮挡节流，后台也能截图
    const r = await c.send('Page.captureScreenshot', { format: 'png' }, 20000);
    fs.writeFileSync(args[0], Buffer.from(r.result.data, 'base64'));
    console.log('saved', args[0]);
  } else {
    console.log('usage: boot|eval|shot');
  }
} finally { c.close(); setTimeout(() => process.exit(0), 100); }
