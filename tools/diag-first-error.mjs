// 首错定位：抓第一个未捕获异常 + 所有 .json 请求的状态 + 源码上下文
// 用法: node tools/diag-first-error.mjs "<url>" <cdp端口> <等待ms> [源码根目录]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const url = process.argv[2];
const PORT = Number(process.argv[3] || 9291);
const WAIT = Number(process.argv[4] || 20000);
const SRCROOT = process.argv[5] || 'mirror';
if (!url) { console.error('用法: node tools/diag-first-error.mjs "<url>" <cdpPort> <waitMs> [srcRoot]'); process.exit(2); }

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = `/tmp/firsterr-${Date.now()}`;
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wsUrl() {
  for (let i = 0; i < 100; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const p = l.find(t => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('CDP 未就绪');
}

const ws = new WebSocket(await wsUrl());
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let id = 0;
const pending = new Map();
const reqs = new Map();      // requestId -> {url}
const jsonReqs = [];         // {url,status,err}
const exceptions = [];
const consoles = [];

ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    reqs.set(m.params.requestId, { url: m.params.request.url });
  }
  if (m.method === 'Network.responseReceived') {
    const r = reqs.get(m.params.requestId);
    if (r) {
      const u = r.url;
      if (/\.json(\?|$)/.test(u)) jsonReqs.push({ url: u, status: m.params.response.status, from: 'response' });
    }
  }
  if (m.method === 'Network.loadingFailed') {
    const r = reqs.get(m.params.requestId);
    if (r && /\.json(\?|$)/.test(r.url)) jsonReqs.push({ url: r.url, status: null, err: m.params.errorText });
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    exceptions.push({
      text: d.text,
      desc: d.exception && d.exception.description,
      url: d.url,
      line: d.lineNumber,
      col: d.columnNumber,
      stack: d.stackTrace && d.stackTrace.callFrames,
    });
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    consoles.push(`[${m.params.type}] ` + m.params.args.map(a => a.value ?? a.description ?? a.type).join(' ').slice(0, 300));
  }
};

const send = (method, params = {}, ms = 15000) => new Promise(r => {
  const i = ++id;
  const t = setTimeout(() => { pending.delete(i); r({ __timeout: true }); }, ms);
  pending.set(i, m => { clearTimeout(t); r(m); });
  try { ws.send(JSON.stringify({ id: i, method, params })); } catch (e) { clearTimeout(t); r({ __err: String(e) }); }
});

await send('Runtime.enable');
await send('Network.enable');
await send('Page.enable');
await send('Page.navigate', { url });
await sleep(WAIT);

// 源码上下文
function sourceContext(u, line) {
  try {
    const m = String(u || '').match(/\/([^/]+\.js)(\?|$)/);
    if (!m) return null;
    const base = m[1];
    const cands = [];
    (function walk(d, depth) {
      if (depth > 4) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.name === base) cands.push(p);
      }
    })(SRCROOT, 0);
    if (!cands.length) return null;
    const file = cands[0];
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const L = Number(line) || 0;
    const from = Math.max(0, L - 2), to = Math.min(lines.length, L + 3);
    return { file, snippet: lines.slice(from, to).map((s, i) => (from + i + 1) + ': ' + s.slice(0, 300)).join('\n') };
  } catch { return null; }
}

console.log('=== 第一个未捕获异常 ===');
if (!exceptions.length) console.log('（无）');
else {
  const e = exceptions[0];
  console.log('text :', e.text);
  console.log('desc :', (e.desc || '').split('\n').slice(0, 4).join('\n        '));
  console.log('at   :', e.url + ':' + e.line + ':' + e.col);
  const ctx = sourceContext(e.url, e.line);
  if (ctx) console.log('源码 : ' + ctx.file + '\n' + ctx.snippet);
  console.log('异常总数:', exceptions.length);
}

console.log('\n=== .json 请求（状态 / 失败原因）===');
if (!jsonReqs.length) console.log('（无 .json 请求）');
const seen = new Set();
for (const r of jsonReqs) {
  const k = r.url + '|' + (r.status ?? r.err);
  if (seen.has(k)) continue; seen.add(k);
  console.log((r.status ? String(r.status) : 'FAIL').padEnd(5), r.err ? ('[' + r.err + '] ') : '', r.url.slice(0, 150));
}

console.log('\n=== 最后 10 条 console ===');
console.log(consoles.slice(-10).join('\n') || '（无）');

ws.close();
try { chrome.kill('SIGKILL'); } catch {}
process.exit(0);
