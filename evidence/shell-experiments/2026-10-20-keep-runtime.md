# 6F 实验：`full-pipeline --keep-runtime` 重跑外壳

日期：2026-10-20 · 执行：6F · 依据：引导被 strip 删掉后无法靠补定义修复

## 做法

```bash
node --max-old-space-size=8192 --stack-size=65500 tools/pipeline/full-pipeline.mjs \
  --input mirror/shell/assets/other/index.ad23f.js \
  --strings .../shell.R7xpx-table-v2.json \
  --keep-runtime --output stage/shell-keep/
# bundle 同理，用 shell.h2eSW-table.json
```

产物：
- `stage/shell-keep/index.js`（other，7.1MB / 117,130 行）—— **`C3jL =` 定义保留**（1 处）
- `stage/shell-keep/bundle.js`（bundle，1.2MB / 8,132 行）
- 两者 `1e9` 仍各 4 处（运行时未删，符合预期）

接线处理：
1. `const _global = globalThis` → `const _global = h2eSW` / `R7xpx`（按 S2 文档）
2. 两个文件都声明 `const _global` → 全局冲突，改为 `_globalB` / `_globalO` 各自唯一

## 结果（三个判据）

| 判据 | 结果 |
|---|---|
| `GET /` 次数 | **1** |
| 主线程可响应 | **否**（`Runtime.evaluate` 8s 超时） |
| `System.entries()` 有 `chunks:///WASM-*` | **无**（心跳/探针未触发） |

页面侧：钩子 4 条日志正常，随后 `astarte` 请求停在 11 次，出现
`chunks:///WASM-6233a0e2.js, chunks:///extra.js` 未注册；无 reload。

## 判断

`--keep-runtime` 保住了引导（`C3jL` 在），但**同时保住了保护代码**，
主线程被卡死 —— 与"原版外壳"同型，比清洗版更接近原版但不可用。

下一步（与 5 号机在 td109 上的方向一致）：在 keep-runtime 产物里
中和 `delete Object.prototype[...]` 那组自毁，再看是否既不死循环、解码又不崩。
