import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceLevelTime, applyBomb, applyBulldozer, canPlacePiece, createGame, createLevel,
  getLevelTimeBonus, getLevelTimeRemaining, isLevelExpired, placePiece, refreshPieces, requestHint, reviveGame, rotatePiece,
  type GameState, type Piece } from '../src/core/game.ts';
import { LEVELS } from '../src/core/levels.ts';
import type { LevelDefinition } from '../src/core/level-types.ts';

const empty = () => Array.from({ length: 8 }, () => Array(8).fill(0));
const single = (): Piece => ({ id: 'timer-single', color: 0, cells: [{ x: 0, y: 0 }] });
function withLevel(run: (definition: LevelDefinition) => void, overrides: Partial<LevelDefinition> = {}) {
  const definition: LevelDefinition = { id: 'timer-fixture', number: 31, mechanic: 'lines', learning: false,
    title: 'Timer fixture', subtitle: '', description: '', difficulty: 5, starScores: [0, 10, 20],
    board: empty(), gems: [], ice: [], goals: [{ kind: 'lines', target: 99 }],
    batches: [[single(), single(), single()]], solution: [], maxMoves: 1,
    timeLimitSeconds: 10, flow: { seed: 2345, openingBatches: 4 }, ...overrides };
  const mutable = LEVELS as LevelDefinition[];
  mutable.push(definition);
  try { run(definition); } finally { mutable.pop(); }
}

test('active campaign time is initialized in integer milliseconds and retries receive the full allowance', () => {
  withLevel(definition => {
    const initial = createLevel(definition.id), after = advanceLevelTime(initial, 1234);
    assert.equal(initial.level!.timeRemainingMs, 10_000);
    assert.equal(getLevelTimeRemaining(after), 8766);
    assert.equal(getLevelTimeRemaining(createLevel(definition.id)), 10_000);
    assert.notEqual(after.level, initial.level);
    assert.equal(initial.level!.timeRemainingMs, 10_000, 'elapsed time does not mutate a previous state');
    for (const field of ['board', 'pieces', 'score', 'moves', 'lines', 'rng', 'batch'] as const) assert.deepEqual(after[field], initial[field]);
  });
});

test('timer advancement ignores invalid deltas, untimed modes and terminal states', () => {
  withLevel(definition => {
    const initial = createLevel(definition.id);
    for (const elapsed of [0, -.5, -100, NaN, Infinity, -Infinity, .5]) assert.equal(advanceLevelTime(initial, elapsed), initial);
    const won = { ...initial, status: 'won' as const }, lost = { ...initial, status: 'lost' as const };
    assert.equal(advanceLevelTime(won, 1000), won);
    assert.equal(advanceLevelTime(lost, 1000), lost);
  });
  for (const state of [createGame('endless', true, 1), createGame('endless', false, 1), createGame('goal', false, 1)]) {
    assert.equal(getLevelTimeRemaining(state), Infinity);
    assert.equal(isLevelExpired(state), false);
    assert.equal(advanceLevelTime(state, 1000), state);
  }
  withLevel(definition => {
    const state = createLevel(definition.id);
    assert.equal(getLevelTimeRemaining(state), Infinity);
    assert.equal(advanceLevelTime(state, 1000), state);
  }, { timeLimitSeconds: undefined });
});

test('timed flow can place and refill beyond its offline/server move estimate without resetting its clock', () => {
  withLevel(definition => {
    let state = advanceLevelTime(createLevel(definition.id), 1234);
    state = { ...state, moves: 500, pieces: [single(), single(), single()] };
    for (const [index, x] of [[0, 0], [1, 2], [2, 4]]) {
      assert.equal(canPlacePiece(state, index, x, 0), true);
      state = placePiece(state, index, x, 0)!.state;
      assert.equal(state.status, 'playing');
      assert.equal(state.level!.timeRemainingMs, 8766);
    }
    assert.equal(state.moves, 503);
    assert.equal(state.batch, 1);
    assert.equal(state.pieces.filter(Boolean).length, 3);
    assert.ok(requestHint(state), 'hints also ignore the server estimate while time remains');
  });
});

