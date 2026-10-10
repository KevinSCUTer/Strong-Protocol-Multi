#!/usr/bin/env node
// tools/deploy.mjs — deployment preparation, the one step `start.sh` (repo root) runs before it execs the server.
// Also usable on its own; it NEVER starts the server (scripts/launch.mjs is the interactive player path).
//
//   node tools/deploy.mjs [options]
//
// Steps (each idempotent, so every start — fresh clone or updated clone — can run them all):
//   1. Node.js ≥ 22 check.
//   2. Production dependencies: every `dependencies` entry of package.json must have node_modules/<pkg>/package.json
//      (ws, three, @zip.js/zip.js, …), and package-lock.json must match the hash in .cache/deploy-state.json.
//      Only then `npm ci` runs (no `npm install` fallback: a failing ci is a failed deployment, and install could
//      rewrite the tracked lockfile). npm ci itself never edits tracked files.
//   3. Client libraries in public/vendor (tools/vendor.mjs) when a copy is missing, older than its node_modules
//      source, or tools/vendor.mjs itself changed since the last run.
//   4. Shared asset roots: public/assets and public/fonts may be symlinks to a directory shared by several
//      checkouts. The links are only ever followed (a dangling link gets its target directory created); they are
//      never replaced, moved or deleted. (server assetCacheCatalog deliberately rejects symlinked manifests — it is
//      not used here.)
//   5. Art / audio / fonts: node tools/fetch-assets.mjs --add-only --download-only — every start re-plans from the
//      CURRENT game data and upstream indexes and downloads only what is missing (existing files are never
//      re-downloaded, rewritten or deleted; a missing atlas page of an existing model is repaired; missing fonts,
//      .woff2 and fonts.css are added without touching existing shared fonts). The committed data/assets.json is
//      NOT written: this preparation never mutates tracked files and runs no git commands, so `git pull` stays
//      clean and local user changes are preserved. Files the current plan adds beyond the committed manifest
//      (e.g. a new operator's art) are downloaded and reported — the client consumes them once the next committed
//      manifest ships.
//      The upstream indexes refresh when older than SP_DEPLOY_INDEX_TTL_HOURS (default 24) or when data/*.json is
//      newer; if that refresh fails but the cached indexes suffice and everything else passes, the preparation
//      succeeds with a loud "refresh pending" note (never recorded as refreshed).
//      Skin avatars the manifest declares (tools/inject-skins-assets.mjs) are outside the fetch-assets plan: the
//      missing ones are fetched by tools/fetch-skin-avatars.mjs (not with --offline).
//   6. Gates (any failure exits non-zero, and the ready stamp is cleared):
//      - fetch-assets exit code (missing avatar/portrait/Front Spine, --strict drops, …),
//      - every /assets|/fonts file the committed data/assets.json declares exists on disk,
//      - every atlas page its .atlas file declares exists on disk,
//      - the fonts are complete (3 originals + 3 .woff2 + fonts.css) unless --no-assets.
//      A 404 on optional mirror art keeps using the built-in fallback instead: the game stays usable and the run
//      says so — it never claims full model completeness.
//
// Options:
//   --prepare-only    accepted for symmetry with start.sh (this tool never starts the server anyway)
//   --no-assets       skip step 5 entirely (documented offline shortcut; the gates for fonts then do not apply)
//   --offline         pass --offline to fetch-assets: no network, post-process what is on disk only
//   --refresh-index   force an upstream index refresh this run
//   --no-refresh-index never refresh the indexes (repeat/offline starts on a sealed machine)
//   --check           report readiness only, change nothing (exit 1 when a gate fails)
//   --quiet           only errors
//   -h, --help
//
// Exit code: 0 = ready (or a report-only --check that passed), 1 = a gate failed, 2 = usage error.
// Environment: PORT / MP3_FOLDER / HOST / SP_ASSET_SOURCE / SP_GITHUB_PROXY are inherited untouched (the server
// reads them itself); SP_DEPLOY_INDEX_TTL_HOURS, SP_DEPLOY_REFRESH_INDEX as above. State: .cache/deploy-state.json
// (git-ignored) — lockHash / vendorHash stamps and `ready`. Preparation clears it before starting and only a
// successful run leaves it true. Report-only checks and help never change the state, including on failure.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { c, mark, VENDOR_REQUIRED } from './setup.mjs';
import { VENDOR_FILES } from './vendor.mjs';
import { atlasInfo } from './assets/atlas.mjs';
import { safeName } from './assets/sources.mjs';
import { FONTS } from './assets/fonts.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STATE_FILE = path.join(ROOT, '.cache', 'deploy-state.json');
export const MANIFEST = path.join(ROOT, 'data', 'assets.json');
export const ASSETS_DIR = path.join(ROOT, 'public', 'assets');
export const FONTS_DIR = path.join(ROOT, 'public', 'fonts');
const FETCH_ASSETS = path.join(ROOT, 'tools', 'fetch-assets.mjs');
const FETCH_SKIN_AVATARS = path.join(ROOT, 'tools', 'fetch-skin-avatars.mjs');

