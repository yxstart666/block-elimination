import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createGame, createLevel, placePiece } from '../src/core/game.ts';
import { LEVELS } from '../src/core/levels.ts';
import { COLOR_COUNT } from '../src/core/colors.ts';
import { chooseBlindMove, firstTrayBranches, legalMoves, previewMove, runBlind } from '../scripts/pacing-bench.mjs';

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const colorIndependent = (state: ReturnType<typeof createGame>) => ({ ...state,
  board: state.board.map(row => row.map(value => Number(value !== 0))),
  pieces: state.pieces.map(piece => piece && Object.fromEntries(Object.entries(piece).filter(([key]) => key !== 'color'))),
});
function verifyPalette(state: ReturnType<typeof createGame>) {
  assert.ok(state.board.flat().every(value => Number.isInteger(value) && value >= 0 && value <= COLOR_COUNT));
  assert.ok(state.pieces.every(piece => !piece || Number.isInteger(piece.color) && piece.color! >= 0 && piece.color! < COLOR_COUNT));
}

test('five-color endless preserves accepted occupancy, shapes, RNG and scoring over thirty identical placements', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/endless-before.json', import.meta.url), 'utf8'));
  assert.equal(fixture.replays.length, 4);
  for (const replay of fixture.replays) {
    assert.equal(replay.actions.length, 30);
    assert.equal(replay.colorIndependentStates.length, 31);
    let state = createGame('endless', false, replay.seed);
    verifyPalette(state);
    assert.equal(digest(colorIndependent(state)), replay.colorIndependentStates[0], `seed ${replay.seed}: initial geometry and RNG`);
    replay.actions.forEach((move: { index: number; x: number; y: number }, index: number) => {
      const result = placePiece(state, move.index, move.x, move.y);
      assert.ok(result, `seed ${replay.seed}: accepted action ${index + 1}`);
      state = result.state;
      verifyPalette(state);
      assert.equal(digest(colorIndependent(state)), replay.colorIndependentStates[index + 1], `seed ${replay.seed}: occupancy, supply geometry, score and RNG at move ${index + 1}`);
    });
  }
});

test('the independent visible-tray model agrees with actual clears and newly placed stars', () => {
  for (const definition of LEVELS) {
    let state = createLevel(definition.id);
    for (let step = 0; step < 12 && state.status === 'playing'; step++) {
      const move = chooseBlindMove(state, definition, 19, 'tray-beam');
      assert.ok(move);
      const expected = previewMove(state, move, definition), actual = placePiece(state, move.index, move.x, move.y)!.state;
      for (const field of ['board', 'level', 'moves', 'score', 'lines', 'combo'] as const) {
        assert.deepEqual(actual[field], expected[field], `${definition.id}: independent ${field} at move ${step + 1}`);
      }
      state = actual;
    }
  }
});

test('all campaign starts offer many complete first-tray routes rather than one required opening', () => {
  for (const definition of LEVELS) {
    assert.ok(definition.flow, `${definition.id}: runtime supply follows the played board`);
    const state = createLevel(definition.id), branches = firstTrayBranches(state);
    assert.ok(state.board.flat().filter(Boolean).length <= 22, `${definition.id}: initial board retains ample room`);
    assert.ok(branches.fullTrayFirstMoves >= 12, `${definition.id}: at least twelve distinct first actions permit all three blocks (${branches.fullTrayFirstMoves}/${branches.legalFirstMoves})`);
    assert.ok(branches.distinctOrigins >= 8, `${definition.id}: choices use several board positions`);
  }
});

test('visible-board policies can start differently, clear early and survive the next tray', () => {
  for (const definition of LEVELS) {
    const runs = [19, 120, 221].map(seed => runBlind({ createLevel, placePiece }, definition, seed, 'tray-beam', 12));
    assert.ok(runs.every(run => run.survivedFirstTray), `${definition.id}: reasonable policies use the first group`);
    assert.ok(runs.filter(run => run.survivedSecondTray).length >= 2, `${definition.id}: more than one independent choice survives a refill`);
    assert.ok(runs.filter(run => run.firstClear !== null && run.firstClear <= 3).length >= 2,
      `${definition.id}: visible placements give a clear in the first three moves`);
    assert.ok(runs.every(run => run.at12.lines >= 2), `${definition.id}: the opening has repeated clear feedback`);
  }
});

test('campaign runtime ignores reference batches and route data after three different opening actions', () => {
  for (const definition of LEVELS) {
    const initial = createLevel(definition.id);
    const moves = legalMoves(initial);
    // Distinct ends of the displayed set exercise actual alternate origins;
    // the checker only requires one accepted placement before the blind policy.
    const firstMoves = [moves[0], moves[Math.floor(moves.length / 2)], moves.at(-1)];
    assert.equal(new Set(firstMoves.map(move => `${move.index},${move.x},${move.y}`)).size, 3);
    const batches = definition.batches, solution = definition.solution;
    try {
      definition.batches = []; definition.solution = [];
      assert.deepEqual(createLevel(definition.id), initial, `${definition.id}: reference data is not runtime supply`);
      for (const first of firstMoves) {
        let state = placePiece(initial, first.index, first.x, first.y)!.state;
        while (state.status === 'playing' && state.moves < 6) {
          const move = chooseBlindMove(state, definition, 19, 'tray-beam');
          assert.ok(move, `${definition.id}: alternate opening keeps a legal visible choice`);
          state = placePiece(state, move.index, move.x, move.y)!.state;
        }
        assert.notEqual(state.status, 'lost', `${definition.id}: alternate opening does not require the witness`);
        assert.ok(state.batch >= 2 || state.status === 'won', `${definition.id}: fresh adaptive groups continue without reference batches`);
      }
    } finally { definition.batches = batches; definition.solution = solution; }
  }
});
