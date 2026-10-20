#!/usr/bin/env node
// 按每个包的 `config.<hash>.json` 递归枚举 native 资源，和磁盘上的 `native/` 实际文件对账。
//
// 用法：
//   node tools/rewrite/enum-native.mjs mirrors/<slug>_<date>
//   node tools/rewrite/enum-native.mjs mirrors/<slug>_<date> --urls /tmp/netlog-<slug>.json
//   node tools/rewrite/enum-native.mjs mirrors/<slug>_<date>/fg5/assets/game/config.9ff58.json --only game
//   node tools/rewrite/enum-native.mjs mirrors/<slug>_<date> --out /tmp/native-manifest.json --strict
//
// 参数：
//   <镜像目录 | config.*.json ...>  可以给镜像根、包目录（含 config.*.json）、或直接给 config 文件（可多个）
//   --out <文件>        native-manifest.json 写到这里（默认写到镜像根 / 当前目录）
//   --report <文件>     人读清单（Markdown）写到这里（默认与 json 同目录的 native-manifest.md）
//   --missing-out <文件> 缺失项清单写到这里（纯文本，一行一个期望路径，便于脚本补抓/比对）
//   --urls <文件>       浏览器实际请求清单（netlog / HAR / 纯 URL 清单），用来标注"缺的里面哪些真的被请求过"
//   --only <子串>       只处理路径里含这个子串的包（可重复、可逗号分隔），如 --only game
//   --limit <N>         人读清单里每个列表最多打印 N 条（默认 20，0 = 全部）
//   --strict            有"多出来的文件 / hash 不符 / 被浏览器请求过但缺"时 exit 1
//   --quiet             不往 stdout 打清单
//   -h, --help          显示帮助
//
// 依据（Cocos Creator 3.x 的包配置）：
//   - `uuids[]` 是包内资源的 uuid；多数是 22 字符压缩 uuid，少数是 9 位短 uuid
//   - `versions.native` 是扁平数组 [uuidIndex, hash, uuidIndex, hash, ...]，声明这个包的全部 native 资源
//   - native 文件落盘为 `<包>/native/<uuid 前两位>/<展开后的 uuid>.<hash>.<ext>`
//   - `paths` 是 uuid 索引 → [资源路径, 类型索引]；native 资源通常没有 paths 项，这里顺手带上便于对照
//
// 判定：
//   - 缺 = versions.native 声明了，但 native/ 下找不到同 uuid 的文件
//   - 多 = native/ 下有文件，但 versions.native 没声明（换版本残留、或 config 与文件不是同一批）
//   - hash 不符 = 找到了同 uuid 的文件，但文件名里的 hash 与 config 不一致（多半是旧版本残留）
//   - 缺 ≠ 一定是漏抓：引擎按需加载/打包在 zip 里的资源不会出现在 native/ 下，最终以运行时 404 为准
//     （SKILL 里"只抓代码不算采完"那段）；带 --urls 时，"被请求过但缺"才是真缺口
//
// 作为模块：
//   import { enumNative } from './enum-native.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractUrls } from './parse-netlog.mjs';

const USAGE = `enum-native.mjs — 按 config.<hash>.json 枚举 native 资源，输出 native-manifest.json + 人读清单

用法：
  node tools/rewrite/enum-native.mjs <镜像目录|config.*.json ...> [--urls netlog.json]
  node tools/rewrite/enum-native.mjs mirrors/fg5_2026-10-17 --urls /tmp/netlog-fg5.json --strict
  node tools/rewrite/enum-native.mjs mirrors/fg5_2026-10-17 --out /tmp/native-manifest.json --only game

完整参数见文件头注释，或 --help。`;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const HEX = '0123456789abcdef';
const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store']);

