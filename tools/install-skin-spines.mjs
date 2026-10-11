// tools/install-skin-spines.mjs — 下载干员皮肤的战斗 Spine 并写进 data/assets.json（docs/SKINS.md）
//
//   node tools/install-skin-spines.mjs [filter…] [--offline] [--download-only] [--source=direct|mirror] [--concurrency=N]
//
// --download-only: only fill in missing files, never write data/assets.json (tools/deploy.mjs: deployment never
// mutates tracked files).
//
// filter: charId / skinId / stem 片段（缺省 = 全部）。--offline 只解析磁盘上已有的文件。
//
// 皮肤模型必须走和原皮相同的构建管线（tools/assets/spine.mjs processModels：下载 → 补全贴图页 → 规范化 atlas →
// 解析 skel → resolveRoles 生成 anims）。客户端 validSpine() 需要的 anims 必须从该皮肤自己的骨骼解析，
// 不能照抄原皮的（皮肤的动画名可以不同）。
//
// fexli 的目录：有 Back 的皮肤在 `{stem}/Front/` + `{stem}/Back/`，没有 Back 的在 `{stem}/Spine/`
// （和原皮一样，例如 char_1012_skadi2_boc_4）。两种都作为候选，按顺序尝试。
//
// 写回 data/assets.json 的 chars[charId].skins[skinId].spine。npm run assets 重建清单会抹掉皮肤条目——之后重跑
// `node tools/inject-skins-assets.mjs && node tools/install-skin-spines.mjs --offline`。
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Downloader } from './assets/downloader.mjs';
import { MirrorPolicy, selectDownloadSource } from './assets/network.mjs';
import { normalizeProxyPrefix, RAW, safeName } from './assets/sources.mjs';
import { kindOf } from './assets/formats.mjs';
import { processModels } from './assets/spine.mjs';
import { skelParserAvailable } from './assets/skel.mjs';
import { skillIndicesByChar } from './assets/plan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'public', 'assets');
const CACHE = join(ROOT, '.cache');
const MANIFEST = join(ROOT, 'data', 'assets.json');

const readJson = async (rel) => JSON.parse(await readFile(join(ROOT, rel), 'utf8'));

/** Remote url stems (no extension) of a skin's Front (Front/ then Spine/) and Back models on fexli. */
export function skinBases(charId, stem) {
  const b = (f) => `${RAW.fexli}spine/${encodeURIComponent(charId)}/${encodeURIComponent(stem)}/${f}/${encodeURIComponent(stem)}`;
  return { front: [b('Front'), b('Spine')], back: [b('Back')] };
}

/** One model def in processModels' shape (plan.mjs fexliModel), with candidate folders tried in order. */
export function skinModelDef(key, dir, bases, skillIndices, stem) {
  const a = (rel, urls) => ({ rel, urls, kind: kindOf(rel) });
  return {
    key, kind: 'op', dir, pma: false, skillIndices,
    baseUrl: bases[0].slice(0, bases[0].lastIndexOf('/') + 1),
    skel: a(`${dir}${stem}.skel`, bases.map((b) => `${b}.skel`)),
    atlas: { ...a(`${dir}${stem}.atlas`, bases.map((b) => `${b}.atlas`)), mutable: true },
    pngs: [a(dir + safeName(`${stem}.png`), bases.map((b) => `${b}.png`))],
  };
}

