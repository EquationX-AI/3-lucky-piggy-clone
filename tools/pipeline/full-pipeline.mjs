#!/usr/bin/env node
// 完整流水线：CFF 反混淆（v2）→ 字符串还原 → 保护代码剥离，产出只读的干净 JS。
//
// 用法：
//   node --max-old-space-size=8192 --stack-size=65500 full-pipeline.mjs \
//     --input bundle.js other.js main.js \
//     --strings bundle.strings.json other.strings.json main.strings.json \
//     [--preds main=main.pred-values.json] \
//     [--integrity-maps main=main-integrity-map.json other=other-integrity-map.json] \
//     --output clean/ [--work clean/.work] [--skip-cff] [--keep-runtime]
//
//  --strings  每个输入一张字符串表，按顺序对应；也可写成 名字=路径（名字取输入文件名第一段，如 bundle / index / main）。
//             表格式：数组（下标=编号，推荐用 slot-replication 的 inspect/strings/<x>.strings.json，已跳过陷阱编号），或 {编号: 字符串}。
//  --preds    可选，零参恒真/恒假判断的采集值 {名字: [true,...]}，同样按顺序或 名字=路径。
//  --sentinels 可选，逗号分隔的哨兵 API 名（还原后应出现在产出里的明文名），默认是 G1000/astarte2 的 4 个（System 不在任何一张表里，已去掉）；
//             其他框架（aeon、JILI 单根等）请按本款实际代码指定，否则会误报。
//  --skip-cff 输入已经是 CFF 产物（const _global = globalThis 开头），跳过步骤 1。
//  --keep-runtime  只还原字符串和常量，不删运行时（调试用）。
//
// 每个输入一个子进程并发处理。产物只用于阅读，不保证能运行。
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);

// CFF 展开用的实现（src/transformers/、cff-versions/）与 deob-parallel.mjs 指向的是同一份，
// 都放在兄弟目录 tools/jscrambler-deobfuscator-fixed/ 下。本目录若将来放了副本则优先用副本。
const DEOB_SIBLING = path.resolve(HERE, '../jscrambler-deobfuscator-fixed');
function deobPath(rel) {
  const local = path.join(HERE, rel);
  if (fs.existsSync(local)) return local;
  const sibling = path.join(DEOB_SIBLING, rel);
  if (fs.existsSync(sibling)) return sibling;
  throw new Error(`找不到反混淆实现 ${rel}：既不在 ${HERE}，也不在 ${DEOB_SIBLING}`);
}

// 子进程模式与主进程模式二选一，中间不能落下去（worker 的退出是异步的，落到 main() 会解析错参数）
async function dispatch() {
  if (process.argv[2] !== '--worker') return main();
  const res = await worker(JSON.parse(process.argv[3]));
  // process.send 是异步的：发完立刻 process.exit 会在消息 flush 前退出，父进程收不到结果，
  // 就会把已经成功的文件报成"子进程退出码 0"的失败。等 send 回调回来再退出。
  const done = () => process.exit(0);
  if (typeof process.send === 'function') { const guard = setTimeout(done, 10000); process.send(res, () => { clearTimeout(guard); done(); }); }
  else done();
}

// ---------------- 主进程 ----------------
function parseArgs(argv) {
  const o = { input: [], strings: [], preds: [], integrityMaps: [], output: null, work: null, sentinels: null, skipCff: false, keepRuntime: false };
  let cur = null;
  for (const a of argv) {
    if (a === '--skip-cff') { o.skipCff = true; cur = null; continue; }
    if (a === '--keep-runtime') { o.keepRuntime = true; cur = null; continue; }
    if (a.startsWith('--')) { cur = a.slice(2); continue; }
    if (cur === 'input' || cur === 'strings' || cur === 'preds' || cur === 'integrity-maps') o[cur === 'integrity-maps' ? 'integrityMaps' : cur].push(a);
    else if (cur === 'output' || cur === 'work') { o[cur] = a; cur = null; }
    else if (cur === 'runtime-map') { o.integrityMaps.push(a); cur = null; } // 兼容旧参数
    else if (cur === 'sentinels') { o.sentinels = a.split(',').map((x) => x.trim()).filter(Boolean); cur = null; }
    else throw new Error('多余参数: ' + a);
  }
  if (!o.input.length || !o.strings.length || !o.output) {
    console.error('用法: node full-pipeline.mjs --input a.js b.js --strings a.json b.json --output out/ [--preds name=x.json] [--skip-cff]');
    process.exit(2);
  }
  return o;
}

