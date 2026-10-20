/**
 * controller 引导：等 cc 场景里的 GameView 组件出现，再 attach + 登录。
 *
 * 为什么不在 main.js 里直接调：`SetGameCb` 那段在**登录成功之后**才执行，
 * 而登录结果正是 controller 要喂的——先后颠倒。所以独立一个引导脚本，按场景出现时机接线。
 */
(function () {
  'use strict';
  var tries = 0;
  var timer = null;
  function tryBoot() {
    if (++tries > 600) { clearInterval(timer); return; }
    var cc = window.cc, C = window.Controller;
    if (!cc || !cc.director || !C || !window.LocalController) return;
    var scene = cc.director.getScene();
    if (!scene) return;
    var gv = null;
    (function walk(n) {
      if (!gv && n.name === 'GameView') gv = n;
      var ch = n.children || [];
      for (var i = 0; i < ch.length; i++) walk(ch[i]);
    })(scene);
    if (!gv) return;
    var comps = gv._components || gv.components || [];
    var view = null;
    for (var j = 0; j < comps.length; j++) {
      if (comps[j] && comps[j].m_spinAck !== undefined) { view = comps[j]; break; }
    }
    if (!view) return;
    clearInterval(timer);
    try {
      // 登录/换注额会走 SetMultiBetInfo → SetExtraBetMaxRatio → GetWalletByID（钱包数组为空会抛），
      // 本地没有多注额信息，直接让它变成 no-op（本款只用一个注额档）。
      if (typeof view.SetMultiBetInfo === 'function') { view.SetMultiBetInfo = function () {}; window.__multiBetStubbed = true; }
      C.attach({ fgProto: window.__fgProto, AckType: window.__ackType, view: view });
      C.use(window.LocalController);
      window.__controllerReady = true;
      C.autoLogin(view);
      window.__loginSent = true;
    } catch (e) {
      window.__controllerErr = String(e);
      // 已知竞态：GetWalletByID 在钱包数组尚未就绪时会抛一次，稍后重试即可成功。
      // 重试成功就只记 warn（不算错误）；重试仍失败才记 error。
      if (!window.__bootRetry && /GetWalletByID|reading 'length'/.test(String(e))) {
        window.__bootRetry = true;
        console.warn('[controller] boot retry after transient wallet race');
        setTimeout(tryBoot, 300);
        return;
      }
      console.error('[controller] boot fail:', e);
    }
  }
  timer = setInterval(function () {
    if (++tries > 600) { clearInterval(timer); return; }
    tryBoot();
  }, 200);
})();

/**
 * 本地 CommonGame：把外壳的 Astarte.CommonGame 整体换掉。
 *
 * 游戏侧只用它 6 个成员（grep _0x353690\. 得到）：
 *   SetGameCb / IsTwice / IsGetRoundEndAck / HasUnshow / ReqNotice / ReqRoundEnd
 * 换成这个之后，游戏不再依赖外壳的连接状态；登录由 controller 直接喂。
 */
window.__LocalCommonGame = {
  _cb: null,
  IsTwice: false,
  IsGetRoundEndAck: true,
  HasUnshow: false,
  SetGameCb: function (view) {
    this._cb = view;
    var C = window.Controller;
    if (!C || !window.LocalController) return;
    // fgProto/AckType 是在 SetGameCb 之后一行才挂到 window 的，等一拍再接线
    setTimeout(function () {
      try {
        C.attach({ fgProto: window.__fgProto, AckType: window.__ackType, view: view });
        C.use(window.LocalController);
        window.__controllerReady = true;
        try { window.__CTRL_LOGIN_DATA__ = window.LocalController.login(); } catch (e) {}
        // 登录 ack 由外壳的 request 出口（runtime/shell-api-override.js）回给游戏，这里不再直接喂，
        // 否则同一份 info 会被投递两次（实测：第二次触发 MSG -92）。
        if (!window.__CTRL_SHELL_OWNS_ACK__) C.autoLogin(view);
        window.__loginSent = true;
      } catch (e) { window.__controllerErr = String(e); console.error('[controller] login fail:', e); }
    }, 60);
  },
  ReqNotice: function () {},
  ReqRoundEnd: function () { return false; }
};
