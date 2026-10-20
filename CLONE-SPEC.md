# 3 LUCKY PIGGY 克隆技术快照

## 基本信息
- 厂商：TaDa Gaming（经 OneAPI 聚合）
- game_code：ONEAPI_TD_400
- 引擎：Cocos 3.6.2（cc.af2c4.js，和 JCUF 完全一致）
- 外壳：astarte2/3.6（动态加载，字符串表可从 td109 复用）
- 盘面：5×3（MainPlateSymbol 5 列 × 3 行）+ FreePlateSymbol（猪币层）
- 赔付线：20 条
- 克隆路线：剥离版（slot-replication S0-S5）
- 基于的 Skill 版本：slot-replication + tada-replication-quickstart v1.0

## 本台特有的技术决策
1. 无独立外壳文件（astarte2 是动态加载，不在游戏根 /tlp/ 下）
2. main + game 都是 obfuscator.io 混淆（不是 Jscrambler）→ 全用 webcrack 反混淆
3. 协议结构从反混淆代码提取（未从预发站录制——canvas 点击问题）
4. protobuf namespace: tlpProto（GameInfoData + SpinAck）
5. AckType 枚举：info=1, spin=0, lastSpin=4, unshow=36

## 本台特有的踩坑
1. HTML 里 system.bundle hash 和 JCUF 一致但 import-map hash 不同
2. 预发站 Continuar 按钮在 Cocos canvas 里点击困难（坐标不匹配）
3. ssoKey 生存时间短（操作慢就 MSG 103 过期）
4. bundleVers 在 settings.assets.bundleVers 里（不在顶层）

## 前端本地化方案
- mirror/ 文件数：19（核心文件，不含动态加载的外壳和素材）
- mirror/ 总大小：2.6MB
- 服务端 serve 方式：Node HTTP serve mirror/ + API 桩
- 游戏页：mirror/index.html（原厂 HTML 34KB）

## 服务端协议
- 编码方式：protobuf（tlpProto.SpinAck / tlpProto.GameInfoData）
- API 接口：init(info) / spin / spin-end / notice / unshow / last-spin
- 通信层入口：OnCommand (main.js:28689)

## 奖项覆盖
- 总奖种数：10（2 可指定 + 8 未覆盖）
- 可指定：miss + 连线中奖
- 未覆盖：Scatter 免费游戏、4 档奖池、3 档购买奖励局
- 后续补录预发样本后扩展

## 已知限制
1. preset-spins 只有 2 局（miss + 连线），需从预发站补录更多样本
2. 外壳和素材的完整镜像未做（19 个核心文件 vs 预发加载的 110+ 资源）
3. 面板上 8 种奖项标为 SKIP（需录制样本）

## 冻结时间
- 本文档冻结于：2026-10-19
- 对应 commit：cb00153
