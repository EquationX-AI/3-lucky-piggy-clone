#!/usr/bin/env node
/**
 * S3 别名实测采集 — 在沙箱浏览器运行原始混淆文件，
 * 拦截 Object.defineProperty(window, name, {get}) 调用，
 * 当场调用 getter 读出返回的内置对象名。
 * 
 * 用法：CDP_PORT=<端口> node capture-aliases.mjs <gameUrl> <outFile>
 *   outFile 以 .json 结尾：输出 {别名: 解析名}；以 .js 结尾：输出 inline-aliases.mjs 用的 shim 格式
 *   d("别名", function(){ return 解析名; });（解析不出的别名不写入，打印出来要人工处理）
 *   前提：Chrome 带 --remote-debugging-port 已打开空白页；沙箱页面要走 MX 代理。
 *   来源：v3 lj500 机台（S3 实测采 179 个），入库时加了 shim 输出。
 * 
 * 产出：JSON { alias: resolvedName, ... }
 * 日志只打印别名和解析结果的类型名，不打印值内容。
 */
import fs from 'node:fs';

const PORT = Number(process.env.CDP_PORT || 18818);
const gameUrl = process.argv[2];
const outFile = process.argv[3] || 'inspect/s3-aliases.json';

if (!gameUrl) { console.error('用法: node capture-aliases.mjs <gameUrl> <outFile.json|outFile.js>'); process.exit(1); }

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
  const send = (method, params = {}, timeout = 120000) => new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error('timeout ' + method)); } }, timeout);
  });
  return { send, close: () => ws.close() };
}