/** The skin avatars among the manifest files missing on disk (fetch-assets does not plan them). */
export function skinAvatarGaps(missing) { return missing.filter((u) => u.startsWith('/assets/char/skin_avatar/')); }
const VENDOR_TOOL = path.join(ROOT, 'tools', 'vendor.mjs');
const PACKAGE_LOCK = path.join(ROOT, 'package-lock.json');
const INDEX_FILES = ['.cache/gamedata/excel/audio_data.json', '.cache/gamedata/excel/charword_table.json', '.cache/ark-models/models_data.json']
  .map((rel) => path.join(ROOT, rel));
const NODE_URL = 'https://nodejs.org/zh-cn/download';
const DEFAULT_INDEX_TTL_HOURS = 24;

const log = (m = '') => console.log(m);

/** sha256 of a file's bytes (null when unreadable). */
export function fileSha256(p) {
  try { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; }
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

/** .cache/deploy-state.json ({} when missing or unreadable). */
export function readState(p = STATE_FILE) { return readJson(p) || {}; }

/** Merge `patch` into the state file (best effort — a broken .cache must not stop a deployment). */
export function writeState(patch, p = STATE_FILE) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ ...readState(p), ...patch }, null, 1) + '\n');
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------------------------------
// Pure helpers (unit-tested; the fs-touching ones take injectable facts)
// ---------------------------------------------------------------------------------------------------

/**
 * Parse CLI flags. Unknown flags are a usage error (start.sh forwards everything here).
 * @param {string[]} argv
 * @returns {{prepareOnly:boolean, noAssets:boolean, offline:boolean, refreshIndex:boolean, noRefreshIndex:boolean,
 *            check:boolean, quiet:boolean, help:boolean}}
 */
export function parseArgs(argv) {
  const o = { prepareOnly: false, noAssets: false, offline: false, refreshIndex: false, noRefreshIndex: false, check: false, quiet: false, help: false };
  for (const a of argv) {
    if (a === '--prepare-only') o.prepareOnly = true;
    else if (a === '--no-assets') o.noAssets = true;
    else if (a === '--offline') o.offline = true;
    else if (a === '--refresh-index') o.refreshIndex = true;
    else if (a === '--no-refresh-index') o.noRefreshIndex = true;
    else if (a === '--check') o.check = true;
    else if (a === '--quiet' || a === '-q') o.quiet = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`未知参数 / unknown option: ${a}（--help 查看用法）`);
  }
  if (o.refreshIndex && o.noRefreshIndex) throw new Error('--refresh-index 和 --no-refresh-index 不能同时使用');
  return o;
}

/** Node.js ≥ 22 check: { ok, message } (message only when too old). */
export function checkNode(version = process.versions.node) {
  const major = Number(String(version).split('.')[0]);
  return major >= 22 ? { ok: true, message: '' }
    : { ok: false, message: `Node.js ${version} 太旧，需要 22 或更高（22 / 24 LTS）：${NODE_URL}` };
}

/** The production dependency names of a package.json object. */
export function prodDependencyNames(pkg) { return Object.keys(pkg?.dependencies || {}); }

/**
 * Which production dependencies have no node_modules/<name>/package.json (checks every one of them, including
 * scoped packages such as @zip.js/zip.js and deep ones such as three).
 * @param {string} modulesDir absolute node_modules directory
 * @param {string[]} deps dependency names
 * @param {(p:string)=>boolean} [exists]
 * @returns {string[]} the missing names
 */
