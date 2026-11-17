import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceLevelTime, applyBomb, applyBulldozer, canPlacePiece, createGame, createLevel,
  finalizeLevelWin, getLevelTimeBonus, getLevelTimeRemaining, isLevelExpired, isLevelUntimed,
  LEVEL_TIME_BONUS_PER_SECOND, placePiece, refreshPieces, requestHint, reviveGame, rotatePiece,
  type GameState, type Piece } from '../src/core/game.ts';
import type { LevelDefinition } from '../src/core/level-types.ts';
import { LEVELS } from '../src/core/levels.ts';
import { COLOR_COUNT } from '../src/core/colors.ts';

const empty = () => Array.from({ length: 8 }, () => Array<number>(8).fill(0));
const single = (): Piece => ({ id: 'mixed-single', color: 0, cells: [{ x: 0, y: 0 }] });
let fixtureNumber = 0;
function withLevel(run: (definition: LevelDefinition) => void, overrides: Partial<LevelDefinition> = {}) {
  const definition: LevelDefinition = { id: `mixed-unit-${++fixtureNumber}`, number: 31, mechanic: 'lines', learning: false,
    title: 'Mixed fixture', subtitle: '', description: '', difficulty: 7, starScores: [0, 100, 200],
    board: empty(), gems: [], ice: [], goals: [{ kind: 'lines', target: 99 }], maxMoves: 1,
    batches: [[single(), single(), single()]], solution: [], flow: { seed: 2345, openingBatches: 4 },
    timeLimitSeconds: 10, ...overrides };
  const entries = LEVELS as LevelDefinition[];
  entries.push(definition);
  try { run(definition); } finally { entries.splice(entries.indexOf(definition), 1); }
}
function oneLineFromVictory(definition: LevelDefinition, remainingMs: number): GameState {
  const initial = createLevel(definition.id);
  const board = empty(); board[0] = [1, 1, 1, 1, 1, 1, 1, 0];
  return { ...initial, score: 50, board, pieces: [single(), null, null],
    level: { ...initial.level!, timeRemainingMs: remainingMs } };
}

test('explicit null is unlimited planning and never falls back to the legacy move estimate', () => {
  withLevel(definition => {
    let state = createLevel(definition.id);
    assert.equal(isLevelUntimed(state), true);
    assert.equal(getLevelTimeRemaining(state), Infinity);
    assert.equal(state.level!.timeRemainingMs, undefined);
    assert.equal(isLevelExpired(state), false);
    assert.equal(advanceLevelTime(state, 86_400_000), state);
    state = { ...state, moves: 500, pieces: [single(), single(), single()] };
    for (const [index, x] of [[0, 0], [1, 2], [2, 4]]) {
      assert.equal(canPlacePiece(state, index, x, 0), true);
      state = placePiece(state, index, x, 0)!.state;
      assert.equal(state.status, 'playing');
    }
    assert.equal(state.moves, 503); assert.equal(state.batch, 1);
    assert.equal(state.pieces.filter(Boolean).length, 3);
    assert.ok(requestHint(state));
  }, { timeLimitSeconds: null });
});

test('unlimited-planning rotations, refresh and board rescues work beyond the server estimate', () => {
  withLevel(definition => {
    const initial = createLevel(definition.id);
    const corner: Piece = { id: 'mixed-corner', color: 0, cells: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] };
    const playing = { ...initial, moves: 500, pieces: [corner, null, null] };
    assert.ok(rotatePiece(playing, 0)); assert.ok(refreshPieces(playing)); assert.ok(requestHint(playing));
    const lost: GameState = { ...playing, status: 'lost', board: Array.from({ length: 8 }, () => Array(8).fill(1)) };
    for (const result of [applyBomb(lost, 0), applyBulldozer(lost), reviveGame(lost)]) {
      assert.ok(result); assert.equal(result.state.status, 'playing');
      assert.equal(result.state.moves, 500); assert.equal(result.state.score, lost.score);
      assert.equal(getLevelTimeRemaining(result.state), Infinity);
    }
  }, { timeLimitSeconds: null });
});

test('an omitted clock still preserves the legacy placement budget', () => {
  withLevel(definition => {
    const state = createLevel(definition.id);
    assert.equal(isLevelUntimed(state), false); assert.equal(getLevelTimeRemaining(state), Infinity);
    assert.equal(placePiece(state, 0, 0, 0)!.state.status, 'lost');
  }, { timeLimitSeconds: undefined, flow: undefined });
});