function parseArgs(argv) {
  const o = { filters: [], offline: false, downloadOnly: false, source: process.env.SP_ASSET_SOURCE || 'direct', concurrency: 8 };
  for (const x of argv) {
    if (x === '--offline') o.offline = true;
    else if (x === '--download-only') o.downloadOnly = true;
    else if (x.startsWith('--source=')) o.source = x.slice(9);
    else if (x.startsWith('--concurrency=')) o.concurrency = Number(x.slice(14)) || 8;
    else if (!x.startsWith('--')) o.filters.push(x);
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!skelParserAvailable()) throw new Error('@pixi-spine/runtime-3.8 not found — run `npm install` first');
  const [research, ops03, assets07] = await Promise.all([
    readJson('docs/research/08-skins.json'), readJson('docs/research/03-operators.json'), readJson('docs/research/07-assets.json'),
  ]);
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const skillIdx = skillIndicesByChar(ops03);

  const models = new Map();
  const targets = [];
  for (const [charId, list] of Object.entries(research.skins || {})) {
    if (!manifest.chars?.[charId]) continue;
    const o = assets07.operators?.[charId] || {};
    const idx0 = skillIdx.get(charId) || [0];
    const idx = [...idx0, ...(o.skills || []).map((k) => k.index).filter((i) => Number.isInteger(i) && i >= 0 && !idx0.includes(i)).sort((x, y) => x - y)];
    for (const s of list) {
      if (opts.filters.length && !opts.filters.some((f) => charId === f || s.skinId === f || s.stem.includes(f))) continue;
      const bases = skinBases(charId, s.stem);
      const frontKey = `skin:${s.skinId}:front`;
      const backKey = `skin:${s.skinId}:back`;
      models.set(frontKey, skinModelDef(frontKey, `spine/op/${charId}/${s.stem}/front/`, bases.front, idx, s.stem));
      models.set(backKey, skinModelDef(backKey, `spine/op/${charId}/${s.stem}/back/`, bases.back, idx, s.stem));
      targets.push({ charId, skinId: s.skinId, frontKey, backKey });
    }
  }
  console.log(`[skin-spines] ${targets.length} skins, ${models.size} candidate models`);
  if (!targets.length) return 0;

  const proxyPrefix = opts.source === 'mirror' ? normalizeProxyPrefix(process.env.SP_GITHUB_PROXY) : '';
  const source = await selectDownloadSource({ mode: opts.source, offline: opts.offline, proxyPrefix });
  const mirrorPolicy = new MirrorPolicy({ source, proxyPrefix });
  const dl = new Downloader({ root: ASSETS, ledgerPath: join(CACHE, 'assets-ledger.json'), concurrency: opts.concurrency, mirrorPolicy });
  await dl.loadLedger();
  // A Back that does not exist is a 404 miss (a Spine/-only skin): processModels reports it, and the skin uses Front.
  const { entries, problems } = await processModels(models, {
    root: ASSETS, dl, cachePath: join(CACHE, 'skin-spine-info.json'), download: !opts.offline, log: (m) => console.log(m),
  });
  await dl.saveLedger();

  if (opts.downloadOnly) {
    const ok = targets.filter((t) => entries.has(t.frontKey)).length;
    console.log(`[skin-spines] download-only: ${ok}/${targets.length} skins have a usable model on disk (manifest untouched)`);
    return ok === targets.length ? 0 : 1;
  }

  let withFront = 0; let withBack = 0; const failed = [];
  for (const t of targets) {
    const rec = manifest.chars[t.charId];
    rec.skins = rec.skins || {};
    const skin = rec.skins[t.skinId] || (rec.skins[t.skinId] = {});
    const front = entries.get(t.frontKey);
    const back = entries.get(t.backKey);
    if (!front) { delete skin.spine; failed.push(t.skinId); continue; }
    skin.spine = back ? { front, back } : { front };
    withFront++; if (back) withBack++;
  }
  let total = 0;
  for (const c of Object.values(manifest.chars)) for (const s of Object.values(c.skins || {})) if (s.spine) total++;
  manifest.stats = { ...(manifest.stats || {}), skinsWithSpine: total };
  await writeFile(MANIFEST + '.tmp', JSON.stringify(manifest));
  await rename(MANIFEST + '.tmp', MANIFEST);

  const real = problems.filter((p) => !/^skin:\S+:back: missing/.test(p));
  if (real.length) { console.log(`[skin-spines] problems (${real.length}):`); for (const p of real.slice(0, 30)) console.log(`  ${p}`); }
  console.log(`[skin-spines] battle models: ${withFront}/${targets.length} skins (Back ${withBack}); manifest total ${total}`);
  if (failed.length) console.log(`[skin-spines] no model, stays on the default model: ${failed.join(', ')}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = 1; });
}
