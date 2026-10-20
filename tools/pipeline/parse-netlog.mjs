#!/usr/bin/env node
// 把 Chrome `--log-net-log` 的 JSON 解析成 URL 清单（也兼容 HAR 和纯 URL 清单，见下）。
//
// 用法：
//   node tools/rewrite/parse-netlog.mjs <netlog.json|har|urls.txt> --host <域名> [--host <域名2>]
//   node tools/rewrite/parse-netlog.mjs <netlog.json> --all
//   node tools/rewrite/parse-netlog.mjs <netlog.json> --host <域名> --paths > urls.txt
//   node tools/rewrite/parse-netlog.mjs <netlog.json> --host <域名> --out urls.txt \
//        --manifest source-manifest.json --root game=/fg5/ --root shell=/astarte2/3.6/web-mobile/
//
// 参数：
//   <输入>             Chrome netlog（`{"constants":…,"events":[…]}`）、DevTools 导出的 HAR、或纯 URL 清单（一行一个）
//   --host <域名>      只要这个域名（可重复、可逗号分隔）；支持 *.example.com 和 .example.com 后缀写法
//   --all             不过滤域名（按域名分组输出）
//   --exclude <域名>   排除域名（可重复、可逗号分隔），常用于 --all 时去掉 google/组件更新等噪声
//   --out <文件>       文本清单写到文件（默认 stdout）；写文件时 stdout 只留摘要
//   --paths           只输出 pathname（一行一个，不带域名），便于直接拼 curl；只能配合单个 --host
//   --keep-query      --paths 时保留 query（默认丢掉，静态资源一般不需要）
//   --manifest <文件>  额外写一份 source-manifest.json 骨架（files[] + roots[]，大小未知留 null）
//   --root name=前缀   手工指定根，如 game=/fg5/、shell=/astarte2/3.6/web-mobile/；不给就按路径第一段自动分
//   --layout flat|host 镜像目录布局：flat（默认，根目录直接是 <第一段>/）或 host（<域名>/<第一段>/）
//   --slug <名字>      manifest 里的 slug；不给就从根目录名或输入文件名猜
//   --date <YYYY-MM-DD> manifest 里的日期；默认今天
//   --schemes http,https  允许的协议（默认 http,https；ws/wss 不是可下载文件，默认丢掉）
//   --quiet            不往 stderr 打摘要
//   -h, --help         显示本帮助
//
// 处理规则：
//   - 去掉 #fragment 后按完整 URL 去重；同一 URL 出现多次只留一条
//   - 跳过 data: / blob: / chrome-extension: / chrome: / devtools: / about: / javascript: / filesystem:
//   - 空串、解析不了的 URL 直接丢弃
//   - 输出按域名分组：`# <host> (<条数>)` + 一行一个 URL；用 --paths 时不带分组头
//
// 作为模块：
//   import { extractUrls } from './parse-netlog.mjs';
//   const urls = await extractUrls('/tmp/netlog.json');   // string[]
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const USAGE = `parse-netlog.mjs — Chrome netlog / HAR / URL 清单 → 按域名分组的 URL 清单 + manifest 骨架

用法：
  node tools/rewrite/parse-netlog.mjs <netlog.json> --host <域名> [--host <域名2>] [--out urls.txt]
  node tools/rewrite/parse-netlog.mjs <netlog.json> --all [--exclude google.com]
  node tools/rewrite/parse-netlog.mjs <netlog.json> --host <域名> --paths > urls.txt
  node tools/rewrite/parse-netlog.mjs <netlog.json> --host <域名> --manifest source-manifest.json \\
       --root game=/fg5/ --root shell=/astarte2/3.6/web-mobile/

常用参数：--out / --paths / --keep-query / --manifest / --root / --layout / --slug / --date
完整说明见文件头注释，或 --help。`;

const SKIP_SCHEMES = new Set([
  'data:', 'blob:', 'chrome-extension:', 'chrome:', 'devtools:', 'about:',
  'javascript:', 'filesystem:', 'edge:', 'moz-extension:', 'chrome-untrusted:',
]);

// ---------------------------------------------------------------- 读输入