export function prodDepsMissing(modulesDir, deps, exists = (p) => fs.existsSync(p)) {
  return deps.filter((name) => !exists(path.join(modulesDir, ...name.split('/'), 'package.json')));
}

/**
 * Does the dependency step need to run (and is `npm ci` the honest command)?
 * @param {{missing:number, lockHash:string|null, state:{lockHash?:string}, hasNodeModules:boolean}} o
 * @returns {{needed:boolean, why:string}}
 */
export function depsNeedInstall({ missing, lockHash, state, hasNodeModules }) {
  if (missing > 0) return { needed: true, why: `${missing} 个生产依赖的 node_modules 缺失` };
  if (!hasNodeModules) return { needed: true, why: 'node_modules 不存在' };
  if (!lockHash) return { needed: true, why: 'package-lock.json 不可读' };
  if (state.lockHash !== lockHash) return { needed: true, why: 'package-lock.json 与上次部署相比已变化' };
  return { needed: false, why: '' };
}

/**
 * Vendored client libraries that are missing or older than their node_modules source. An optional file whose
 * source is not installed is skipped (tools/vendor.mjs skips it too).
 * @param {{dst:string, optional?:boolean, srcExists:boolean, srcMtime?:number, dstExists:boolean, dstMtime?:number}[]} entries
 * @returns {string[]} the file names in public/vendor to refresh
 */
export function staleVendorFiles(entries) {
  return entries
    .filter((e) => !(e.optional && !e.srcExists))
    .filter((e) => !e.dstExists || (e.srcExists && e.srcMtime > e.dstMtime))
    .map((e) => e.dst);
}

/**
 * Must tools/vendor.mjs run: a stale/missing copy, or the tool itself changed since the last run (its rewrite of
 * Preact's hooks build is code, not data).
 * @param {{stale:string[], state:{vendorHash?:string}, vendorHash:string|null}} o
 */
export function vendorNeedsRun({ stale, state, vendorHash }) {
  if (stale.length) return { needed: true, why: `${stale.length} 个文件缺失或比源码旧` };
  if (state.vendorHash !== vendorHash) return { needed: true, why: 'tools/vendor.mjs 自上次运行后变化' };
  return { needed: false, why: '' };
}

/**
 * Index refresh policy: refresh when the cached indexes are older than the TTL or when game data changed after
 * they were fetched. Indexes missing from .cache are not "refresh" (fetch-assets downloads them anyway).
 * @param {{indexStats:{mtime:number,size:number}[], dataMtimes:number[], ttlHours:number, now:number}} o
 */
export function indexRefreshNeeded({ indexStats, dataMtimes, ttlHours, now }) {
  if (!indexStats.length || indexStats.some((s) => !s || !(s.size > 0))) return false;
  const oldestIndex = Math.min(...indexStats.map((s) => s.mtime));
  if (oldestIndex < now - ttlHours * 3600_000) return true;
  const newestData = Math.max(0, ...dataMtimes);
  return newestData > oldestIndex;
}

/** Do all cached upstream indexes exist (so a failed refresh can fall back to them)? */
export function cachedIndexesReady(files = INDEX_FILES, stat = (p) => fs.statSync(p)) {
  return files.every((p) => { try { return stat(p).size > 0; } catch { return false; } });
}

/**
 * The fetch-assets invocation of a deployment run: always --add-only (never rewrite/delete an existing shared
 * file) and --download-only (the committed manifest is never written).
 * @param {{offline?:boolean}} opts
 * @param {boolean} refresh pass --refresh-index
 * @returns {string[]}
 */
export function buildFetchArgs(opts = {}, refresh = false) {
  const args = ['--add-only', '--download-only'];
  if (opts.offline) args.push('--offline');
  if (refresh) args.push('--refresh-index');
  return args;
}

/**
 * Shared asset roots: which state is each in, and what (if anything) may be created. A symlink is only ever
 * followed — never replaced, moved or deleted (several checkouts share public/assets and public/fonts through
 * it). A dangling link gets its TARGET directory created (mutate only: --check reports read-only), resolving the
 * link text; the link itself stays.
 * @param {{assetsDir:string, fontsDir:string, mutate?:boolean, lstat?:(p:string)=>any, stat?:(p:string)=>any,
 *          readlink?:(p:string)=>string, mkdir?:(p:string)=>any}} o
 * @returns {Promise<{ok:boolean, states:Record<string,string>, errors:string[]}>}
 */
