/**
 * controller 的本地假实现（本地可玩版专用，不进生产构建）。
 *
 * 预设局来自真机 36 局的 ack 快照（evidence/s4.4/multiplier-harvest.json → preset-spins.json），
 * 每条都是一次真实下发的结果对象：PlateSymbol（4 组×3）、Mult、TotalWin、AwardTypeFlag、AwardDataVec。
 * 余额只在这里加减——按 skill 判定「改余额只在 controller」。
 */
(function (global) {
  'use strict';
  var SPINS = null, idx = 0;
  var balance = 12000000;     // 分；对应真机 $120,000（×100）
  var bet = 1200;             // 分；$12

  function load() {
    if (SPINS) return SPINS;
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/controller/preset-spins.json', false);  // 绝对路径：页面在 /fg/ 下也能取到
    xhr.send(null);
    SPINS = JSON.parse(xhr.responseText);
    return SPINS;
  }

  global.LocalController = {
    getBalance: function () { return balance; },
    /** 指定下一局用第几条预设（验收工具用它强制覆盖各分支） */
    setNext: function (i) { idx = Number(i) || 0; return idx; },
    /** 当前余额（分） */
    __balance: function () { return balance; },
    /** 预设条数 */
    count: function () { return load().length; },
    login: function () {
      load();
      // GameInfoData 的 proto 只有 Mul 一个字段（见 stage/clean/main.js 的 ctor）：余额/注额走登录回包 profile.coin/betValue
      return { Mul: [1, 2, 3, 5, 10, 15] };
    },
    spin: function (req) {
      var sp = load();
      var ack = JSON.parse(JSON.stringify(sp[idx % sp.length]));
      idx++;
      bet = Number(req && req.bet) || bet;
      balance = balance - bet + Math.round(Number(ack.TotalWin || 0));
      ack.NowMoney = balance;
      ack.ShowIndex = 'local-' + idx;
      ack.AckType = 0;
      return ack;
    },
    stats: function () { return { index: idx, balance: balance, bet: bet }; }
  };
})(window);