async function* eachLine(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

// 只读文件头判断类型：netlog 头是 {"constants":…；HAR 是 {"log":…；其余当 URL 清单
function sniff(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, n).toString('utf8').trimStart();
    if (head.startsWith('{')) {
      if (/^\{\s*"(constants|events)"/.test(head)) return 'netlog';
      if (/^\{\s*"log"/.test(head)) return 'har';
      return 'json';
    }
  } finally {
    fs.closeSync(fd);
  }
  return 'urls';
}

function eventsToUrls(events) {
  const urls = [];
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const p = ev.params || {};
    const u = p.url || p.request_url || p.redirect_url;
    if (typeof u === 'string' && u) urls.push(u);
  }
  return urls;
}

function harToUrls(har) {
  const entries = har && har.log && Array.isArray(har.log.entries) ? har.log.entries : [];
  return entries.map((e) => e && e.request && e.request.url).filter((u) => typeof u === 'string' && u);
}

// netlog 每个事件一行（`{"constants":…` 头一行，后面事件逐行，行尾带逗号）。
// 先用流式逐行解析，事件数不为 0 就够用；格式不是逐行（pretty-print）再把整份 JSON 读进来兜底。
async function readNetlog(file) {
  const urls = [];
  let events = 0;
  for await (const raw of eachLine(file)) {
    const line = raw.trim().replace(/,$/, '');
    if (!line || line === '"events": [' || line === ']}' || line === ']') continue;
    if (!line.includes('"url"') && !line.includes('"constants"')) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object' || obj.constants) continue;
    events++;
    const p = obj.params || {};
    const u = p.url || p.request_url || p.redirect_url;
    if (typeof u === 'string' && u) urls.push(u);
  }
  if (events > 0) return { urls, events };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed && Array.isArray(parsed.events)) {
    return { urls: eventsToUrls(parsed.events), events: parsed.events.length };
  }
  if (parsed && parsed.log && Array.isArray(parsed.log.entries)) return { urls: harToUrls(parsed), events: 0 };
  throw new Error('不像 netlog：既没有 events 数组，也不是 HAR');
}

async function readUrlList(file) {
  const urls = [];
  for await (const raw of eachLine(file)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    urls.push(line);
  }
  return { urls, events: 0 };
}

export async function extractUrls(file, { schemes = ['http:', 'https:'] } = {}) {
  const kind = sniff(file);
  let result;
  if (kind === 'netlog') result = await readNetlog(file);
  else if (kind === 'har') result = { urls: harToUrls(JSON.parse(fs.readFileSync(file, 'utf8'))), events: 0 };
  else if (kind === 'json') {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && Array.isArray(parsed.events)) result = { urls: eventsToUrls(parsed.events), events: parsed.events.length };
    else if (parsed && parsed.log && Array.isArray(parsed.log.entries)) result = { urls: harToUrls(parsed), events: 0 };
    else throw new Error('JSON 里既没有 events 数组，也不是 HAR');
  } else result = await readUrlList(file);

  const allow = new Set(schemes.map((s) => (s.endsWith(':') ? s : s + ':')));
  const seen = new Set();
  const out = [];
  for (const raw of result.urls) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const hashAt = trimmed.indexOf('#');
    const noHash = hashAt < 0 ? trimmed : trimmed.slice(0, hashAt);
    let url;
    try { url = new URL(noHash); } catch { continue; }
    const scheme = url.protocol.toLowerCase();
    if (SKIP_SCHEMES.has(scheme)) continue;
    if (!allow.has(scheme)) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    out.push(url.href);
  }
  return out;
}

// ---------------------------------------------------------------- 过滤与分组

function parseHostPattern(raw) {
  return String(raw).trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
}

export function hostMatches(hostname, patterns) {
  if (!patterns || !patterns.length) return true;
  const h = hostname.toLowerCase();
  return patterns.some((raw) => {
    const p = parseHostPattern(raw);
    if (!p) return false;
    if (p.startsWith('*.')) return h === p.slice(2) || h.endsWith(p.slice(1));
    if (p.startsWith('.')) return h.endsWith(p);
    return h === p;
  });
}

function splitList(values) {
  const out = [];
  for (const v of values) for (const part of String(v).split(',')) if (part.trim()) out.push(part.trim());
  return out;
}

// ---------------------------------------------------------------- manifest

