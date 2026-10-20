// 在干净的同域页面里加载原始混淆文件，立刻导出解码器的整张字符串表（解码器尚未被业务代码调用）
// 用法：先把标签页导航到 https://uat-wbgame.tadagaming.com/astarte2/（无注入），再 eval 本文件，
//      之前设置 window.__DUMP_SPEC__ = {url, ns, dec, max}
(async function () {
  var J = JSON.stringify.bind(JSON), W = window; // 原始文件会破坏全局内置，先存引用
  var sp = window.__DUMP_SPEC__;
  var txt = await (await fetch(sp.url)).text();
  var regs = [];
  window.System = { register: function () { regs.push(arguments[0]); }, import: function () { return Promise.resolve({}); } };
  try { (0, eval)(txt); } catch (e) { return J({ evalError: (e && e.message) + "", stack: (e && e.stack || "").slice(0, 600) }); }
  var ns = W[sp.ns]; if (!ns) return J({ err: 'ns missing', regs: regs });
  var out = [];
  for (var i = 0; i <= sp.max; i++) { var v; try { v = ns[sp.dec](i); } catch (e) { v = null; } out.push(v === undefined ? null : v); }
  return J(out);
})()
