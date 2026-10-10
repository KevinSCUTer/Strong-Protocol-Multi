#!/usr/bin/env node
// scripts/make-linux-bundle.mjs — 打一份 Linux「懒人包」：解压 → bash start.sh（默认端口 3325）。
//
//   node scripts/make-linux-bundle.mjs [--out <dir>] [--arch x64|arm64|both] [--no-node] [--no-archive] [--force]
//
// 产物目录（默认 <仓库的上一级>/Stronghold-Protocol-Linux/，并同时打成旁边的 .tar.gz）：
//   start.sh                  入口：选对架构的内置 node → app/scripts/launch.mjs --no-setup（默认 PORT=3325）
//   node/linux-x64/…          官方 Linux x64 完整发行版（版本与 sha256 钉在下面的 NODE_PINS，含 npm）
//   node/linux-arm64/…        官方 Linux arm64 完整发行版（树莓派 / ARM 云主机）
//   app/                      游戏本体：git 跟踪的文件 + 生产依赖 + 全部素材，离线可玩
//   README-懒人包.md          给玩家看的说明（含非官方 / 严禁盈利 / 素材版权声明）
//   LICENSE / NOTICE.md / THIRD-PARTY-NOTICES.md
//
// 目标机器什么都不用装：tar xzf 解压 → bash start.sh → http://<机器地址>:3325。素材与依赖都在包里。
//
// 三条硬规则与 make-windows-bundle.mjs 相同（都是踩过的坑，那里的纯函数测试 test/windows-bundle.test.js
// 同样覆盖这几份共享实现）：
//   1. app/ 的文件清单来自 `git ls-files`，不是手写的跳过表 —— `.env` / `.venv` / `.claude` 这些本机文件
//      被 .gitignore 挡在版本库外，因此天然进不了发行包。
//   2. node_modules 用 `npm ci --omit=dev` 重新装一遍，不带 devDependency（puppeteer-core 之类）。
//   3. Node **每次都从校验过 sha256 的官方 tar.gz 重新解压**：下载的包缓进仓库的 .cache/，解压目录是
//      新建的临时目录、用完即删。缓存的下载包与解压结果没有对应关系，残缺的解压产物绝不能进包。
//
// 换 Node 版本：改 NODE_PINS（两个架构一起换，sha256 取自官方 SHASUMS256.txt）。这里不提供
// --node-version 覆盖：一次打包带两个架构，覆盖参数说不清是哪一个的哈希，改常量更不容易错。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// 共享的纯函数（--out 安全检查、整树 / 按清单复制）与 Windows 便携包保持同一条实现。
import { copyDir, copyFiles, outDirIsUnsafe } from './make-windows-bundle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MB = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

/** 官方 Node tar.gz 的下载缓存（不进版本库）。放仓库下而不是系统临时目录：后者是共享的，中断留下的残片会混进来。 */
const NODE_CACHE_DIR = path.join(ROOT, '.cache');

/**
 * 便携版 Node：版本与 sha256 **钉死在仓库里**，运行时只认这份常量（与 make-windows-bundle.mjs 的
 * NODE_PIN 同一个 v22.23.3）。不用 `latest-v22.x`：那样今天打的包和上个月打的包内容不同；校验哈希
 * 也不能运行时去 nodejs.org 现抓 —— 那等于把「发出去的二进制是什么」交给当时的网络应答决定。
 * 换版本请改这里（两个架构一起，sha256 取自 https://nodejs.org/dist/<版本>/SHASUMS256.txt）。
 */
const NODE_PINS = Object.freeze([
  Object.freeze({
    arch: 'linux-x64',
    file: 'node-v22.23.3-linux-x64.tar.gz',
    sha256: '1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af',
  }),
  Object.freeze({
    arch: 'linux-arm64',
    file: 'node-v22.23.3-linux-arm64.tar.gz',
    sha256: '5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2',
  }),
]);

/** 这几份不进版本库（npm / tools/setup.mjs 生成），但必须进包，否则游戏缺素材或缺前端库。 */
const ASSET_DIRS = ['public/assets', 'public/fonts', 'public/vendor'];

/** 版本库里有、但懒人包不要的（测试代码，省体积）。 */
const SKIP_TRACKED = ['test/'];

