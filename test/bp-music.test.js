import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createBpMusic, BP_MUSIC_PREFIX } from '../server/bpMusic.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-bp-music-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function request(port, url, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('music request timed out')));
    req.end();
  });
}

test('missing, relative and empty playlists fall back before modulo, including seed zero', async (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'empty.mp3'), '');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not audio');
  fs.mkdirSync(path.join(dir, 'directory.mp3'));
  for (const folder of ['', dir, path.join(dir, 'missing'), 'relative']) {
    const music = await createBpMusic({ folder });
    assert.equal(music.count, 0);
    for (const seed of [0, 1, 4294967295, NaN, -1]) assert.equal(music.select(seed), null);
  }
});

test('stable filename ordering and seed modulo select only readable top-level regular MP3s', async (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'z last.mp3'), 'Z');
  fs.writeFileSync(path.join(dir, 'A first.MP3'), 'A');
  fs.writeFileSync(path.join(dir, '中文.mp3'), 'C');
  fs.writeFileSync(path.join(dir, '.private.mp3'), 'secret');
  fs.mkdirSync(path.join(dir, 'nested'));
  fs.writeFileSync(path.join(dir, 'nested', 'ignored.mp3'), 'N');
  const music = await createBpMusic({ folder: dir });
  assert.equal(music.count, 3);
  for (const [seed, bytes] of [[0, 'A'], [1, 'Z'], [2, 'C'], [3, 'A'], [4294967295, 'A']]) {
    const url = music.select(seed);
    assert.match(url, /^\/api\/bp-music\/[a-f0-9]{64}$/);
    assert.equal(url.includes(dir), false);
    const track = await music.resolve(url.slice(BP_MUSIC_PREFIX.length));
    assert.equal(fs.readFileSync(track.file, 'utf8'), bytes);
  }
  assert.equal(music.select('1'), null);
  assert.equal(music.select(1.5), null);
  assert.equal(await music.resolve('../secret.mp3'), null);
});

test('a playlist refuses symlink MP3s and a selected file replaced by a symlink', async (t) => {
  const dir = fixture(t);
  const outside = path.join(dir, 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  try { fs.symlinkSync(outside, path.join(dir, 'linked.mp3')); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(error.code); return; } throw error; }
  const file = path.join(dir, 'safe.mp3');
  fs.writeFileSync(file, 'safe');
  const music = await createBpMusic({ folder: dir });
  assert.equal(music.count, 1);
  const id = music.select(0).slice(BP_MUSIC_PREFIX.length);
  fs.unlinkSync(file);
  fs.symlinkSync(outside, file);
  assert.equal(await music.resolve(id), null);
});

test('BP audio HTTP supports GET/HEAD, ranges and revalidation without exposing the folder', async (t) => {
  const dir = fixture(t);
  const bytes = Buffer.from([0, 1, 2, 3, 4, 5]);
  fs.writeFileSync(path.join(dir, 'song.mp3'), bytes);
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, mp3Folder: dir });
  t.after(() => srv.close());
  const url = srv.lobby.bpMusic.select(1);
  const full = await request(srv.port, url);
  assert.equal(full.status, 200);
  assert.equal(full.headers['content-type'], 'audio/mpeg');
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.equal(full.headers['cache-control'], 'no-cache');
  assert.deepEqual(full.body, bytes);
  const head = await request(srv.port, url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-length'], '6');
  const range = await request(srv.port, url, { headers: { range: 'bytes=1-3' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers['content-range'], 'bytes 1-3/6');
  assert.deepEqual(range.body, bytes.subarray(1, 4));
  const cached = await request(srv.port, url, { headers: { 'if-none-match': full.headers.etag } });
  assert.equal(cached.status, 304);
  const invalidRange = await request(srv.port, url, { headers: { range: 'bytes=99-' } });
  assert.equal(invalidRange.status, 416);
  for (const bad of ['/api/bp-music', '/api/bp-music/', '/api/bp-music/song.mp3', '/api/bp-music/../secret.txt', '/api/bp-music/%2e%2e%2fsecret.txt']) {
    const response = await request(srv.port, bad);
    assert.equal(response.status, 404, bad);
    assert.equal(response.body.toString().includes(dir), false);
  }
  fs.unlinkSync(path.join(dir, 'song.mp3'));
  assert.equal((await request(srv.port, url)).status, 404);
});

test('real match players share effective-seed music across setup rerolls, drafts and reconnect', { timeout: 15000 }, async (t) => {
  const dir = fixture(t);
  for (const name of ['a', 'b', 'c']) fs.writeFileSync(path.join(dir, `${name}.mp3`), name);
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, mp3Folder: dir, seedFn: () => 0 });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map((client) => client.terminate())); await srv.close(); });
  const player = async (name, token) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    clients.push(c);
    const welcome = await c.hello(name, token);
    c.token = welcome.token;
    return c;
  };
  const ok = async (client, msg) => assert.equal((await client.request(msg)).t, 'ok');
  const host = await player('Host');
  await ok(host, { t: 'room.create', mode: 'coop', difficulty: 'HARD' });
  const room = await host.waitFor('room.state');
  const guest = await player('Guest');
  await ok(guest, { t: 'room.join', code: room.code });
  await ok(guest, { t: 'room.ready', ready: true });
  await ok(host, { t: 'room.start' });
  const first = await host.waitFor('m.public', (pub) => pub.phase === 'INFO_CHECK');
  const other = await guest.waitFor('m.public', (pub) => pub.phase === 'INFO_CHECK');
  const m = srv.lobby.rooms.get(room.code).match;
  assert.equal(m.seed, 1, 'gameplay seed zero is normalized by the existing Match constructor');
  assert.equal(first.bpBgm, srv.lobby.bpMusic.select(m.seed));
  assert.equal(other.bpBgm, first.bpBgm);
  const track = await request(srv.port, first.bpBgm);
  assert.equal(track.body.toString(), 'b', 'effective seed 1 modulo 3 chooses zero-based index 1');
  await ok(host, { t: 'room.rerollSetup', setupRevision: 0 });
  const vote = await host.waitFor('m.public', (pub) => !!pub.rerollVote);
  await ok(guest, { t: 'g.rerollVote', voteId: vote.rerollVote.id, agree: true });
  const rerolled = await host.waitFor('m.public', (pub) => pub.setupRevision === 1);
  assert.equal(rerolled.bpBgm, first.bpBgm);
  await guest.terminate();
  const resumed = await player('Guest', guest.token);
  assert.equal((await resumed.waitFor('m.public', (pub) => pub.setupRevision === 1)).bpBgm, first.bpBgm);
  await ok(host, { t: 'g.infoReady', setupRevision: 1 });
  await ok(resumed, { t: 'g.infoReady', setupRevision: 1 });
  const draft = await host.waitFor('m.public', (pub) => pub.phase === 'BAND_DRAFT');
  assert.equal(draft.bpBgm, first.bpBgm);
});
