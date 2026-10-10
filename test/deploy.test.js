// test/deploy.test.js — the deployment preparation (tools/deploy.mjs + the root start.sh; DEV-20261010-05):
// readiness helpers (production dependencies incl. @zip.js/zip.js and three, the lockfile stamp, the vendor
// fingerprint, the index refresh policy), the shared public/assets · public/fonts symlink guard, the committed
// manifest's file and atlas-page gates, the font gate, and the honest exit codes (a failed download is never a
// success and never leaves a ready stamp). The tracked files (data/assets.json, package-lock.json) are fixtures
// here only as facts read from disk — the deployment writes neither, and fetch-assets runs with --download-only.
// Run: node --test test/deploy.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseArgs, checkNode, prodDependencyNames, prodDepsMissing, depsNeedInstall, staleVendorFiles, vendorNeedsRun,
  indexRefreshNeeded, cachedIndexesReady, buildFetchArgs, ensureSharedDirs, manifestUrls, manifestGaps, fontsStatus,
  deployGate, fileSha256,
} from '../tools/deploy.mjs';
import { parseArgs as parseFetchArgs, unmanifestedFiles } from '../tools/fetch-assets.mjs';
import { buildPlan } from '../tools/assets/plan.mjs';
import { resolveTemplate } from '../tools/assets/manifest.mjs';
import { indexAudio } from '../tools/assets/audio.mjs';
import { Downloader } from '../tools/assets/downloader.mjs';
import { processModels } from '../tools/assets/spine.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = () => {};
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89]),
  Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]), // IEND
]);

// ---------------------------------------------------------------------------------------------------
// CLI, Node check, dependencies
// ---------------------------------------------------------------------------------------------------

test('deploy parseArgs: every flag, conflicts and the usage error (start.sh forwards everything)', () => {
  assert.deepEqual(parseArgs([]), { prepareOnly: false, noAssets: false, offline: false, refreshIndex: false, noRefreshIndex: false, check: false, quiet: false, help: false });
  assert.equal(parseArgs(['--prepare-only', '--check', '--quiet']).check, true);
  assert.equal(parseArgs(['--no-assets', '--offline']).noAssets, true);
  assert.equal(parseArgs(['-h']).help, true);
  assert.throws(() => parseArgs(['--refresh-index', '--no-refresh-index']), /不能同时使用/);
  assert.throws(() => parseArgs(['--port=3326']), /未知参数/, 'unknown flags fail: the server takes PORT from the environment');
});

test('checkNode: 22 / 24 pass, 18 fails with the download hint', () => {
  assert.deepEqual(checkNode('22.0.0'), { ok: true, message: '' });
  assert.equal(checkNode('24.14.0').ok, true);
  const old = checkNode('18.19.1');
  assert.equal(old.ok, false);
  assert.match(old.message, /22 或更高/);
});