test('time clamps at zero and an expired run cannot place, rotate, refresh, hint or rescue', () => {
  withLevel(definition => {
    let state = createLevel(definition.id);
    state.board[6][6] = 2;
    state.pieces = [{ id: 'timer-corner', color: 1, cells: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] }, null, null];
    const expired = advanceLevelTime(state, 25_000);
    assert.equal(expired.status, 'lost');
    assert.equal(expired.level!.timeRemainingMs, 0);
    assert.equal(isLevelExpired(expired), true);
    assert.equal(canPlacePiece(expired, 0, 0, 0), false);
    assert.equal(placePiece(expired, 0, 0, 0), null);
    assert.equal(rotatePiece(expired, 0), null);
    assert.equal(refreshPieces(expired), null);
    assert.equal(requestHint(expired), null);
    assert.equal(applyBomb(expired, 0), null);
    assert.equal(applyBulldozer(expired), null);
    assert.equal(reviveGame(expired), null);
    assert.equal(advanceLevelTime(expired, 1000), expired);
    const stalePlaying = { ...expired, status: 'playing' as const };
    assert.equal(placePiece(stalePlaying, 0, 0, 0), null, 'a stale UI flag cannot bypass zero time');
    assert.equal(rotatePiece(stalePlaying, 0), null);
    assert.equal(refreshPieces(stalePlaying), null);
  });
});

test('board rescues preserve remaining time and remain available after the move estimate while time is positive', () => {
  withLevel(definition => {
    const initial = advanceLevelTime(createLevel(definition.id), 3500);
    const state: GameState = { ...initial, moves: 500, pieces: [single(), null, null], status: 'lost',
      board: Array.from({ length: 8 }, () => Array(8).fill(1)) };
    for (const result of [applyBomb(state, 0), applyBulldozer(state), reviveGame(state)]) {
      assert.ok(result);
      assert.equal(result.state.status, 'playing');
      assert.equal(result.state.moves, 500);
      assert.equal(getLevelTimeRemaining(result.state), 6500);
    }
  });
});

test('a goal completed with the final positive millisecond wins and cannot later expire', () => {
  withLevel(definition => {
    let state = advanceLevelTime(createLevel(definition.id), 9999);
    state = { ...state, moves: 500, pieces: [single(), null, null], board: empty() };
    state.board[0] = [1, 1, 1, 1, 1, 1, 1, 0];
    const won = placePiece(state, 0, 7, 0)!.state;
    assert.equal(won.status, 'won');
    assert.equal(getLevelTimeRemaining(won), 1);
    assert.equal(isLevelExpired(won), false);
    assert.equal(advanceLevelTime(won, 50_000), won);
  }, { goals: [{ kind: 'lines', target: 1 }] });
});

test('untimed legacy fixed fixtures still enforce their placement budget', () => {
  withLevel(definition => {
    const initial = createLevel(definition.id);
    const result = placePiece(initial, 0, 0, 0)!.state;
    assert.equal(result.status, 'lost');
    assert.equal(result.moves, 1);
  }, { flow: undefined, timeLimitSeconds: undefined });
});

test('all campaign levels allow their genuine three-star witness regardless of thinking time', () => {
  for (const definition of LEVELS) {
    assert.equal(definition.timeLimitSeconds, null);
    let state = createLevel(definition.id);
    for (const move of definition.solution) {
      state = advanceLevelTime(state, 14_400_000);
      assert.equal(state.status, 'playing', `${definition.id}: even hours of thinking leave a live board`);
      state = placePiece(state, move.index, move.x, move.y)!.state;
    }
    assert.equal(state.status, 'won');
    assert.equal(state.score, definition.starScores[2]);
    assert.equal(getLevelTimeRemaining(state), Infinity);
    assert.equal(getLevelTimeBonus(state), 0);
    assert.equal(state.level!.timeRemainingMs, undefined, 'campaign runs contain no countdown');
  }
});

test('every campaign remains playable beyond its offline move estimate without a hidden budget', () => {
  for (const definition of LEVELS) {
    const initial = createLevel(definition.id);
    const state: GameState = { ...initial, moves: definition.maxMoves + 100, board: empty(),
      pieces: [single(), single(), single()] };
    const elapsed = advanceLevelTime(state, 86_400_000);
    assert.equal(elapsed, state);
    const result = placePiece(elapsed, 0, 0, 0);
    assert.ok(result, `${definition.id}: placement works beyond the estimate`);
    assert.equal(result.state.status, 'playing');
    assert.ok(requestHint(result.state));
    assert.equal(getLevelTimeRemaining(result.state), Infinity);
  }
});
