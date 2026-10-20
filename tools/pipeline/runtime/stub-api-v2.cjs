const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const PORT = Number(process.env.PORT || 5691);
const cert = fs.readFileSync(process.env.CERT);
const key = fs.readFileSync(process.env.KEY);
const logPath = process.env.LOG || '/tmp/stub-api-v2.log';

const server = https.createServer({ cert, key }, (req, res) => {
  const url = req.url;
  const host = req.headers.host || '?';
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const ts = new Date().toISOString().slice(11,19);
    console.log(`${ts} ${req.method} ${host}${url.slice(0,120)} ${body ? body.slice(0,80) : ''}`);
    fs.appendFileSync(logPath, JSON.stringify({t:Date.now(), host, method:req.method, url, body:body.slice(0,500)}) + '\n');
    
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    };
    
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }


    // ===== 奖控调试 API =====
    const PC_DATA = global.__PRIZE_DATA__ || (global.__PRIZE_DATA__ = {
      spinAcks: null, next: null, history: []
    });
    // 懒加载预设数据
    if (!PC_DATA.spinAcks) {
      try { PC_DATA.spinAcks = JSON.parse(require('fs').readFileSync(
        require('path').join(__dirname, './spinacks.json'), 'utf8')); }
      catch(e) { PC_DATA.spinAcks = []; console.log('[奖控] spinacks.json 未找到'); }
    }

    if (url.startsWith('/api/prize-control/')) {
      const route = url.replace('/api/prize-control/', '').split('?')[0];
      
      if (route === 'presets') {
        const list = PC_DATA.spinAcks.map((a, i) => ({
          index: i, TotalWin: a.TotalWin, AwardTypeFlag: a.AwardTypeFlag,
          hasNudge: !!a.NudgeReel, awardCount: a.AwardDataVec ? a.AwardDataVec.length : 0,
          board: a.PlateSymbol ? a.PlateSymbol.map(c => c.Column) : null,
        }));
        res.writeHead(200, cors); res.end(JSON.stringify(list)); return;
      }
      
      if (route === 'set' && req.method === 'POST') {
        const { index } = JSON.parse(body);
        if (index >= 0 && index < PC_DATA.spinAcks.length) {
          PC_DATA.next = PC_DATA.spinAcks[index];
          console.log('[奖控] 设置 #' + index + ' TotalWin=' + PC_DATA.next.TotalWin);
          res.writeHead(200, cors); res.end(JSON.stringify({ ok: true, index, TotalWin: PC_DATA.next.TotalWin })); return;
        }
        res.writeHead(400, cors); res.end('{"err":"bad index"}'); return;
      }
      
      if (route === 'next') {
        if (PC_DATA.next) {
          const r = PC_DATA.next; PC_DATA.next = null;
          PC_DATA.history.unshift({ time: new Date().toISOString(), TotalWin: r.TotalWin, Flag: r.AwardTypeFlag });
          if (PC_DATA.history.length > 10) PC_DATA.history.pop();
          console.log('[奖控] 投递 TotalWin=' + r.TotalWin);
          res.writeHead(200, cors); res.end(JSON.stringify({ has: true, data: r })); return;
        }
        res.writeHead(200, cors); res.end('{"has":false}'); return;
      }
      
      if (route === 'status') {
        res.writeHead(200, cors); res.end(JSON.stringify({
          queued: PC_DATA.next ? { TotalWin: PC_DATA.next.TotalWin, Flag: PC_DATA.next.AwardTypeFlag } : null,
          history: PC_DATA.history
        })); return;
      }
      
      if (route === 'panel') {
        try {
          const html = require('fs').readFileSync(
            require('path').join(__dirname, './panel.html'), 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...cors });
          res.end(html); return;
        } catch(e) { res.writeHead(500, cors); res.end('{"err":"panel not found"}'); return; }
      }
    }
    // ===== 奖控调试 API 结束 =====

    
    // SSO 登录：优先用复刻目录里录制的真机回包（明文 JSON），否则退回通用桩
    if (url.includes('sso-login')) {
      try {
        const f = require('path').join(process.cwd(), 'inspect/replay/sso-login.json');
        const rec = fs.readFileSync(f, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        res.end(rec); return;
      } catch (e) { /* 没有录制回包就走下面的通用桩 */ }
      const resp = {
        Code: 0,
        Message: "Success",
        Data: {
          Token: "local-stub-token-" + Date.now(),
          AccountID: 99999,
          Account: "local_test",
          Currency: "MXN",
          Balance: 100000,
          Wallet: 100000,
          Language: "en",
          ApiID: 10106,
          GameID: 807,
          NickName: "LocalTest",
          Country: "MX",
          IsDemo: false,
          IsTrial: false,
          Region: "eu",
          OperatorToken: "",
          ExtraData: {}
        }
      };
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(resp));
      return;
    }
    
    // protobuf 接口：VIP / 龙虎榜 / 公告。回 "{}" 会被外壳按 protobuf 解码并抛
    // RangeError（index out of range），空 body 才能解成空消息。
    if (url.includes('/vipservice/') || url.includes('/longhu/') || url.includes('/smartnotice/') || url.includes('/promotionservice/') || url.includes('/favoriteservice/') || url.includes('/rankingservice/') || url.includes('/subagentservice/')) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', ...cors });
      res.end();
      return;
    }

    // OnLogin 系列
    if (url.includes('OnLogin') || url.includes('onlogin')) {
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ Code: 0, Data: {} }));
      return;
    }
    
    // 排行榜/邮件等
    if (url.includes('GetMailList') || url.includes('GetLonghu') || url.includes('MakeUserSubAgent')) {
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ Code: 0, Data: { List: [] } }));
      return;
    }
    
    // 所有其他请求返回 200 + {}
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    res.end('{}');
  });
});

// ===== WebSocket upgrade：让 wss://<api-host>/lifeservice/ws2 能握手成功 =====
// astarte2 外壳的生命服务走 WebSocket；桩若对 upgrade 回 200，客户端会当成握手失败并重试，
// 重试耗尽后弹 MSG 999.1（"Connection failed"）。这里做最小握手并保持连接，不解析业务帧。
server.on('upgrade', (req, socket, head) => {
  const key = req.headers['sec-websocket-key'];
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`${ts} WS  ${req.headers.host || '?'}${req.url.slice(0, 80)}`);
  try {
    fs.appendFileSync(logPath, JSON.stringify({ t: Date.now(), host: req.headers.host, method: 'WS', url: req.url, body: '' }) + '\n');
  } catch (e) {}
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  // 最小帧处理：只回 ping（0x9）的 pong（0xA），其余忽略；连接保持到对端关闭
  socket.on('data', (buf) => {
    try {
      for (let i = 0; i + 1 < buf.length; i++) {
        if ((buf[i] & 0x0f) === 0x9 && !(buf[i + 1] & 0x80)) {
          socket.write(Buffer.from([0x8a, 0x00]));
          break;
        }
      }
    } catch (e) {}
  });
  socket.on('error', () => {});
  socket.on('close', () => {});
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`STUB API v2 READY on ${PORT}`);
});