async function main() {
  const c = await connect();
  await c.send('Page.enable');
  
  // 注入拦截脚本：在文档加载前拦截 defineProperty
  const interceptScript = `
(function() {
  var captured = {};
  var origDefProp = Object.defineProperty;
  
  // 内置对象名映射
  var builtinNames = new Map();
  builtinNames.set(window, 'window');
  // 框架全局：拦截时它们通常已存在；不在内置表里会被当成普通 object/Window（v3 fg5：System 别名被记成 window.X）
  ['System','cc','sp','dragonBones','Astarte','LobbyData','AudioManager'].forEach(function(n){ try { if (typeof window[n] !== 'undefined' && window[n] !== null) builtinNames.set(window[n], n); } catch(e){} });
  builtinNames.set(Object, 'Object');
  builtinNames.set(Array, 'Array');
  builtinNames.set(Function, 'Function');
  builtinNames.set(String, 'String');
  builtinNames.set(Number, 'Number');
  builtinNames.set(Boolean, 'Boolean');
  builtinNames.set(Date, 'Date');
  builtinNames.set(RegExp, 'RegExp');
  builtinNames.set(Error, 'Error');
  builtinNames.set(TypeError, 'TypeError');
  builtinNames.set(RangeError, 'RangeError');
  builtinNames.set(Math, 'Math');
  builtinNames.set(JSON, 'JSON');
  builtinNames.set(Promise, 'Promise');
  builtinNames.set(Map, 'Map');
  builtinNames.set(Set, 'Set');
  builtinNames.set(WeakMap, 'WeakMap');
  builtinNames.set(WeakSet, 'WeakSet');
  builtinNames.set(Symbol, 'Symbol');
  builtinNames.set(Proxy, 'Proxy');
  builtinNames.set(Reflect, 'Reflect');
  builtinNames.set(ArrayBuffer, 'ArrayBuffer');
  builtinNames.set(DataView, 'DataView');
  builtinNames.set(Uint8Array, 'Uint8Array');
  builtinNames.set(Int8Array, 'Int8Array');
  builtinNames.set(Uint16Array, 'Uint16Array');
  builtinNames.set(Int16Array, 'Int16Array');
  builtinNames.set(Uint32Array, 'Uint32Array');
  builtinNames.set(Int32Array, 'Int32Array');
  builtinNames.set(Float32Array, 'Float32Array');
  builtinNames.set(Float64Array, 'Float64Array');
  builtinNames.set(parseInt, 'parseInt');
  builtinNames.set(parseFloat, 'parseFloat');
  builtinNames.set(isNaN, 'isNaN');
  builtinNames.set(isFinite, 'isFinite');
  builtinNames.set(setTimeout, 'setTimeout');
  builtinNames.set(setInterval, 'setInterval');
  builtinNames.set(clearTimeout, 'clearTimeout');
  builtinNames.set(clearInterval, 'clearInterval');
  builtinNames.set(encodeURIComponent, 'encodeURIComponent');
  builtinNames.set(decodeURIComponent, 'decodeURIComponent');
  builtinNames.set(eval, 'eval');
  builtinNames.set(atob, 'atob');
  builtinNames.set(btoa, 'btoa');
  try { builtinNames.set(System, 'System'); } catch(e) {}
  try { builtinNames.set(navigator, 'navigator'); } catch(e) {}
  try { builtinNames.set(location, 'Location'); } catch(e) {}
  try { builtinNames.set(document, 'document'); } catch(e) {}
  try { builtinNames.set(console, 'console'); } catch(e) {}
  try { builtinNames.set(performance, 'performance'); } catch(e) {}
  try { builtinNames.set(localStorage, 'localStorage'); } catch(e) {}
  try { builtinNames.set(sessionStorage, 'sessionStorage'); } catch(e) {}
  try { builtinNames.set(XMLHttpRequest, 'XMLHttpRequest'); } catch(e) {}
  try { builtinNames.set(fetch, 'fetch'); } catch(e) {}
  try { builtinNames.set(Image, 'Image'); } catch(e) {}
  try { builtinNames.set(Audio, 'Audio'); } catch(e) {}
  try { builtinNames.set(WebAssembly, 'WebAssembly'); } catch(e) {}
  try { builtinNames.set(requestAnimationFrame, 'requestAnimationFrame'); } catch(e) {}
  try { builtinNames.set(cancelAnimationFrame, 'cancelAnimationFrame'); } catch(e) {}
  try { builtinNames.set(screen, 'screen'); } catch(e) {}
  try { builtinNames.set(crypto, 'crypto'); } catch(e) {}
  try { builtinNames.set(TextEncoder, 'TextEncoder'); } catch(e) {}
  try { builtinNames.set(TextDecoder, 'TextDecoder'); } catch(e) {}
  try { builtinNames.set(Blob, 'Blob'); } catch(e) {}
  try { builtinNames.set(URL, 'URL'); } catch(e) {}
  try { builtinNames.set(URLSearchParams, 'URLSearchParams'); } catch(e) {}
  try { builtinNames.set(FormData, 'FormData'); } catch(e) {}
  try { builtinNames.set(AbortController, 'AbortController'); } catch(e) {}
  try { builtinNames.set(Worker, 'Worker'); } catch(e) {}
  try { builtinNames.set(MessageChannel, 'MessageChannel'); } catch(e) {}
  try { builtinNames.set(IntersectionObserver, 'IntersectionObserver'); } catch(e) {}
  try { builtinNames.set(MutationObserver, 'MutationObserver'); } catch(e) {}
  try { builtinNames.set(ResizeObserver, 'ResizeObserver'); } catch(e) {}
  try { builtinNames.set(WebSocket, 'WebSocket'); } catch(e) {}
  try { builtinNames.set(history, 'history'); } catch(e) {}
  
  // 特殊值
  builtinNames.set(undefined, 'undefined');
  builtinNames.set(null, 'null');
  builtinNames.set(true, 'true');
  builtinNames.set(false, 'false');
  builtinNames.set(1000, '1000');
  
  function resolveName(val) {
    if (builtinNames.has(val)) return builtinNames.get(val);
    if (val === window) return 'window';
    // 精确匹配：在 window 自有属性里找值完全相同的全局名（跳过已采到的别名本身）
    if (val !== null && (typeof val === 'object' || typeof val === 'function')) {
      try {
        var keys = Object.getOwnPropertyNames(window);
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i]; if (captured.hasOwnProperty(k)) continue;
          var d = Object.getOwnPropertyDescriptor(window, k);
          if (d && 'value' in d && d.value === val && /^[A-Za-z_$][\w$]*$/.test(k)) return k;
        }
      } catch(e) {}
    }
    // 以下都是猜测（加 ? 前缀），写 shim 时不会采用，需人工确认
    if (typeof val === 'function') return '?Function';
    if (typeof val === 'number') return String(val);
    if (typeof val === 'string') return 'string:' + val.length;
    if (typeof val === 'undefined') return '?undefined';
    if (val === null) return 'null';
    if (typeof val === 'object') {
      try {
        if (val.constructor) return '?' + (val.constructor.name || 'Object');
      } catch(e) {}
      return '?Object';
    }
    return typeof val;
  }
  
  Object.defineProperty = function(target, prop, descriptor) {
    // 只拦截对 window 的带 get 的定义（Jscrambler 全局别名）
    if (target === window && descriptor && typeof descriptor.get === 'function' && typeof prop === 'string') {
      try {
        var val = descriptor.get();
        captured[prop] = resolveName(val);
      } catch(e) {
        captured[prop] = 'error';
      }
    }
    return origDefProp.call(Object, target, prop, descriptor);
  };
  
  // 暴露采集结果
  window.__s3_captured = captured;
})();
`;

  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: interceptScript });
  console.log('拦截脚本已注入');
  
  // 导航到游戏页面
  console.log('导航到游戏页面...');
  await c.send('Page.navigate', { url: gameUrl });
  
  // 等待采集完成（等 Cocos 初始化或超时）
  for (let i = 0; i < 45; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const r = await c.send('Runtime.evaluate', {
        expression: '(function(){var c=window.__s3_captured||{};return JSON.stringify({count:Object.keys(c).length,hasCc:typeof cc!=="undefined"})})()',
        returnByValue: true
      }, 5000);
      const v = JSON.parse(r.result?.result?.value || '{}');
      if (i % 5 === 0) console.log(`[${i*2}s] 别名: ${v.count}, cc: ${v.hasCc}`);
      
      // Cocos 初始化后别名应该全部注册完了
      if (v.hasCc && v.count > 100) {
        console.log('Cocos 已初始化，别名采集完成');
        break;
      }
    } catch {}
  }
  
  // 提取结果
  const r = await c.send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__s3_captured || {})',
    returnByValue: true
  });
  const aliases = JSON.parse(r.result?.result?.value || '{}');
  
  const path = await import('node:path');
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  if (outFile.endsWith('.js')) {
    const ok = [], bad = [];
    for (const [k, v] of Object.entries(aliases)) ((/^[A-Za-z_$][\w$.]*$/.test(v) || /^-?\d+(\.\d+)?$/.test(v)) && v !== 'error' ? ok : bad).push([k, v]);
    fs.writeFileSync(outFile, ok.map(([k, v]) => `d(${JSON.stringify(k)}, function(){ return ${v}; });`).join('\n') + '\n');
    if (bad.length) console.log(`⚠ ${bad.length} 个别名解析不出内置名，未写入 shim，需人工确认：`, bad.map(([k, v]) => k + '=' + v).join(' '));
  } else fs.writeFileSync(outFile, JSON.stringify(aliases, null, 2));
  
  const count = Object.keys(aliases).length;
  console.log(`\n采集完成: ${count} 个别名`);
  
  // 统计解析类型
  const types = {};
  for (const [k, v] of Object.entries(aliases)) {
    types[v] = (types[v] || 0) + 1;
  }
  console.log('类型分布:');
  for (const [t, c] of Object.entries(types).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t}: ${c}`);
  }
  
  c.close();
  setTimeout(() => process.exit(0), 200);
}

main().catch(e => { console.error(e); process.exit(1); });
