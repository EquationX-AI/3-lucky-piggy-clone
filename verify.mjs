// td400 门禁：一条命令跑完
// 通过 = 全部 PASS；FAIL 与 SKIP 都算未通过（SKIP 必须写明原因）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.VERIFY_PORT || 17400);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0, skip = 0;
const fails = [], skips = [];
function ok(n) { pass++; console.log('PASS ' + n); }
function no(n, why) { fail++; fails.push(n + ' :: ' + why); console.log('FAIL ' + n + ' :: ' + why); }
function sk(n, why) { skip++; skips.push(n + ' :: ' + why); console.log('SKIP ' + n + ' :: ' + why); }
function check(n, cond, why) { cond ? ok(n) : no(n, why || ''); }

// ---------- 起服务 ----------
const srv = spawn('node', ['server.cjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', d => srvLog += d);
srv.stderr.on('data', d => srvLog += d);

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/'); if (r.ok || r.status === 404) return true; } catch {}
    await sleep(250);
  }
  return false;
}
const ready = await waitReady();
check('① 服务启动', ready, 'server.cjs 未就绪');
if (!ready) { srv.kill(); process.exit(1); }

async function jget(p) { const r = await fetch(BASE + p); return { status: r.status, body: await r.json().catch(() => null) }; }
async function jpost(p, b, h) { const r = await fetch(BASE + p, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, h || {}), body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; }

// ---------- ② 游戏页 ----------
{
  const r = await fetch(BASE + '/tlp/?ssoKey=local&lang=es-AR&apiId=10106&gameID=400');
  const html = await r.text();
  const hasEngine = html.includes('system.bundle') && html.includes('import-map');
  const hasHook = html.includes('/controller/td400-hook.js');
  check('② 游戏页 200 且注入钩子', r.ok && hasEngine && hasHook, `status=${r.status} engine=${hasEngine} hook=${hasHook}`);
}

// ---------- ③ 面板 ----------
{
  const r = await fetch(BASE + '/panel');
  const html = await r.text();
  const split = html.includes('grid-template-columns') && html.includes('<iframe');
  const regions = ['快捷预设', '盘面编辑器', '特殊玩法', '赔付表', '回合日志'].filter(k => html.includes(k)).length;
  check('③ 面板 200 + 左右分栏 + 区域齐全', r.ok && split && regions >= 5, `split=${split} regions=${regions}/5`);
}

// ---------- ④ 奖种目录 ----------
let kinds = [];
{
  const { status, body } = await jget('/api/kinds');
  kinds = (body && body.kinds) || [];
  const usable = kinds.filter(k => !k.skip);
  check('④ 奖种目录可用', status === 200 && kinds.length >= 2 && usable.length >= 2, `kinds=${kinds.length} usable=${usable.length}`);
}

// ---------- ⑤ 注入 → 跑一局（金额对账）----------
if (kinds.length) {
  const k = kinds.find(x => !x.skip);
  const inj = await jpost('/api/result', { kind: k.id });
  const before = (await jget('/api/session')).body;
  const play = await jget('/api/result?sid=verify&bet=200');
  const after = (await jget('/api/session')).body;
  const expectBal = Math.round((before.balance - 200 + play.body.win) * 100) / 100;
  check('⑤ 注入生效 + 余额对账',
    inj.status === 200 && play.status === 200 &&
    Math.abs(expectBal - after.balance) < 0.01 && play.body.win === (play.body.data.TotalWin || 0),
    `inj=${inj.status} win=${play.body && play.body.win} bal ${before.balance}->${after.balance} expect ${expectBal}`);
} else sk('⑤ 注入生效 + 余额对账', '无可用奖种');

// ---------- ⑥ 盘面注入校验 ----------
{
  const good = await jpost('/api/result', { grid: [[1,2,3],[4,5,6],[7,8,9],[10,11,12],[13,14,15]] });
  const bad = await jpost('/api/result', { grid: [[1,2],[3,4]] });
  check('⑥ 盘面注入：合法通过 / 非法拒绝', good.status === 200 && bad.status === 400, `good=${good.status} bad=${bad.status}`);
}