test('a timed victory adds all displayed remaining seconds once and keeps the move score separate', () => {
  assert.equal(LEVEL_TIME_BONUS_PER_SECOND, 10);
  withLevel(definition => {
    const state = oneLineFromVictory(definition, 2250), snapshot = structuredClone(state);
    assert.equal(getLevelTimeBonus(state), 0); assert.equal(state.level!.timeBonus, undefined);
    const result = placePiece(state, 0, 7, 0)!;
    assert.equal(result.state.status, 'won'); assert.equal(result.gained, 30);
    assert.equal(result.state.level!.timeBonus, 30);
    assert.equal(result.state.score, 50 + result.gained + 30);
    assert.equal(getLevelTimeBonus(result.state), 30);
    assert.equal(getLevelTimeRemaining(result.state), 2250);
    assert.equal(finalizeLevelWin(result.state), result.state);
    assert.equal(advanceLevelTime(result.state, 100_000), result.state);
    assert.equal(placePiece(result.state, 0, 7, 0), null);
    assert.equal(applyBomb(result.state, 0), null); assert.equal(applyBulldozer(result.state), null);
    assert.deepEqual(state, snapshot);
  }, { goals: [{ kind: 'lines', target: 1 }] });
});

test('the final positive millisecond is a displayed second, while zero time cannot win', () => {
  withLevel(definition => {
    const last = placePiece(oneLineFromVictory(definition, 1), 0, 7, 0)!.state;
    assert.equal(last.level!.timeBonus, 10); assert.equal(last.score, 90);
    const exact = placePiece(oneLineFromVictory(definition, 2000), 0, 7, 0)!.state;
    assert.equal(exact.level!.timeBonus, 20); assert.equal(exact.score, 100);
    const expired = oneLineFromVictory(definition, 0);
    assert.equal(placePiece(expired, 0, 7, 0), null);
    assert.equal(getLevelTimeBonus(expired), 0);
  }, { goals: [{ kind: 'lines', target: 1 }] });
});

test('a bomb that completes a goal grants the same one-time countdown award without placement points', () => {
  withLevel(definition => {
    let state = advanceLevelTime(createLevel(definition.id), 1234);
    state = { ...state, score: 70, board: empty(), pieces: [single(), null, null],
      level: { ...state.level!, gems: [{ x: 0, y: 0 }] } };
    state.board[0][0] = 2;
    const result = applyBomb(state, 0)!;
    assert.equal(result.state.status, 'won'); assert.equal(result.state.level!.timeBonus, 90);
    assert.equal(result.state.score, 160); assert.equal(result.state.level!.collectedGems, 1);
    for (const field of ['moves', 'lines', 'combo', 'batch', 'rng'] as const) assert.equal(result.state[field], state[field]);
    assert.equal(state.level!.timeBonus, undefined); assert.equal(state.score, 70);
    assert.equal(finalizeLevelWin(result.state), result.state);
  }, { mechanic: 'gems', goals: [{ kind: 'gems', target: 1 }] });
});

test('cumulative bulldozer snapshots settle one bonus even when several prefixes already satisfy the goals', () => {
  withLevel(definition => {
    const initial = advanceLevelTime(createLevel(definition.id), 2001);
    const state: GameState = { ...initial, score: 70, board: empty(), pieces: [single(), null, null],
      level: { ...initial.level!, gems: [{ x: 0, y: 5 }], clearedColors: Array(COLOR_COUNT).fill(0) } };
    state.board[5][0] = 1; state.board[6][3] = 1; state.board[7][7] = 1;
    for (const column of [0, 3, 7]) {
      const result = applyBulldozer(state, column)!;
      assert.equal(result.state.status, 'won'); assert.equal(result.state.level!.timeBonus, 80);
      assert.equal(result.state.score, 150); assert.equal(result.state.level!.collectedGems, 1);
      assert.equal(getLevelTimeRemaining(result.state), 7999);
      assert.equal(finalizeLevelWin(result.state), result.state);
    }
    assert.equal(state.score, 70); assert.equal(state.level!.timeBonus, undefined);
  }, { mechanic: 'dual', goals: [{ kind: 'gems', target: 1 }, { kind: 'color', color: 0, target: 1 }] });
});

test('unlimited and old untimed wins record zero time bonus and do not change endless or goal scores', () => {
  for (const timeLimitSeconds of [null, undefined]) withLevel(definition => {
    const result = placePiece(oneLineFromVictory(definition, 9999), 0, 7, 0)!;
    assert.equal(result.state.status, 'won'); assert.equal(result.state.score, 80);
    assert.equal(result.state.level!.timeBonus, 0); assert.equal(getLevelTimeBonus(result.state), 0);
  }, { goals: [{ kind: 'lines', target: 1 }], timeLimitSeconds });
  for (const mode of ['endless', 'goal'] as const) {
    const state = { ...createGame(mode, false, 1), status: 'won' as const };
    assert.equal(finalizeLevelWin(state), state); assert.equal(getLevelTimeBonus(state), 0);
  }
});

test('a status flag alone cannot award points before real objectives are complete', () => {
  withLevel(definition => {
    const state = { ...createLevel(definition.id), status: 'won' as const };
    assert.equal(finalizeLevelWin(state), state);
    assert.equal(state.level!.timeBonus, undefined); assert.equal(getLevelTimeBonus(state), 0);
  });
});
