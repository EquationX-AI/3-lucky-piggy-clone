#!/usr/bin/env node
// 3 LUCKY PIGGY (td400) 本地克隆服务
// 静态资源 + 平台接口桩 + 游戏协议 + 控奖面板
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 7400);
const MIRROR = path.resolve(__dirname, "mirror");
const PRESETS = JSON.parse(fs.readFileSync(path.join(__dirname, "controller/preset-spins.json"), "utf8"));

const MIME = {
  '.html':'text/html;charset=utf-8', '.js':'application/javascript;charset=utf-8',
  '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg',
  '.webp':'image/webp', '.mp3':'audio/mpeg', '.ogg':'audio/ogg',
  '.css':'text/css', '.ico':'image/x-icon', '.bin':'application/octet-stream',
  '.zip':'application/zip', '.ttf':'font/ttf', '.atlas':'text/plain',
  '.astc':'application/octet-stream', '.plist':'application/xml',
  '.cconb':'application/octet-stream', '.skel':'application/octet-stream'
};

// ---------- 路由表：URL 前缀 → mirror 子目录 ----------
// td400 游戏路径是 /tlp/，外壳在 /astarte2/3.6/web-mobile/
const ROUTES = [
  { prefix: '/tlp/',                         dir: '' },           // game root → mirror/
  { prefix: '/cocos-js/',                    dir: 'cocos-js/' },  // 引擎
  { prefix: '/astarte2/3.6/web-mobile/',     dir: 'shell/' },     // 外壳
  { prefix: '/smallicon/',                   dir: 'smallicon/' }, // 图标
];

// ---------- 游戏状态 ----------
let balance = 100000;
let spinIdx = 0;
let nextResult = null; // 控奖注入
const rejects = [];
const PAGE_LOGS = [];

// ---------- 辅助 ----------
function serveFile(filePath, res) {
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }
  return false;
}

function readBody(req) {
  return new Promise(resolve => {
    let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(d));
  });
}