function normalizePrefix(prefix) {
  let p = String(prefix || '').trim();
  if (!p) return '';
  if (!p.startsWith('/')) p = '/' + p;
  if (!p.endsWith('/')) p = p + '/';
  return p;
}

function buildManifest(urls, opt, kind, input) {
  const files = urls.map((href) => {
    const u = new URL(href);
    return { host: u.hostname.toLowerCase(), path: u.pathname, url: href, bytes: null };
  }).sort((a, b) => (a.host + a.path).localeCompare(b.host + b.path));

  let roots;
  if (opt.roots.length) {
    roots = opt.roots.map(({ name, prefix }) => {
      const p = normalizePrefix(prefix);
      const rel = p.replace(/^\/+|\/+$/g, '');
      const hosts = [...new Set(files.filter((f) => f.path.startsWith(p)).map((f) => f.host))];
      return {
        name,
        dir: opt.layout === 'host' ? (hosts[0] ? `${hosts[0]}/${rel}` : rel) : rel,
        sourceUrl: hosts[0] ? `https://${hosts[0]}${p}` : null,
        hosts,
        fileCount: files.filter((f) => f.path.startsWith(p)).length,
        totalBytes: null,
        fetchedAt: null,
      };
    });
  } else {
    const map = new Map();
    for (const f of files) {
      const seg = f.path.split('/').filter(Boolean)[0];
      const key = seg ? `${f.host}\u0000${seg}` : `${f.host}\u0000`;
      if (!map.has(key)) map.set(key, { seg, host: f.host, count: 0 });
      map.get(key).count++;
    }
    roots = [...map.values()].map(({ seg, host, count }) => ({
      name: seg || `${host} 根路径`,
      dir: seg ? (opt.layout === 'host' ? `${host}/${seg}` : seg) : '',
      sourceUrl: `https://${host}/${seg ? seg + '/' : ''}`,
      hosts: [host],
      fileCount: count,
      totalBytes: null,
      fetchedAt: null,
      auto: true,
    })).filter((r) => r.dir);
  }

  const rootOf = (f) => {
    let hit = null;
    for (const r of roots) {
      const rel = opt.layout === 'host' && r.dir.includes('/') ? r.dir.split('/').slice(1).join('/') : r.dir;
      if (!rel) continue;
      if (f.path === '/' + rel || f.path.startsWith('/' + rel + '/')) { hit = r.name; break; }
    }
    return hit;
  };

  const slug = opt.slug || (roots[0] ? path.basename(roots[0].dir) : path.basename(input).replace(/\.[^.]+$/, ''));
  return {
    slug,
    date: opt.date || new Date().toISOString().slice(0, 10),
    source: kind,
    input,
    generatedAt: new Date().toISOString(),
    hosts: [...new Set(files.map((f) => f.host))].sort(),
    roots,
    files: files.map((f) => ({ ...f, root: rootOf(f) })),
    notes: [
      'bytes 未知：netlog 只记了 URL，没记响应体大小；补抓后用 find/du 回填 totalBytes',
      'roots 是按 URL 路径自动分的骨架；要精确对应镜像目录，用 --root name=前缀 手工指定',
      'manifest-verify 读 roots[].dir 找目录；dir 为空或与实际镜像布局不符时先改这里',
    ],
  };
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, text);
}

// ---------------------------------------------------------------- CLI

