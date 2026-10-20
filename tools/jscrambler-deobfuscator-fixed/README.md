# jscrambler-deobfuscator-fixed

Jscrambler 反混淆器的修复版：[worstperson/jscrambler-deobfuscator](https://github.com/worstperson/jscrambler-deobfuscator) 的 `all-fixes` 分支（commit `e95ff95`，合并 `unflattener-fix1`…`fix5`，即上游 PR #14–#18 的 5 个控制流修复）。上游 [Ciarands](https://github.com/Ciarands/jscrambler-deobfuscator) 原版还原控制流时会丢 return 和分支。

- `src/`：e95ff95 原样。
- `local-wip.diff`：G1000 前期在 prepare.js、controlFlowUnflattener.js、inlineArrayBuilder.js、inlineSetupFunctions.js、resolveStrings.js 上试过的修改，**未验证、默认不应用**（其中 prepare.js 的命名空间修正让 `_global` 指向各文件自己的命名空间对象；不打这个补丁时产物第一行是 `const _global = globalThis`，读代码时把 `_global.xxx` 理解为命名空间属性即可）。
- 用法：不要直接调本目录，用 `tools/rewrite/deob-parallel.mjs`（每个文件一个进程并发跑）。依赖：`npm install`。
- 字符串阶段会打印 `Aborting. Could not find: large string function and decoder IIFE.`：这是预期的，字符串在 R2 用运行时导出的表另行还原。

实测（G1000 三个文件，2026-10-15，8 核 Mac）：并发总用时 2386 秒，按文件相加 6931 秒（约 2.9 倍），（G1000 时代记录的基准数据，随该款样本一起归档）。产物与此前串行产出的参考代码结构一致（switch / return 数量相同或相差 <0.1%），差异主要是上面 `_global` 那一行。