// ---------- 服务 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = decodeURIComponent(url.pathname);

  // CORS — 只允许本机（G5）
  const origin = req.headers.origin || '';
  if (origin && (origin.includes('127.0.0.1') || origin.includes('localhost'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; } // G6: OPTIONS 不执行业务

  // ---------- 埋点 / event / 生命周期 → 返回合法空 JSON（不能 204，客户端会 .json()） ----------
  if (p.includes('/webservice/') || p.includes('/event/') || p.includes('/gtag/') ||
      p.includes('/lifeservice/') || p.includes('/notice/') || p.includes('/mail/') ||
      p.includes('/rank/') || p.includes('/backpack/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 0, code: 0, data: {}, result: {} }));
    return;
  }

  // ---------- 控奖面板 ----------
  if (p === '/panel' || p === '/panel.html' || p === '/panel/') {
    res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' });
    fs.createReadStream(path.join(__dirname, 'public/panel.html')).pipe(res);
    return;
  }

  // ---------- 管理 API（只本机）----------
  if (p === '/api/set-next' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    if (!body || !body.result) {
      rejects.push({ time: Date.now(), reason: 'empty result', body });
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'result required' }));
      return;
    }
    nextResult = body.result;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, queued: true }));
    console.log('  ✓ set-next:', JSON.stringify(body.result).slice(0, 80));
    return;
  }

  if (p === '/api/session' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ balance, spinIdx, nextResult: !!nextResult }));
    return;
  }

  if (p === '/api/rejects' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ count: rejects.length, rejects }));
    return;
  }

  // ---------- 页内日志外送（渲染卡死时唯一可见通道） ----------
  if (p === '/api/log' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const line = `[${body.level || 'log'}] ${body.msg}`;
      PAGE_LOGS.push(line);
      if (PAGE_LOGS.length > 500) PAGE_LOGS.shift();
      console.log('  PAGE ' + line);
    } catch (e) {}
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  if (p === '/api/pagelogs' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ count: PAGE_LOGS.length, lines: PAGE_LOGS.slice(-200) }));
    return;
  }

  // ---------- SSO login / verifySession ----------
  if (p.includes('sso-login') || p.includes('verifySession')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      token: 'local-token', linecode: 'es-AR', homeUrl: `http://127.0.0.1:${PORT}`,
      lobbyMode: 0, country: 'CO',
      response: { time: Date.now() },
      origin_fetch: false, GameBundle: 'game',
      profile: { id: 1, aid: '1', apiId: '10106', siteId: 1,
                 subAgentCode: -1, betLevel: 0, betValue: 200, lobbyMode: 0, meta: {} }
    }));
    return;
  }

  // ---------- 游戏 API — info/init ----------
  if (req.method === 'POST' && (p.includes('/api/init') || p.includes('/api/info'))) {
    await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      code: 0, ackType: 1,
      data: {
        BlueOdds: [], CoinOdds: [], CrackLevels: [0,0,0,0,0], JPOdds: [],
        BuyMul: [50, 100, 200], Mul: [1, 1.5, 8],
        WalletInfo: [{ coin: balance, bet: [200,400,600,1000,2000,4000,6000,10000], unit: 1, ratio: 1, decimal: 2, currencySymbol: '$' }]
      }
    }));
    console.log('  API info, balance:', balance);
    return;
  }

  // ---------- 游戏 API — spin ----------
  if (req.method === 'POST' && p.includes('/api/spin') && !p.includes('spin-end')) {
    const body = await readBody(req);
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    const bet = parsed.bet || 200;

    // G2: 注额校验
    const validBets = [200,400,600,1000,2000,4000,6000,10000];
    if (!validBets.includes(bet)) {
      rejects.push({ time: Date.now(), reason: 'invalid bet', bet });
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid bet amount', validBets }));
      return;
    }
    // 余额不足
    if (balance < bet) {
      rejects.push({ time: Date.now(), reason: 'insufficient balance', balance, bet });
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'insufficient balance' }));
      return;
    }

    // 取结果：控奖注入优先，否则轮播预设
    let result;
    if (nextResult) {
      result = nextResult;
      nextResult = null;
    } else {
      result = PRESETS[spinIdx % PRESETS.length];
    }
    const win = result.TotalWin || 0;
    balance = balance - bet + win;
    spinIdx++;

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, ackType: 0, data: result, balance }));
    console.log('  API spin #' + spinIdx + ', bet:', bet, ', win:', win, ', bal:', balance);
    return;
  }

  // ---------- spin-end / notice / unshow / last-spin ----------
  if (req.method === 'POST') {
    await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0 }));
    return;
  }

  // ---------- 清洗版外壳（替换 Jscrambler 原字节，外壳允许替换） ----------
  if (!process.env.NOCLEAN && p === '/astarte2/3.6/web-mobile/src/chunks/bundle.fb6e5.js') {
    const fp = path.join(__dirname, 'cleanshell', 'bundle.js');
    if (serveFile(fp, res)) return;
  }
  if (!process.env.NOCLEAN && p === '/astarte2/3.6/web-mobile/assets/other/index.ad23f.js') {
    const fp = path.join(__dirname, 'cleanshell', 'other.js');
    if (serveFile(fp, res)) return;
  }
  if (p.startsWith('/cleanshell/')) {
    const fp = path.join(__dirname, 'cleanshell', p.slice('/cleanshell/'.length));
    if (serveFile(fp, res)) return;
  }

  // ---------- 测试用：把外壳脚本当普通 script 提供 ----------
  if (p.startsWith('/tp-shell/')) {
    const rel = p.slice('/tp-shell/'.length);
    const fp = path.join(MIRROR, 'shell', 'src', 'chunks', rel);
    if (serveFile(fp, res)) return;
    const fp2 = path.join(MIRROR, 'shell', 'assets', 'other', rel);
    if (serveFile(fp2, res)) return;
  }

  // ---------- 控制器脚本（本地注入文件，不属于镜像） ----------
  if (p.startsWith('/controller/')) {
    const rel = p.slice('/controller/'.length);
    const filePath = path.join(__dirname, 'controller', rel);
    if (serveFile(filePath, res)) return;
  }

  // ---------- 游戏入口（serve 时注入钩子，镜像本体不改） ----------
  if (p === '/' || p === '/tlp' || p === '/tlp/') {
    const idx = path.join(MIRROR, 'index.html');
    if (fs.existsSync(idx)) {
      let html = fs.readFileSync(idx, 'utf8');
      if (url.searchParams.get('raw') === '1') {
        res.writeHead(200, { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' });
        res.end(html); return;
      }
      // 在 System.import 之前注入：钩子必须先于游戏代码执行
      const inject = [
        '<script src="/controller/td400-hook.js" charset="utf-8"></script>',
        '<script src="/controller/Controller.js" charset="utf-8"></script>',
        '<script src="/controller/LocalController.js" charset="utf-8"></script>'
      ].join('\n');
      if (html.includes('System.import(')) {
        html = html.replace(/(<script>\s*System\.import\()/, inject + '\n$1');
      } else {
        html = html.replace('</body>', inject + '\n</body>');
      }
      res.writeHead(200, { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
  }

  // ---------- 请求日志（外壳/资源排查用） ----------
  if (process.env.REQLOG && (p.includes('/astarte2/') || p.includes('/assets/'))) {
    console.log('  REQ ' + p.slice(0, 120));
  }

  // ---------- 静态文件路由 ----------
  for (const route of ROUTES) {
    if (p.startsWith(route.prefix)) {
      const rel = p.slice(route.prefix.length);
      const filePath = path.join(MIRROR, route.dir, rel);
      if (serveFile(filePath, res)) return;
      break;
    }
  }

  // ---------- 直接从 mirror 根找 ----------
  {
    const filePath = path.join(MIRROR, p);
    if (serveFile(filePath, res)) return;
  }

  console.log('  404', p.slice(0, 100));
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`3 LUCKY PIGGY server on http://127.0.0.1:${PORT}/`);
  console.log(`  Game:  http://127.0.0.1:${PORT}/tlp/?ssoKey=local&lang=es-AR&apiId=10106&gameID=400&skin=1&region=eu`);
  console.log(`  Panel: http://127.0.0.1:${PORT}/panel`);
});