/** 包根要带的许可证 / 声明。 */
const LEGAL_FILES = ['LICENSE', 'NOTICE.md', 'THIRD-PARTY-NOTICES.md'];

/**
 * 本机从游戏文件里提取出来的 3D 棋盘贴图清单（不进版本库）。
 * `public/assets/local` 会随 `public/assets` 一起进包，但游戏是**靠这份 JSON** 才知道哪些贴图可用 ——
 * 只带贴图不带清单，玩家拿到的是用不上的文件。它存在时就一起收。
 */
const LOCAL_ASSET_MANIFEST = path.join('data', 'local-assets.json');

/** 上一次打的懒人包长这样：包根有这份说明、入口脚本，还有一个 app/ 目录。 */
const BUNDLE_MARKERS = Object.freeze(['README-懒人包.md', 'start.sh', 'app']);

function parseArgs(argv) {
  const o = { out: '', arch: 'both', node: true, archive: true, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [k, v] = a.split('=');
    const val = () => (v !== undefined ? v : argv[++i]);
    if (k === '--out') o.out = String(val() || '');
    else if (k === '--arch') o.arch = String(val() || '');
    else if (a === '--no-node') o.node = false;
    else if (a === '--no-archive') o.archive = false;
    else if (a === '--force') o.force = true;
    else if (a === '-h' || a === '--help') o.help = true;
  }
  return o;
}

const HELP = `node scripts/make-linux-bundle.mjs — 生成 Linux 懒人包（解压 → bash start.sh，端口 3325）

  --out <dir>        产物目录（默认 <仓库上一级>/Stronghold-Protocol-Linux；tar.gz 打在它旁边）
  --arch <…>         内置哪些架构的 Node：x64 / arm64 / both（默认 both）
  --no-node          不内置 Node（目标机器需自备 Node 22+；Alpine 等 musl 系统只能用这个）
  --no-archive       只产出目录，不打 tar.gz
  --force            目录已存在时先删掉（只肯删空目录，或上一次打的懒人包；其余情况拒绝）

  app/ 里只放 git 跟踪的文件 + 生产依赖（npm ci --omit=dev）+ public/{assets,fonts,vendor}；
  因此 .env / .venv / .claude 这些本机文件不会被打进去。data/local-assets.json 存在时
  （本机提取过 3D 棋盘贴图）会一起收，否则贴图进了包也用不上。
  包内 start.sh 固定以 app/scripts/launch.mjs --no-setup 启动（素材已在包里，不需要联网准备），
  默认 PORT=3325；可用环境变量覆盖：PORT=8080 bash start.sh。
`;

/**
 * `--force` 允不允许删掉这个目录？与 make-windows-bundle 的 forceDeleteVerdict 同一条规则，
 * 只是包根标记换成懒人包自己的（README-懒人包.md + start.sh + app/）。
 * @param {string} dir
 * @returns {'missing' | 'empty' | 'bundle' | 'refuse'}
 */
export function linuxForceDeleteVerdict(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return e?.code === 'ENOENT' ? 'missing' : 'refuse';
  }
  if (entries.length === 0) return 'empty';
  const app = entries.find((e) => e.name === 'app');
  const looksLikeBundle = BUNDLE_MARKERS.every((n) => entries.some((e) => e.name === n))
    && !!app && (app.isDirectory() || app.isSymbolicLink());
  return looksLikeBundle ? 'bundle' : 'refuse';
}

/**
 * 版本库里跟踪的文件（仓库相对路径，posix 分隔符，NUL 分隔读取以免中文 / 空格文件名被 git 转义）。
 * @returns {string[]}
 */
