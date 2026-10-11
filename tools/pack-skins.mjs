#!/usr/bin/env node
// i18n-ignore-file: owner CLI, reports in Chinese.
// tools/pack-skins.mjs — 把 data/assets.json 声明的全部皮肤素材（头像 + 战斗 Spine）打成一个 tar.gz（docs/SKINS.md）
//
//   node tools/pack-skins.mjs [--out=DIR]      # 默认 .cache/skin-pack/
//
// 包内路径相对 public/assets（char/skin_avatar/…、spine/op/{charId}/{stem}/…），只有文件条目、没有目录条目：
// 在服务器上 `tar -xzf <包> -C public/assets` 即可，public/assets 是共享目录的软链接时也只会被跟随、不会被替换。
// atlas 是 processModels 规范化后的版本（与清单一致）。缺任何一个声明的文件就拒绝打包。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atlasInfo } from './assets/atlas.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'public', 'assets');
export const SIZE_LIMIT = 500 * 1024 * 1024;

/** Every /assets/ URL under chars[*].skins of a manifest (avatars, skel, atlas, textures), sorted, unique. */
export function skinAssetUrls(manifest) {
  const out = new Set();
  const walk = (n) => {
    if (typeof n === 'string') { if (n.startsWith('/assets/')) out.add(n); } else if (n && typeof n === 'object') for (const v of Object.values(n)) walk(v);
  };
  for (const c of Object.values(manifest?.chars || {})) for (const s of Object.values(c?.skins || {})) walk(s);
  return [...out].sort();
}

function main() {
  const outArg = process.argv.slice(2).find((a) => a.startsWith('--out='));
  const outDir = path.resolve(outArg ? outArg.slice(6) : path.join(ROOT, '.cache', 'skin-pack'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'assets.json'), 'utf8'));
  const rels = skinAssetUrls(manifest).map((u) => decodeURIComponent(u.slice('/assets/'.length)));
  // atlas pages a model needs beyond `textures` (normally the same files)
  for (const r of rels.filter((x) => x.endsWith('.atlas'))) {
    const text = fs.readFileSync(path.join(ASSETS, r), 'utf8');
    for (const p of atlasInfo(text).pages) { const pr = path.posix.join(path.posix.dirname(r), p); if (!rels.includes(pr)) rels.push(pr); }
  }
  const missing = rels.filter((r) => { try { return !fs.statSync(path.join(ASSETS, r)).size; } catch { return true; } });
  if (missing.length) {
    console.error(`✘ ${missing.length} 个皮肤文件不在盘上（如 ${missing.slice(0, 3).join(', ')}）→ 先运行 node tools/install-skin-spines.mjs / fetch-skin-avatars.mjs`);
    return 1;
  }
  rels.sort();
  const skins = Object.values(manifest.chars).reduce((n, c) => n + Object.values(c.skins || {}).filter((s) => s.spine).length, 0);
  const hash = createHash('sha256');
  let bytes = 0;
  for (const r of rels) { const b = fs.readFileSync(path.join(ASSETS, r)); bytes += b.length; hash.update(r).update(b); }
  const tag = hash.digest('hex').slice(0, 10);
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `Stronghold-skins-${skins}-${tag}.tar.gz`);
  const list = path.join(outDir, `.filelist-${tag}.txt`);
  fs.writeFileSync(list, rels.join('\n') + '\n');
  // file entries only (-n: no recursion), no macOS metadata / xattrs (GNU tar on the server warns about them)
  const bsd = /bsdtar/.test(spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout || '');
  const args = ['-czf', out, ...(bsd ? ['--no-mac-metadata', '--no-xattrs', '--no-acls', '--uid', '0', '--gid', '0', '--uname', '', '--gname', ''] : ['--owner=0', '--group=0', '--numeric-owner', '--no-recursion']),
    ...(bsd ? ['-n'] : []), '-C', ASSETS, '-T', list];
  const r = spawnSync('tar', args, { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  fs.unlinkSync(list);
  if (r.status !== 0) { console.error('✘ tar 失败'); return 1; }
  const size = fs.statSync(out).size;
  const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
  console.log(`✔ ${out}`);
  console.log(`  ${skins} 套皮肤模型 · ${rels.length} 个文件 · 原始 ${mb(bytes)} → 压缩包 ${mb(size)}`);
  console.log('  服务器上：tar -xzf <包> -C public/assets   （在仓库根目录执行）');
  if (size > SIZE_LIMIT) { console.error(`✘ 超过 ${mb(SIZE_LIMIT)}`); return 1; }
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