export async function ensureSharedDirs({ assetsDir, fontsDir, mutate = true, lstat = fs.lstatSync, stat = fs.statSync, readlink = fs.readlinkSync, mkdir = (p) => fs.mkdirSync(p, { recursive: true }) }) {
  const states = {};
  const errors = [];
  for (const [name, p] of [['assets', assetsDir], ['fonts', fontsDir]]) {
    let st;
    try { st = await lstat(p); } catch { states[name] = 'missing'; continue; } // fetch-assets / buildFonts create it
    if (st.isSymbolicLink()) {
      let target;
      try { target = await stat(p); } catch { // dangling link: create the target directory it names, keep the link
        if (!mutate) { states[name] = 'link-dangling'; continue; }
        const text = readlink(p);
        const abs = path.isAbsolute(text) ? text : path.resolve(path.dirname(p), text);
        try { mkdir(abs); states[name] = 'link-target-created'; } catch (e) { errors.push(`${name}: 软链接目标无法创建：${e.message}`); }
        continue;
      }
      if (target.isDirectory()) states[name] = 'link';
      else errors.push(`${name}: 软链接目标不是目录：${p}`);
      continue;
    }
    if (st.isDirectory()) { states[name] = 'dir'; continue; }
    errors.push(`${name}: 不是目录也不是软链接：${p}`);
  }
  return { ok: errors.length === 0, states, errors };
}

/**
 * Every '/assets/…' or '/fonts/…' URL of a manifest (same walk as tools/setup.mjs checkAssets).
 * @param {any} node
 * @param {string[]} [out]
 * @returns {string[]}
 */