function trackedFiles() {
  const r = spawnSync('git', ['-C', ROOT, 'ls-files', '-z'], { maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    throw new Error('git ls-files 失败：打包只收版本库里跟踪的文件，请在完整的 git 仓库里运行');
  }
  return r.stdout.toString('utf8').split('\0').filter(Boolean);
}

/**
 * 只装生产依赖，装到 app/node_modules。
 *
 * 在临时目录里 `npm ci --omit=dev` 再搬过来：既拿到干净的生产依赖（不带 puppeteer-core 这类
 * devDependency），又不会动本仓库自己的 node_modules。依赖全是纯 JS（htm / pixi / preact /
 * three / ws），在 macOS 上装出的 node_modules 到 Linux 照常工作。
 */
async function installProductionDeps(appDir) {
  const stage = path.join(appDir, '.deps-stage');
  await fsp.rm(stage, { recursive: true, force: true });
  await fsp.mkdir(stage, { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src)) throw new Error(`缺少 ${f}：无法安装生产依赖`);
    await fsp.copyFile(src, path.join(stage, f));
  }
  console.log('  · 安装生产依赖 npm ci --omit=dev（稍等）…');
  const r = spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit' });
  if (r.error || r.status !== 0) throw new Error('npm ci --omit=dev 失败（懒人包需要生产依赖，请先联网）');
  await fsp.rm(path.join(appDir, 'node_modules'), { recursive: true, force: true });
  await fsp.rename(path.join(stage, 'node_modules'), path.join(appDir, 'node_modules'));
  await fsp.rm(stage, { recursive: true, force: true });
}

/**
 * 确保官方 tar.gz 在仓库的 .cache/ 里，且 sha256 与仓库里钉死的一致。
 * @param {{arch: string, file: string, sha256: string}} pin
 * @returns {Promise<string>} tar 包的绝对路径
 */
