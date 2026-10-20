# 流水线报告

生成时间：2026-10-20T03:29:35.517Z，总用时 46.4s（各文件并发）

## index.ad23f.js

- 产物：`/Users/scott/dora-team/agents/kangkang/repos/3-lucky-piggy-clone/stage/shell-keep/index.js`（117131 行，6989 KB）；语法检查：通过
- 命名空间：`R7xpx`；字符串表：`/Users/scott/dora-team/agents/kangkang/repos/slot-replication/replicas/td109/inspect/strings/shell.R7xpx-table-v2.json`
- 用时：CFF 10s，字符串与常量 35.7s，生成 0.3s
- 字符串：解码函数 W2M$/O9MW，替换 26721 处，表里取不到 2 处 {"6901":2}，参数仍不是常量 0 处
- 完整性常量：Y71/r2z（第 3 个参数，y2S=2 → y2S=4 → y2S=8 → y2S=4 → y2S=3，倒序应用），折叠 220 处，未解 0 处；用"解码(常量)"调用校验 46 处：倒序命中 46、正序命中 0
- 键控谓词：W_Uh/T9Ey/Q1zj/K2b3/m_allMemberAccount/m_refusedLabel/READY/N4oi，折叠 130 处，删转发定义 5 处；可信度抽检（选中分支的字符串在文件里出现次数不少于被丢弃分支）28/28
- 零参判断：替换 0 处；折叠 if/三元/逻辑 5 处，合并拼接 3659 处，内联字符串别名 166000 处
- 哨兵检查：register=1，SpinAck=2，GameView=0，OnCommand=13
  - **⚠ 字符串还原哨兵缺失：GameView 未出现在产出中——可能字符串表错位或对错了文件（用的是默认哨兵：外壳 bundle 天然没有 SpinAck/GameView，其他框架也会缺；请用 --sentinels 按文件指定后再判断）**

| 关键字 | 命中行数 | 示例 |
|---|---|---|
| jscrambler | 18 | L895: `if (typeof _global.g$M().SendJscramblerLog !== "function") {`<br>L903: `_global.g$M().SendJscramblerLog("GameTampering");` |
| notification | 0 |  |
| 违规码 j-0xx | 15 | L751: `L9O = L9O \|\| "j-014-00022";`<br>L753: `L9O = L9O \|\| "j-014-00024";` |
| Function.prototype.toString | 2 | L1064: `} else if (_global.B9e(Function.prototype.toString, e77, f$m)) {`<br>L1154: `e7a = Function.prototype.toString;` |
| MurmurHash 常量 | 3 | L1086: `X9d = 3432918353;`<br>L1087: `K96 = 2971072446;` |
| SendJscramblerLog / GameTampering | 13 | L895: `if (typeof _global.g$M().SendJscramblerLog !== "function") {`<br>L903: `_global.g$M().SendJscramblerLog("GameTampering");` |
| 域名锁 X0gnGEw | 0 |  |
| 自毁 about:blank | 5 | L31981: `}, n7_["about:blank "] = function (e7i, K5j) {`<br>L31983: `null == (z2Z = this.Ended) \|\| z2Z["about:blank "](e7i, K5j);` |
| _global 运行时引用 | 326 | L1: `const _global = globalThis;`<br>L2: `_global[41018] = function () {` |
