# S0 摸底 · 3 LUCKY PIGGY (ONEAPI_TD_400)

| # | 问题 | 答案 |
|---|---|---|
| 1 | gameUid/slug/名 | ONEAPI_TD_400 / td400 / 3 LUCKY PIGGY |
| 2 | 混淆类型 | 待确认（需下载 main bundle 看头部） |
| 3 | 外壳混淆类型 | **无外壳**（无 astarte 目录） |
| 4 | 框架类型 | Cocos 3.6.2（cc.af2c4.js 和 JCUF 一致） |
| 5 | 架构 | 单根（uat-wbgame.tadagaming.com/tlp/） |
| 6 | 沙箱可用 | ✅ CO 预发站可启动 |
| 7 | WASM | 待确认 |
| 8 | AckType | 待确认 |
| 9 | protobuf | 待确认 |
| 10 | extra 资源 | 待确认 |
| 11 | 属性别名 | 待确认（需下载后看） |
| 12 | launch 参数 | ssoKey=xxx&lang=es-AR&apiId=10106&gameID=400&skin=1&region=eu |

## 关键发现
- **无 astarte 外壳**——和 Gold Mine Express 相同（简化结构）
- Cocos 引擎 cc.af2c4.js（和 JCUF 完全一致 = 3.6.2）
- system.bundle.692e9.js（和 JCUF 完全一致）
- import-map.e7209.json（不同 hash = 不同的模块映射）
- 游戏路径 /tlp/（three lucky piggy）
- 有 zip-bundler（可能和 GME 一样，资源 ZIP 内嵌）

## 路线判断
**剥离版路线**（指令要求）：
1. S1 镜像采集
2. S1.5 字符串表（从 td109 复用）
3. S2 反混淆（main webcrack + other full-pipeline）
4. S2.5 守卫剥离
5. S3-S4 代码清洗
6. S4.4 controller + 面板
7. S5 本地验收