async function ensureNodeTarball(pin) {
  const tarPath = path.join(NODE_CACHE_DIR, pin.file);

  if (fs.existsSync(tarPath)) {
    const h = crypto.createHash('sha256').update(await fsp.readFile(tarPath)).digest('hex');
    if (h === pin.sha256) return tarPath;
    console.log(`  · ${path.relative(ROOT, tarPath)} 校验失败，重新下载`);
  }

  const url = `https://nodejs.org/dist/${pin.file.replace(/^node-v([\d.]+)-.*$/, 'v$1')}/${pin.file}`;
  console.log(`  · 下载 ${url}（约 50 MB）`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (got !== pin.sha256) throw new Error(`${pin.file} sha256 不匹配：\n    期望 ${pin.sha256}\n    实际 ${got}`);
  await fsp.mkdir(NODE_CACHE_DIR, { recursive: true });
  await fsp.writeFile(tarPath, buf);
  return tarPath;
}

/**
 * 便携版 Node：从**校验过的** tar.gz 解出完整发行版（含 npm）。
 *
 * 每次都新建一个临时目录重新解压，绝不复用上一次的解压结果 —— 缓存的是 tar 包，不是解压产物：
 * 解压中断留下的残缺目录与 tar 包没有任何对应关系，直接搬就会把坏文件发出去。
 * @param {string} bundleNodeDir
 * @param {{arch: string, file: string, sha256: string}} pin
 * @param {string} tarPath 已校验 sha256 的官方 tar.gz（ensureNodeTarball 的返回值）
 */
async function extractBundledNode(bundleNodeDir, pin, tarPath) {
  const rootName = pin.file.replace(/\.tar\.gz$/, '');   // 官方 tar.gz 的固定顶层目录名
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), `sp-node-${pin.arch}-`));
  try {
    const r = spawnSync('tar', ['-xzf', tarPath, '-C', tmp], { stdio: 'ignore' });
    if (r.error || r.status !== 0) throw new Error(`解压 ${pin.file} 失败：需要 tar（macOS / Linux 自带）`);
    const srcRoot = path.join(tmp, rootName);
    if (!fs.existsSync(path.join(srcRoot, 'bin', 'node'))) throw new Error(`解压后没找到 bin/node：${srcRoot}`);
    // 发出去的二进制必须带它自己的许可证 —— 官方发行版根目录就有，整目录搬运时一起带走。
    if (!fs.existsSync(path.join(srcRoot, 'LICENSE'))) throw new Error(`官方发行版里没有 LICENSE：${srcRoot}`);
    const dst = path.join(bundleNodeDir, pin.arch);
    await fsp.rm(dst, { recursive: true, force: true });
    await fsp.mkdir(bundleNodeDir, { recursive: true });
    // verbatimSymlinks:true 原样复制链接文本（bin/npm → ../lib/...）：默认的 false 会把相对目标解析成
    // 打包机上的绝对路径，搬进包里就是断链（链接指向解包时的临时目录）。
    fs.cpSync(srcRoot, dst, { recursive: true, verbatimSymlinks: true });
    for (const b of ['node', 'npm', 'npx', 'corepack']) {
      try { await fsp.chmod(path.join(dst, 'bin', b), 0o755); } catch { /* 没有该项就算了 */ }
    }
    const nodeBin = path.join(dst, 'bin', 'node');
    return { arch: pin.arch, bytes: (await fsp.stat(nodeBin)).size };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

/**
 * 包内的 start.sh（入口脚本）。
 *
 * 选内置 node：按 `uname -m` 挑架构 → 试跑 `-v`（musl 的 Alpine 跑不动 glibc 版、或目录不完整都会在这里
 * 失败）→ 失败就退回系统的 node。端口默认 3325（环境变量可覆盖），无显示器环境默认不开浏览器。
 * @returns {string}
 */
export function startScript() {
  return `#!/usr/bin/env bash
# 卫戍协议：盟约 · Linux 懒人包启动脚本。解压后在本目录执行：bash start.sh
# 默认端口 3325（改端口：PORT=8080 bash start.sh，或 bash start.sh --port 8080）。
# 内置 Node（linux-x64 / linux-arm64）优先；跑不起来（musl 系统 / 架构不符）就退回系统的 Node 22+。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

export PORT="\${PORT:-3325}"
export HOST="\${HOST:-0.0.0.0}"
# 服务器 / 容器一般没有显示器：默认不自动开浏览器（想要就 SP_NO_BROWSER=0 bash start.sh）。
export SP_NO_BROWSER="\${SP_NO_BROWSER:-1}"

MACH="$(uname -m)"
case "$MACH" in
  x86_64|amd64)   BUNDLED="$HERE/node/linux-x64/bin/node" ;;
  aarch64|arm64)  BUNDLED="$HERE/node/linux-arm64/bin/node" ;;
  *)              BUNDLED="" ;;
esac

NODE=""
if [ -n "$BUNDLED" ] && [ -x "$BUNDLED" ] && "$BUNDLED" -v >/dev/null 2>&1; then
  NODE="$BUNDLED"
else
  if [ -n "$BUNDLED" ]; then
    echo "! 内置 Node 在这台机器上跑不起来（musl 的 Alpine？glibc 太旧？），改用系统的 node。" >&2
  elif [ -z "$BUNDLED" ]; then
    echo "! 未知架构 $MACH：没有内置 Node 可用，改用系统的 node。" >&2
  fi
fi
if [ -z "$NODE" ]; then
  command -v node >/dev/null 2>&1 || { echo "✖ 找不到可用的 Node.js：Alpine（musl）请先安装 Node 22+（apk add nodejs npm）" >&2; exit 1; }
  NODE="$(command -v node)"
fi
if [ "$("$NODE" -p 'Number(process.versions.node.split(".")[0])')" -lt 22 ]; then
  echo "✖ Node.js $("$NODE" -v) 太旧，需要 22 或更高（22 / 24 LTS）。" >&2
  exit 1
fi

# 依赖被删过（或解压时丢了）就补装一次；正常情况下懒人包自带 app/node_modules，直接跳过。
if [ ! -f "$HERE/app/node_modules/ws/package.json" ]; then
  echo "[首次运行] app/node_modules 缺失，正在补装生产依赖 npm ci --omit=dev …"
  NPM_CLI=""
  for d in linux-x64 linux-arm64; do
    if [ -f "$HERE/node/$d/lib/node_modules/npm/bin/npm-cli.js" ]; then NPM_CLI="$HERE/node/$d/lib/node_modules/npm/bin/npm-cli.js"; break; fi
  done
  if [ -n "$NPM_CLI" ]; then
    (cd "$HERE/app" && "$NODE" "$NPM_CLI" ci --omit=dev --ignore-scripts --no-audit --no-fund)
  else
    command -v npm >/dev/null 2>&1 || { echo "✖ 找不到 npm：请安装 Node.js 22+ 后重试" >&2; exit 1; }
    (cd "$HERE/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
  fi
fi

exec "$NODE" "$HERE/app/scripts/launch.mjs" --no-setup "$@"
`;
}

/**
 * 包内说明。带不带内置 Node、内置了哪些架构，会影响「是否需要装 Node」和目录结构两处措辞。
 * @param {{version: string, arches: string[], withNode: boolean}} p
 * @returns {string}
 */
export function bundleReadme({ version, arches, withNode }) {
  const nodePaths = arches.map((a) => `\`node/${a}/bin/node\``).join('、');
  const nodeNeed = withNode
    ? `目标机器**不需要安装 Node**：包内的 ${nodePaths} 就是官方便携版 Node ${version}（Alpine 等 musl 系统跑不动 glibc 版，start.sh 会自动退回系统的 Node 22+）。`
    : '这个包**没有内置 Node**，请先在这台机器上安装 Node 22 或 24（LTS）。';
  const nodeTree = withNode
    ? `\nnode/                             内置的官方 Node ${version}${arches.map((a) => `\n  ${a}/`).join('')}`
    : '\n（没有 node/ 这一层：本包不内置 Node，请自行安装 Node 22/24 LTS）';
  const tree = `start.sh                          入口：bash start.sh（默认端口 3325）
app/                              游戏本体：server / shared / public（全部素材）/ data / scripts / tools${nodeTree}
README-懒人包.md                  本文件
LICENSE / NOTICE.md / THIRD-PARTY-NOTICES.md`;

  return `# 卫戍协议：盟约 · Linux 懒人包

\`\`\`bash
tar xzf Stronghold-Protocol-Linux-*.tar.gz
cd Stronghold-Protocol-Linux
bash start.sh
\`\`\`

然后浏览器打开 **http://<这台机器的地址>:3325**（本机就是 http://localhost:3325）。
素材、前端库、生产依赖、Node 全在包里，**不需要再下载任何东西，也不需要在目标机器上装 Node**。
${nodeNeed}

**不联网也能玩**：美术 / 音频 / 依赖 / 字体全部在包内，断网时用自带的 \`app/public/fonts\`
（Bender / Novecento Wide）和系统黑体，玩法不受影响。**联网时**页面还会去 Google Fonts 加载
Noto Sans SC 这类网页字体（\`index.html\` 里那条外链这次没有改，它也不阻塞渲染），
只是让中文更接近原版观感 —— 断网不会因此卡住或报错。

## 常用操作

\`\`\`bash
bash start.sh                    # 开服（前台运行，Ctrl+C 停止）
PORT=8080 bash start.sh          # 换端口
bash start.sh --port 8080        # 同上（参数会透传给启动器）
HOST=127.0.0.1 bash start.sh     # 只监听本机（放在反向代理后面时）
SP_NO_BROWSER=0 bash start.sh    # 有桌面环境时，自动打开浏览器
\`\`\`

防火墙放行（否则朋友连不上）：

\`\`\`bash
sudo ufw allow 3325/tcp           # Ubuntu / Debian（ufw）
sudo firewall-cmd --permanent --add-port=3325/tcp && sudo firewall-cmd --reload   # RHEL / CentOS（firewalld）
\`\`\`

想开机常驻：用 systemd，见仓库 docs/DEPLOY.md 的「macOS / Linux 常驻」一节
（\`WorkingDirectory\` 指向包里的 \`app/\`，\`ExecStart\` 用 \`node/bin/<架构>/bin/node server/index.js\`）。

## 声明

> [!IMPORTANT]
> - 本项目是玩家自制的**非官方同人作品**，与上海鹰角网络科技有限公司（Hypergryph）、Yostar 及其关联方**没有任何关系**，未获其授权或认可。
> - 《明日方舟》及「卫戍协议」相关的名称、角色、美术、音乐、音效、文本与数据等素材，版权归原权利人所有。这些素材**不适用**本项目的 GPL-3.0 许可证；GPL 只覆盖本项目自己编写的代码。
> - 仅供学习交流与个人非商业使用。**严禁任何形式的盈利**，包括但不限于：售卖本项目或整合包、付费下载或付费分发、收费服务器或收费代开、广告 / 打赏 / 会员等变现方式，以及其他任何商业用途。
> - 本包为了方便玩家附带了游戏的美术与音频素材，下载即视为同意本声明。请勿将素材用于本项目以外的用途或**单独再分发**。完整条款见 [NOTICE.md](NOTICE.md)。
> - 权利人如认为本项目侵犯其权益，请通过 Issue 联系，我们会**立即删除**相关内容。
> - 本项目按「现状」提供，**不提供任何担保**，使用风险自负。

包内 [LICENSE](LICENSE) 里的 GPL-3.0-or-later 覆盖的是**本项目自己编写的代码**；内置 Node.js（MIT）以及
其它第三方组件的许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)${withNode ? '（Node 自己的许可证在 `node/<架构>/LICENSE`）' : ''}。

## 怎么玩

\`\`\`
本机当服务器   bash start.sh：在这台机器开服，控制台会打印「发给朋友」的
               局域网地址（形如 http://192.168.1.23:3325）
连别人的服务器 不需要这个包，直接用浏览器打开对方的网址就行
\`\`\`

建房后把 4 位「同盟密钥」或「复制链接」（\`…/?room=密钥\`）发给朋友即可。

## 目录结构

\`\`\`
${tree}
\`\`\`

卸载＝直接删掉整个文件夹（不写任何系统目录）。存档 / 昵称在各人浏览器的 localStorage 里。
`;
}

async function dirSize(dir) {
  let bytes = 0; let files = 0;
  const walk = async (d) => {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) { files++; try { bytes += (await fsp.stat(p)).size; } catch { /* ignore */ } }
    }
  };
  await walk(dir);
  return { bytes, files };
}