export function manifestUrls(node, out = []) {
  if (typeof node === 'string') { if (/^\/(assets|fonts)\//.test(node)) out.push(node); }
  else if (Array.isArray(node)) for (const x of node) manifestUrls(x, out);
  else if (node && typeof node === 'object') for (const x of Object.values(node)) manifestUrls(x, out);
  return out;
}

const urlToPath = (publicDir, url) => path.join(publicDir, ...url.split('/').filter(Boolean).map(decodeURIComponent));

/**
 * Completeness of the committed manifest on this disk: files it declares but that are missing (or empty), and
 * atlas pages its .atlas files declare but that are missing — an interrupted download the plan round skipped
 * (e.g. an extra page of an already-satisfied model). A symlinked publicDir is fine: stat follows links.
 * @param {object} manifest data/assets.json
 * @param {string} publicDir absolute public/ directory
 * @param {{readFile?:(p:string)=>Promise<Buffer>, stat?:(p:string)=>any}} [io] injectable for tests
 * @returns {Promise<{missing:string[], missingAtlasPages:string[]}>}
 */
export async function manifestGaps(manifest, publicDir, io = {}) {
  const stat = io.stat || ((p) => fs.statSync(p));
  const readFile = io.readFile || ((p) => fs.promises.readFile(p));
  const missing = [];
  for (const url of [...new Set(manifestUrls(manifest))]) {
    let st = null;
    try { st = stat(urlToPath(publicDir, url)); } catch { /* missing */ }
    if (!st || !st.isFile() || !st.size) missing.push(url);
  }
  const missingAtlasPages = [];
  for (const url of [...new Set(manifestUrls(manifest))].filter((u) => u.endsWith('.atlas'))) {
    if (missing.includes(url)) continue;
    let text;
    try { text = (await readFile(urlToPath(publicDir, url))).toString('utf8'); } catch { continue; }
    for (const page of atlasInfo(text).pages) {
      const p = path.join(path.dirname(urlToPath(publicDir, url)), safeName(page));
      let st = null;
      try { st = stat(p); } catch { /* missing */ }
      if (!st || !st.isFile() || !st.size) missingAtlasPages.push(`${url} → ${safeName(page)}`);
    }
  }
  return { missing, missingAtlasPages };
}

/**
 * Font completeness of a public/fonts directory (the manifest's `fonts` entry points here): every font's original
 * and .woff2, plus fonts.css. Only meaningful when assets were in scope of the run.
 * @param {string} fontsDir absolute public/fonts directory
 * @param {{name:string, ext:string}[]} [fonts] defaults to tools/assets/fonts.mjs FONTS
 * @param {(p:string)=>any} [stat]
 * @returns {{ok:boolean, missing:string[]}}
 */
export function fontsStatus(fontsDir, fonts = FONTS, stat = (p) => fs.statSync(p)) {
  const missing = [];
  const has = (name) => { try { const st = stat(path.join(fontsDir, name)); return st.isFile() && st.size > 0; } catch { return false; } };
  for (const f of fonts) {
    if (!has(`${f.name}.${f.ext}`)) missing.push(`${f.name}.${f.ext}`);
    if (!has(`${f.name}.woff2`)) missing.push(`${f.name}.woff2`);
  }
  if (!has('fonts.css')) missing.push('fonts.css');
  return { ok: missing.length === 0, missing };
}

/**
 * The deployment gate: every reason this preparation must exit non-zero. `gaps` is manifestGaps output, `fonts`
 * fontsStatus output (ignored when assets were out of scope).
 * @param {{fetchCode:number, noAssets?:boolean, fonts:{ok:boolean, missing:string[]}, gaps:{missing:string[], missingAtlasPages:string[]}}} o
 * @returns {{ok:boolean, reasons:string[]}}
 */
export function deployGate({ fetchCode, noAssets = false, fonts, gaps }) {
  const reasons = [];
  if (fetchCode !== 0) reasons.push(`fetch-assets 退出码 ${fetchCode}（必需素材缺失或校验失败，见上方与 .cache/assets-report.json）`);
  if (!noAssets) {
    if (!fonts.ok) reasons.push(`字体不完整（${fonts.missing.join(', ')}）→ 重新运行即可续传；一直失败请检查网络（SP_ASSET_SOURCE=mirror 可选镜像）`);
    if (gaps.missing.length) {
      reasons.push(`data/assets.json 声明的 ${gaps.missing.length} 个文件不在盘上（如 ${gaps.missing.slice(0, 3).join(', ')}）→ 重新运行续传`);
    }
    if (gaps.missingAtlasPages.length) {
      reasons.push(`${gaps.missingAtlasPages.length} 个 atlas 声明的贴图页缺失（如 ${gaps.missingAtlasPages.slice(0, 3).join(', ')}）→ 重新运行续传`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------

/** Run a command with inherited stdio; { ok, code } (never throws). */
function run(cmd, args, { shell = false } = {}) {
  let r;
  try { r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell, windowsHide: true }); } catch (e) { return { ok: false, code: -1, error: e }; }
  if (r.error) return { ok: false, code: -1, error: r.error };
  return { ok: r.status === 0, code: r.status ?? -1 };
}

/** `npm <args>` through the running npm when there is one (a `.cmd` shim needs a shell on Windows). */
function npmRunner() {
  const execPath = process.env.npm_execpath;
  if (execPath && /npm-cli\.js$/i.test(execPath) && fs.existsSync(execPath)) return { cmd: process.execPath, pre: [execPath], shell: false };
  return { cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', pre: [], shell: process.platform === 'win32' };
}

function vendorEntries(stat = (p) => fs.statSync(p)) {
  return VENDOR_FILES.map(([src, dst, optional]) => {
    let srcSt = null; let dstSt = null;
    try { srcSt = stat(path.join(ROOT, src)); } catch { /* not installed */ }
    try { dstSt = stat(path.join(ROOT, 'public', 'vendor', dst)); } catch { /* not copied */ }
    return { dst, optional: !!optional, srcExists: !!srcSt, srcMtime: srcSt?.mtimeMs, dstExists: !!dstSt, dstMtime: dstSt?.mtimeMs };
  });
}

/** When the index refresh failed but the cached indexes carried the run: say so, loudly, and stamp it as pending. */
function reportRefreshPending() {
  log(c.warn('[deploy] 上游素材索引刷新未完成（本次准备使用了 .cache 里的缓存索引完成）。'));
  log(c.warn('        新干员/新模型可能要等下次启动重试刷新后才会被计划；这只影响新增内容，不影响已提交清单的完整性。'));
  writeState({ refreshPending: true });
}

/** True while a report-only run (--check) is on the wire: such a run writes nothing, ready stamp included. */
let reportOnly = process.argv.slice(2).some((arg) => ['--check', '--help', '-h'].includes(arg));

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); return 2; }
  if (opts.help) {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
    const start = src.findIndex((l) => l.startsWith('//   node tools/deploy.mjs'));
    const end = src.findIndex((l, i) => i > start && l.startsWith('// Exit code'));
    console.log(src.slice(start, end + 1).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return 0;
  }
  const say = (m) => { if (!opts.quiet) log(m); };
  const state = readState();
  reportOnly = opts.check;
  // An interrupted preparation must not retain the previous run's ready stamp.
  if (!reportOnly) writeState({ ready: false });

  // 1. Node
  const node = checkNode();
  if (!node.ok) { log(`${mark.err} ${node.message}`); return 1; }
  say(`${mark.ok} Node.js v${process.versions.node}`);

  // --check: report only, change nothing — no preparation step, no state write, however it exits. A row is a ✘
  // only when a gate would fail; "what the next start would do" (npm ci / vendor refresh / index refresh) is
  // informational.
  if (opts.check) {
    reportOnly = true;
    const deps = prodDepsMissing(path.join(ROOT, 'node_modules'), prodDependencyNames(readJson(path.join(ROOT, 'package.json'))));
    const lockHash = fileSha256(PACKAGE_LOCK);
    const depsWanted = depsNeedInstall({ missing: deps.length, lockHash, state, hasNodeModules: fs.existsSync(path.join(ROOT, 'node_modules')) });
    const entries = vendorEntries();
    const stale = staleVendorFiles(entries);
    const vendorHash = fileSha256(VENDOR_TOOL);
    const vneed = vendorNeedsRun({ stale, state, vendorHash });
    const vendorMissing = VENDOR_REQUIRED.filter((f) => !fs.existsSync(path.join(ROOT, 'public', 'vendor', f)));
    const shared = await ensureSharedDirs({ assetsDir: ASSETS_DIR, fontsDir: FONTS_DIR, mutate: false });
    const manifest = readJson(MANIFEST);
    const gaps = manifest ? await manifestGaps(manifest, path.join(ROOT, 'public')) : { missing: [], missingAtlasPages: [] };
    const fonts = opts.noAssets ? { ok: true, missing: [] } : fontsStatus(FONTS_DIR);
    const refresh = refreshPlan(opts);
    const lines = [
      ['Node.js', `v${process.versions.node}`, true, true],
      ['生产依赖 node_modules', deps.length ? `缺少 ${deps.join(', ')} → npm ci 会补齐` : '完整', deps.length === 0, true],
      ['依赖安装', depsWanted.needed ? `下次启动将 npm ci（${depsWanted.why}）` : '无需重装', true, false],
      ['前端库 public/vendor', vendorMissing.length ? `缺少 ${vendorMissing.join(', ')} → vendor 会补齐`
        : vneed.needed ? '下次启动将刷新' : '最新', vendorMissing.length === 0, true],
      ['共享素材目录', Object.entries(shared.states).map(([k, v]) => `${k}=${v}`).join(' ') || '（首次运行时创建）', shared.ok, true],
      ['素材清单 data/assets.json', manifest ? (gaps.missing.length || gaps.missingAtlasPages.length
        ? `缺 ${gaps.missing.length} 个文件 / ${gaps.missingAtlasPages.length} 个贴图页 → 启动时补下载`
        : `完整（${manifestUrls(manifest).length} 个引用）`) : '不可读', !!manifest && !gaps.missing.length && !gaps.missingAtlasPages.length, true],
      ['字体 public/fonts', fonts.ok ? '完整' : `缺 ${fonts.missing.join(', ')} → 启动时补下载`, fonts.ok, true],
      ['索引刷新', refresh ? '下次启动将刷新（--refresh-index）' : '不需要', true, false],
    ];
    const width = Math.max(...lines.map(([, label]) => label.length)) + 2;
    for (const [label, detail, ok, gate] of lines) log(`${ok ? mark.ok : mark.err} ${label.padEnd(width)}${c.dim(detail)}${gate ? '' : c.dim('（信息）')}`);
    const ok = lines.every(([, , rowOk, gate]) => !gate || rowOk);
    log(ok ? '\n可以启动：bash start.sh' : '\n尚未就绪：上面的 ✘ 会在下次 bash start.sh 时自动修复（网络问题除外）。');
    return ok ? 0 : 1;
  }

  // 2. Production dependencies: npm ci only, no npm install fallback (the tracked lockfile must not be touched).
  const pkg = readJson(path.join(ROOT, 'package.json'));
  const deps = prodDepsMissing(path.join(ROOT, 'node_modules'), prodDependencyNames(pkg));
  const lockHash = fileSha256(PACKAGE_LOCK);
  const want = depsNeedInstall({ missing: deps.length, lockHash, state, hasNodeModules: fs.existsSync(path.join(ROOT, 'node_modules')) });
  if (want.needed) {
    say(`\n${c.cyan('▶')} 安装生产依赖（npm ci：${want.why}）…`);
    const npm = npmRunner();
    const r = run(npm.cmd, [...npm.pre, 'ci', '--no-audit', '--no-fund'], { shell: npm.shell });
    if (!r.ok) {
      log(`${mark.err} npm ci 失败（退出码 ${r.code}）。部署不回退到 npm install（那会改写 package-lock.json）；请解决后重试（常见原因：Node 版本、registry 不可达）。`);
      return 1;
    }
    const still = prodDepsMissing(path.join(ROOT, 'node_modules'), prodDependencyNames(pkg));
    if (still.length) { log(`${mark.err} npm ci 后仍缺依赖：${still.join(', ')}`); return 1; }
    writeState({ lockHash });
    say(`${mark.ok} 依赖已安装`);
  } else {
    say(`${mark.ok} 生产依赖 node_modules 完整`);
  }

  // 3. Vendor libraries: refresh when a copy is missing/stale or the tool itself changed.
  const vendorHash = fileSha256(VENDOR_TOOL);
  const stale = staleVendorFiles(vendorEntries());
  const vneed = vendorNeedsRun({ stale, state, vendorHash });
  if (vneed.needed) {
    say(`${c.cyan('▶')} 刷新前端库 public/vendor（${vneed.why}）…`);
    const r = run(process.execPath, [VENDOR_TOOL]);
    if (!r.ok) { log(`${mark.err} tools/vendor.mjs 失败（退出码 ${r.code}）。`); return 1; }
    const missingAfter = VENDOR_REQUIRED.filter((f) => !fs.existsSync(path.join(ROOT, 'public', 'vendor', f)));
    if (missingAfter.length) { log(`${mark.err} public/vendor 缺少 ${missingAfter.join(', ')}（npm ci 后 public/vendor 应由 vendor 重建）。`); return 1; }
    writeState({ vendorHash });
    say(`${mark.ok} 前端库已刷新`);
  } else {
    say(`${mark.ok} 前端库 public/vendor 最新`);
  }

  // 4. Shared asset roots: follow symlinks, never replace them.
  const shared = await ensureSharedDirs({ assetsDir: ASSETS_DIR, fontsDir: FONTS_DIR });
  if (!shared.ok) { for (const e of shared.errors) log(`${mark.err} ${e}`); return 1; }
  say(`${mark.ok} 素材目录 ${Object.entries(shared.states).map(([k, v]) => `${k}: ${v}`).join(' · ') || '（由下载步骤创建）'}`);

  // 5. Art / audio / fonts.
  let fetchCode = 0;
  let refreshPending = false;
  if (opts.noAssets) {
    say(`${mark.skip} 素材下载已跳过（--no-assets）`);
  } else {
    const refresh = refreshPlan(opts);
    const base = buildFetchArgs(opts, refresh);
    say(`\n${c.cyan('▶')} 补全美术与音频（node tools/fetch-assets.mjs ${base.join(' ')}）…`);
    let r = run(process.execPath, [FETCH_ASSETS, ...base]);
    if (r.code !== 0 && refresh && cachedIndexesReady()) {
      // The refresh failed; the cached indexes may still carry a complete run. Retry without --refresh-index and
      // report the pending refresh honestly — never as a success.
      log(c.warn('[deploy] 索引刷新失败，改用缓存索引重试 …'));
      r = run(process.execPath, [FETCH_ASSETS, ...buildFetchArgs(opts, false)]);
      refreshPending = r.code === 0;
    }
    fetchCode = r.code;
    // 5b. Skin avatars: data/assets.json declares them (tools/inject-skins-assets.mjs) but the fetch-assets plan does
    // not cover them; tools/fetch-skin-avatars.mjs downloads only the missing ones (existing files are kept).
    if (!opts.offline) {
      const m = readJson(MANIFEST);
      const missingSkins = m ? skinAvatarGaps((await manifestGaps(m, path.join(ROOT, 'public'))).missing) : [];
      if (missingSkins.length) {
        say(`\n${c.cyan('▶')} 补全皮肤头像（${missingSkins.length} 个，node tools/fetch-skin-avatars.mjs）…`);
        run(process.execPath, [FETCH_SKIN_AVATARS]);
      }
    }
  }

  // 6. Gates.
  const manifest = readJson(MANIFEST);
  if (!manifest && !opts.noAssets) {
    log(`${mark.err} data/assets.json 不可读（素材清单缺失或损坏）→ git checkout -- data/assets.json 后重试。`);
    return 1;
  }
  const gaps = opts.noAssets ? { missing: [], missingAtlasPages: [] } : await manifestGaps(manifest, path.join(ROOT, 'public'));
  const fonts = opts.noAssets ? { ok: true, missing: [] } : fontsStatus(FONTS_DIR);
  const gate = deployGate({ fetchCode, noAssets: opts.noAssets, fonts, gaps });
  if (!gate.ok) {
    for (const reason of gate.reasons) log(`${mark.err} ${reason}`);
    log(c.err('部署未就绪。可选镜像素材缺失时游戏仍可用占位/替代资源——上面列出的是必需项。'));
    return 1;
  }
  if (refreshPending) reportRefreshPending();
  else if (state.refreshPending) writeState({ refreshPending: false });

  // Stamp: only a fully successful preparation leaves `ready` true (the wrapper below clears it on every failure).
  writeState({
    manifestSha256: fileSha256(MANIFEST),
    refreshPending,
    ready: true,
    readyAt: new Date().toISOString(),
  });
  say(`${mark.ok} 部署准备完成${opts.noAssets ? '（--no-assets：未检查素材与字体）' : '：素材、清单与字体齐全'}`);
  return 0;
}

/** Index refresh TTL: SP_DEPLOY_INDEX_TTL_HOURS, default 24. */
function indexTtlHours(env = process.env) {
  const n = Number(env.SP_DEPLOY_INDEX_TTL_HOURS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INDEX_TTL_HOURS;
}

/** The cached upstream indexes' { mtime, size } (null entries when a file is missing). */
function currentIndexStats() {
  return INDEX_FILES.map((p) => { try { const s = fs.statSync(p); return { mtime: s.mtimeMs, size: s.size }; } catch { return null; } });
}

/** All data/*.json mtimes (game data a pull may have renewed after the indexes were fetched). */
function dataMtimes() {
  try {
    return fs.readdirSync(path.join(ROOT, 'data')).filter((f) => f.endsWith('.json'))
      .map((f) => { try { return fs.statSync(path.join(ROOT, 'data', f)).mtimeMs; } catch { return 0; } });
  } catch { return []; }
}

/** Does this run refresh the upstream indexes (--refresh-index, env, TTL, or newer game data)? */
function refreshPlan(opts, env = process.env) {
  if (opts.noRefreshIndex || opts.offline) return false;
  return opts.refreshIndex || env.SP_DEPLOY_REFRESH_INDEX === '1'
    || indexRefreshNeeded({ indexStats: currentIndexStats(), dataMtimes: dataMtimes(), ttlHours: indexTtlHours(env), now: Date.now() });
}

function isMain() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) {
  // Every real failure — a failed gate, npm ci, a usage error, a thrown error — clears the ready stamp. A
  // report-only --check is exempt: it never writes, not even on failure.
  const notReady = () => { if (!reportOnly) writeState({ ready: false, lastFailure: new Date().toISOString() }); };
  main().then((code) => {
    if (code !== 0) notReady();
    process.exitCode = code;
  }, (e) => {
    console.error(`${mark.err} deploy 出错：${e?.stack || e}`);
    notReady();
    process.exitCode = 1;
  });
}
