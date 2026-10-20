import http from 'node:http';
import { spawn } from 'node:child_process';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 启动服务
const srv = spawn('node', ['server.cjs'], { env: { ...process.env, PORT: '17400' }, stdio: 'pipe' });
await sleep(3000);

const api = async (path, body) => {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:17400${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
};

let pass = 0, fail = 0;
// 1. 冷启动
try { const r = await fetch('http://127.0.0.1:17400/'); pass++; console.log('PASS ① 冷启动 200'); } catch { fail++; console.log('FAIL ① 冷启动'); }

// 2. API info
try { const r = await api('/api/init', {}); if (r.code === 0 && r.data?.WalletInfo) { pass++; console.log('PASS ② API info'); } else { fail++; console.log('FAIL ② API info'); } } catch { fail++; }

// 3. API spin
try { const r = await api('/api/spin', {}); if (r.code === 0 && r.data) { pass++; console.log('PASS ③ API spin'); } else { fail++; console.log('FAIL ③ spin'); } } catch { fail++; }

// 4. 面板
try { const r = await fetch('http://127.0.0.1:17400/panel'); if (r.ok) { pass++; console.log('PASS ④ 面板 200'); } else { fail++; } } catch { fail++; }

// 5. 余额变化
try {
  const before = (await api('/api/init', {})).data.WalletInfo[0].coin;
  await api('/api/spin', {});
  const after = (await api('/api/init', {})).data.WalletInfo[0].coin;
  if (after !== before) { pass++; console.log('PASS ⑤ 余额变化 ' + before + '→' + after); } else { fail++; console.log('FAIL ⑤ 余额不变'); }
} catch { fail++; }

console.log(`\n${pass} PASS, ${fail} FAIL`);
srv.kill();
process.exit(fail > 0 ? 1 : 0);
