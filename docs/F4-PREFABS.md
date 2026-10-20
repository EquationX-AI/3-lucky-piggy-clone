# td400 F4 素材清单（我方控制器要实例化的原厂预制体）

> 来源：`mirror/assets/game/config.bb71d.json`（bundle 名 `game`，共 42 个 `cc.Prefab`）。
> 用途：F4 路线下不运行厂商外壳/主逻辑，由我方控制器把原厂预制体实例化出来。

## 关键预制体

| 路径 | uuid | 说明 |
|---|---|---|
| `Prefab/MainGame` | **918** | **主游戏视图预制体**（首选实例化目标） |
| `Dice/Prefab/MainGame` | 1561 | 另一份 MainGame（Dice 主题变体） |
| `Prefab/GameIntro/GameIntro` | 1722 | 进场动画 |
| `Prefab/Intro/Intro_Cell_01` | 764 | 介绍页格 1 |
| `Prefab/Intro/Intro_Cell_02` | 1544 | 介绍页格 2 |
| `Prefab/SingleSlotPlate` | 573 | 单格盘面 |
| `Prefab/JP/JP_Panel` | 330 | 奖池面板 |
| `Prefab/JP/JP_cell` | 514 | 奖池格 |
| `Prefab/JP/JP_GrandLock` | 677 | GRAND 锁 |
| `Prefab/Symbol/Symbol_02` … `Symbol_16` | 403/547/843/935/1304/1141/1326/1264/770/707/1293 | 符号预制体（缺 Symbol_06 以外个别编号，按需查表） |
| `Prefab/Character/Pig` | 1630 | 小猪角色 |
| `Prefab/Effect/*` | 见 config | 特效（FX_WinFrame / FX_NearWin / Scatter_FX / FX_Fly_* …） |

## 注意：`GameView_L` / `GameView_S` 不是预制体

`Animation/Scene/GameView_L`(uuid 36) 与 `GameView_S`(38) 是 **`cc.AnimationClip`**（横/竖屏场景动画），
不是可实例化的 Prefab。要找 GameView 节点，走 `Prefab/MainGame`(918) 实例化后在子树里找。

## 实例化方式（Cocos 3.6）

```js
const bundle = cc.assetManager.getBundle('game');
bundle.load('Prefab/MainGame', cc.Prefab, (err, prefab) => {
  if (err) return console.error(err);
  const node = cc.instantiate(prefab);
  cc.director.getScene().addChild(node);
  // 该 node 子树里应能找到名为 GameView 的节点及其组件（m_spinAck !== undefined）
});
```

## 当前进度

- 场景 `MainGame` 能加载（`Success to load scene`）
- 但 GameView 节点不存在（`gv=none`），因为原版路径依赖外壳
- F4 要做的：跳过外壳，直接用上面的预制体造出视图，再接我方 `CommonGame.SetGameCb` 与 `OnCommand`
