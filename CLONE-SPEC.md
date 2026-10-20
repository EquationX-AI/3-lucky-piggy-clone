# 3 LUCKY PIGGY 克隆技术快照

> 三周后回来改这台：先读本文件，再看最新技能。
> 冻结时间：2026-10-20 · 对应 commit：见仓库 `git log`

## 基本信息

| 项 | 值 |
|---|---|
| 厂商 | TaDa Gaming（经 OneAPI 聚合） |
| game_code | `ONEAPI_TD_400` |
| 游戏路径 | `/tlp/` |
| 厂商域名 | `uat-wbgame.tadagaming.com` |
| 引擎 | Cocos **3.6.2**，`cc.af2c4.js`（2.1MB） |
| 外壳 | `astarte2/3.6`，chunk `bundle.fb6e5.js`（与 td109 **同 hash**） |
| 盘面 | 主盘 5 列 × 3 行；另有 `FreePlateSymbol`（猪币层） |
| 赔付线 | 20 条 |
| 混淆 | main = **obfuscator.io**；shell = Jscrambler CFF |
| 克隆路线 | 剥离版（slot-replication），交付形态待定（见 §7） |

## 1. 目录与路由

```
3-lucky-piggy-clone/
├── mirror/           # 原厂字节，不可改（映射 /tlp/）
│   ├── shell/        # 外壳（映射 /astarte2/3.6/web-mobile/）
│   ├── cocos-js/     # 引擎（映射 /cocos-js/）
│   └── smallicon/    # 图标
├── controller/       # 我方接线：td400-hook.js / Controller.js / LocalController.js / preset-spins.json / kinds.json
├── public/panel.html # 控奖面板（单文件，左右分栏）
├── patched/          # main 的定点补丁产物（不写回 mirror）
├── cleanshell/       # td109 的清洗版外壳（实验用，当前不可用，见 §6）
├── server.cjs        # 一个进程：静态 + 平台桩 + 游戏协议 + 面板 API
├── verify.mjs        # 门禁
├── docs/PROTOCOL.md  # 协议分析（AckType / SpinAck / GameInfoData）
└── docs/MIRROR-INTEGRITY.md
```

## 2. 服务端（server.cjs）

| 路由 | 用途 |
|---|---|
| `/tlp/` | 游戏入口；**serve 时注入** `controller/*.js`（mirror 本体不改） |
| `/cocos-js/`、`/astarte2/3.6/web-mobile/`、`/smallicon/` | 三个资源根 |
| `/panel` | 控奖面板 |
| `/api/session` | `{balance, spinIdx, bet, lastWin, nextResult}` |
| `/api/kinds` | 奖种目录 `{kinds, uncovered}` |
| `/api/result` POST | 注入：`{kind}` 或 `{grid}`；special（jackpot/buyBonus/scatter）当前返回 400 |
| `/api/result` GET | 跑一局 `?sid=&bet=` → `{win, balance, data}` |
| `/api/rejects` | 拒绝记录 |
| `/api/log`、`/api/pagelogs` | 页内 beacon（渲染卡死时唯一可见通道） |

安全：CORS 仅本机、OPTIONS 204 不执行业务、注额档位校验、`ADMIN_KEY` 可选。

## 3. 已确认的技术事实

1. **游戏用 `"https://" + location.host` 拼外壳地址**（原版 main 里只有 1 处），本地 http 会 TLS 失败 → 必须改 http（`patched/` 里定点改，或用 hook 拦截）。
2. **`versions.json` 是扁平结构**，游戏经 Cocos `JsonAsset` 读 `.json`，文件不用改。
3. **外壳 chunk 不能走 SystemJS**：它靠文件内 `function h2eSW(){}` 提升定义命名空间，当普通 script 才能执行。
4. **`OnCommand(ackType, bytes)`** 是唯一注入点，挂在 GameView 组件上；`Astarte.CommonGame.SetGameCb(view)` 把 view 交给外壳。
5. **可以在不碰 protobuf 的前提下注入**：把 `OnCommand` 换成「对象直投」版，收到对象直接 `view.OnRecvSpinAck(obj)`。`preset-spins.json` 即最终结果对象。
6. 代码里内嵌了多条真实 `SpinAck` 样例（`FeaturesSpinAck`），覆盖 miss / 连线 / 免费进入 / 猪币收集，可直接当结果模板。

## 4. 面板

- 单文件 `public/panel.html`，暗色、左右分栏（左 ≤430px + 右 iframe）
- 6 个区域：状态栏 / 快捷预设 / 盘面编辑器 / 特殊玩法 / 赔付表 / 回合日志（+ 操作区）
- 奖种目录 `controller/kinds.json`：10 条，其中 2 条可用（miss、连线），8 条标记 `skip`（缺原厂样本）
- 截图：`evidence/panel/panel-layout.png`

## 5. 镜像

见 `docs/MIRROR-INTEGRITY.md`：336 文件 / 33MB / **70 个 astc 魔数全部合格** / 游戏资源零 404。

## 6. 当前卡点（未解决）

**外壳加载不完整 → GameView 不出现**（`gv=none, setGameCb=0`）。

| 方案 | 结果 |
|---|---|
| 原版 `bundle.fb6e5.js`（字节正确） | 加载后主线程阻塞，场景起不来 |
| td109 `clean3/{bundle,other}.js`（清洗版） | 能执行，但清洗把 `System.register` 剥离；且存在 deob 别名错误（`O1x0J` 未定义、参数为乱码字符串）→ 无法注册 `chunks:///WASM-*` / `virtual:///prerequisite-imports/other` |

已确认不可行：`location`/`location.hostname`/`location.reload` 均不可改写（`configurable:false`），所以无法运行时伪造域名。

待决策：**继续剥离版（需要可用的清洗外壳）还是切 F4（空注册替换 + 我方控制器）**——由 Scott 定。

## 7. 本台特有的坑

1. `cc.af2c4.js` 曾被误抓成 404 页面（1567B HTML），必须校验文件头。
2. `import-map` 映射 `cc → ../cocos-js/cc.af2c4.js`，服务端要提供 `/cocos-js/` 根。
3. 包一层 `System.import` 的 Promise 会让外壳 chunk 加载死锁——不要在 `System.import` 返回值上挂 `.then`。
4. 外壳里的 `w4mPe["63d7"]` 就是 `System.register` 的去混淆别名；`h2eSW`/`R7xpx` 是它自己的命名空间对象（`[41018] === globalThis`）。
5. 页内日志 beacon 是渲染卡死时唯一能看到进度的通道，保留它。
6. 游戏 URL 缺 `be`/`domain_platform`/`gs` 这些**反转域名**参数时，会拼出 `https://scwanding/...` 这类坏地址。

## 8. 下一步

1. 等路线决策（剥离 vs F4）
2. 若继续剥离：需要一份**保留 `System.register` 且无 deob 别名错误**的清洗外壳
3. 外壳通了之后：`SetGameCb` 应该变 1 → 接 `Controller.attach` + `autoLogin` → GameView 出现 → 再谈 SPIN/E2E
