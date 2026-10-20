// F4：空注册 other（不运行厂商 other，避免域名白名单烧死主线程）
// 只提供 System.register 骨架 + virtual 模块，导出全空。
(function () {
  var S = window.System;
  function emptyDeclare() { return { setters: [], execute: function () {} }; }
  try { S.register('chunks:///other.js', [], emptyDeclare); } catch (e) {}
  try { S.register('virtual:///prerequisite-imports/other', [], emptyDeclare); } catch (e) {}
  try { console.log('[F4] other stub registered'); } catch (e) {}
})();
