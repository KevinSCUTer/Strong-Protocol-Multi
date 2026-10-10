// test/linux-bundle.test.js — Linux 懒人包脚本里那几处「写错就会毁掉一次打包」的纯函数。
//
// 打包本身要联网下载官方 Node、还要 `npm ci`，不适合放进单元测试（与 test/windows-bundle.test.js 同一
// 取舍）；这里盯住这些：
//   * `--force` 只肯删「空目录」或「上一次打的懒人包」，认不出来就不许动；
//   * 生成的 start.sh 是合法的 bash，端口默认 3325、musl 退回系统 Node 的逻辑写在明面上；
//   * 包内说明的措辞：不能声称「不访问外网」（Google Fonts 外链没改），`--no-node` 时也不能说不用装 Node；
//   * 内置 Node 的版本与 sha256 钉在仓库里（不许换成 latest 这类浮动版本）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

describe('make-linux-bundle.mjs: --force 只肯删空目录或上一次的包', () => {
  test('不存在 / 空目录 / 上一次打的包 → 可以删', async () => {
    const { linuxForceDeleteVerdict } = await mod('scripts/make-linux-bundle.mjs');
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-lx-force-'));
    try {
      assert.equal(linuxForceDeleteVerdict(path.join(base, 'nope')), 'missing');

      const empty = path.join(base, 'empty');
      await fsp.mkdir(empty);
      assert.equal(linuxForceDeleteVerdict(empty), 'empty');

      const bundle = path.join(base, 'bundle');
      await fsp.mkdir(path.join(bundle, 'app'), { recursive: true });
      await fsp.writeFile(path.join(bundle, 'README-懒人包.md'), '# x');
      await fsp.writeFile(path.join(bundle, 'start.sh'), 'x');
      assert.equal(linuxForceDeleteVerdict(bundle), 'bundle');
    } finally {
      await fsp.rm(base, { recursive: true, force: true });
    }
  });

  test('有东西但不是上次的包 → 一律拒绝（别人的目录、仓库、只有半份的产物）', async () => {
    const { linuxForceDeleteVerdict } = await mod('scripts/make-linux-bundle.mjs');
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-lx-force2-'));
    try {
      const other = path.join(base, 'Documents');
      await fsp.mkdir(other);
      await fsp.writeFile(path.join(other, '重要文件.txt'), 'x');
      assert.equal(linuxForceDeleteVerdict(other), 'refuse', '别人的目录不能删');
      assert.equal(linuxForceDeleteVerdict(ROOT), 'refuse', '仓库根不是懒人包');

      const half = path.join(base, 'half');
      await fsp.mkdir(path.join(half, 'app'), { recursive: true });
      await fsp.writeFile(path.join(half, 'README-懒人包.md'), '# x');
      assert.equal(linuxForceDeleteVerdict(half), 'refuse', '缺 start.sh：可能是别人的目录，不删');
    } finally {
      await fsp.rm(base, { recursive: true, force: true });
    }
  });
});

describe('make-linux-bundle.mjs: 生成的 start.sh', () => {
  test('是合法的 bash；端口默认 3325，环境变量可覆盖；musl 退回系统 Node', async () => {
    const { startScript } = await mod('scripts/make-linux-bundle.mjs');
    const s = startScript();
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-lx-start-'));
    try {
      const p = path.join(base, 'start.sh');
      await fsp.writeFile(p, s);
      assert.equal(spawnSync('bash', ['-n', p]).status, 0, 'bash -n 语法检查');
    } finally {
      await fsp.rm(base, { recursive: true, force: true });
    }
    assert.match(s, /PORT:-3325/, '默认端口 3325，且允许环境变量覆盖');
    assert.match(s, /uname -m/, '按架构挑内置 Node');
    assert.match(s, /musl/, '跑不起内置 Node 时要说明原因（Alpine 的 musl）');
    assert.match(s, /launch\.mjs.*--no-setup/, '素材已在包里：固定 --no-setup，不联网准备');
    assert.match(s, /set -euo pipefail/, '出错即停');
  });
});

describe('make-linux-bundle.mjs: 内置 Node 的钉版', () => {
  test('版本与 sha256 钉在仓库里，x64 / arm64 都有，同一个版本', async () => {
    const src = await fsp.readFile(path.join(ROOT, 'scripts', 'make-linux-bundle.mjs'), 'utf8');
    const pins = [...src.matchAll(/arch: '(linux-(?:x64|arm64))',\s*\n\s*file: '(node-v[\d.]+-linux-(?:x64|arm64)\.tar\.gz)',\s*\n\s*sha256: '([0-9a-f]{64})'/g)];
    assert.equal(pins.length, 2, `要钉住 x64 与 arm64 两个架构，实际 ${pins.length}`);
    const versions = new Set(pins.map((p) => p[2].replace(/^node-v([\d.]+)-.*/, 'v$1')));
    assert.equal(versions.size, 1, '两个架构必须是同一个 Node 版本');
    for (const p of pins) assert.match(p[2], new RegExp(`^node-v[\\d.]+-${p[1]}\\.tar\\.gz$`), '文件名与架构对应');
  });
});

describe('make-linux-bundle.mjs: 包内说明的措辞', () => {
  test('联网 / 断网两种情况都讲清，每条授权要点都在', async () => {
    const { bundleReadme } = await mod('scripts/make-linux-bundle.mjs');
    const r = bundleReadme({ version: 'v22.23.3', arches: ['linux-x64', 'linux-arm64'], withNode: true });
    assert.ok(!/不访问外网/.test(r), 'index.html 的 Google Fonts 外链没改，不能说这个包不访问外网');
    assert.match(r, /不联网也能玩/, '断网可用要写清楚');
    assert.match(r, /Google Fonts/, '联网时会去 Google Fonts 加载字体，要如实说明');
    assert.match(r, /bash start\.sh/, '入口命令要写清楚');
    assert.match(r, /3325/);
    for (const key of ['版权归原权利人所有', '不适用', '单独再分发', '立即删除', '不提供任何担保', '严禁任何形式的盈利']) {
      assert.match(r, new RegExp(key));
    }
    assert.ok(!/本包按 GPL/.test(r), '不能写「本包按 GPL-3.0-or-later 分发」');
  });

  test('--no-node 时不再写「不需要安装 Node」，目录结构也不列 node/', async () => {
    const { bundleReadme } = await mod('scripts/make-linux-bundle.mjs');
    const r = bundleReadme({ version: 'v22.23.3', arches: [], withNode: false });
    assert.ok(!/不需要安装 Node/.test(r), '没内置 Node 就不能说不用装');
    assert.match(r, /没有内置 Node/, '要明确告诉玩家自己去装 Node 22/24');
    assert.ok(!/node\/linux/.test(r), '目录结构里不该出现内置 Node');
  });
});
