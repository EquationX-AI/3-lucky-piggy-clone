# td400 镜像完整性报告

> 采集时间：2026-10-20 · 采集方式：td109 同 hash 外壳复用 + api-captures 补 native + 厂商补缺
> 结论：**二进制全部合格，可直接用于后续开发**

## 规模

| 根 | 文件数 | 说明 |
|---|---|---|
| `mirror/`（游戏本体，映射 `/tlp/`） | 约 70 | index.html、src/、assets/{main,game,gameLite,internal}、native |
| `mirror/shell/`（映射 `/astarte2/3.6/web-mobile/`） | 206 | 31 个语言包 + other/tada/tadaMain/extra + src/chunks |
| `mirror/cocos-js/`（映射 `/cocos-js/`） | 1 | `cc.af2c4.js` 2.1MB |
| `mirror/smallicon/` | 17 | 图标 |
| 合计 | **336** | **约 33 MB** |

## 二进制完整性（重点）

```bash
for f in $(find mirror -name "*.astc"); do xxd -l 4 -p "$f"; done | sort | uniq -c
```

结果：**70 / 70 全部为 `13aba15c`，损坏 0 个**（对照 8K 报告的 T25：CDP getResponseBody 用 utf8 落盘会写坏二进制）。

## 零 404 验证

启动 `npm start` 后完整加载游戏页到场景 `MainGame`，服务端日志：

```
404 计数 = 1（仅 /tlp/favicon1.ico，非游戏资源）
```

游戏侧日志：`Success to load scene: db://assets/Scene/MainGame.scene`

## 已知缺口

| 项 | 状态 | 说明 |
|---|---|---|
| `/tlp/favicon1.ico` | 缺 | 浏览器 favicon，不影响游戏 |
| 2 个字体 URL | 采集时 JSON 截断 | 未观察到运行时请求，暂不影响 |

## 采集踩坑（记录）

1. **`cc.af2c4.js` 曾被抓成 404 页面**（1567 字节 HTML），必须检查魔数/文件头；真引擎在 `cocos-js/` 根下，2.1MB。
2. 游戏的 import-map 映射 `cc → ../cocos-js/cc.af2c4.js`，服务端必须提供 `/cocos-js/` 根。
3. 外壳 `versions.json` 是扁平结构，游戏侧经 Cocos `JsonAsset` 读 `.json` 属性——文件本身不用改。
4. 外壳 chunk 是 Jscrambler 碎片（`function h2eSW(){}` 靠函数提升），**不能当 SystemJS 模块**加载。
