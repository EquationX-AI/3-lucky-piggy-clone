#!/usr/bin/env node
// 极简静态服务，给原版对照环境（start-ref.sh）和采集期"本地镜像跑一遍"用。
//
// 用法：
//   node tools/rewrite/serve.mjs --port 5630 --root <hostroot> [--root <overlay>] [--log serve.log]
//   node tools/rewrite/serve.mjs --port 7500 --root mirrors/<slug>_<date> --stub-api --log server.log
//
// 参数：
//   --port <端口>     监听端口（必填）
//   --root <目录>     静态根，可重复；按出现顺序优先（第一个命中的文件胜出）
//   --block <正则>    命中 pathname 就返回 404（可重复），用于"屏蔽某个文件"做对照实验
//   --stub-api        找不到文件、且路径像接口（/api/*、/smartnotice、/webservice）时返回 200 空响应
//   --log <文件>      JSONL 访问日志；404 会带 "miss":true，可直接 grep '"miss":true' server.log
//   --bind <地址>     监听地址，默认 127.0.0.1
//   -h, --help        显示帮助
//
// 行为：
//   - 只读写本地目录，不代理、不改写；目录请求补 index.html，缺结尾斜杠先 301
//   - 路径穿越（../）拒绝；只监听回环地址
//   - 响应带 CORS 和 no-cache，方便浏览器里反复刷新
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `serve.mjs — 极简静态服务（原版对照环境 / 本地镜像检查）

用法：
  node tools/rewrite/serve.mjs --port <端口> --root <目录> [--root <覆盖目录>] [--log serve.log]
  node tools/rewrite/serve.mjs --port 7500 --root mirrors/fg5_2026-10-17 --stub-api --log server.log

参数：--port / --root（可重复，前面的优先）/ --block <正则> / --stub-api / --log / --bind / -h`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.plist': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.atlas': 'text/plain; charset=utf-8',
  '.skel': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.astc': 'application/octet-stream',
  '.cconb': 'application/octet-stream',
  '.ccon': 'application/octet-stream',
  '.data': 'application/octet-stream',
  '.zip': 'application/zip',
};

