// F4：空注册 extra（它依赖 WASM/rollup 两个 chunk，厂商实现不运行）
(function () {
  var S = window.System;
  function emptyDeclare() { return { setters: [], execute: function () {} }; }
  try { S.register('chunks:///extra.js', [], emptyDeclare); } catch (e) {}
  try { S.register('virtual:///prerequisite-imports/extra', [], emptyDeclare); } catch (e) {}
  try { console.log('[F4] extra stub registered'); } catch (e) {}
})();
