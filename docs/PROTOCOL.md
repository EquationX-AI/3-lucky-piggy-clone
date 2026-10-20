# td400 (3 LUCKY PIGGY) 通信协议分析

> 来源：`slot-replication` 的 `replicas/td400/clean/main-deob.js`（td400 反混淆产物，只读参考）。
> 提取方式：从 protobuf 编码函数里读 `uint32(tag).<type>` 与字段赋值，逐条对照；样例取自代码内嵌的示例 ack。
> 版本：v1.0 · 2026-10-20

## 1. 注入点

游戏侧唯一消费服务端明文的位置：

```js
// main-deob.js: OnCommand(ackType, bytes)
_0x35f0c2.OnCommand = function (ackType, bytes) {
  switch (ackType) {
    case AckType.info:                       // 1
      var info = tlpProto.GameInfoData.decode(bytes);   // → 写 BlueOdds/CoinOdds/CrackLevels/JPOdds
      break;
    case AckType.lastSpin:                   // 4
    case AckType.spin:                       // 0
      var ack = tlpProto.SpinAck.decode(bytes);
      this.OnRecvSpinAck(ack);               // → 盘面/赢分/演出
      break;
    case AckType.unshow:                     // 36
      this.m_unshowSpinAck = tlpProto.SpinAck.decode(bytes);
      break;
  }
};
```

`OnCommand` 挂在 **GameView 组件**上（`_0x35f0c2` 是该组件原型）；`Astarte.CommonGame.SetGameCb(this)` 把 GameView 交给外壳。

## 2. AckType 枚举

| 名称 | 值 | 载荷 |
|---|---|---|
| `spin` | 0 | `tlpProto.SpinAck` |
| `info` | 1 | `tlpProto.GameInfoData` |
| `lastSpin` | 4 | `tlpProto.SpinAck` |
| `unshow` | 36 | `tlpProto.SpinAck` |

## 3. tlpProto.SpinAck 字段表

| tag | 字段 | 类型 | 说明 |
|---|---|---|---|
| 10 | `RoundQueue` | repeated `RoundInfo` | 每一轮的盘面与赢线（多步奖励局每步一条） |
| 17 | `FreeTotalWin` | double | 免费游戏累计赢分 |
| 25 | `TotalWin` | double | 本局总赢分 |
| 34 | `ShowIndex` | string | 展示用索引 |
| 41 | `NowMoney` | double | 结算后余额 |
| 48 | `AckType` | int32 | 回包类型 |
| 57 | `RTP` | double | RTP |
| 65 | `Bet` | double | 注额 |
| 72 | `FolderIndex` | int32 | 当前轮索引 |
| 82 | `CrackLevels` | repeated int32 | 裂纹等级 |

## 4. tlpProto.RoundInfo 字段（按示例 ack 归纳）

| 字段 | 类型 | 说明 |
|---|---|---|
| `MainPlateSymbol` | `CColumn[]`（5 列） | 主盘面，每列 `{Col:[符号]}` |
| `FreePlateSymbol` | `CColumn[]`（5 列） | 猪币/免费层，每格 `{Symbol, JPState, JPMult, Number}` |
| `WinLineInfos` | `AwardData[]` | 中奖线：`{LineNum, Count, Symbol, Win}` |
| `AwardTypeFlag` | int32 | 奖种标记（见 §6） |
| `RoundWin` | double | 本轮赢分 |
| `FreeRemainRound` | int32 | 免费游戏剩余轮数 |
| `FreeTotalWin` | double | 免费累计 |
| `CrackLevels` | int32[] | 裂纹等级 |
| `AddCrack` | bool[3] | 是否加裂纹 |
| `MaxFlag` | bool | 满盘标记 |
| `ScatterPos` / `EffectPos` | int / int[] | scatter 位置、特效位置 |
| `BlueData` / `GreenData` | 对象/数组 | 特色数据（猪币收集） |
| `JPState` / `JPMult` / `Number` | int / int / double | 奖池状态、倍数、数量 |

## 5. tlpProto.GameInfoData 字段表（info 回包）

| tag | 字段 | 类型 |
|---|---|---|
| 18 | `Mul` | repeated double |
| 26 | `JPOdds` | repeated int32 |
| 34 | `BlueOdds` | repeated `CColumn` |
| 42 | `CoinOdds` | repeated `CColumn` |
| 50 | `CrackLevels` | repeated int32 |
| 57 | `MaxBet` | double |
| 66 | `BuyMul` | repeated int32（购买奖励局倍率，如 50/100/200） |

其它在 `OnCommand` 里被直接读取的字段：`BlueOdds`、`CoinOdds`、`CrackLevels`、`JPOdds`。

`BuyReq`：`BaseBet`(9, double)、`BuyType`(16, int32)。

## 6. AwardTypeFlag（从示例与演出分支归纳）

| 值 | 含义 |
|---|---|
| 0 | 普通局 |
| 4 | 免费游戏进入（示例里 `AwardTypeFlag: 4` 与 `FreeRemainRound` 同时出现） |

> 其余取值需用真钱样本补全；当前只有 0 / 4 有明确样例。

## 7. 代码内嵌的真实样例（可直接当结果模板）

`main-deob.js` 里 `FeaturesSpinAck` 是一个数组，含多条完整 `SpinAck`：

```json
{
  "RoundQueue": [{
    "MainPlateSymbol": [{"Col":[6,6,6]},{"Col":[10,14,4]},{"Col":[12,3,6]},{"Col":[4,2,13]},{"Col":[7,7,4]}],
    "FreePlateSymbol": [ ... 5 列，每列 3 个 {Symbol:21,JPState:0,JPMult:0,Number:0} ... ],
    "WinLineInfos": [],
    "AwardTypeFlag": 4,
    "RoundWin": 0,
    "FreeRemainRound": 3,
    "AddCrack": [false,false,false],
    "MaxFlag": false
  }],
  "FreeTotalWin": 5054.4,
  "TotalWin": 5054.4,
  "ShowIndex": "",
  "NowMoney": 0,
  "AckType": 0,
  "Bet": 1,
  "FolderIndex": 0
}
```

这批样例覆盖：普通 miss、连线中奖、免费游戏进入（`AwardTypeFlag:4` + `FreeRemainRound`）、猪币收集（`BlueData`/`GreenData`）。

## 8. 本地服务端建议

两种可行形态：

**A. 直接投对象（无需 protobuf）**
把 `GameView.OnCommand` 换成「对象直投」版，收到对象时直接 `view.OnRecvSpinAck(obj)`。当前 `controller/td400-hook.js` 就是这么做的，`preset-spins.json` 即最终结果对象。

**B. 编码成 protobuf 字节**
用 `tlpProto.SpinAck.encode(...)` 得到 bytes 再喂 `OnCommand`。需要先拿到 `tlpProto` 引用（它在 main 的模块闭包里，可在主包加载后挂到 `window.__tlpProto`）。

两条路的输出结构相同，差别只在有没有编码步骤。

## 9. 待补

- `AwardTypeFlag` 全量枚举（需真钱样本）
- 4 档奖池（MINI/MINOR/MAJOR/GRAND）的触发与 `JPState/JPMult` 取值
- 3 档购买奖励局（`BuyMul` 50/100/200）的 `BuyType` 对应关系
- `BlueData` / `GreenData` 的完整字段（猪币收集玩法）
