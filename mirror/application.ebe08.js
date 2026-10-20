System.register([], function (_export, _context) {
  "use strict";

  var cc, Application;

  function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

  function _defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } }

  function _createClass(Constructor, protoProps, staticProps) { if (protoProps) _defineProperties(Constructor.prototype, protoProps); if (staticProps) _defineProperties(Constructor, staticProps); return Constructor; }

  return {
    setters: [],
    execute: function () {
      _export("Application", Application = /*#__PURE__*/function () {
        function Application() {
          _classCallCheck(this, Application);
        }

        _createClass(Application, [{
          key: "init",
          value: function init(engine) {
            cc = engine;
            cc.game.onPostProjectInitDelegate.add(this.onPostProjectInit.bind(this));
            window.pageLoadTiming.logTime('log851');
            window.pageLoadTiming.calculateDuration(851, 'headStartTime', 'log851');
          }
        }, {
          key: "onPostProjectInit",
          value: function onPostProjectInit() {
            cc.view.resizeWithBrowserSize(true);
          }
        }, {
          key: "GetLinkParameterByName",
          value: function GetLinkParameterByName(name) {
            var url = window.location.href;
            name = name.replace(/[\[\]]/g, '\\$&');
            var regex = new RegExp('[?&]' + name + '(=([^&#]*)|&|#|$)'),
                results = regex.exec(url);
            if (!results) return null;
            if (!results[2]) return '';
            return decodeURIComponent(results[2].replace(/\+/g, ' '));
          }
        }, {
          key: "start",
          value: function start() {
            function getChromeVersion() {
              var raw = navigator.userAgent.match(/Chrom(e|ium)\/([0-9]+)\./);
              return raw ? parseInt(raw[2], 10) : -1;
            }

            if (cc.sys.isBrowser && cc.sys.isMobile && cc.sys.os === cc.sys.OS.ANDROID) {
              if (getChromeVersion() >= 120) {
                console.log('Disable WebGL2 rendering of chrome v.120.');
                window.WebGL2RenderingContext = null;
              }
            }

            window.pageLoadTiming.logTime('log852');
            window.pageLoadTiming.calculateDuration(852, 'headStartTime', 'log852');
            window.SetProgressInterval(30);
            return cc.game.init({
              settingsPath: 'src/settings.1928e.json',
              overrideSettings: {
                splashScreen: {
                  enabled: false
                }
              }
            }).then(function () {
              if (cc.sys.isBrowser) {
                if (cc.gfx.deviceManager.gfxDevice instanceof cc.WebGLDevice) {
                  var device = cc.gfx.deviceManager.gfxDevice;
                  device.extensions.useVAO = false;
                }
              }

              window.SetProgressInterval(50);
              window.pageLoadTiming.logTime('log853');
              window.pageLoadTiming.calculateDuration(853, 'headStartTime', 'log853');
              cc.game.run();
            });
          }
        }]);

        return Application;
      }());
    }
  };
});