function parseArgs(argv) {
  const opt = { port: 0, roots: [], blocks: [], stubApi: false, log: '', bind: '127.0.0.1' };
  const take = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} 需要一个值`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else if (a === '--port') { opt.port = Number(take(i, a)); i++; }
    else if (a === '--root') { opt.roots.push(take(i, a)); i++; }
    else if (a === '--block') { opt.blocks.push(take(i, a)); i++; }
    else if (a === '--stub-api') opt.stubApi = true;
    else if (a === '--log') { opt.log = take(i, a); i++; }
    else if (a === '--bind') { opt.bind = take(i, a); i++; }
    else throw new Error(`不认识的参数：${a}`);
  }
  if (!Number.isInteger(opt.port) || opt.port <= 0 || opt.port > 65535) throw new Error('--port 必须是 1-65535 的整数');
  if (!opt.roots.length) throw new Error('至少要给一个 --root');
  try { opt.blocks = opt.blocks.map((p) => new RegExp(p)); } catch (e) { throw new Error(`--block 正则不合法：${e.message}`); }
  return opt;
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
let opt;
try { opt = parseArgs(process.argv.slice(2)); } catch (e) {
  console.error(`[serve] ${e.message}\n\n${USAGE}`);
  process.exit(2);
}

const roots = opt.roots.map((r) => path.resolve(r));
for (const r of roots) {
  if (!fs.existsSync(r)) { console.error(`[serve] --root 不存在：${r}`); process.exit(2); }
}
if (opt.log) fs.mkdirSync(path.dirname(path.resolve(opt.log)), { recursive: true });

function writeLog(entry) {
  if (!opt.log) return;
  try { fs.appendFileSync(opt.log, JSON.stringify(entry) + '\n'); } catch { /* 日志失败不影响响应 */ }
}

function findFile(pathname) {
  for (const root of roots) {
    const candidate = path.resolve(root, '.' + pathname);
    if (candidate !== root && !candidate.startsWith(root + path.sep)) continue;
    let stat;
    try { stat = fs.statSync(candidate); } catch { continue; }
    if (stat.isFile()) return { file: candidate, stat };
    if (stat.isDirectory()) {
      const index = path.join(candidate, 'index.html');
      try {
        const istat = fs.statSync(index);
        if (istat.isFile()) return { file: index, stat: istat, dir: candidate };
      } catch { /* 目录没有 index.html，继续找下一个 root */ }
    }
  }
  return null;
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'no-cache',
  };
  const send = (status, headers, body) => {
    res.writeHead(status, { ...cors, ...headers });
    if (req.method === 'HEAD' || body === undefined) res.end();
    else res.end(body);
  };

  if (req.method === 'OPTIONS') {
    writeLog({ t: new Date().toISOString().slice(11, 23), method: req.method, path: req.url, status: 204 });
    return send(204);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writeLog({ t: new Date().toISOString().slice(11, 23), method: req.method, path: req.url, status: 405 });
    return send(405, { 'Content-Type': 'text/plain; charset=utf-8' }, 'method not allowed');
  }

  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); } catch {
    writeLog({ t: new Date().toISOString().slice(11, 23), method: req.method, path: req.url, status: 400 });
    return send(400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'bad url');
  }

  const blocked = opt.blocks.find((re) => re.test(pathname));
  if (blocked) {
    writeLog({ t: new Date().toISOString().slice(11, 23), method: req.method, path: pathname, status: 404, blocked: true });
    return send(404, { 'Content-Type': 'text/plain; charset=utf-8' }, `blocked by ${blocked}`);
  }

  const hit = findFile(pathname);
  if (!hit) {
    const apiLike = pathname.startsWith('/api/') || pathname.includes('smartnotice') || pathname.includes('webservice');
    if (opt.stubApi && apiLike) {
      const isPlain = pathname.includes('webservice');
      writeLog({ t: new Date().toISOString().slice(11, 23), method: req.method, path: pathname, status: 200, stub: true });
      return send(200, { 'Content-Type': isPlain ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8' }, isPlain ? 'ok' : '{}');
    }
    writeLog({ t: new Date().toISOString().slice(11, 23), method: req.method, path: pathname, status: 404, miss: true });
    return send(404, { 'Content-Type': 'text/plain; charset=utf-8' }, `404 ${pathname}`);
  }

  // 目录请求没带结尾斜杠：先 301，页面里的相对路径才不会算错
  if (hit.dir && !pathname.endsWith('/')) {
    writeLog({ t: new Date().toISOString().slice(11, 23), method: req.method, path: pathname, status: 301 });
    return send(301, { Location: pathname + '/' });
  }

  let body;
  try { body = fs.readFileSync(hit.file); } catch (e) {
    writeLog({ t: new Date().toISOString().slice(11, 23), method: req.method, path: pathname, status: 500, error: e.message });
    return send(500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'read error');
  }
  const ext = path.extname(hit.file).toLowerCase();
  writeLog({
    t: new Date().toISOString().slice(11, 23), method: req.method, path: pathname,
    status: 200, type: req.method === 'HEAD' ? 'head' : 'file',
    bytes: body.length, ms: Date.now() - started,
  });
  return send(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
  }, body);
});

server.on('error', (e) => {
  console.error(`[serve] 启动失败：${e.message}`);
  process.exit(1);
});

server.listen(opt.port, opt.bind, () => {
  console.log(`READY http://${opt.bind}:${opt.port} roots=${roots.join(':')}${opt.stubApi ? ' stub-api' : ''}`);
  if (isCli) process.on('SIGINT', () => server.close(() => process.exit(0)));
  if (isCli) process.on('SIGTERM', () => server.close(() => process.exit(0)));
});
