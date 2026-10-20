// f4-boot.js —— F4 接线（td400 版）
// 不运行厂商外壳逻辑，用我方代码把原厂预制体变成可见棋盘。
(function () {
  'use strict';
  var S = globalThis.__f4 = { state: 'init', view: null, node: null, tries: 0, hidden: [] };

  function hideDom() {
    ['splash', 'JiliNew', 'TaDa', 'MsgBox_JILI', 'MsgBox_Tada'].forEach(function (id) {
      var e = document.getElementById(id);
      if (e) e.style.display = 'none';
    });
  }

  function hideLoadNodes(scene) {
    var hidden = [];
    (function walk(n) {
      // 只清遮挡层；Node_Bar（底栏：余额/注额/旋转）必须保留
      if (/^(IntroView|LoadingToBtn|Intro_ProgressBar|MASK|Node_GameIntro)$/.test(n.name) && n.active) {
        n.active = false; hidden.push(n.name);
      }
      (n.children || []).forEach(walk);
    })(scene);
    return hidden;
  }

  function findView(node) {
    var view = null;
    (function walk(n) {
      if (view) return;
      (n._components || []).forEach(function (c) { if (c && c.m_spinAck !== undefined) view = c; });
      (n.children || []).forEach(walk);
    })(node);
    return view;
  }

  var timer = setInterval(function () {
    S.tries++;
    if (S.tries > 900) { clearInterval(timer); if (S.state === 'init') S.state = 'timeout'; return; }
    var cc = globalThis.cc;
    if (!cc || !cc.assetManager || !cc.director) return;
    var scene = null;
    try { scene = cc.director.getScene(); } catch (e) {}
    if (!scene) return;

    var bundle = cc.assetManager.getBundle('game');
    if (!bundle) {
      if (S.state !== 'loading-bundle') {
        S.state = 'loading-bundle';
        cc.assetManager.loadBundle('game', function (err, b) {
          if (err) { S.state = 'bundle-err:' + (err.message || err); return; }
          S.state = 'init';
        });
      }
      return;
    }

    if (S.state === 'init') {
      S.state = 'loading-prefab';
      bundle.load('Prefab/MainGame', cc.Prefab, function (err, prefab) {
        if (err) { S.state = 'prefab-err:' + (err.message || err); return; }
        try {
          var node = cc.instantiate(prefab);
          var canvas = null;
          scene.children.forEach(function (c) { if (c.name === 'Canvas') canvas = c; });
          (canvas || scene).addChild(node);
          node.setPosition(0, 0, 0);
          S.node = node;
          S.view = findView(node);
          hideDom();
          S.hidden = hideLoadNodes(scene);
          S.state = S.view ? 'ready' : 'no-view';
          console.log('[f4] state=' + S.state + ' children=' + node.children.length
            + ' view=' + (S.view ? cc.js.getClassName(S.view) : 'none')
            + ' hidden=' + (S.hidden || []).join(','));
        } catch (e) { S.state = 'instantiate-err:' + e; }
      });
      return;
    }

    hideDom();
    hideLoadNodes(scene);
  }, 100);
})();