function parseCli(argv) {
  const opt = {
    input: null, hosts: [], excludes: [], all: false, out: null, paths: false, keepQuery: false,
    manifest: null, roots: [], layout: 'flat', slug: '', date: '', quiet: false,
    schemes: ['http:', 'https:'],
  };
  const take = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} 需要一个值`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else if (a === '--host') { opt.hosts.push(...splitList([take(i, a)])); i++; }
    else if (a === '--exclude') { opt.excludes.push(...splitList([take(i, a)])); i++; }
    else if (a === '--all') opt.all = true;
    else if (a === '--out') { opt.out = take(i, a); i++; }
    else if (a === '--paths') opt.paths = true;
    else if (a === '--keep-query') opt.keepQuery = true;
    else if (a === '--manifest') { opt.manifest = take(i, a); i++; }
    else if (a === '--root') {
      const v = take(i, a); i++;
      const at = v.indexOf('=');
      if (at <= 0) throw new Error(`--root 要写成 name=路径前缀，如 game=/fg5/，收到 ${v}`);
      opt.roots.push({ name: v.slice(0, at), prefix: v.slice(at + 1) });
    } else if (a === '--layout') { opt.layout = take(i, a); i++; }
    else if (a === '--slug') { opt.slug = take(i, a); i++; }
    else if (a === '--date') { opt.date = take(i, a); i++; }
    else if (a === '--schemes') { opt.schemes = splitList([take(i, a)]).map((s) => (s.endsWith(':') ? s : s + ':')); i++; }
    else if (a === '--quiet') opt.quiet = true;
    else if (a.startsWith('-')) throw new Error(`不认识的参数：${a}`);
    else if (!opt.input) opt.input = a;
    else throw new Error(`多余的参数：${a}`);
  }
  if (!opt.input) throw new Error('缺少输入文件');
  if (!opt.all && !opt.hosts.length) throw new Error('必须给 --host <域名> 或 --all');
  if (opt.all && opt.hosts.length) throw new Error('--all 和 --host 不要混用');
  if (opt.layout !== 'flat' && opt.layout !== 'host') throw new Error(`--layout 只能是 flat 或 host，收到 ${opt.layout}`);
  return opt;
}

async function main() {
  let opt;
  try { opt = parseCli(process.argv.slice(2)); } catch (e) {
    console.error(`[parse-netlog] ${e.message}\n\n${USAGE}`);
    process.exit(2);
  }

  if (!fs.existsSync(opt.input)) {
    console.error(`[parse-netlog] 找不到输入：${opt.input}`);
    process.exit(2);
  }

  const kind = sniff(opt.input);
  const all = await extractUrls(opt.input, { schemes: opt.schemes });
  const hosts = opt.hosts;
  const excludes = opt.excludes;

  const selected = all.filter((href) => {
    const host = new URL(href).hostname;
    if (hosts.length && !hostMatches(host, hosts)) return false;
    if (excludes.length && hostMatches(host, excludes)) return false;
    return true;
  });

  if (!selected.length) {
    console.error(`[parse-netlog] 输入 ${all.length} 条 URL，但没有一条匹配 ${opt.all ? '--all' : hosts.join(', ')}`);
    process.exit(1);
  }

  const groups = new Map();
  for (const href of selected) {
    const host = new URL(href).hostname.toLowerCase();
    if (!groups.has(host)) groups.set(host, []);
    groups.get(host).push(href);
  }
  for (const list of groups.values()) list.sort();
  const sortedGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  if (opt.paths && sortedGroups.length > 1) {
    console.error(`[parse-netlog] --paths 只能用于单个域名，当前选中 ${sortedGroups.length} 个（${[...groups.keys()].join(', ')}）；请加 --host`);
    process.exit(2);
  }

  let text;
  if (opt.paths) {
    text = selected.map((href) => {
      const u = new URL(href);
      return opt.keepQuery ? u.pathname + u.search : u.pathname;
    }).sort().join('\n') + '\n';
  } else {
    text = sortedGroups.map(([host, list]) => `# ${host} (${list.length})\n${list.join('\n')}\n`).join('\n');
  }

  if (opt.out) {
    writeFile(opt.out, text);
    if (!opt.quiet) console.log(`[parse-netlog] 写出 ${opt.out}（${selected.length} 条，${sortedGroups.length} 个域名）`);
  } else {
    process.stdout.write(text);
  }

  if (opt.manifest) {
    const manifest = buildManifest(selected, opt, kind, path.resolve(opt.input));
    writeFile(opt.manifest, JSON.stringify(manifest, null, 2) + '\n');
    if (!opt.quiet) {
      console.error(`[parse-netlog] 写出 ${opt.manifest}（roots ${manifest.roots.length} 个，files ${manifest.files.length} 条；大小未填）`);
    }
  }

  if (!opt.quiet) {
    console.error(`[parse-netlog] 输入=${kind} 去重后=${all.length} 选中=${selected.length} 域名=${sortedGroups.length}` + (opt.out ? '' : '（清单已写 stdout）'));
    for (const [host, list] of sortedGroups) console.error(`  - ${host}: ${list.length}`);
  }
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  main().catch((e) => { console.error(`[parse-netlog] 失败：${e.message}`); process.exit(1); });
}