/** 把产物目录打成旁边的 Stronghold-Protocol-Linux-v<版本>.tar.gz（tar 自带，权限 / 符号链接原样保留）。 */
function tarFolder(outDir, archivePath) {
  const parent = path.dirname(outDir);
  const name = path.basename(outDir);
  const r = spawnSync('tar', ['-czf', archivePath, '-C', parent, name], { stdio: 'inherit' });
  if (r.error || r.status !== 0 || !fs.existsSync(archivePath)) {
    throw new Error('打 tar.gz 失败：需要 tar（macOS / Linux 自带）');
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return 0; }
  if (!['both', 'x64', 'arm64'].includes(o.arch)) {
    console.error(`✖ --arch 只认 x64 / arm64 / both，收到的是 ${o.arch}`);
    return 1;
  }
  const pins = NODE_PINS.filter((p) => o.arch === 'both'
    || (o.arch === 'x64' && p.arch === 'linux-x64') || (o.arch === 'arm64' && p.arch === 'linux-arm64'));
  const out = path.resolve(o.out || path.join(path.dirname(ROOT), 'Stronghold-Protocol-Linux'));
  const appDir = path.join(out, 'app');
  const nodeDir = path.join(out, 'node');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const archivePath = path.join(path.dirname(out), `Stronghold-Protocol-Linux-v${pkg.version}.tar.gz`);

  console.log(`\n卫戍协议 · Linux 懒人包\n  源仓库：${ROOT}\n  产物：  ${out}\n`);

  // --out 指到仓库本身 / 上级目录时直接拒绝（与 Windows 便携包同一条检查）；--force 只肯删「空目录」或「上一次打的包」。
  if (outDirIsUnsafe(out)) {
    console.error(`✖ --out 指向仓库本身或它的上级目录：${out}\n  加 --force 会把仓库删掉，请换一个仓库之外的目录（例如 /opt/Stronghold-Protocol-Linux）。`);
    return 1;
  }
  const verdict = linuxForceDeleteVerdict(out);
  if (verdict !== 'missing') {
    if (!o.force) {
      console.error(`✖ ${out} 已存在。要覆盖请加 --force —— 它只会删掉空目录，或上一次打的懒人包，其余情况一律拒绝。`);
      return 1;
    }
    if (verdict === 'refuse') {
      console.error(`✖ ${out} 已存在，但它既不是空目录，也不像上一次打的懒人包（包根要有 README-懒人包.md、start.sh 和 app/）。`
        + '\n  为免误删，这里不会动它：请自己确认后删掉，或换一个 --out。');
      return 1;
    }
    await fsp.rm(out, { recursive: true, force: true });
    console.log(`  · 清掉 ${out}（${verdict === 'empty' ? '空目录' : '上一次的懒人包'}）`);
  }
  if (o.archive && fs.existsSync(archivePath)) {
    if (!o.force) { console.error(`✖ ${archivePath} 已存在（--force 替换）`); return 1; }
    await fsp.rm(archivePath, { force: true });
  }
  await fsp.mkdir(out, { recursive: true });

  // 1) 游戏代码：只收 git 跟踪的文件
  const all = trackedFiles();
  const wanted = all.filter((rel) => !SKIP_TRACKED.some((p) => rel === p || rel.startsWith(p)));
  console.log(`  · 复制游戏本体（git 跟踪的 ${wanted.length} 个文件，略过 ${all.length - wanted.length} 个 test/ 文件）…`);
  const copied = await copyFiles(wanted, appDir);
  console.log(`    完成：${copied.files} 个文件 / ${MB(copied.bytes)}`);

  // 2) 素材与前端库（不进版本库，必须存在）
  for (const d of ASSET_DIRS) {
    if (!fs.existsSync(path.join(ROOT, d))) {
      throw new Error(`缺少 ${d} —— 先运行 node tools/setup.mjs 把素材 / 前端库准备好`);
    }
  }
  console.log(`  · 复制素材与前端库（${ASSET_DIRS.join('、')}）…`);
  let assetFiles = 0; let assetBytes = 0;
  for (const d of ASSET_DIRS) {
    const s = await copyDir(path.join(ROOT, d), path.join(appDir, d));
    assetFiles += s.files; assetBytes += s.bytes;
  }
  console.log(`    完成：${assetFiles} 个文件 / ${MB(assetBytes)}`);

  // 2b) 3D 棋盘贴图的清单（本机提取过才有）：贴图在 public/assets/local 里，靠这份 JSON 才会被游戏采用。
  const localManifest = path.join(ROOT, LOCAL_ASSET_MANIFEST);
  if (fs.existsSync(localManifest)) {
    await fsp.copyFile(localManifest, path.join(appDir, LOCAL_ASSET_MANIFEST));
    console.log(`    带上 ${LOCAL_ASSET_MANIFEST}（3D 棋盘贴图的清单，贴图本体在 public/assets/local）`);
  }

  // 3) 生产依赖
  await installProductionDeps(appDir);
  const deps = await dirSize(path.join(appDir, 'node_modules'));
  console.log(`    完成：${deps.files} 个文件 / ${MB(deps.bytes)}（只含生产依赖）`);

  // 4) 内置 Node（每次都从校验过的 tar.gz 重新解压）
  let nodeInfo = [];
  if (o.node) {
    for (const pin of pins) {
      console.log(`  · 准备内置 Node（${pin.arch}）…`);
      const tarPath = await ensureNodeTarball(pin);
      const one = await extractBundledNode(nodeDir, pin, tarPath);
      nodeInfo.push(one);
      console.log(`    完成：${pin.file} / bin/node ${MB(one.bytes)}`);
    }
  }

  // 5) 包根：法律文件、入口脚本、说明
  for (const f of LEGAL_FILES) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src)) {
      console.log(`    ! 版本库里没有 ${f}，包根将缺少这份声明`);
      continue;
    }
    await fsp.copyFile(src, path.join(out, f));
  }
  await fsp.writeFile(path.join(out, 'start.sh'), startScript(), { encoding: 'utf8', mode: 0o755 });
  await fsp.writeFile(path.join(out, 'README-懒人包.md'),
    bundleReadme({ version: NODE_PINS[0].file.replace(/^node-([\d.]+)-.*$/, 'v$1'), arches: nodeInfo.map((n) => n.arch), withNode: !!o.node }), 'utf8');

  const total = await dirSize(out);
  console.log(`\n✔ 懒人包目录已生成：${out}\n  ${total.files} 个文件 / ${MB(total.bytes)}`);
  if (o.archive) {
    console.log('  · 打包 tar.gz（几分钟）…');
    tarFolder(out, archivePath);
    console.log(`✔ 压缩包：${archivePath}（${MB((await fsp.stat(archivePath)).size)}）`);
    console.log('  在 Linux 上：tar xzf 解压 → 进入目录 → bash start.sh → http://<地址>:3325');
  } else {
    console.log('  在 Linux 上：进入目录 → bash start.sh → http://<地址>:3325');
  }
  return 0;
}

// 作为脚本运行时才打包（被 import 时只导出纯函数，方便测试）——与 make-windows-bundle.mjs 同一约定。
function isMain() {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isMain()) main().then((code) => { process.exitCode = code ?? 0; }, (e) => { console.error(e?.stack || e); process.exitCode = 1; });
