#!/usr/bin/env node
// 明文/未混淆文件的「厂商自毁函数」中和：只跑 strip-protection.neutralizeSelfDestruct，
// 写与 full-pipeline.mjs 第 3 步完全相同的 `已清空：厂商自毁函数` 标记，供 S4.2 的 strip-guards.mjs 识别。
//
// 为什么需要它：无混淆游戏（main 是明文 System.register）不进 S2 反混淆流水线，
// full-pipeline 的第 3 步就不会跑，S2.5 的「已清空处数 = 守卫组数」永远对不上。
//
// 用法：
//   node tools/rewrite/neutralize-selfdestruct.mjs <输入.js> <输出.js>
// 输出与输入同格式（generator 重排），退出码 0 表示写出；命中 0 处也会写出，但会打印警告。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('用法: node tools/rewrite/neutralize-selfdestruct.mjs <输入.js> <输出.js>');
  process.exit(2);
}

// 与 full-pipeline.mjs 一样从本目录解析 @babel/*（tools/rewrite/node_modules）
const babel = await import('@babel/core');
const S = await import(pathToFileURL(path.join(HERE, 'lib/strip-protection.mjs')).href);

const src = fs.readFileSync(input, 'utf8');
const ast = babel.parseSync(src, { sourceType: 'script' });
const n = S.neutralizeSelfDestruct(ast);
const code = babel.transformFromAstSync(ast, src, { sourceType: 'script', code: true }).code;
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, code);
console.log(`neutralizeSelfDestruct: ${n} 处；写出 ${output}（${(Buffer.byteLength(code) / 1024).toFixed(0)} KB）`);
if (!n) {
  console.error('警告：0 处命中——确认这个文件里确实有厂商自毁函数（window.opener/about:blank/window.close 的组合），否则 S2.5 数量会对不上');
  process.exitCode = 0;
}
