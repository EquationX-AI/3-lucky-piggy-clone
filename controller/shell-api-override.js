/**
 * TD_400 (3 LUCKY PIGGY) 外壳接管 — astarte2 3.6 无 WASM 变体
 *
 * td400 没有独立的 WASM 加密模块（不同于 td109）。
 * 外壳的 CommonGame 通过 globalThis.Astarte 注入，游戏在 main bundle 的
 * __preload 里调 CommonGame.SetGameCb(this) 注册 GameView。
 *
 * 策略：在引擎加载前预设 Astarte.CommonGame 为本地实现，
 * 拦截 SetGameCb 拿到 GameView，然后通过 OnCommand 喂 protobuf 字节。
 *
 * 同时钩住 System.register 拦截外壳 WASM 模块（如果存在的话），
 * 替换 WebSocket 为假连接，屏蔽 MSG 错误弹框。
 */
(function (w) {
  'use strict';

  var stats = { login: 0, spins: 0, setGameCb: 0, wsStubbed: 0 };
  w.__CTRL_STATS__ = stats;
  w.__CTRL_PUSH_IDLE__ = true;
  w.__CTRL_SHELL_OWNS_ACK__ = false;

  // ========== 1. 预设 Astarte 命名空间 ==========
  w.Astarte = w.Astarte || {};
  var A = w.Astarte;

  // CommonGame 本地实现
  A.CommonGame = {
    _cb: null,
    IsTwice: false,
    IsGetRoundEndAck: true,
    HasUnshow: false,
    m_postMoney: 12000000,
    SetGameCb: function (view) {
      this._cb = view;
      stats.setGameCb++;
      console.log('[shell-override] SetGameCb received GameView');

      // 等一拍让 proto 注册完成
      setTimeout(function () {
        try {
          // 找到 tlpProto — 它在 main bundle 的 protobufjs 注册
          var fgProto = null;
          var ackType = null;

          // tlpProto 在 main.js 运行后挂到模块闭包里，通过 window 搜不到；
          // 但 OnCommand 里用 tlpProto.GameInfoData.decode — 我们从 GameView 的 OnCommand 函数文本里反推不了。
          // 正确做法：从 cc.director.getScene() 的组件上找 __proto__ 链上的 protobuf 引用。
          // 但更简单的做法：用 Controller.js 在 attach 时接收外部传入的 fgProto。
          // 这里通过全局 __fgProto / __ackType 传递。

          if (w.__fgProto && w.__ackType) {
            w.Controller.attach({ fgProto: w.__fgProto, AckType: w.__ackType, view: view });
            w.Controller.use(w.LocalController);
            w.__controllerReady = true;
            w.Controller.autoLogin(view);
            w.__loginSent = true;
            console.log('[shell-override] Controller attached and login sent');
          } else {
            console.warn('[shell-override] waiting for __fgProto/__ackType...');
            // 轮询等待 proto 就绪
            var waitCount = 0;
            var waitTimer = setInterval(function () {
              if (++waitCount > 100) { clearInterval(waitTimer); console.error('[shell-override] proto timeout'); return; }
              if (!w.__fgProto || !w.__ackType) return;
              clearInterval(waitTimer);
              w.Controller.attach({ fgProto: w.__fgProto, AckType: w.__ackType, view: view });
              w.Controller.use(w.LocalController);
              w.__controllerReady = true;
              w.Controller.autoLogin(view);
              w.__loginSent = true;
              console.log('[shell-override] Controller attached (delayed) and login sent');
            }, 100);
          }
        } catch (e) {
          w.__controllerErr = String(e);
          console.error('[shell-override] SetGameCb handler error:', e);
        }
      }, 100);
    },
    ReqNotice: function () {},
    ReqRoundEnd: function () { return false; },
    // 厂商的其它成员（游戏代码可能读）
    ShowMessageBox: function () {},
    ShowMsg: function () {},
    ShowTips: function () {},
    GetChips: function () { return 120000; },
    GetApiID: function () { return '10106'; },
    GetAID: function () { return '1'; }
  };

  // 其它 Astarte 模块占位（游戏代码 globalThis.Astarte.XXX 会取）
  A.AppManager = A.AppManager || { GetAID: function () { return '1'; }, GetApiID: function () { return '10106'; } };
  A.Define = A.Define || { AudioClips: {}, StringKey: {}, GameBundle: 'game' };
  A.BuyBonus = A.BuyBonus || {};
  A.Backpack = A.Backpack || {};
  A.DailyMission = A.DailyMission || {};
  A.Debris = A.Debris || {};
  A.GaiaManager = A.GaiaManager || {};
  A.GiftCode = A.GiftCode || {};
  A.IframeCommand = A.IframeCommand || { Send: function () {} };
  A.StateManager = A.StateManager || {
    _state: 1001,
    Current: function () { return this._state; },
    NextState: function (s) { this._state = s; stats.stateChanges = (stats.stateChanges || 0) + 1; }
  };
  A.NewBottombar = A.NewBottombar || {
    GetNowBetValue: function () { return w.__CTRL_BET__ || 200; },
    GetBetList: function () { return [200,400,600,1000,2000,4000,6000,10000]; },
    ChangeBetByStep: function () {},
    BalanceLabel: null
  };
  A.MsgBox = A.MsgBox || { Show: function () {}, ShowMessageBox: function () {} };

  // ========== 2. WebSocket 假连接 ==========
  var RealWS = w.WebSocket;
  if (RealWS) {
    function FakeWS(url) {
      this.url = url; this.readyState = 0; this._sent = 0;
      this.onopen = this.onmessage = this.onerror = this.onclose = null;
      var self = this;
      setTimeout(function () {
        self.readyState = 1;
        try { self.onopen && self.onopen({ type: 'open' }); } catch (e) {}
        setTimeout(function () {
          try { self.onmessage && self.onmessage({ type: 'message', data: '{"error":0}' }); } catch (e) {}
        }, 40);
      }, 30);
      stats.wsStubbed++;
    }
    FakeWS.prototype.send = function () { this._sent++; };
    FakeWS.prototype.close = function () { this.readyState = 3; try { this.onclose && this.onclose({ type: 'close', code: 1000 }); } catch (e) {} };
    FakeWS.prototype.addEventListener = function (t, f) { if (t === 'open' && this.readyState === 1) setTimeout(f, 0); else this['on' + t] = f; };
    FakeWS.prototype.removeEventListener = function () {};

    w.WebSocket = function (url, proto) {
      if (/lifeservice|\/ws\d|tadagaming/i.test(String(url))) return new FakeWS(url);
      return new RealWS(url, proto);
    };
    w.WebSocket.prototype = RealWS.prototype;
    ['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(function (k) { try { w.WebSocket[k] = RealWS[k]; } catch(e){} });
  }

  // ========== 3. 拦截外发 fetch/XHR（零外发保障） ==========
  var origFetch = w.fetch;
  w.fetch = function (url) {
    var u = String(typeof url === 'string' ? url : (url && url.url) || '');
    // 放行本机请求
    if (u.startsWith('/') || u.includes('127.0.0.1') || u.includes('localhost')) {
      return origFetch.apply(this, arguments);
    }
    // 厂商埋点/统计 — 静默成功
    if (/googletagmanager|gtag|google-analytics|tadagaming|webservice|event/i.test(u)) {
      stats.blockedFetch = (stats.blockedFetch || 0) + 1;
      return Promise.resolve(new Response('{}', { status: 200 }));
    }
    console.warn('[shell-override] blocked fetch:', u);
    stats.blockedFetch = (stats.blockedFetch || 0) + 1;
    return Promise.resolve(new Response('{}', { status: 200 }));
  };

  // ========== 4. 状态机推进定时器 ==========
  setInterval(function () {
    try {
      var SM = A.StateManager;
      if (!SM || !w.__CTRL_PUSH_IDLE__) return;
      var cur = SM.Current();
      // LOGIN → IDLE
      if (cur === 1001 && w.__loginSent) {
        SM.NextState(1005);
        stats.pushedIdle = (stats.pushedIdle || 0) + 1;
      }
    } catch (e) {}
  }, 300);

  // ========== 5. SSO 登录回包模板 ==========
  w.__CTRL_LOGIN_OBJ__ = {
    homeUrl: '/', linecode: 0, token: 'local-dev-token',
    response: { error: 0, message: '', time: Math.floor(Date.now() / 1000) },
    lobbyMode: 4, country: 'Mexico', GameBundle: 'game',
    profile: {
      id: '', aid: 1, apiId: 10106, subAgentCode: 1, betLevel: 0, betValue: 200,
      lobbyMode: 4, coin: 12000000, walletType: 2, siteId: 959274638,
      nickname: 'local', account: 'local@api-10106.game',
      wallets: [{ id: 1, walletType: 2, coin: 12000000, balance: 12000000, currency: 'MXN', isDefault: true }],
      meta: {}
    },
    wallets: [{ id: 1, walletType: 2, coin: 12000000, balance: 12000000, currency: 'MXN', isDefault: true }]
  };

  console.log('[shell-override] td400 shell override installed');
})(window);
