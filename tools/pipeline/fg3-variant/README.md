# tools/rewrite/fg3-variant

Jscrambler「命名空间字符串表」变体的识别与字符串表导出（fg3 main 首见）。原理、坑和实测见 [`docs/Jscrambler字符串表变体.md`](../../../docs/Jscrambler字符串表变体.md)。

| 脚本 | 作用 |
|---|---|
| `scan-variant.mjs` | 识别是不是这个变体，输出命名空间、表属性号、基址、哨兵编号、旋转编号、访问器包装区间 |
| `dump-table-browser.mjs` | 在本地无头 Chrome 里导出字符串表（数组，下标=编号），`--verify` 用原文件交叉核对 |

```bash
node tools/rewrite/fg3-variant/scan-variant.mjs <混淆原文件.js>
node tools/rewrite/fg3-variant/dump-table-browser.mjs <混淆原文件.js> inspect/strings/<名字>.strings.json --verify
```

`deob-parallel.mjs` 碰到这个变体会在汇总里直接打印第二条命令，照着跑即可。

改脚本时别破坏的规矩：

1. **必须在真浏览器里导**。Node `vm` 拼出来的是另一张表（fg3 实测 4708/5201 项不同）。
2. **先走哨兵、跳过旋转编号**，否则整表是诱饵词或整体错位。
3. **不能插入或删除原文件任何字符**（自校验用的是源码字节偏移）。切骨架时表工厂之前一字不动；挂钩用等长替换。
4. **日志不打印字符串内容**，只打编号和长度（R2 安全规则）。
