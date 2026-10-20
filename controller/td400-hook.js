/**
 * TD_400 (3 LUCKY PIGGY) 接线钩子
 *
 * 与 td109 的差异：td400 没有独立 WASM 外壳模块，`Astarte.CommonGame` 由外壳注入，
 * 本地没有外壳 → 直接预设一个本地 CommonGame 顶上。
 *
 * 关键设计（绕开 protobuf）：
 *   原版 OnCommand(ackType, bytes) 内部是
 *     case info:      tlpProto.GameInfoData.decode(bytes) → 一堆字段赋值
 *     case spin:      tlpProto.SpinAck.decode(bytes)      → this.OnRecvSpinAck(obj)
 *   而 OnCommand 在本地只由我们自己调用，所以把 OnCommand 换成一版「既吃 bytes 也吃对象」的：
 *   收到对象时直接走游戏自己的 OnRecvSpinAck，完全不需要构造 tlpProto 类。
 *   → 不需要 extern proto、不需要编码器，preset JSON 就是最终结果对象。
 */
(function (w) {
  'use strict';

  var STATS = {
    setGameCb: 0, infoSent: 0, spins: 0, spinsOk: 0,
    errors: [], lastError: null
  };
  w.__CTRL_STATS__ = STATS;

  function log() {
    try { console.log.apply(console, ['[td400]'].concat([].slice.call(arguments))); } catch (e) {}
    // 本地日志外送：渲染线程卡住时 CDP 也读不到，用 beacon 让服务端留痕
    try {
      var msg = [].slice.call(arguments).map(function (x) {
        try { return typeof x === 'string' ? x : JSON.stringify(x); } catch (e) { return String(x); }
      }).join(' ');
      var x = new XMLHttpRequest();
      x.open('POST', '/api/log', true);
      x.setRequestHeader('content-type', 'application/json');
      x.send(JSON.stringify({ t: Date.now(), level: 'log', msg: String(msg).slice(0, 500) }));
    } catch (e) {}
  }
  function err(m) {
    STATS.lastError = String(m);
    STATS.errors.push(String(m));
    try { console.error('[td400]', m); } catch (e) {}
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/api/log', true);
      x.setRequestHeader('content-type', 'application/json');
      x.send(JSON.stringify({ t: Date.now(), level: 'error', msg: String(m).slice(0, 800) }));
    } catch (e) {}
  }
  w.__CTRL_LOG__ = log;
  w.__CTRL_ERR__ = err;

  // ---------- 1. 预设 Astarte 命名空间 ----------
  w.Astarte = w.Astarte || {};
  var A = w.Astarte;

  // 注额（分）
  w.__CTRL_BET__ = 200;
  // 余额（分）
  w.__CTRL_COIN__ = 12000000;

  var BET_LIST = [200, 400, 600, 1000, 2000, 4000, 6000, 10000];

  A.CommonGame = {
    _cb: null,
    IsTwice: false,
    IsGetRoundEndAck: true,
    HasUnshow: false,
    m_postMoney: w.__CTRL_COIN__,
    GameMallInfo: [],
    SetGameCb: function (view) {
      this._cb = view;
      STATS.setGameCb++;
      log('SetGameCb 收到 GameView');
      try { wire(view); } catch (e) { err('SetGameCb wiring: ' + e); }
    },
    ReqNotice: function () {},
    ReqRoundEnd: function () { return false; },
    ShowMessageBox: function () {},
    ShowMsg: function () {},
    ShowTips: function () {},
    GetChips: function () { return Math.floor(w.__CTRL_COIN__ / 100); },
    GetApiID: function () { return '10106'; },
    GetAID: function () { return '1'; },
    IsGetRoundEndAck2: function () { return true; }
  };

  A.AppManager = A.AppManager || {
    GetAID: function () { return '1'; },
    GetApiID: function () { return '10106'; }
  };
  A.Define = A.Define || { AudioClips: {}, StringKey: {}, GameBundle: 'game' };
  A.BuyBonus = A.BuyBonus || {};
  A.Backpack = A.Backpack || {};
  A.DailyMission = A.DailyMission || {};
  A.Debris = A.Debris || {};
  A.GaiaManager = A.GaiaManager || {};
  A.GiftCode = A.GiftCode || {};
  A.IframeCommand = A.IframeCommand || { Send: function () {}, AddCb: function () {} };
  A.MsgBox = A.MsgBox || { Show: function () {}, ShowMessageBox: function () {}, ShowTips: function () {} };
  A.NewBottombar = A.NewBottombar || {
    GetNowBetValue: function () { return w.__CTRL_BET__; },
    GetBetList: function () { return BET_LIST.slice(); },
    ChangeBetByStep: function () {},
    BalanceLabel: null
  };

  // ---------- 2. 结果目录（预设 + 控奖注入） ----------
  var PRESETS = null;
  var presetIdx = 0;
  var nextResult = null;

  function loadPresets() {
    if (PRESETS) return PRESETS;
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', '/controller/preset-spins.json', false);
      xhr.send(null);
      PRESETS = JSON.parse(xhr.responseText);
    } catch (e) {
      err('加载 preset-spins.json 失败: ' + e);
      PRESETS = [];
    }
    return PRESETS;
  }

  function takeResult(reqBet) {
    var ack;
    if (nextResult) {
      ack = JSON.parse(JSON.stringify(nextResult));
      nextResult = null;
    } else {
      var sp = loadPresets();
      if (!sp.length) return null;
      ack = JSON.parse(JSON.stringify(sp[presetIdx % sp.length]));
      presetIdx++;
    }
    var bet = Number(reqBet) || w.__CTRL_BET__;
    var win = Number(ack.TotalWin || 0);
    w.__CTRL_COIN__ = w.__CTRL_COIN__ - bet + win;
    ack.NowMoney = w.__CTRL_COIN__;
    if (ack.AckType == null) ack.AckType = 0;
    if (!ack.ShowIndex) ack.ShowIndex = 'local-' + Date.now();
    // 单步结果补 round_finished（面板五必检③）
    if (ack.RoundQueue && ack.RoundQueue.length && ack.FolderIndex == null) ack.FolderIndex = 0;
    return ack;
  }

  w.__CTRL_TAKE_RESULT__ = takeResult;
  w.__CTRL_SET_NEXT__ = function (obj) { nextResult = obj; };

  // ---------- 3. 接线 GameView ----------
  var wired = false;
  function wire(view) {
    if (wired) return;
    wired = true;
    w.__ctrlView = view;

    // 3.1 记下原版 OnCommand，换成「对象直投」版
    var origOnCommand = view.OnCommand;
    w.__origOnCommand = origOnCommand;

    view.OnCommand = function (ackType, payload) {
      // 我们自己投递的是对象；外壳投递的是 Uint8Array
      if (payload && typeof payload === 'object' &&
          !(payload instanceof Uint8Array) && !(payload instanceof ArrayBuffer)) {
        if (ackType === 0 || ackType === 4) {
          // spin / lastSpin → 直接进游戏自己的演出入口
          try {
            if (typeof view.OnRecvSpinAck === 'function') {
              view.OnRecvSpinAck(payload);
              return true;
            }
          } catch (e) { err('OnRecvSpinAck: ' + e); }
          return false;
        }
        if (ackType === 1) {
          try {
            applyInfo(view, payload);
            return true;
          } catch (e) { err('applyInfo: ' + e); }
          return false;
        }
      }
      // 字节路径：走原版（保留兼容）
      try { return origOnCommand.apply(view, arguments); }
      catch (e) { err('origOnCommand: ' + e); }
    };

    log('OnCommand 已替换为对象直投版');

    // 3.2 立即发 info
    setTimeout(function () { sendInfo(view); }, 200);

    // 3.3 把 SPIN 按钮接到我方
    hookSpin(view);
  }

  /** info 回包：把原版 case info 的关键动作重做一遍（不需要 protobuf） */
  function applyInfo(view, info) {
    view.m_blueOdds = info.BlueOdds || [];
    view.m_coinOdds = info.CoinOdds || [];
    view.CrackLevels = view.CrackLevels || [0, 0, 0, 0, 0];
    for (var i = 0; i < view.CrackLevels.length; i++) {
      view.CrackLevels[i] = (info.CrackLevels && info.CrackLevels[i]) || 0;
    }
    try { if (view.m_jpManager && view.m_jpManager.Init) view.m_jpManager.Init(info.JPOdds || []); } catch (e) {}
    try { if (view.SetTxt) view.SetTxt(); } catch (e) {}
    try { if (view.SettingBottomBar) view.SettingBottomBar(); } catch (e) {}
    STATS.infoSent++;
    log('info 已应用: BlueOdds=' + view.m_blueOdds.length + ' CoinOdds=' + view.m_coinOdds.length);
  }

  function sendInfo(view) {
    var info = {
      AckType: 1,
      BlueOdds: [], CoinOdds: [], CrackLevels: [0, 0, 0, 0, 0], JPOdds: [],
      Mul: [1, 1.5, 2, 3, 5, 8, 10, 15, 20, 30, 50, 100],
      BuyMul: [50, 100, 200],
      WalletInfo: [{ coin: w.__CTRL_COIN__, bet: BET_LIST.slice(), unit: 1, ratio: 1, decimal: 2, currencySymbol: '$' }]
    };
    try {
      view.OnCommand(1, info);
      // 状态机 LOGIN → IDLE
      pushIdle();
    } catch (e) { err('sendInfo: ' + e); }
  }

  // ---------- 4. 状态机推进 ----------
  function findStateManager() {
    // 游戏内部状态机不是 Astarte.StateManager，而是 main bundle 里的单例；
    // 这里从 view 上找 m_* 里带 Current/NextState 的对象。
    var cands = [];
    try {
      for (var k in w.__ctrlView) {
        var v = w.__ctrlView[k];
        if (v && typeof v === 'object' && typeof v.Current === 'function' && typeof v.NextState === 'function') {
          cands.push(k);
        }
      }
    } catch (e) {}
    return cands;
  }
  w.__CTRL_FIND_SM__ = findStateManager;

  var smHack = null;
  function pushIdle() {
    // 游戏状态机在 main bundle 闭包里，view 上没有直接引用；
    // 退而求其次：直接调 SetSpinState(IDLE) 让底栏可用。
    try {
      var v = w.__ctrlView;
      if (v && typeof v.SetSpinState === 'function') {
        v.SetSpinState(1005);
        log('SetSpinState(1005) 已调用');
      }
    } catch (e) { err('pushIdle: ' + e); }
  }
  w.__CTRL_PUSH_IDLE__ = pushIdle;

  // ---------- 5. SPIN 接线 ----------
  function hookSpin(view) {
    // 5.1 包一层 ClickSpin：先让游戏自己起转，再喂 ack
    if (typeof view.ClickSpin === 'function' && !view.__spinHooked) {
      view.__spinHooked = true;
      var origClick = view.ClickSpin;
      view.ClickSpin = function () {
        var bet = w.__CTRL_BET__;
        try { if (view.GetNowBetValue) bet = Number(view.GetNowBetValue()) || bet; } catch (e) {}
        // 先起转（游戏内部 StartSpin）
        var r = null;
        try { r = origClick.apply(view, arguments); } catch (e) { err('ClickSpin: ' + e); }
        // 1.6s 后投 ack（对齐厂商停盘节奏）
        setTimeout(function () {
          try {
            var ack = takeResult(bet);
            if (!ack) { err('无可用结果'); return; }
            STATS.spins++;
            view.OnCommand(0, ack);
            STATS.spinsOk++;
            log('spin #' + STATS.spins + ' 已投递, win=' + (ack.TotalWin || 0) + ', bal=' + w.__CTRL_COIN__);
            // 结束后回 IDLE
            setTimeout(function () { pushIdle(); }, 1200);
          } catch (e) { err('spin ack: ' + e); }
        }, 1600);
        return r;
      };
      log('ClickSpin 已接管');
    }

    // 5.2 场景里的 SPIN 按钮直接绑
    try {
      var cc = w.cc;
      var scene = cc && cc.director && cc.director.getScene();
      if (scene) {
        (function walk(n) {
          if (/^(btn_spin|BTN_SPIN|Button_Spin|plateSpinBtn)$/i.test(n.name)) {
            if (!n.__spinBound) {
              n.__spinBound = true;
              var btn = cc.Button && n.getComponent && n.getComponent(cc.Button);
              if (btn) btn.clickEvents = [];
              n.off(cc.Node.EventType.TOUCH_END);
              n.on(cc.Node.EventType.TOUCH_END, function () {
                log('SPIN 按钮被点击');
                try { view.ClickSpin(); } catch (e) { err('btn spin: ' + e); }
              }, n);
              log('SPIN 按钮已绑定: ' + n.name);
            }
          }
          var ch = n.children || [];
          for (var i = 0; i < ch.length; i++) walk(ch[i]);
        })(scene);
      }
    } catch (e) { err('hookSpin walk: ' + e); }
  }

  // 没等到 SetGameCb 时兜底：直接扫场景找 GameView
  var scan = setInterval(function () {
    if (wired) { clearInterval(scan); return; }
    try {
      var cc = w.cc;
      var scene = cc && cc.director && cc.director.getScene();
      if (!scene) return;
      var gv = null;
      (function walk(n) {
        if (!gv && n.name === 'GameView') gv = n;
        var ch = n.children || [];
        for (var i = 0; i < ch.length; i++) walk(ch[i]);
      })(scene);
      if (!gv) return;
      var comps = gv._components || gv.components || [];
      for (var j = 0; j < comps.length; j++) {
        if (comps[j] && comps[j].m_spinAck !== undefined) {
          log('扫描兜底找到 GameView');
          wire(comps[j]);
          break;
        }
      }
    } catch (e) {}
  }, 300);

  // ---------- 6. 零外发：拦 fetch / XHR ----------
  var origFetch = w.fetch;
  if (origFetch) {
    w.fetch = function (input) {
      var u = String(typeof input === 'string' ? input : (input && input.url) || '');
      if (u.startsWith('/') || u.indexOf('127.0.0.1') >= 0 || u.indexOf('localhost') >= 0) {
        return origFetch.apply(this, arguments);
      }
      STATS.blockedFetch = (STATS.blockedFetch || 0) + 1;
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    };
  }

  var XHR = w.XMLHttpRequest;
  if (XHR && XHR.prototype && XHR.prototype.open) {
    var origOpen = XHR.prototype.open;
    var HOST = w.location.host;
    XHR.prototype.open = function (method, url) {
      var u = String(url == null ? '' : url);
      var args = [].slice.call(arguments);

      // 1) 指向本机的 https → http（保持绝对 URL，避免相对路径解析差异）
      if (u.indexOf('https://' + HOST) === 0) {
        args[1] = 'http://' + HOST + u.slice(('https://' + HOST).length);
        return origOpen.apply(this, args);
      }
      // 2) 真正的外部绝对 URL：改写到本机同路径，保留全部参数（含 async）
      if (/^https?:\/\//i.test(u) && u.indexOf('//' + HOST) < 0 &&
          u.indexOf('//127.0.0.1') < 0 && u.indexOf('//localhost') < 0) {
        STATS.blockedXhr = (STATS.blockedXhr || 0) + 1;
        STATS.blockedUrls = STATS.blockedUrls || [];
        if (STATS.blockedUrls.length < 40) STATS.blockedUrls.push(u.slice(0, 160));
        try {
          var path = u.replace(/^https?:\/\/[^/]+/i, '');
          args[1] = path || '/';
        } catch (e) {}
        return origOpen.apply(this, args);
      }
      // 3) 相对路径 / 本机 URL / data: / blob:：原样放行，参数一个不动
      return origOpen.apply(this, args);
    };
  }

  // ---------- 7. WebSocket 假连接 ----------
  var RealWS = w.WebSocket;
  if (RealWS) {
    function FakeWS(url) {
      var self = this;
      this.url = url; this.readyState = 0; this._sent = 0;
      this.onopen = this.onmessage = this.onerror = this.onclose = null;
      setTimeout(function () {
        self.readyState = 1;
        try { self.onopen && self.onopen({ type: 'open' }); } catch (e) {}
        setTimeout(function () {
          try { self.onmessage && self.onmessage({ type: 'message', data: '{"error":0}' }); } catch (e) {}
        }, 40);
      }, 30);
      STATS.wsStubbed = (STATS.wsStubbed || 0) + 1;
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
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { try { w.WebSocket[k] = RealWS[k]; } catch (e) {} });
  }

  // ---------- 8.5 修 https 硬编码：游戏用 "https://" + location.host 拉外壳 ----------
  // 本地服务是 http，https 会 TLS 失败 → versions.json 拿不到 → 起不来。
  // 只把"指向本机"的 https 改成 http，其它外链仍由零外发逻辑处理。
  function patchLoadRemote() {
    var cc = w.cc;
    if (!cc || !cc.assetManager || cc.assetManager.__httpsPatched) return false;
    var am = cc.assetManager;
    am.__httpsPatched = true;

    function fixUrl(u) {
      u = String(u == null ? '' : u);
      var host = w.location.host;
      if (u.indexOf('https://' + host) === 0) return 'http://' + host + u.slice(('https://' + host).length);
      if (u.indexOf('https://127.0.0.1') === 0) return 'http://' + u.slice(8);
      if (u.indexOf('https://localhost') === 0) return 'http://' + u.slice(8);
      return u;
    }
    w.__CTRL_FIX_URL__ = fixUrl;

    var origLoad = am.loadRemote;
    if (typeof origLoad === 'function') {
      am.loadRemote = function (url) {
        var args = [].slice.call(arguments);
        args[0] = fixUrl(url);
        return origLoad.apply(am, args);
      };
    }
    var origDl = am.downloader && am.downloader.load;
    if (typeof origDl === 'function') {
      am.downloader.load = function (url) {
        var args = [].slice.call(arguments);
        args[0] = fixUrl(url);
        return origDl.apply(am.downloader, args);
      };
    }
    log('loadRemote https→http 补丁已装');
    return true;
  }
  var lrTimer = setInterval(function () {
    try { if (patchLoadRemote()) clearInterval(lrTimer); } catch (e) {}
  }, 50);

  // ---------- 8.6 同一个 https 硬编码也影响 SystemJS 加载外壳 bundle ----------
  // 注意：不要包 System.import 返回的 Promise —— 实测会让外壳 chunk 加载死锁。
  // 改在 script.src 赋值处做外科手术：只把我们自己主机的 https 改回 http。
  (function patchScriptSrc() {
    try {
      var d = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
      if (!d || !d.set || HTMLScriptElement.prototype.__httpsPatched) return;
      HTMLScriptElement.prototype.__httpsPatched = true;
      var host = w.location.host;
      Object.defineProperty(HTMLScriptElement.prototype, 'src', {
        configurable: true,
        enumerable: d.enumerable,
        get: function () { return d.get.call(this); },
        set: function (v) {
          var u = String(v == null ? '' : v);
          var abs = (w.location.origin + '/');
          if (u.indexOf('https://' + host) === 0) {
            u = 'http://' + host + u.slice(('https://' + host).length);
          } else if (u.indexOf('https://127.0.0.1') === 0 || u.indexOf('https://localhost') === 0) {
            u = 'http://' + u.slice(8);
          }
          d.set.call(this, u);
        }
      });
      log('script.src https→http 补丁已装');
    } catch (e) { err('patchScriptSrc: ' + e); }
  })();

  // ---------- 9. 吞掉外壳错误弹框 ----------
  ['ShowMessageBox', 'ShowMsg', 'ShowTips', 'Show'].forEach(function (k) {
    if (A.MsgBox && !A.MsgBox['__w' + k]) {
      var orig = A.MsgBox[k];
      A.MsgBox['__w' + k] = true;
      A.MsgBox[k] = function () {
        var c = arguments[0];
        if (c === -92 || c === 999.1 || (typeof c === 'string' && /-92|999\.1/.test(c))) return;
        if (typeof orig === 'function') return orig.apply(this, arguments);
      };
    }
  });

  // ---------- 10. 心跳 + 全局异常外送 ----------
  var beat = 0;
  setInterval(function () {
    beat++;
    if (beat > 40) return;            // 最多 80 秒
    try {
      var scene = null, gv = 'no';
      try { scene = w.cc && cc.director && cc.director.getScene(); } catch (e) {}
      try {
        if (scene) {
          var f = null;
          (function walk(n) { if (!f && n.name === 'GameView') f = n; (n.children || []).forEach(walk); })(scene);
          gv = f ? 'node' : 'none';
          if (f) {
            var has = false;
            (f._components || []).forEach(function (c) { if (c && c.m_spinAck !== undefined) has = true; });
            gv = has ? 'comp' : 'node';
          }
        }
      } catch (e) {}
      log('HB#' + beat + ' scene=' + (scene ? scene.name : 'null') + ' gv=' + gv +
          ' wire=' + (wired ? 1 : 0) + ' cb=' + STATS.setGameCb + ' info=' + STATS.infoSent);
    } catch (e) {}
  }, 2000);

  w.addEventListener('error', function (ev) {
    try { err('window.error: ' + (ev.message || '') + ' @' + (ev.filename || '') + ':' + (ev.lineno || '')); } catch (e) {}
  });
  w.addEventListener('unhandledrejection', function (ev) {
    try {
      var r = ev.reason;
      err('unhandledrejection: ' + (r && (r.stack || r.message) || String(r)).slice(0, 600));
    } catch (e) {}
  });

  // 清洗版外壳需要自己的命名空间对象（td109 清洗产物约定）：
  //   _global[41018] === globalThis，其余槽位由外壳自己写。
  if (!w.h2eSW) { w.h2eSW = { 41018: w }; }
  if (!w.R7xpx) { w.R7xpx = { 41018: w }; }
  w.__CTRL_NS_READY__ = true;

  log('td400 接线钩子已安装');
})(window);
