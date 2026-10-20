// 验收：重写组件是否已替换原类并在原始场景中工作
// 用法：node ../../tools/rewrite/cdp.mjs eval tools/probe/verify-swap.js
(async function () {
  var out = { loader: window.__REPLICA_REWRITE__ ? { ok: window.__REPLICA_REWRITE__.ok, components: window.__REPLICA_REWRITE__.components, error: window.__REPLICA_REWRITE__.error } : 'missing' };
  if (!window.__REPLICA_REWRITE__ || !window.__REPLICA_REWRITE__.ok) return JSON.stringify(out);
  var reg = window.__REPLICA_REWRITE__.mod.REWRITTEN;
  var scene = cc.director.getScene();
  out.perComponent = {};
  reg.forEach(function (info, uuid) {
    var r = { classIdOwner: cc.js._getClassById(uuid) === info.ctor ? 'ours' : 'NOT-ours', replacedOriginal: !!info.replaced, instances: [], originalInstances: 0 };
    (function walk(n) {
      (n.components || []).forEach(function (c) {
        if (c instanceof info.ctor) {
          var keys = Object.keys(c).filter(function (k) { return k.indexOf('m_') === 0; });
          var fields = {}; keys.forEach(function (k) { var v = c[k]; fields[k] = v == null ? null : (v.constructor && cc.js.getClassName(v.constructor)) || typeof v; });
          r.instances.push({ node: n.name, path: n.getPathInHierarchy ? n.getPathInHierarchy() : n.name, fields: fields });
        } else if (info.replaced && c instanceof info.replaced) r.originalInstances++;
      });
      n.children.forEach(walk);
    })(scene);
    out.perComponent[info.name] = r;
  });
  // 被谁引用：EffectPlate.m_fxShowSpine
  var eps = [];
  (function walk(n) { (n.components || []).forEach(function (c) { if (cc.js.getClassName(c) === 'EffectPlate') eps.push(c); }); n.children.forEach(walk); })(scene);
  var fx = reg.get('7cfa8py1ExAmKzdY2kFdy4E');
  out.effectPlateRefs = eps.map(function (ep) { return { node: ep.node.name, m_fxShowSpine: ep.m_fxShowSpine ? (ep.m_fxShowSpine instanceof fx.ctor ? 'ours@' + ep.m_fxShowSpine.node.name : 'other') : null, viaGetter: ep.FxShowSpine === ep.m_fxShowSpine }; });
  // 行为：调用 PlayMultiWin，确认能播完、节点最后被隐藏
  if (eps[0] && eps[0].m_fxShowSpine) {
    var c = eps[0].m_fxShowSpine, t0 = performance.now(), anims = [];
    var before = c.node.active;
    var p = c.PlayMultiWin();
    out.play = { activeDuring: c.node.active, track: (function () { try { return c.m_spine.getCurrent(0).animation.name; } catch (e) { return 'err:' + e.message; } })() };
    var res = await Promise.race([p.then(function () { return 'resolved'; }), new Promise(function (r) { setTimeout(function () { r('timeout-10s'); }, 10000); })]);
    out.play.result = res; out.play.ms = Math.round(performance.now() - t0); out.play.activeAfter = c.node.active; out.play.activeBefore = before;
  }
  var gv = null; (function walk(n) { if (n.name === 'GameView') gv = n; n.children.forEach(walk); })(scene);
  out.gameView = gv ? { active: gv.activeInHierarchy } : null;
  try { out.stateId = window.__ASTARTE_IMPL__.StateManager.m_currStateId; } catch (e) {}
  return JSON.stringify(out, null, 1);
})()
