// public/tutorial/ — the illustrated guide package (图文攻略): the five generated single-file pages
// (index + 4 perspectives), imported from the guide generator's output by tools/import-tutorial.mjs.
// The import swaps every embedded base64 game image for the /assets/… URL of the identical file, so
// the committed pages must carry no game art (AGENTS.md) and must only reference images the committed
// data/assets.json manifest downloads (a fresh clone + setup sees the same pages). The landing page
// carries the injected fork note (official 4-player reference vs this fork's fixed groups / capacity).
// The title screen links the package: a plain <a href="/tutorial/" target="_blank"
// rel="noopener noreferrer"> with the t('图文攻略') label in every pack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticHandler } from '../server/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TUTORIAL = path.join(ROOT, 'public', 'tutorial');
const PAGES = ['index.html', 'stronghold_eli5.html', 'how_to_play_with_teammate.html', 'lol.html', 'arknight_stronghold.html'];
const read = (p) => fs.readFileSync(p, 'utf8');

test('the five guide pages are committed, each with the import provenance comment', () => {
  for (const name of PAGES) {
    const html = read(path.join(TUTORIAL, name));
    assert.match(html, /^<!doctype html>/i, `${name} keeps its doctype`);
    assert.match(html, /Converted by tools\/import-tutorial\.mjs/, `${name} records its provenance`);
  }
});

test('no game art is embedded: the pages carry no base64 image payloads (AGENTS.md)', () => {
  for (const name of PAGES) {
    const html = read(path.join(TUTORIAL, name));
    assert.doesNotMatch(html, /data:image\/[^;"]*;base64,/, `${name} embeds no raster art`);
  }
});

test('every image the pages reference is a manifest-listed /assets/… URL (fresh-clone downloadable)', () => {
  const manifest = read(path.join(ROOT, 'data', 'assets.json'));
  const refs = new Set();
  for (const name of PAGES) {
    for (const m of read(path.join(TUTORIAL, name)).matchAll(/(?:src|href)="([^"]+)"/g)) {
      const url = m[1];
      if (!url.startsWith('/assets/')) continue;
      assert.doesNotMatch(url, /\.\.|\\|[\0]/, `${name}: safe asset path ${url}`);
      refs.add(url);
    }
  }
  assert.ok(refs.size > 0, 'the pages reference the shared game art');
  const missing = [...refs].filter((url) => !manifest.includes(`"${url}"`));
  assert.deepEqual(missing, [], 'every referenced asset is listed in data/assets.json');
});

test('the landing page carries the fork note in all five languages (official 4p reference vs this fork)', () => {
  const html = read(path.join(TUTORIAL, 'index.html'));
  assert.match(html, /sp-fork-note/);
  assert.match(html, /sp\.pref\.lang/, 'the note reads the game language choice');
  for (const key of ["'zh'", "'zh-TW'", "'en'", "'ja'", "'ko'"]) {
    assert.match(html, new RegExp(`${key}\\s*:`), `the note has a ${key} text`);
  }
  assert.match(html, /docs\/PLAYER_CAPACITY\.md/, 'the note points at the capacity rules');
});

test('the title screen links /tutorial/ in a new tab with the translated label', () => {
  const title = read(path.join(ROOT, 'public', 'js', 'screens', 'title.js'));
  const anchor = title.match(/<a class="[^"]*title-tutorial[^"]*"[^>]*>/);
  assert.ok(anchor, 'title.js has the 图文攻略 anchor');
  assert.match(anchor[0], /href="\/tutorial\/"/);
  assert.match(anchor[0], /target="_blank"/);
  assert.match(anchor[0], /rel="noopener noreferrer"/);
  assert.match(title, /t\('图文攻略'\)/, 'the label goes through t()');
  for (const pack of ['en', 'ja', 'ko', 'zh-TW']) {
    const json = JSON.parse(read(path.join(ROOT, 'public', 'i18n', `${pack}.json`)));
    assert.ok(json['图文攻略'], `${pack} translates 图文攻略`);
  }
});

test('the static server serves the guide package at /tutorial/ (index.html as the default document)', async () => {
  const handler = createStaticHandler({ publicDir: path.join(ROOT, 'public'), dataDir: path.join(ROOT, 'data'), sharedDir: path.join(ROOT, 'shared') });
  const srv = http.createServer((req, res) => {
    const [p, q] = req.url.split('?');
    handler(req, res, p, q || '');
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  try {
    const get = (url) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: url }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
      });
      req.on('error', reject);
      req.end();
    });
    for (const url of ['/tutorial/', '/tutorial/lol.html']) {
      const r = await get(url);
      assert.equal(r.status, 200, url);
      assert.match(r.type, /text\/html/);
      assert.match(r.body, /<!doctype html>/i);
    }
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});