// Cocos 压缩 uuid → 落盘用的完整 uuid（8-4-4-4-12）；9 位短 uuid 原样返回
export function decompressUuid(uuid) {
  const at = uuid.indexOf('@');
  const head = at >= 0 ? uuid.slice(0, at) : uuid;
  const tail = at >= 0 ? uuid.slice(at) : '';
  if (head.length !== 22) return head + tail;
  let hex = head.slice(0, 2);
  for (let i = 2; i < 22; i += 2) {
    const lhs = B64.indexOf(head[i]);
    const rhs = B64.indexOf(head[i + 1]);
    if (lhs < 0 || rhs < 0) return uuid;
    hex += HEX[lhs >> 2] + HEX[((lhs & 3) << 2) | (rhs >> 4)] + HEX[rhs & 0xF];
  }
  if (hex.length !== 32) return uuid;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}${tail}`;
}

const normUuid = (s) => String(s).replace(/-/g, '').toLowerCase();

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ent.name.startsWith('.') && ent.name !== '.DS_Store') continue;
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else out.push(full);
  }
}

function isConfigFile(file) {
  return /^config\.[^.]+\.json$/i.test(path.basename(file));
}

function readConfig(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data || !Array.isArray(data.uuids)) throw new Error(`${file} 不像 Cocos 包配置：没有 uuids 数组`);
  return data;
}

// native 目录有两种落盘形态：
//   1) native/<uuid 前两位>/<uuid>.<hash>.<ext>                   普通贴图/音频
//   2) native/<uuid 前两位>/<uuid>.<hash>/<字体名>.ttf            BitmapFont 这类把多个文件装在一个目录里
// 这里按 `<base>.<hash>` 归组，两种形态都能对上；同一 base + hash 的多个文件算一个资源。
function scanNative(nativeDir) {
  const byBase = new Map(); // base → [{ base, hash, ext, bytes, rel, files }]
  const all = [];
  if (!fs.existsSync(nativeDir)) return { byBase, fileCount: 0 };
  walk(nativeDir, all);
  const groups = new Map(); // base + hash → group
  for (const full of all) {
    const parts = path.relative(nativeDir, full).split(path.sep);
    if (parts.length < 2) continue;
    const name = parts[1];
    const dot = name.indexOf('.');
    const base = dot < 0 ? name : name.slice(0, dot);
    const rest = dot < 0 ? [''] : name.slice(dot + 1).split('.');
    const hash = rest[0] || '';
    const nested = parts.length > 2;
    const ext = nested ? path.extname(full).replace(/^\./, '') : (rest.length > 1 ? rest[rest.length - 1] : '');
    const key = `${normUuid(base)}\u0000${hash}`;
    if (!groups.has(key)) {
      groups.set(key, { base, hash, ext, bytes: 0, rel: parts.slice(0, nested ? 2 : parts.length).join('/'), files: [] });
    }
    const g = groups.get(key);
    try { g.bytes += fs.statSync(full).size; } catch { /* 忽略 */ }
    g.files.push(path.relative(nativeDir, full).split(path.sep).join('/'));
  }
  for (const g of groups.values()) {
    const key = normUuid(g.base);
    if (!byBase.has(key)) byBase.set(key, []);
    byBase.get(key).push(g);
  }
  return { byBase, fileCount: all.length };
}

function buildUrlIndex(urls) {
  const byBase = new Map();
  for (const href of urls) {
    let u;
    try { u = new URL(href); } catch { continue; }
    if (!u.pathname.includes('/native/')) continue;
    const name = path.posix.basename(u.pathname);
    const dot = name.indexOf('.');
    const base = dot < 0 ? name : name.slice(0, dot);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(href);
  }
  return byBase;
}

export function enumNative(targets, opt = {}) {
  const baseDir = opt.baseDir || process.cwd();
  const rel = (p) => path.relative(baseDir, p).split(path.sep).join('/');
  const configFiles = [];
  for (const target of targets) {
    const abs = path.resolve(target);
    if (fs.statSync(abs).isDirectory()) {
      const found = [];
      walk(abs, found);
      configFiles.push(...found.filter(isConfigFile).sort());
    } else if (isConfigFile(abs)) {
      configFiles.push(abs);
    } else {
      throw new Error(`不是目录、也不是 config.<hash>.json：${target}`);
    }
  }
  const only = opt.only || [];
  const filtered = only.length
    ? configFiles.filter((f) => only.some((s) => f.toLowerCase().includes(String(s).toLowerCase())))
    : configFiles;

  const entries = [];
  for (const configFile of filtered) {
    const cfg = readConfig(configFile);
    const bundleDir = path.dirname(configFile);
    const nativeBase = typeof cfg.nativeBase === 'string' && cfg.nativeBase ? cfg.nativeBase : 'native';
    const nativeDir = path.join(bundleDir, nativeBase);
    const uuids = cfg.uuids;
    const paths = cfg.paths && typeof cfg.paths === 'object' ? cfg.paths : {};
    const types = Array.isArray(cfg.types) ? cfg.types : [];
    const declared = [];

    const versions = cfg.versions && typeof cfg.versions === 'object' ? cfg.versions : {};
    const source = Array.isArray(versions.native) ? 'versions.native' : 'none';
    if (Array.isArray(versions.native)) {
      for (let i = 0; i + 1 < versions.native.length; i += 2) {
        const idx = Number(versions.native[i]);
        const hash = String(versions.native[i + 1]);
        if (!Number.isInteger(idx) || idx < 0 || idx >= uuids.length) continue;
        const uuid = String(uuids[idx]);
        const resolved = decompressUuid(uuid);
        const p = paths[String(idx)];
        declared.push({
          idx,
          uuid,
          resolved,
          hash,
          assetPath: Array.isArray(p) && typeof p[0] === 'string' ? p[0] : null,
          type: Array.isArray(p) && typeof p[1] === 'number' && types[p[1]] ? types[p[1]] : null,
        });
      }
    }

    const { byBase: files, fileCount } = scanNative(nativeDir);
    const declaredResolved = new Set(declared.map((d) => normUuid(d.resolved)));
    const missing = [];
    const hashMismatch = [];
    let present = 0;

    for (const d of declared) {
      // uuid 在磁盘上可能是带连字符的完整形式，也可能是不带连字符的 32 位；统一去掉连字符再比
      const found = files.get(normUuid(d.resolved)) || [];
      const sameHash = found.filter((f) => f.hash === d.hash);
      if (!sameHash.length) {
        if (found.length) {
          hashMismatch.push({
            uuid: d.uuid, resolved: d.resolved, expectedHash: d.hash,
            found: found.map((f) => ({ rel: f.rel, hash: f.hash, ext: f.ext, bytes: f.bytes })),
            assetPath: d.assetPath, type: d.type,
          });
        } else {
          missing.push({
            uuid: d.uuid,
            resolved: d.resolved,
            hash: d.hash,
            expectedPrefix: `${rel(nativeDir)}/${d.resolved.slice(0, 2)}/${d.resolved}.${d.hash}.`,
            assetPath: d.assetPath,
            type: d.type,
          });
        }
        continue;
      }
      present += 1;
    }

    const extra = [];
    for (const [base, list] of files) {
      if (declaredResolved.has(base)) continue;
      for (const f of list) extra.push({ rel: rel(path.join(nativeDir, f.rel)), base, hash: f.hash, ext: f.ext, bytes: f.bytes });
    }

    entries.push({
      config: rel(configFile),
      bundle: path.basename(bundleDir),
      nativeDir: rel(nativeDir),
      nativeBase,
      declaredFrom: source,
      note: source === 'versions.native' ? null : 'config 里没有 versions.native：无法判定缺哪些，磁盘上的 native 文件都会记为多',
      declared: declared.length,
      present,
      missing,
      extra,
      hashMismatch,
      configUuidCount: uuids.length,
      configPathsCount: Object.keys(paths).length,
      nativeFilesOnDisk: fileCount,
      nativeAssetsOnDisk: [...files.values()].reduce((n, l) => n + l.length, 0),
    });
  }

  const urlIndex = opt.urls ? buildUrlIndex(opt.urls) : null;
  if (urlIndex) {
    for (const e of entries) {
      // 同一个 uuid 会同时挂在多个包上（依赖共享），只看本包的 native 目录，
      // 否则 game 的缺失会错记成 extra 包请求过。
      const bundleName = path.posix.basename(path.posix.dirname(e.nativeDir));
      const tail = bundleName === '.' ? `/${path.posix.basename(e.nativeDir)}/` : `/${bundleName}/${path.posix.basename(e.nativeDir)}/`;
      for (const m of e.missing) {
        m.requestedUrls = (urlIndex.get(m.resolved) || []).filter((href) => {
          try { return new URL(href).pathname.includes(tail); } catch { return false; }
        });
      }
      e.missingRequested = e.missing.filter((m) => m.requestedUrls.length).length;
    }
  }

  const totals = {
    bundles: entries.length,
    declared: entries.reduce((n, e) => n + e.declared, 0),
    present: entries.reduce((n, e) => n + e.present, 0),
    missing: entries.reduce((n, e) => n + e.missing.length, 0),
    missingRequested: entries.reduce((n, e) => n + (e.missingRequested || 0), 0),
    extra: entries.reduce((n, e) => n + e.extra.length, 0),
    hashMismatch: entries.reduce((n, e) => n + e.hashMismatch.length, 0),
  };

  return { generatedAt: new Date().toISOString(), urlSource: opt.urlFilePath || null, totals, bundles: entries };
}

function mdReport(manifest, limit) {
  const lines = [];
  const t = manifest.totals;
  lines.push('# native 资源清单', '');
  lines.push(`- 生成：${manifest.generatedAt}`);
  if (manifest.urlSource) lines.push(`- URL 交叉核对：${manifest.urlSource}`);
  lines.push(`- 合计：${t.bundles} 个包，声明 ${t.declared}，在盘 ${t.present}，缺 ${t.missing}（其中被浏览器请求过 ${t.missingRequested}），多 ${t.extra}，hash 不符 ${t.hashMismatch}`);
  lines.push('');
  lines.push('| 包 | config | 声明 | 在盘 | 缺 | 缺且被请求 | 多 | hash 不符 |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|');
  for (const e of manifest.bundles) {
    lines.push(`| ${e.bundle} | \`${e.config}\` | ${e.declared} | ${e.present} | ${e.missing.length} | ${e.missingRequested || 0} | ${e.extra.length} | ${e.hashMismatch.length} |`);
  }
  lines.push('');

  for (const e of manifest.bundles) {
    lines.push(`## ${e.bundle}（\`${e.config}\`）`, '');
    lines.push(`- native 目录：\`${e.nativeDir}\``);
    lines.push(`- 声明来源：${e.declaredFrom === 'versions.native' ? 'config 的 versions.native' : '无（config 里没有 versions.native）'}；config uuids ${e.configUuidCount}，paths ${e.configPathsCount}；磁盘 native 文件 ${e.nativeFilesOnDisk}`);
    if (e.note) lines.push(`- ⚠ ${e.note}`);
    lines.push(`- 声明 ${e.declared}，在盘 ${e.present}，缺 ${e.missing.length}（被请求过 ${e.missingRequested || 0}），多 ${e.extra.length}，hash 不符 ${e.hashMismatch.length}`);
    lines.push('');

    const requested = e.missing.filter((m) => (m.requestedUrls || []).length);
    const quiet = e.missing.filter((m) => !(m.requestedUrls || []).length);
    const show = (list) => (limit > 0 ? list.slice(0, limit) : list);
    const more = (n, shown) => (n > shown ? `（只列前 ${shown} 条，完整清单见 json）` : '');

    if (requested.length) {
      lines.push(`### 真缺口：浏览器请求过、但镜像里没有（${requested.length}）`, '');
      for (const m of show(requested)) {
        lines.push(`- \`${m.resolved}.${m.hash}.*\`${m.type ? `（${m.type}）` : ''} → ${m.requestedUrls[0]}`);
      }
      lines.push(more(requested.length, show(requested).length), '');
    }
    if (quiet.length) {
      lines.push(`### 缺、但浏览器没请求过（${quiet.length}，可能按需/打包，先别全量补）`, '');
      for (const m of show(quiet)) {
        lines.push(`- \`${m.resolved}.${m.hash}.*\`${m.assetPath ? `（${m.assetPath}）` : ''}`);
      }
      lines.push(more(quiet.length, show(quiet).length), '');
    }
    if (e.extra.length) {
      lines.push(`### 多：磁盘有、config 没声明（${e.extra.length}）`, '');
      for (const f of show(e.extra)) lines.push(`- \`${f.rel}\`（${f.bytes} 字节）`);
      lines.push(more(e.extra.length, show(e.extra).length), '');
    }
    if (e.hashMismatch.length) {
      lines.push(`### hash 不符（${e.hashMismatch.length}）`, '');
      for (const m of show(e.hashMismatch)) {
        lines.push(`- \`${m.resolved}\`：config 要 \`${m.expectedHash}\`，磁盘是 ${m.found.map((f) => `\`${f.hash}\``).join('、')}`);
      }
      lines.push(more(e.hashMismatch.length, show(e.hashMismatch).length), '');
    }
  }
  lines.push('> 说明：native 缺不等于漏抓。引擎按需加载、打包在 zip/cconb 里、或只在特定场景出现的资源，不会出现在 `native/` 下。');
  lines.push('> 最终以运行时 404 清单为准；带 `--urls` 时，看"真缺口"那一节。');
  return lines.join('\n') + '\n';
}

function parseCli(argv) {
  const opt = { targets: [], out: '', report: '', missingOut: '', urls: '', only: [], limit: 20, strict: false, quiet: false };
  const take = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} 需要一个值`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else if (a === '--out') { opt.out = take(i, a); i++; }
    else if (a === '--report') { opt.report = take(i, a); i++; }
    else if (a === '--missing-out') { opt.missingOut = take(i, a); i++; }
    else if (a === '--urls') { opt.urls = take(i, a); i++; }
    else if (a === '--only') { opt.only.push(...String(take(i, a)).split(',').map((s) => s.trim()).filter(Boolean)); i++; }
    else if (a === '--limit') { opt.limit = Number(take(i, a)); i++; }
    else if (a === '--strict') opt.strict = true;
    else if (a === '--quiet') opt.quiet = true;
    else if (a.startsWith('-')) throw new Error(`不认识的参数：${a}`);
    else opt.targets.push(a);
  }
  if (!opt.targets.length) throw new Error('缺少输入（镜像目录或 config.<hash>.json）');
  if (!Number.isFinite(opt.limit) || opt.limit < 0) throw new Error('--limit 必须是非负整数');
  return opt;
}

