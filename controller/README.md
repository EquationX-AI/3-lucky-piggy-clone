# TD_400 3 LUCKY PIGGY Controller

## 通信层结构

| AckType | protobuf 类型 | 用途 |
|---|---|---|
| info | tlpProto.GameInfoData | 进入游戏（BlueOdds/CoinOdds/CrackLevels/JPOdds）|
| spin | tlpProto.SpinAck | 普通/免费 spin 结果 |
| lastSpin | tlpProto.SpinAck | 上次未显示的 spin |
| unshow | tlpProto.SpinAck | 隐藏 spin |

## SpinAck 关键字段
- RoundQueue: 每轮的盘面和赢线
- FolderIndex: 当前轮索引
- FreeTotalWin: 免费游戏总赢分
- IsFreeGame: 是否免费游戏
- MaxFlag: 满盘标记
- CurCoinNum: 当前金币数
- FreeRemainRound: 免费游戏剩余轮数
- BlueData/GreenData: 特色数据
- ConvertPlate: 转换盘面
- CrackLevels: 裂纹等级

## 注入点
OnCommand (main.js:28689) — 游戏接收服务端结果的唯一入口。
Controller 在这里注入：用 tlpProto.SpinAck.encode 造 bytes 喂给 OnCommand。