test('prodDepsMissing: every production dependency is checked, including scoped @zip.js/zip.js and three', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const deps = prodDependencyNames(pkg);
  assert.ok(deps.includes('ws') && deps.includes('three') && deps.includes('@zip.js/zip.js'));
  assert.deepEqual(prodDepsMissing(path.join(ROOT, 'node_modules'), deps), [], 'this checkout is installed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-deploy-deps-'));
  try {
    fs.mkdirSync(path.join(dir, 'ws'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ws', 'package.json'), '{}');
    assert.deepEqual(prodDepsMissing(dir, ['ws', 'three', '@zip.js/zip.js', 'preact']), ['three', '@zip.js/zip.js', 'preact']);
    assert.deepEqual(prodDepsMissing(dir, []), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('depsNeedInstall: missing packages, a changed package-lock.json or no stamp each mean npm ci', () => {
  assert.equal(depsNeedInstall({ missing: 1, lockHash: 'a', state: { lockHash: 'a' }, hasNodeModules: true }).needed, true);
  assert.equal(depsNeedInstall({ missing: 0, lockHash: null, state: {}, hasNodeModules: true }).needed, true, 'an unreadable lockfile is re-installed');
  assert.equal(depsNeedInstall({ missing: 0, lockHash: 'a', state: {}, hasNodeModules: true }).needed, true, 'first run');
  assert.match(depsNeedInstall({ missing: 0, lockHash: 'b', state: { lockHash: 'a' }, hasNodeModules: true }).why, /package-lock/);
  assert.equal(depsNeedInstall({ missing: 0, lockHash: 'a', state: { lockHash: 'a' }, hasNodeModules: true }).needed, false, 'dependency update is the only trigger');
  assert.equal(depsNeedInstall({ missing: 0, lockHash: 'a', state: { lockHash: 'a' }, hasNodeModules: false }).needed, true);
});

// ---------------------------------------------------------------------------------------------------
// vendor
// ---------------------------------------------------------------------------------------------------

test('staleVendorFiles: a missing or older-than-source copy is refreshed; an optional file without its source is skipped', () => {
  const stale = staleVendorFiles([
    { dst: 'pixi.min.js', srcExists: true, srcMtime: 200, dstExists: true, dstMtime: 300 },
    { dst: 'preact.module.js', srcExists: true, srcMtime: 300, dstExists: true, dstMtime: 300 },
    { dst: 'hooks.module.js', srcExists: true, srcMtime: 400, dstExists: true, dstMtime: 300 },
    { dst: 'three.module.js', optional: true, srcExists: true, srcMtime: 5, dstExists: false },
    { dst: 'zip-native.min.js', srcExists: true, srcMtime: 1, dstExists: false },
    { dst: 'zip-LICENSE.txt', srcExists: false, dstExists: false },
  ]);
  assert.deepEqual(stale, ['hooks.module.js', 'three.module.js', 'zip-native.min.js', 'zip-LICENSE.txt']);
});

test('vendorNeedsRun: stale copies or a changed tools/vendor.mjs (the code rewrites Preact hooks) each trigger it', () => {
  const stale = vendorNeedsRun({ stale: ['x.js'], state: { vendorHash: 'same' }, vendorHash: 'same' });
  assert.equal(stale.needed, true);
  assert.match(stale.why, /1 个文件/);
  assert.equal(vendorNeedsRun({ stale: [], state: {}, vendorHash: 'h1' }).needed, true, 'no stamp yet');
  assert.equal(vendorNeedsRun({ stale: [], state: { vendorHash: 'h1' }, vendorHash: 'h1' }).needed, false);
  assert.match(vendorNeedsRun({ stale: [], state: { vendorHash: 'h1' }, vendorHash: 'h2' }).why, /vendor\.mjs/);
});

// ---------------------------------------------------------------------------------------------------
// index refresh policy and the fetch invocation
// ---------------------------------------------------------------------------------------------------

test('indexRefreshNeeded: TTL and newer game data refresh; missing cached indexes do not (fetch downloads them anyway)', () => {
  const now = 1_000_000_000_000;
  const hour = 3600_000;
  const fresh = [{ mtime: now - hour, size: 10 }, { mtime: now - 2 * hour, size: 10 }, { mtime: now - hour, size: 10 }];
  assert.equal(indexRefreshNeeded({ indexStats: fresh, dataMtimes: [now - 3 * hour], ttlHours: 24, now }), false);
  assert.equal(indexRefreshNeeded({ indexStats: fresh.map((s) => ({ ...s, mtime: now - 25 * hour })), dataMtimes: [now - 30 * hour], ttlHours: 24, now }), true, 'older than the TTL');
  assert.equal(indexRefreshNeeded({ indexStats: fresh, dataMtimes: [now], ttlHours: 24, now }), true, 'data/*.json pulled after the indexes');
  assert.equal(indexRefreshNeeded({ indexStats: [null, ...fresh.slice(1)], dataMtimes: [], ttlHours: 24, now }), false);
  assert.equal(indexRefreshNeeded({ indexStats: [], dataMtimes: [], ttlHours: 24, now }), false);
  assert.equal(indexRefreshNeeded({ indexStats: fresh.map((s) => ({ ...s, size: 0 })), dataMtimes: [], ttlHours: 24, now }), false, 'an empty index is missing');
});

test('buildFetchArgs: --add-only --download-only always; --offline and the index refresh are additive', () => {
  assert.deepEqual(buildFetchArgs({}, false), ['--add-only', '--download-only'], 'the committed data/assets.json is never written');
  assert.deepEqual(buildFetchArgs({ offline: true }, false), ['--add-only', '--download-only', '--offline']);
  assert.deepEqual(buildFetchArgs({}, true), ['--add-only', '--download-only', '--refresh-index']);
});

test('cachedIndexesReady: every cached index present and non-empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-deploy-idx-'));
  try {
    const a = path.join(dir, 'a.json');
    fs.writeFileSync(a, '{}');
    assert.deepEqual(cachedIndexesReady([a, path.join(dir, 'gone.json')]), false);
    fs.writeFileSync(path.join(dir, 'gone.json'), '');
    assert.deepEqual(cachedIndexesReady([a, path.join(dir, 'gone.json')]), false, 'empty does not count');
    fs.writeFileSync(path.join(dir, 'gone.json'), '{}');
    assert.deepEqual(cachedIndexesReady([a, path.join(dir, 'gone.json')]), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------
// shared asset roots
// ---------------------------------------------------------------------------------------------------

test('ensureSharedDirs: a real dir, a followed symlink, a missing dir; never a non-directory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-deploy-share-'));
  try {
    const real = path.join(dir, 'real');
    fs.mkdirSync(real);
    const linked = path.join(dir, 'linked');
    fs.symlinkSync(real, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const r = await ensureSharedDirs({ assetsDir: real, fontsDir: linked });
    assert.deepEqual(r.states, { assets: 'dir', fonts: 'link' });
    assert.equal(r.ok, true);
    assert.equal(fs.lstatSync(linked).isSymbolicLink(), true, 'the shared symlink is preserved');
    const missing = await ensureSharedDirs({ assetsDir: path.join(dir, 'absent'), fontsDir: linked });
    assert.equal(missing.states.assets, 'missing', 'fetch-assets creates it');
    const file = path.join(dir, 'afile');
    fs.writeFileSync(file, 'x');
    const bad = await ensureSharedDirs({ assetsDir: file, fontsDir: linked });
    assert.equal(bad.ok, false);
    assert.match(bad.errors[0], /不是目录也不是软链接/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureSharedDirs: a dangling symlink is reported read-only (--check) and its target — resolved through the link text — is created on a run, the link kept', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-deploy-dangle-'));
  try {
    const sharedRoot = path.join(dir, 'shared-root');
    const link = path.join(dir, 'assets');
    fs.symlinkSync(path.join('shared-root', 'assets'), link, 'dir'); // relative target, like this repo's public/assets
    const check = await ensureSharedDirs({ assetsDir: link, fontsDir: link, mutate: false });
    assert.equal(check.states.assets, 'link-dangling');
    assert.equal(check.ok, true, '--check reports instead of fixing');
    assert.equal(fs.existsSync(sharedRoot), false, 'read-only: nothing was created');
    const run = await ensureSharedDirs({ assetsDir: link, fontsDir: link });
    assert.equal(run.states.assets, 'link-target-created');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the link itself is never replaced');
    assert.equal(fs.statSync(link).isDirectory(), true, 'the target now exists through the link');
    assert.equal(fs.statSync(sharedRoot).isDirectory(), true, 'the relative link text was resolved against the link\'s directory');
    const again = await ensureSharedDirs({ assetsDir: link, fontsDir: link });
    assert.equal(again.states.assets, 'link', 'idempotent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------
// manifest gates: declared files and declared atlas pages
// ---------------------------------------------------------------------------------------------------

test('manifestUrls walks nested objects and arrays', () => {
  const urls = manifestUrls({ a: '/assets/x.png', b: [{ c: '/fonts/f.css' }, { d: { e: '/assets/y.webp', f: 'https://cdn.example/z.png' } }] });
  assert.deepEqual(urls.sort(), ['/assets/x.png', '/assets/y.webp', '/fonts/f.css']);
});

test('manifestGaps: declared files must exist as non-empty files; an atlas\'s declared pages too — even pages the manifest itself does not list', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-deploy-gap-'));
  try {
    const pub = path.join(dir, 'public');
    fs.mkdirSync(path.join(pub, 'assets', 'char'), { recursive: true });
    fs.mkdirSync(path.join(pub, 'assets', 'spine', 'op', 'c'), { recursive: true });
    fs.writeFileSync(path.join(pub, 'assets', 'char', 'c.png'), PNG);
    fs.writeFileSync(path.join(pub, 'assets', 'spine', 'op', 'c', 'c.skel'), 'skel-bytes-0123456789abcdef');
    fs.writeFileSync(path.join(pub, 'assets', 'spine', 'op', 'c', 'c.atlas'), 'c.png\nsize: 2,2\n\nc 2.png\nsize: 2,2\n');
    fs.writeFileSync(path.join(pub, 'assets', 'spine', 'op', 'c', 'c.png'), PNG);
    fs.writeFileSync(path.join(pub, 'assets', 'spine', 'op', 'c', 'c_2.png'), PNG); // the atlas's 'c 2.png', safeName()d on disk
    fs.mkdirSync(path.join(pub, 'fonts'));
    fs.writeFileSync(path.join(pub, 'fonts', 'fonts.css'), '@font-face{}');
    const manifest = {
      chars: { c: { avatar: '/assets/char/c.png', spine: { front: { skel: '/assets/spine/op/c/c.skel', atlas: '/assets/spine/op/c/c.atlas', textures: ['/assets/spine/op/c/c.png'] } } } },
      fonts: { css: '/fonts/fonts.css' },
    };
    assert.deepEqual(await manifestGaps(manifest, pub), { missing: [], missingAtlasPages: [] });

    // a declared page the manifest never lists (an interrupted extra-page download) is still a gap
    fs.rmSync(path.join(pub, 'assets', 'spine', 'op', 'c', 'c_2.png'));
    let gaps = await manifestGaps(manifest, pub);
    assert.deepEqual(gaps.missing, []);
    assert.deepEqual(gaps.missingAtlasPages, ['/assets/spine/op/c/c.atlas → c_2.png']);

    // declared files: missing, empty, and a directory instead of a file
    fs.rmSync(path.join(pub, 'assets', 'char', 'c.png'));
    fs.writeFileSync(path.join(pub, 'assets', 'char', 'c.png'), '');
    fs.rmSync(path.join(pub, 'assets', 'char', 'c.png'));
    fs.mkdirSync(path.join(pub, 'assets', 'char', 'c.png'));
    gaps = await manifestGaps(manifest, pub);
    assert.deepEqual(gaps.missing, ['/assets/char/c.png'], 'a directory at a declared path is not the file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fontsStatus: each font\'s original and .woff2 plus fonts.css, all real non-empty files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-deploy-fonts-'));
  const FONTS = [{ name: 'bender-regular', ext: 'otf' }, { name: 'bender-light', ext: 'ttf' }];
  try {
    for (const f of FONTS) {
      fs.writeFileSync(path.join(dir, `${f.name}.${f.ext}`), 'x');
      fs.writeFileSync(path.join(dir, `${f.name}.woff2`), 'x');
    }
    fs.writeFileSync(path.join(dir, 'fonts.css'), 'x');
    assert.deepEqual(fontsStatus(dir, FONTS), { ok: true, missing: [] });
    fs.rmSync(path.join(dir, 'bender-light.ttf'), { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'bender-light.ttf'));
    const r = fontsStatus(dir, FONTS);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['bender-light.ttf'], 'a directory named like the font is missing');
    fs.rmSync(path.join(dir, 'bender-light.ttf'), { recursive: true, force: true });
    fs.rmSync(path.join(dir, 'fonts.css'));
    assert.ok(fontsStatus(dir, FONTS).missing.includes('fonts.css'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------
// the gate: honest exit codes
// ---------------------------------------------------------------------------------------------------

test('deployGate: a failed fetch, incomplete fonts, or manifest/atlas gaps each fail; optional-fallback-only runs do not', () => {
  const fonts = { ok: true, missing: [] };
  const gaps = { missing: [], missingAtlasPages: [] };
  assert.deepEqual(deployGate({ fetchCode: 0, fonts, gaps }), { ok: true, reasons: [] });
  const fail = deployGate({ fetchCode: 1, fonts, gaps });
  assert.equal(fail.ok, false, 'a failed download is never a success');
  assert.match(fail.reasons[0], /fetch-assets 退出码 1/);
  assert.equal(deployGate({ fetchCode: 0, fonts: { ok: false, missing: ['fonts.css'] }, gaps }).ok, false);
  const g = deployGate({ fetchCode: 0, fonts, gaps: { missing: ['/assets/a.png'], missingAtlasPages: ['/assets/s/a.atlas → b.png'] } });
  assert.equal(g.reasons.length, 2, 'declared files and declared pages are separate reasons');
  assert.deepEqual(deployGate({ fetchCode: 0, noAssets: true, fonts: { ok: false, missing: ['x'] }, gaps: { missing: ['/a'], missingAtlasPages: [] } }).reasons, [],
    '--no-assets: the documented offline shortcut skips the asset gates');
});

// ---------------------------------------------------------------------------------------------------
// fetch-assets integration points: --download-only, the plan of new game data, interrupted resume
// ---------------------------------------------------------------------------------------------------

test('fetch-assets parseArgs: --download-only composes with --add-only and refuses the manifest-writing flags', () => {
  assert.equal(parseFetchArgs(['--add-only', '--download-only']).downloadOnly, true);
  assert.throws(() => parseFetchArgs(['--download-only', '--prune']), /never writes data\/assets\.json/);
  assert.throws(() => parseFetchArgs(['--download-only', '--allow-shrink']), /never writes data\/assets\.json/);
  assert.equal(parseFetchArgs(['--download-only']).addOnly, false);
});

test('new game data, new art: the current plan downloads the missing file add-only and reports it as not yet runtime-consumed', async () => {
  // A unit the committed data/assets.json does not know yet (like a freshly pulled 自选 pick): the deployment's
  // plan covers it through data/backups.json, the add-only run brings its art, --download-only leaves the tracked
  // manifest alone and the run reports the file as downloaded but not runtime-consumed.
  const { template } = buildPlan({
    assets07: {}, ops03: {}, enemies05: {}, maps05: {}, audio: indexAudio({}), modelsData: {},
    extraOperators: { char_112_siege: { name: '推进之王', subProfessionId: 'pioneer', nationId: 'victoria',
      skills: [{ index: 0, skillId: 'skchr_siege_2', iconId: 'skchr_siege_2' }] } },
  });
  const rel = 'char/avatar/char_112_siege.png';
  assert.equal(template.chars.char_112_siege.avatar.alts[0].rel, rel, 'the plan of the CURRENT data knows the new unit');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-deploy-plan-'));
  try {
    fs.mkdirSync(path.join(dir, 'char', 'avatar'), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), PNG);
    const resolved = resolveTemplate(template, { root: dir, spine: new Map() });
    assert.equal(resolved.value.chars.char_112_siege.avatar, '/assets/char/avatar/char_112_siege.png');
    const committed = { chars: {}, stats: {} };
    assert.ok(unmanifestedFiles(resolved.files, committed).includes(rel), 'reported as downloaded but not runtime-consumed');
    const known = { chars: { char_112_siege: { avatar: '/assets/char/avatar/char_112_siege.png' } } };
    assert.deepEqual(unmanifestedFiles(resolved.files, known), [], 'once the committed manifest ships it, the note goes');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an existing model whose atlas declares a page that is missing on disk: the add-only spine round repairs it', async () => {
  // processModels reads the atlas already on disk and downloads the pages it declares beyond the plan (the
  // interrupted "new atlas, second page" case); in add-only mode nothing existing is rewritten.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-deploy-page-'));
  try {
    const base = 'spine/op/c/front';
    fs.mkdirSync(path.join(dir, base), { recursive: true });
    fs.writeFileSync(path.join(dir, base, 'c.skel'), Buffer.alloc(48, 0x7f)); // binary, not an error page
    fs.writeFileSync(path.join(dir, base, 'c.atlas'), 'c.png\nsize: 1,1\n\nc2.png\nsize: 1,1\n');
    fs.writeFileSync(path.join(dir, base, 'c.png'), PNG); // page 1 is there, page 2 was never downloaded
    const url = (f) => `https://example.invalid/${base}/${f}`;
    const models = new Map([
      ['op:c:front', {
        key: 'op:c:front', dir: `${base}/`, baseUrl: 'https://example.invalid/', pma: false, skillIndices: [0],
        skel: { rel: `${base}/c.skel`, urls: [url('c.skel')], kind: 'skel' },
        atlas: { rel: `${base}/c.atlas`, urls: [url('c.atlas')], kind: 'atlas' },
        pngs: [{ rel: `${base}/c.png`, urls: [url('c.png')], kind: 'png' }],
      }],
    ]);
    const fetched = [];
    const dl = new Downloader({ root: dir, ledgerPath: path.join(dir, 'ledger.json'), keepExisting: true, retries: 1, backoffMs: 0, log: quiet,
      fetchImpl: async (u) => { fetched.push(u); return new Response(PNG); } });
    await dl.loadLedger();
    await processModels(models, { root: dir, dl, cachePath: path.join(dir, 'spine-info.json'), download: true,
      writable: (r) => dl.written.has(r), log: quiet });
    assert.ok(fetched.some((u) => u.endsWith('/c2.png')), 'the declared-but-missing page was downloaded');
    assert.deepEqual(fs.readFileSync(path.join(dir, base, 'c2.png')), PNG);
    assert.deepEqual(fs.readFileSync(path.join(dir, base, 'c.atlas')).toString(), 'c.png\nsize: 1,1\n\nc2.png\nsize: 1,1\n',
      'the existing atlas file is untouched (add-only)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('interrupted download resumes; add-only never overwrites what is there (existing art, ledger or not)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-deploy-resume-'));
  try {
    const jobs = [
      { rel: 'a.png', urls: ['https://example.invalid/a.png'], kind: 'png' },
      { rel: 'b.png', urls: ['https://example.invalid/b.png'], kind: 'png' },
    ];
    const ledger = path.join(dir, 'ledger.json');
    const first = new Downloader({ root: dir, ledgerPath: ledger, retries: 1, backoffMs: 0, concurrency: 1, log: quiet,
      fetchImpl: async (url) => (url.includes('a.png') ? new Response(PNG) : new Response('nope', { status: 500 })) });
    const r1 = await first.run(jobs);
    assert.equal(r1.get('a.png').status, 'ok');
    assert.equal(r1.get('b.png').status, 'error');
    assert.ok(fs.existsSync(path.join(dir, 'a.png')), 'the finished file is kept for the next run');
    assert.equal(fs.existsSync(path.join(dir, 'b.png')), false, 'a failed download writes no file');

    const second = new Downloader({ root: dir, ledgerPath: ledger, retries: 1, backoffMs: 0, concurrency: 1, log: quiet,
      fetchImpl: async () => new Response(PNG) });
    const r2 = await second.run(jobs);
    assert.equal(r2.get('a.png').status, 'skip', 'the resume does not re-download');
    assert.equal(r2.get('b.png').status, 'ok');

    const rewriting = new Downloader({ root: dir, ledgerPath: path.join(dir, 'other-ledger.json'), keepExisting: true, log: quiet,
      fetchImpl: async () => { throw new Error('must not even be called'); } });
    const r3 = await rewriting.run(jobs);
    assert.equal(r3.get('a.png').status, 'skip', 'add-only keeps every existing file');
    assert.deepEqual(fs.readFileSync(path.join(dir, 'a.png')), PNG, 'byte-for-byte unchanged');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------
// the real scripts (read-only against this checkout)
// ---------------------------------------------------------------------------------------------------

test('bash start.sh --prepare-only --check: banner first, read-only report, no server', { skip: process.platform === 'win32' }, (t) => {
  const { dir } = isolatedDeploy(t);
  fs.mkdirSync(path.join(dir, 'public', 'vendor'), { recursive: true });
  for (const name of ['pixi.min.js', 'pixi-spine.js', 'preact.module.js', 'hooks.module.js', 'htm.module.js']) {
    fs.writeFileSync(path.join(dir, 'public', 'vendor', name), '// vendor fixture');
  }
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'assets.json'), '{}');
  fs.mkdirSync(path.join(dir, 'public', 'fonts'));
  for (const name of ['bender-regular.otf', 'bender-light.ttf', 'novecento-wide-normal.otf',
    'bender-regular.woff2', 'bender-light.woff2', 'novecento-wide-normal.woff2', 'fonts.css']) {
    fs.writeFileSync(path.join(dir, 'public', 'fonts', name), 'font fixture');
  }
  const sh = (args) => spawnSync('bash', [path.join(dir, 'start.sh'), ...args], { encoding: 'utf8', cwd: dir, timeout: 10_000 });
  const check = sh(['--prepare-only', '--check']);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.equal(check.stdout.split('\n')[0], '卫戍协议，启动！！！', 'the first visible line of every start');
  assert.doesNotMatch(check.stdout, /部署准备完成/, '--check reports readiness even when combined with --prepare-only');
  assert.doesNotMatch(check.stdout, /lanUrls|http:\/\/localhost/, 'no server was started');
  const bare = sh(['--check']);
  assert.equal(bare.status, 0, bare.stdout + bare.stderr);
  assert.doesNotMatch(bare.stdout, /部署准备完成/, '--check reports; it does not claim a preparation completed');
  const help = sh(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--prepare-only/);
  assert.doesNotMatch(help.stdout, /部署准备完成/);
});

function isolatedDeploy(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-deploy-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(ROOT, 'tools'), path.join(dir, 'tools'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'start.sh'), path.join(dir, 'start.sh'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module', dependencies: {} }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  fs.mkdirSync(path.join(dir, '.cache'));
  const state = path.join(dir, '.cache', 'deploy-state.json');
  const check = (args = ['--check']) => spawnSync(process.execPath, [path.join(dir, 'tools', 'deploy.mjs'), ...args], {
    encoding: 'utf8', cwd: dir, timeout: 10_000,
  });
  return { dir, state, check };
}

test('a failing --check leaves existing state, absent state and dangling links untouched', (t) => {
  const { dir, state, check } = isolatedDeploy(t);
  fs.mkdirSync(path.join(dir, 'public'));
  if (process.platform !== 'win32') fs.symlinkSync('../missing-assets', path.join(dir, 'public', 'assets'));
  fs.writeFileSync(state, '{"ready":true,"ownerNote":"keep"}\n');
  const before = fs.readFileSync(state);
  const r = check();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /尚未就绪/);
  assert.deepEqual(fs.readFileSync(state), before);
  assert.equal(fs.existsSync(path.join(dir, 'missing-assets')), false);
  assert.equal(fs.existsSync(path.join(dir, 'public', 'vendor')), false);
  fs.unlinkSync(state);
  assert.equal(check().status, 1);
  assert.equal(fs.existsSync(state), false, 'a failing check creates no state file');
  assert.equal(check(['--check', '--unknown']).status, 2);
  assert.equal(fs.existsSync(state), false, 'invalid report-only arguments also leave the disk alone');
});

test('failed vendor preparation and usage errors clear readiness without an install fallback', (t) => {
  const { dir, state, check } = isolatedDeploy(t);
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'tools', 'vendor.mjs'), 'export const VENDOR_FILES = [];\nif (process.argv[1]?.endsWith("vendor.mjs")) process.exit(7);\n');
  fs.writeFileSync(state, JSON.stringify({ ready: true, lockHash: fileSha256(path.join(dir, 'package-lock.json')) }));
  const failed = check(['--no-assets']);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /tools\/vendor\.mjs 失败/);
  assert.equal(JSON.parse(fs.readFileSync(state)).ready, false);
  fs.writeFileSync(state, '{"ready":true}');
  const bad = check(['--no-such-flag']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /未知参数/);
  assert.equal(JSON.parse(fs.readFileSync(state)).ready, false);
});

test('npm ci failure stops the root launcher, preserves the lock and never invokes npm install', { skip: process.platform === 'win32' }, (t) => {
  const { dir, state } = isolatedDeploy(t);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const npm = path.join(bin, 'npm');
  fs.writeFileSync(npm, '#!/bin/sh\nprintf "%s\\n" "$*" >> npm-calls.txt\nexit 7\n');
  fs.chmodSync(npm, 0o755);
  fs.writeFileSync(state, '{"ready":true}');
  const lock = fs.readFileSync(path.join(dir, 'package-lock.json'));
  const r = spawnSync('bash', [path.join(dir, 'start.sh'), '--prepare-only', '--no-assets'], {
    cwd: dir, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, npm_execpath: '' },
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /npm ci 失败/);
  assert.equal(fs.readFileSync(path.join(dir, 'npm-calls.txt'), 'utf8'), 'ci --no-audit --no-fund\n');
  assert.equal(JSON.parse(fs.readFileSync(state)).ready, false);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'package-lock.json')), lock);
});

test('readiness is cleared before a child preparation step can be interrupted', (t) => {
  const { dir, state, check } = isolatedDeploy(t);
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'tools', 'vendor.mjs'), `export const VENDOR_FILES = [];
if (process.argv[1]?.endsWith('vendor.mjs')) {
  const fs = await import('node:fs');
  const url = new URL('../.cache/deploy-state.json', import.meta.url);
  fs.writeFileSync(new URL('../.cache/observed.json', import.meta.url), fs.readFileSync(url));
  process.exit(7);
}\n`);
  fs.writeFileSync(state, JSON.stringify({ ready: true, lockHash: fileSha256(path.join(dir, 'package-lock.json')) }));
  assert.equal(check(['--no-assets']).status, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.cache', 'observed.json'))).ready, false,
    'the previous success was cleared before vendor started');
});