const shortName = (f) => path.basename(f).split('.')[0];

function assign(list, inputs, label) {
  const named = new Map(), plain = [];
  for (const x of list) { const m = x.match(/^([^=/]+)=(.+)$/); if (m) named.set(m[1], m[2]); else plain.push(x); }
  return inputs.map((inp, i) => {
    const k = shortName(inp);
    const k2 = path.basename(path.dirname(inp));
    if (named.has(k)) return path.resolve(named.get(k));
    if (named.has(k2)) return path.resolve(named.get(k2));
    if (plain.length === inputs.length) return path.resolve(plain[i]);
    if (plain.length === 1 && label === 'strings') { console.warn(`[警告] 只给了一张字符串表，${k} 也用它；外壳和游戏各文件的表不同，混用会错位`); return path.resolve(plain[0]); }
    return null;
  });
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const out = path.resolve(o.output);
  const work = path.resolve(o.work || path.join(out, '.work'));
  fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(work, { recursive: true });
  const strings = assign(o.strings, o.input, 'strings');
  const preds = assign(o.preds, o.input, 'preds');
  const intMaps = assign(o.integrityMaps, o.input, 'integrity-maps');
  // 输出文件名：取文件名第一段（bundle.ad349.js → bundle.js）；重名时（两个 index.*.js）改用上级目录名（other / main）
  const firsts = o.input.map(shortName);
  const shorts = firsts.map((s, i) => firsts.filter((x) => x === s).length > 1 ? path.basename(path.dirname(o.input[i])) : s);
  const outNames = shorts.map((s) => s + '.js');
  const t0 = Date.now();
  const jobs = o.input.map((inp, i) => new Promise((resolve) => {
    if (!strings[i]) { resolve({ input: inp, error: '没有对应的字符串表' }); return; }
    const cfg = { input: path.resolve(inp), strings: strings[i], preds: preds[i], work, out, outName: outNames[i], tag: `${shorts[i]}#${i}`,
      skipCff: o.skipCff, keepRuntime: o.keepRuntime, sentinels: o.sentinels, integrityMap: intMaps[i] || null };
    const child = fork(SELF, ['--worker', JSON.stringify(cfg)], { execArgv: ['--max-old-space-size=8192', '--stack-size=65500'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let result = null, errText = '';
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => { errText += d; process.stderr.write(d); });
    child.on('message', (m) => { result = m; });
    child.on('exit', (code) => {
      if (result) return resolve(result);
      // 没收到结果但退出码 0、产物又存在：说明只是结果消息没送到，不能报假失败。
      const outFile = path.join(out, outNames[i]);
      if (code === 0 && fs.existsSync(outFile)) {
        const text = fs.readFileSync(outFile, 'utf8');
        console.error(`[警告] ${path.basename(inp)} 没收到子进程结果（退出码 0），产物存在，按完成处理`);
        return resolve({ input: inp, output: outFile, outBytes: Buffer.byteLength(text), outLines: text.split('\n').length, recovered: true });
      }
      resolve({ input: inp, error: `子进程退出码 ${code}: ${errText.slice(-500)}` });
    });
  }));
  const results = await Promise.all(jobs);
  const report = { generatedAt: new Date().toISOString(), totalSeconds: +((Date.now() - t0) / 1000).toFixed(1), files: results };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(out, 'report.md'), renderReport(report));
  console.log(`\n完成，用时 ${report.totalSeconds}s；报告：${path.join(out, 'report.md')}`);
  if (results.some((r) => r.error)) process.exitCode = 1;
}

function renderReport(r) {
  const L = [];
  L.push('# 流水线报告', '', `生成时间：${r.generatedAt}，总用时 ${r.totalSeconds}s（各文件并发）`, '');
  for (const f of r.files) {
    L.push(`## ${path.basename(f.input)}`, '');
    if (f.error) { L.push(`**失败**：${f.error}`, ''); continue; }
    if (!f.timing) { L.push(`- 产物：\`${f.output}\`（${f.outLines} 行，${(f.outBytes / 1024).toFixed(0)} KB）——子进程结果消息没送到（退出码 0、产物存在），按完成处理，没有分步统计`, ''); continue; }
    L.push(`- 产物：\`${f.output}\`（${f.outLines} 行，${(f.outBytes / 1024).toFixed(0)} KB）；语法检查：${f.syntaxOk ? '通过' : '失败 ' + f.syntaxError}`);
    L.push(`- 命名空间：\`${f.ns}\`；字符串表：\`${f.strings}\`${f.preds ? `；判断值表：\`${f.preds}\`` : ''}`);
    L.push(`- 用时：${Object.entries(f.timing).map(([k, v]) => `${k} ${v}s`).join('，')}`);
    const s = f.decode, ic = f.integrity, kp = f.keyed;
    L.push(`- 字符串：解码函数 ${s.decoders.join('/')}，替换 ${s.decoded} 处，表里取不到 ${s.missed} 处${s.missed ? ' ' + JSON.stringify(s.missIdx) : ''}，参数仍不是常量 ${s.dynamicArg} 处`);
    L.push(`- 完整性常量：${ic.families.map((x) => x.names.join('/') + `（第 ${x.encodedArg + 1} 个参数，${x.steps.join(' → ')}，${ic.order === 'reverse' ? '倒序' : '正序'}应用）`).join('；') || '未发现'}，折叠 ${ic.folded} 处，未解 ${ic.unresolved} 处；` +
      (ic.validation ? `用"解码(常量)"调用校验 ${ic.validation.samples} 处：倒序命中 ${ic.validation.hitReverse}、正序命中 ${ic.validation.hitForward}` : '无校验样本') + (ic.error ? `；**警告**：${ic.error}` : ''));
    L.push(`- 键控谓词：${kp.names.join('/') || '无'}，折叠 ${kp.folded} 处，删转发定义 ${kp.forwarders} 处` + (kp.plausibility ? `；可信度抽检（选中分支的字符串在文件里出现次数不少于被丢弃分支）${kp.plausibility.plausible}/${kp.plausibility.checked}` +
      (kp.plausibility.doubt.length ? `，存疑：${kp.plausibility.doubt.map((d) => `${d.key} 选 "${d.keep}" 弃 "${d.drop}"`).join('；')}` : '') : ''));
    L.push(`- 零参判断：替换 ${s.preds} 处；折叠 if/三元/逻辑 ${s.folded} 处，合并拼接 ${s.concat} 处，内联字符串别名 ${s.inlined} 处`);
    if (f.sentinels) {
      const hits = Object.entries(f.sentinels).map(([k, v]) => `${k}=${v}`).join('，');
      L.push(`- 哨兵检查：${hits}${f.sentinelWarning ? `\n  - **⚠ ${f.sentinelWarning}**` : ''}`);
    }
    if (f.strip) {
      const p = f.strip;
      L.push(`- 剥离：删运行时顶层语句 ${p.runtimeStatements} 条（约 ${(p.runtimeBytes / 1024).toFixed(0)} KB 原始代码），业务顶层语句 ${p.businessStatements} 条，删代码锁辅助函数 ${p.deadHelpers} 个、无用变量 ${p.deadVars} 个（其中 _global 别名 ${p.aliasesRemoved} 个），清空厂商自毁函数 ${p.selfDestruct} 个，还原对象字面量 ${p.objectLiterals} 处`);
      const res = Object.entries(p.residue);
      L.push(`- 残留运行时引用：${res.length ? res.map(([k, v]) => `${k}×${v}`).join('，') + `（对应定义保留 ${p.keptForResidue} 条）。**有残留时先怀疑字符串表不对应（错位或用错文件的表）**` : '无'}`);
    }
    L.push('', '| 关键字 | 命中行数 | 示例 |', '|---|---|---|');
    for (const [k, v] of Object.entries(f.scan)) L.push(`| ${k} | ${v.count} | ${v.samples.slice(0, 2).map((x) => `L${x.line}: \`${x.text.replace(/\|/g, '\\|').slice(0, 90)}\``).join('<br>')} |`);
    L.push('');
  }
  return L.join('\n');
}

// ---------------- 子进程 ----------------
async function worker(cfg) {
  const babel = await import('@babel/core');
  const _traverse = await import('@babel/traverse');
  const _generate = await import('@babel/generator');
  const traverse = _traverse.default.default ?? _traverse.default;
  const generate = _generate.default.default ?? _generate.default;
  const D = await import(pathToFileURL(path.join(HERE, 'lib/decode-strings.mjs')).href);
  const R = await import(pathToFileURL(path.join(HERE, 'lib/runtime-fold.mjs')).href);
  const S = await import(pathToFileURL(path.join(HERE, 'lib/strip-protection.mjs')).href);
  const { execFileSync } = await import('node:child_process');

  const say = (...a) => process.stdout.write(`[${cfg.tag}] ${a.join(' ')}\n`);
  const origLog = console.log, origWarn = console.warn;
  const mute = () => { console.log = () => {}; console.warn = () => {}; };
  const unmute = () => { console.log = origLog; console.warn = origWarn; };
  const timing = {};
  const lap = (k, t) => { timing[k] = +((Date.now() - t) / 1000).toFixed(1); };
  const res = { input: cfg.input, strings: cfg.strings, preds: cfg.preds, timing };
  try {
    const src = fs.readFileSync(cfg.input, 'utf8');
    // 命名空间：原始文件第一句 NS[数字] = ... 的 NS
    const m = src.match(/^\s*([^\s[=;(]+)\s*\[\s*\d+\s*\]\s*=/);
    res.ns = m ? m[1] : null;
    const cffFile = path.join(cfg.work, cfg.outName.replace(/\.js$/, '') + '.cff.js');

    // ---- 步骤 1：CFF ----
    let code = src;
    if (!cfg.skipCff) {
      let t = Date.now();
      mute();
      const ast = babel.parseSync(src, { sourceType: 'script' });
      const tdir = deobPath('src/transformers');
      const pick = (mod) => mod.default || mod[Object.keys(mod).find((k) => mod[k] && mod[k].visitor)];
      const prep = pick(await import(pathToFileURL(path.join(tdir, 'prepare.js')).href));
      traverse(ast, prep.visitor);
      const cffMod = await import(pathToFileURL(path.join(deobPath('cff-versions'), 'v3-preserve-predicates.js')).href);
      if (cffMod.configure) cffMod.configure({ sourceCode: src, dynamicInit: true, hostname: 'localhost' });
      traverse(ast, pick(cffMod).visitor);
      const fin = pick(await import(pathToFileURL(path.join(tdir, 'final.js')).href));
      traverse(ast, fin.visitor);
      code = babel.transformFromAstSync(ast, null, { sourceType: 'script', code: true }).code;
      unmute();
      fs.writeFileSync(cffFile, code);
      res.cffDynInit = cffMod.dynInitStats ? { tried: cffMod.dynInitStats.tried, resolved: cffMod.dynInitStats.resolved } : null;
      lap('CFF', t);
      say(`CFF 完成 ${timing.CFF}s → ${cffFile}`);
    }

    // ---- 步骤 2：字符串与常量还原 ----
    let t = Date.now();
    const ast = babel.parseSync(code, { sourceType: 'script' });
    const table = D.loadTable(JSON.parse(fs.readFileSync(cfg.strings, 'utf8')));
    const preds = cfg.preds ? D.loadPreds(JSON.parse(fs.readFileSync(cfg.preds, 'utf8'))) : new Map();
    if (!cfg.preds) say('提示：未传 --preds，零参判断函数（如 fg5 main 的 m9a/d25）不会被替换；若产出残留大量 if(NS.xxx()) 守卫或括号不平衡，先按文档 S1.5 采 pred-values 再重跑');
    const decoders = D.detectDecoders(ast);
    const st = D.newStats();
    D.replaceDecoderCalls(ast, { table, decoders }, st);           // 2a 常量参数的解码调用
    D.simplify(ast, st);                                             // 字符串别名内联后，运行时函数名/违规码才是明文
    const runtimeMap = cfg.integrityMap ? JSON.parse(fs.readFileSync(path.resolve(cfg.integrityMap), 'utf8')) : null;
    if (runtimeMap) say(`使用完整性映射表 (${Object.keys(runtimeMap).length} 条)`);
    res.integrity = R.foldIntegrityConstants(ast, { decoders, table, runtimeMap }); // 2b 完整性常量
    st.dynamicArg = 0;
    D.replaceDecoderCalls(ast, { table, decoders }, st);           // 2c 参数刚变成常量的解码调用
    res.keyed = R.foldKeyedPredicates(ast);                          // 2d 键控谓词
    D.replacePreds(ast, preds, st);                                  // 2e 采集到的零参判断
    D.simplify(ast, st);
    res.decode = st;
    lap('字符串与常量', t);
    say(`字符串 ${st.decoded}，常量 ${res.integrity.folded}，键控谓词 ${res.keyed.folded}，判断 ${st.preds}（${timing['字符串与常量']}s）`);
    if (res.integrity.error) say('警告：' + res.integrity.error);

    // ---- 步骤 3：保护剥离 ----
    if (!cfg.keepRuntime) {
      t = Date.now();
      res.strip = S.stripProtection(ast, { nsName: res.ns });
      res.strip.selfDestruct = S.neutralizeSelfDestruct(ast);
      res.strip.objectLiterals = S.restoreObjectLiterals(ast);
      // 剥离后可能又出现可折叠的东西（例如别名删除后的空 if）
      D.simplify(ast, D.newStats());
      lap('剥离', t);
      say(`删运行时语句 ${res.strip.runtimeStatements} 条，残留引用 ${Object.keys(res.strip.residue).length} 种`);
    }

    // ---- 生成与检查 ----
    t = Date.now();
    const out = generate(ast, { comments: true, jsescOption: { minimal: true } }).code + '\n';
    const outFile = path.join(cfg.out, cfg.outName);
    fs.writeFileSync(outFile, out);
    lap('生成', t);
    res.output = outFile; res.outBytes = Buffer.byteLength(out); res.outLines = out.split('\n').length;
    try { execFileSync(process.execPath, ['--check', outFile], { stdio: 'pipe' }); res.syntaxOk = true; }
    catch (e) { res.syntaxOk = false; res.syntaxError = String(e.stderr || e).slice(0, 300); }
    res.scan = S.scanProtection(out);

    // ---- 字符串还原哨兵检查 ----
    // 抽样 5 个已知 API 名：如果字符串表对应错误或错位，这些名字不会出现在产出里。
    const SENTINELS = cfg.sentinels && cfg.sentinels.length ? cfg.sentinels : ['register', 'SpinAck', 'GameView', 'OnCommand'];
    const sentinelHits = {};
    const missingSentinels = [];
    for (const s of SENTINELS) {
      // 搜索整词出现（字符串字面量或标识符）
      const count = (out.match(new RegExp(`\\b${s}\\b`, 'g')) || []).length;
      sentinelHits[s] = count;
      if (count === 0) missingSentinels.push(s);
    }
    res.sentinels = sentinelHits;
    if (missingSentinels.length > 0) {
      const usingDefault = !(cfg.sentinels && cfg.sentinels.length);
      const warn = `字符串还原哨兵缺失：${missingSentinels.join(', ')} 未出现在产出中——可能字符串表错位或对错了文件` +
        (usingDefault ? '（用的是默认哨兵：外壳 bundle 天然没有 SpinAck/GameView，其他框架也会缺；请用 --sentinels 按文件指定后再判断）' : '');
      res.sentinelWarning = warn;
      say('⚠ ' + warn);
    }

    say(`写出 ${outFile}（${res.outLines} 行），语法检查 ${res.syntaxOk ? '通过' : '失败'}`);
  } catch (e) {
    unmute();
    res.error = String(e && e.stack || e).slice(0, 2000);
    say('失败：' + res.error);
  }
  return res;
}

await dispatch();