function writeOut(file, text) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, text);
}

async function main() {
  let opt;
  try { opt = parseCli(process.argv.slice(2)); } catch (e) {
    console.error(`[enum-native] ${e.message}\n\n${USAGE}`);
    process.exit(2);
  }

  for (const t of opt.targets) {
    if (!fs.existsSync(t)) { console.error(`[enum-native] 找不到：${t}`); process.exit(2); }
  }

  let urls = null;
  if (opt.urls) {
    if (!fs.existsSync(opt.urls)) { console.error(`[enum-native] 找不到 --urls 文件：${opt.urls}`); process.exit(2); }
    urls = await extractUrls(opt.urls);
  }

  const firstTargetAbs = path.resolve(opt.targets[0]);
  const baseDir = fs.statSync(firstTargetAbs).isDirectory() ? firstTargetAbs : process.cwd();
  const manifest = enumNative(opt.targets, {
    only: opt.only,
    urls,
    baseDir,
    urlFilePath: opt.urls ? path.resolve(opt.urls) : null,
  });
  manifest.mirror = path.resolve(opt.targets[0]);
  if (!manifest.bundles.length) {
    console.error('[enum-native] 没找到任何 config.<hash>.json；镜像根目录给对了吗？');
    process.exit(1);
  }

  const outFile = opt.out || path.join(baseDir, 'native-manifest.json');
  const reportFile = opt.report || path.join(path.dirname(path.resolve(outFile)), 'native-manifest.md');
  writeOut(outFile, JSON.stringify(manifest, null, 2) + '\n');
  const report = mdReport(manifest, opt.limit);
  writeOut(reportFile, report);

  if (opt.missingOut) {
    const lines = ['# 缺失的 native 资源（期望路径；`<ext>` 表示扩展名未知，实际可能打包在 zip/cconb 里）'];
    for (const e of manifest.bundles) {
      lines.push(`# ${e.bundle}（${e.config}）`);
      for (const m of e.missing) lines.push(`${e.nativeDir}/${m.resolved.slice(0, 2)}/${m.resolved}.${m.hash}.<ext>`);
    }
    writeOut(opt.missingOut, lines.join('\n') + '\n');
  }

  if (!opt.quiet) process.stdout.write(report);

  const t = manifest.totals;
  console.error(`[enum-native] ${t.bundles} 个包：声明 ${t.declared}，在盘 ${t.present}，缺 ${t.missing}（被请求过 ${t.missingRequested}），多 ${t.extra}，hash 不符 ${t.hashMismatch}`);
  console.error(`[enum-native] 写出 ${outFile}`);
  console.error(`[enum-native] 写出 ${reportFile}`);
  if (opt.missingOut) console.error(`[enum-native] 写出 ${opt.missingOut}`);

  if (opt.strict) {
    const bad = [];
    if (t.extra) bad.push(`${t.extra} 个多余文件`);
    if (t.hashMismatch) bad.push(`${t.hashMismatch} 个 hash 不符`);
    if (t.missingRequested) bad.push(`${t.missingRequested} 个被浏览器请求过但缺失`);
    if (bad.length) { console.error(`[enum-native] --strict 失败：${bad.join('、')}`); process.exit(1); }
  }
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  main().catch((e) => { console.error(`[enum-native] 失败：${e.message}`); process.exit(1); });
}
