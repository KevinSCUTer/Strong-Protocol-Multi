// 干员皮肤 → 战场 (docs/SKINS.md): the skin a player picked reaches the battle — PlayerState.skins → battleInput()
// units[].skin → BattleSpec (client combat: b.start) → sim Unit.skin → snapshot unitInfo().skin, which the renderer
// passes to assets.spineEntry({ skin }). Golden / promoted pieces keep their base chess's skin; bots wear defaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { buildBattleSpec, createBattleFromSpec } from '../../server/sim/spec.js';
import { unitInfo } from '../../server/sim/snapshot.js';
import { DATA, makeMatch } from './harness.js';

const INSIDE = 'chess_char_1_01_a';
const SKIN = 'char_498_inside@test#1';
const chess = (id) => (Object.hasOwn(DATA.chess, id) ? DATA.chess[id] : null);

function seats(skins, bots = 0) {
  const s = [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true, skins }];
  for (let i = 0; i < bots; i++) s.push({ seat: s.length, playerId: `ai_${i}`, name: `AI${i}`, isBot: true, connected: true });
  return s;
}
function place(ps, chessId, row, col) {
  const p = ps.newPiece('chess', chessId);
  ps.board.set(`${row},${col}`, p);
  return p;
}
function freshBoard(ps) {
  for (const p of [...ps.board.values()]) ps.returnCopies(p);
  ps.board.clear();
}

test('battleInput carries the chosen skin, golden pieces inherit the base chess skin, others have none', () => {
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seats: seats({ [INSIDE]: SKIN }), seed: 3 }).start();
  const ps = h.ps('p_0');
  h.toPrep(1);
  freshBoard(ps);
  place(ps, INSIDE, 9, 3);
  place(ps, chess(INSIDE).goldenId, 10, 3);
  const other = Object.values(DATA.chess).find((c) => !c.isGolden && c.visible && !c.isHidden && !c.isDiy && c.chessId !== INSIDE);
  place(ps, other.chessId, 11, 3);
  const units = ps.battleInput().units;
  const by = (id) => units.find((u) => u.chessId === id);
  assert.equal(by(INSIDE).skin, SKIN);
  assert.equal(by(chess(INSIDE).goldenId).skin, SKIN, 'golden keeps the base skin');
  assert.equal(by(other.chessId).skin, undefined);
  h.m.dispose();
});

test('the skin survives BattleSpec and reaches the sim unit and its snapshot info', () => {
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seats: seats({ [INSIDE]: SKIN }), seed: 5 }).start();
  const m = h.m;
  const ps = h.ps('p_0');
  h.toPrep(1);
  freshBoard(ps);
  place(ps, INSIDE, 9, 3);
  const spec = buildBattleSpec(m._normalOpts(ps));
  const su = spec.players[0].units.find((u) => u.chessId === INSIDE);
  assert.equal(su.skin, SKIN, 'BattleSpec keeps skin');
  const b = createBattleFromSpec(spec, DATA, { quiet: true, recordEvents: false });
  const unit = b.units.find((u) => u.side === 'ally' && u.defId === INSIDE);
  assert.ok(unit, 'operator deployed');
  assert.equal(unit.skin, SKIN);
  assert.equal(unitInfo(unit).skin, SKIN, 'snapshot tells the renderer');
  m.dispose();
});

test('client-side combat: b.start spec carries the skin', () => {
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seats: seats({ [INSIDE]: SKIN }), seed: 9, clientCombat: true, clients: false }).start();
  const m = h.m;
  const ps = h.ps('p_0');
  h.toPrep(1);
  freshBoard(ps);
  place(ps, INSIDE, 10, 3);
  ps.resolveTemp();
  assert.deepEqual(m.handle('p_0', { t: 'g.ready', ready: true }), { ok: true });
  h.run(() => m.phase === PHASE.COMBAT);
  const start = h.lastTo('p_0', 'b.start');
  assert.equal(start.spec.players[0].units.find((x) => x.chessId === INSIDE).skin, SKIN);
  m.dispose();
});

test('a skin changed mid-match (Match.setSkins) applies to the next battle', () => {
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seats: seats(null), seed: 11 }).start();
  const m = h.m;
  const ps = h.ps('p_0');
  h.toPrep(1);
  freshBoard(ps);
  place(ps, INSIDE, 9, 3);
  assert.equal(ps.battleInput().units[0].skin, undefined);
  assert.deepEqual(m.setSkins('p_0', { [INSIDE]: SKIN }), { ok: true });
  assert.equal(ps.battleInput().units[0].skin, SKIN);
  m.dispose();
});