// ---------- ⑦ 注额校验 ----------
{
  const bad = await jpost('/api/spin', { bet: 999 });
  const rej = await jget('/api/rejects');
  check('⑦ gB2 非法注额被拒 + 记入拒绝表', bad.status === 400 && rej.body.count >= 1, `status=${bad.status} rejects=${rej.body && rej.body.count}`);
}

// ---------- ⑧ 未覆盖奖项必须明确拒绝（不能假装成功）----------
{
  const k = kinds.find(x => x.skip);
  if (k) {
    const r = await jpost('/api/result', { kind: k.id });
    check('⑧ 未覆盖奖项明确拒绝', r.status === 400 && !!r.body.error, `status=${r.status}`);
  } else sk('⑧ 未覆盖奖项明确拒绝', '目录里没有 skip 项');
}

// ---------- ⑨ 交付文档 ----------
{
  const spec = fs.existsSync(path.join(ROOT, 'CLONE-SPEC.md'));
  const proto = fs.existsSync(path.join(ROOT, 'docs/PROTOCOL.md'));
  const integ = fs.existsSync(path.join(ROOT, 'docs/MIRROR-INTEGRITY.md'));
  check('⑨ CLONE-SPEC / PROTOCOL / MIRROR-INTEGRITY 齐全', spec && proto && integ, `spec=${spec} proto=${proto} integ=${integ}`);
}

// ---------- ⑩ 镜像二进制完整性 ----------
{
  const dir = path.join(ROOT, 'mirror');
  let total = 0, bad = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.astc')) {
        total++;
        const b = Buffer.alloc(4);
        const fd = fs.openSync(p, 'r'); fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd);
        if (b.toString('hex') !== '13aba15c') bad++;
      }
    }
  })(dir);
  check('⑩ astc 魔数全部合格', total > 0 && bad === 0, `total=${total} bad=${bad}`);
}

// ---------- ⑪ 引擎与外壳资源可达 ----------
{
  const urls = [
    '/cocos-js/cc.af2c4.js',
    '/astarte2/3.6/web-mobile/assets/versions.json',
    '/astarte2/3.6/web-mobile/src/chunks/bundle.fb6e5.js',
    '/tlp/assets/main/index.d2cb2.js',
  ];
  const codes = [];
  for (const u of urls) { const r = await fetch(BASE + u); codes.push(r.status); }
  check('⑪ 引擎/外壳/主包均可取', codes.every(c => c === 200), 'codes=' + codes.join(','));
}

// ---------- ⑫ 游戏画面（当前硬门禁）----------
// 说明：这一项必须由真实浏览器判定，这里只能做静态代理判断。
{
  const idx = fs.readFileSync(path.join(ROOT, 'mirror/index.html'), 'utf8');
  const html = await (await fetch(BASE + '/tlp/?ssoKey=local')).text();
  const canvasInjected = html.includes('cocos') || html.includes('Cocos');
  no('⑫ 游戏画面渲染（GameView 出现）',
    '未通过：外壳加载不完整（other/extra bundle 未注册），GameView 未创建。' +
    '该项必须由真实浏览器截图判定，见 CLONE-SPEC §6');
}

// ---------- ⑬ E2E 截图存在性 ----------
{
  const d = path.join(ROOT, 'evidence/e2e');
  const n = fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.png')).length : 0;
  if (n === 0) no('⑬ E2E 截图（非连线全验 + 连线抽 30%）', '0 张；依赖 ⑫ 通过后才能做真实点击');
  else check('⑬ E2E 截图', n > 0, '');
}

// ---------- 汇总 ----------
srv.kill();
console.log(`\n${pass} PASS, ${fail} FAIL, ${skip} SKIP`);
if (fails.length) { console.log('\n--- FAIL ---'); fails.forEach(f => console.log('  ' + f)); }
if (skips.length) { console.log('\n--- SKIP ---'); skips.forEach(s => console.log('  ' + s)); }
const allGreen = fail === 0 && skip === 0;
console.log(allGreen ? '\n门禁：全绿' : '\n门禁：未通过（FAIL 或 SKIP 均视为未通过）');
process.exit(allGreen ? 0 : 1);
