/**
 * TD_400 controller —— 通信层唯一出口（交付三样之一）。
 *
 * 背景（skill comm-replace「下行加密 / 会话绑定时怎么办」）：
 *   厂商外壳负责「发请求 / 收结果」，下行是密文、密钥每会话随机（deviceBlock 32B），解密在外壳 wasm 里。
 *   不反汇编 wasm、不录回放：把这两头剪断，中间换成这里。
 *
 * 游戏侧只调两个方法：
 *   Controller.attach({ fgProto, AckType, view })  main.js 初始化时一次
 *   Controller.autoLogin(view)                     进游戏后触发登录（info）
 *   Controller.requestSpin(view)                   玩家按 SPIN 时
 *
 * 实现用 use(impl) 注入：impl.login() -> GameInfoData 形状；impl.spin(req) -> SpinAck 形状。
 * 没注入实现时直接抛「待接入」，不会假装成功。
 *
 * 为什么注入点在 OnCommand：外壳把解密后的 ack 交给 main.js 的 OnCommand(ackType, bytes)，
 * 那是 JS 侧唯一消费明文的地方。这里用 fgProto.encode 造同样的 bytes 喂进去，
 * 游戏自己的解码与状态机一行都不用改。
 */
(function (global) {
  'use strict';

  var impl = null;
  var ctx = null;                                   // { fgProto, AckType, view }
  var stats = { logins: 0, spins: 0, wins: 0, totalWin: 0, balance: null };

  function need(name) {
    if (!ctx) throw new Error('Controller: attach() 还没调用');
    if (!impl) throw new Error('Controller.' + name + ': 还没注入实现（Controller.use(impl)）');
  }

  var Controller = {
    attach: function (c) { ctx = c || null; return Controller; },
    use: function (i) { impl = i || null; Controller._impl = impl; return Controller; },

    /** 对象 → protobuf bytes → 走游戏自己的 OnCommand 解码路 */
    /** 只编码不投递：给"在外壳 request 出口处直接回包"的场景用（见 runtime/shell-api-override.js） */
    encodeBytes: function (ackType, obj) {
      if (!ctx || !ctx.fgProto) throw new Error('Controller.encodeBytes: ctx 不完整');
      var name = ctx.protoName || 'GameInfoData';
      var proto = ctx.fgProto[name] || ctx.fgProto.SpinAck;
      return proto.encode(proto.fromObject(obj)).finish();
    },
    emit: function (ackType, obj) {
      if (!ctx || !ctx.fgProto || !ctx.view) throw new Error('Controller.emit: ctx 不完整');
      var proto = ackType === ctx.AckType.info ? ctx.fgProto.GameInfoData : ctx.fgProto.SpinAck;
      var bytes = proto.encode(proto.fromObject(obj)).finish();
      // OnCommand 在 CommonGame 上（ctx.view 是 GameView，没有这个方法）
      var host = ctx.commandHost || (ctx.view && typeof ctx.view.OnCommand === 'function' ? ctx.view : null);
      if (!host && typeof global !== 'undefined' && global.Astarte && global.Astarte.CommonGame) host = global.Astarte.CommonGame;
      if (!host) throw new Error('Controller.emit: 找不到 OnCommand 宿主');
      host.OnCommand(ackType, bytes);
      return bytes;
    },

    autoLogin: function (view) {
      need('autoLogin');
      if (view) ctx.view = view;
      var info = impl.login();
      stats.logins++;
      if (info.NowMoney != null) stats.balance = info.NowMoney;
      Controller.emit(ctx.AckType.info, info);
      return info;
    },

    requestSpin: function (view, req) {
      need('requestSpin');
      // 连点保护：厂商侧转盘期间再点不会重复下单；本地也照做（F14）
      var now = Date.now();
      if (Controller.__spinBusyUntil && now < Controller.__spinBusyUntil) {
        stats.ignoredSpins = (stats.ignoredSpins || 0) + 1;
        return null;
      }
      Controller.__spinBusyUntil = now + 1500;
      // 对齐厂商的 ack 落地时间（实测 vendor 起转后 1.8–2.1s 才把结果交给客户端）
      var ackDelay = Number((global && global.__CTRL_ACK_DELAY_MS__) || 0);
      if (view) ctx.view = view;
      var r = req || Controller.buildRequest(view);
      var ack = impl.spin(r);
      stats.spins++;
      var win = Number(ack.TotalWin || 0);
      if (win > 0) { stats.wins++; stats.totalWin += win; }
      if (ack.NowMoney != null) stats.balance = ack.NowMoney;
      if (ackDelay > 0) { stats.ackDelayMs = ackDelay; setTimeout(function () { Controller.emit(ctx.AckType.spin, ack); }, ackDelay); return ack; }
      // ack 投递时机：宿主可以接 __CTRL_BEFORE_ACK__，在"游戏真的进到转动态"之后回调 emit。
      // 不用 setTimeout 猜时间——外壳自己会在超时后报 -92（已实测）。
      var before = global && global.__CTRL_BEFORE_ACK__;
      if (typeof before === 'function') {
        before(function () { Controller.emit(ctx.AckType.spin, ack); });
      } else {
        Controller.emit(ctx.AckType.spin, ack);
      }
      return ack;
    },

    /**
     * 延迟投递版：先让游戏自己把 spin 请求发出去（状态机 IDLE→SPIN_REQ→SPIN，自己调 StartSpin），
     * 等 ackDelayMs 后（对齐厂商 1.8–2.1s）再喂结果，让 SetPlateInfo 在转动态下逐轴停。
     */
    requestSpinDeferred: function (view, req) {
      need('requestSpin');
      if (view) ctx.view = view;
      var r = req || Controller.buildRequest(view);
      var ack = impl.spin(r);
      stats.spins++;
      var win = Number(ack.TotalWin || 0);
      if (win > 0) { stats.wins++; stats.totalWin += win; }
      if (ack.NowMoney != null) stats.balance = ack.NowMoney;
      var delay = Number((global && global.__CTRL_ACK_DELAY_MS__) || 2050);
      stats.ackDelayMs = delay;
      setTimeout(function () { Controller.emit(ctx.AckType.spin, ack); }, delay);
      return ack;
    },

    /** 注额/EX 从游戏视图取，controller 不自己维护一份 */
    buildRequest: function (view) {
      var v = view || (ctx && ctx.view) || {};
      var bet = 0, extra = false;
      try { bet = Number(v.GetNowBetValue()) || 0; } catch (e) {}
      try { extra = !!(v.m_extraBar && v.m_extraBar.IsExtra && v.m_extraBar.IsExtra()); } catch (e) {}
      return { bet: bet, isExtra: extra, ts: Date.now() };
    },

    stats: function () {
      var bal = stats.balance;
      if (bal == null && impl && typeof impl.getBalance === "function") {
        try { bal = impl.getBalance(); } catch (e) {}
      }
      return { logins: stats.logins, spins: stats.spins, wins: stats.wins, totalWin: stats.totalWin, balance: bal };
    }
  };

  global.Controller = Controller;
})(window);
