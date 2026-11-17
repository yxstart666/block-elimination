import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { applyBomb, applyBulldozer, canPlacePiece, createGame, createLevel, getHint, getLevelGoals, placePiece, refreshPieces, requestHint, reviveGame, rotatePiece } from '../src/core/game.ts';
import type { Cell, GameState } from '../src/core/game.ts';
import { LEVELS } from '../src/core/levels.ts';
import { COLOR_COUNT } from '../src/core/colors.ts';
import type { LevelDefinition, LevelGoal } from '../src/core/level-types.ts';

const key = (p: Cell) => `${p.x},${p.y}`;
function fixture(mechanic: 'lines' | 'gems' | 'ice' | 'dual' | 'colors' = 'lines'): GameState {
  const state = createLevel((LEVELS.find(level => level.mechanic === mechanic) ?? LEVELS[0]).id);
  state.board = Array.from({ length: 8 }, () => Array(8).fill(0));
  state.pieces = [{ id: 'single', color: 2, cells: [{ x: 0, y: 0 }] }, null, null];
  state.level!.gems = []; state.level!.ice = [];
  return state;
}

let fixtureNumber = 0;
// In-memory unit goals isolate rule boundaries from authored target changes.
function goalFixture(t: TestContext, goals: LevelGoal[]): GameState {
  const definition: LevelDefinition = { ...LEVELS[0], id: `unit-goals-${++fixtureNumber}`, goals, timeLimitSeconds: null,
    mechanic: goals.some(goal => goal.kind === 'gems') ? 'dual' : 'colors', gems: [], ice: [] };
  const entries = LEVELS as LevelDefinition[];
  entries.push(definition);
  t.after(() => { entries.splice(entries.indexOf(definition), 1); });
  const state = createLevel(definition.id);
  state.board = Array.from({ length: 8 }, () => Array(8).fill(0));
  state.pieces = [{ id: 'single', color: 0, cells: [{ x: 0, y: 0 }] }, null, null];
  return state;
}

test('bomb draws uniformly from useful complete 3x3 origins and clamps injected random values', () => {
  const state = fixture();
  state.board = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => (x + y) % 2));
  const origins = new Set<string>();
  for (let index = 0; index < 36; index++) {
    const effect = applyBomb(state, (index + .5) / 36)!;
    assert.ok(effect);
    assert.equal(effect.area.length, 9);
    const minX = Math.min(...effect.area.map(p => p.x)), minY = Math.min(...effect.area.map(p => p.y));
    assert.deepEqual({ x: minX, y: minY }, { x: index % 6, y: Math.floor(index / 6) });
    origins.add(`${minX},${minY}`);
    assert.equal(new Set(effect.area.map(key)).size, 9);
    assert.ok(effect.area.every(p => p.x >= 0 && p.x < 8 && p.y >= 0 && p.y < 8));
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      assert.equal(effect.state.board[y][x], effect.area.some(p => p.x === x && p.y === y) ? 0 : state.board[y][x]);
    }
  }
  assert.equal(origins.size, 36);
  assert.deepEqual(applyBomb(state, -1)!.area, applyBomb(state, 0)!.area);
  assert.deepEqual(applyBomb(state, NaN)!.area, applyBomb(state, 0)!.area);
  assert.deepEqual(applyBomb(state, 1)!.area, applyBomb(state, Infinity)!.area);
  assert.deepEqual(applyBomb(state, 1)!.area[0], { x: 5, y: 5 });
});

test('bomb never chooses an empty region and only requests randomness for a valid effective action', t => {
  const random = t.mock.method(Math, 'random', () => .999);
  const empty = fixture();
  assert.equal(applyBomb(empty), null);
  assert.equal(applyBomb(createGame('goal', false)), null);
  assert.equal(random.mock.callCount(), 0);
  const state = fixture(); state.board[7][7] = 4;
  const effect = applyBomb(state)!;
  assert.equal(random.mock.callCount(), 1);
  assert.deepEqual(effect.area[0], { x: 5, y: 5 });
  assert.deepEqual(effect.cleared, [{ x: 7, y: 7 }]);
  applyBomb(state, 0);
  assert.equal(random.mock.callCount(), 1, 'injected values do not draw random numbers');
});

test('bulldozer clears only fixed bottom rows and never moves blocks above them', () => {
  const state = fixture();
  state.board = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => (x + y) % 2 ? y % COLOR_COUNT + 1 : 0));
  const before = structuredClone(state), effect = applyBulldozer(state)!;
  assert.equal(effect.area.length, 24);
  assert.equal(new Set(effect.area.map(key)).size, 24);
  assert.ok(effect.area.every(p => p.y >= 5 && p.y <= 7));
  for (let y = 0; y < 8; y++) assert.deepEqual(effect.state.board[y], y < 5 ? before.board[y] : Array(8).fill(0));
  assert.equal(effect.cleared.length, 12);
  assert.deepEqual(state, before);
});

test('new tools reject goal mode, tutorial, finished, missing-level and retained timed-fixture expiry', t => {
  const base = fixture(); base.board[7][7] = 2;
  const timedDefinition: LevelDefinition = { ...LEVELS[0], id: 'unit-expired-tools', timeLimitSeconds: 10 };
  const entries = LEVELS as LevelDefinition[];
  entries.push(timedDefinition);
  t.after(() => { entries.splice(entries.indexOf(timedDefinition), 1); });
  const exhausted = createLevel(timedDefinition.id); exhausted.board[7][7] = 2;
  exhausted.level!.timeRemainingMs = 0;
  const states: GameState[] = [createGame('endless', false, 19), createGame('goal', false),
    { ...base, tutorial: true }, { ...base, status: 'won' }, { ...base, status: 'lost', pieces: [null, null, null] },
    { ...base, level: undefined }, { ...base, level: { ...base.level!, id: 'missing' } }, exhausted];
  for (const state of states) {
    const before = structuredClone(state);
    assert.equal(applyBomb(state, 0), null);
    assert.equal(applyBulldozer(state), null);
    assert.deepEqual(state, before);
  }
});

test('endless bomb and bulldozer clear their fixed areas without changing score, supply or RNG', () => {
  const state = createGame('endless', false, 19);
  state.board = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => (x + y) % 2 ? 7 : 0));
  state.pieces = [{ id: 'square', color: 3, cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] }, null, null];
  Object.assign(state, { score: 123, lines: 7, combo: 2, moves: 10, batch: 4, refreshes: 1 });
  const before = structuredClone(state);
  for (const effect of [applyBomb(state, 0), applyBulldozer(state)]) {
    assert.ok(effect);
    assert.ok(effect.cleared.length > 0);
    assert.equal(effect.state.status, 'playing');
    assert.equal(effect.state.level, undefined, 'endless tools never invent campaign progress');
    for (const field of ['score', 'lines', 'combo', 'moves', 'batch', 'rng', 'seed', 'lastLongBatch', 'refreshes', 'target'] as const) assert.equal(effect.state[field], before[field]);
    assert.deepEqual(effect.state.pieces, before.pieces);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      assert.equal(effect.state.board[y][x], effect.area.some(p => p.x === x && p.y === y) ? 0 : before.board[y][x]);
    }
    effect.state.pieces[0]!.cells[0].x = 4;
    effect.state.board[0][0] = 4;
    effect.area[0].x = 4;
  }
  assert.deepEqual(state, before);
});

test('endless destructive rescue reopens lost play only when a remaining candidate fits', () => {
  const state = createGame('endless', false, 20);
  state.board = Array.from({ length: 8 }, () => Array(8).fill(1));
  state.pieces = [{ id: 'square', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] }, null, null];
  state.status = 'lost';
  const before = structuredClone(state);
  for (const effect of [applyBomb(state, 0)!, applyBulldozer(state)!]) {
    assert.equal(effect.state.status, 'playing');
    assert.equal(effect.state.score, before.score);
    assert.equal(effect.state.moves, before.moves);
    assert.deepEqual(effect.state.pieces, before.pieces);
  }
  state.pieces[0] = { id: 'tall', cells: Array.from({ length: 5 }, (_, y) => ({ x: 0, y })) };
  assert.equal(applyBomb(state, 0)!.state.status, 'lost');
  assert.equal(applyBulldozer(state)!.state.status, 'lost');
  assert.deepEqual(state.board, before.board);
});

test('endless tools reject ineffective areas and tutorial, completed or empty-supply runs', () => {
  const empty = createGame('endless', false, 21);
  assert.equal(applyBomb(empty, 0), null);
  assert.equal(applyBulldozer(empty), null);
  empty.board[0][0] = 2;
  assert.equal(applyBulldozer(empty), null, 'top-only blocks do not consume a bulldozer');
  for (const state of [{ ...empty, tutorial: true }, { ...empty, status: 'won' as const }, { ...empty, pieces: [null, null, null] }]) {
    const before = structuredClone(state);
    assert.equal(applyBomb(state, 0), null);
    assert.equal(applyBulldozer(state), null);
    assert.deepEqual(state, before);
  }
});

test('empty destructive actions return null but an empty icy floor is a valid target', () => {
  const state = fixture('ice');
  assert.equal(applyBomb(state, 0), null); assert.equal(applyBulldozer(state), null);
  state.board[0][0] = 1;
  assert.equal(applyBulldozer(state), null, 'top-only blocks cannot waste a bulldozer reward');
  state.level!.ice = [{ x: 7, y: 7 }];
  const effect = applyBulldozer(state)!;
  assert.equal(effect.state.level!.clearedIce, 1);
  assert.deepEqual(effect.cleared, []);
  assert.equal(effect.state.board[0][0], 1);
});

test('direct destruction collects unique gems and ice, including ice on empty cells', () => {
  const state = fixture('dual');
  state.board[6][6] = 4; state.board[1][1] = 3;
  state.level!.gems = [{ x: 6, y: 6 }, { x: 1, y: 1 }];
  state.level!.ice = [{ x: 5, y: 5 }, { x: 6, y: 6 }, { x: 1, y: 1 }];
  const before = structuredClone(state), effect = applyBomb(state, 1)!;
  assert.deepEqual(effect.state.level!.gems, [{ x: 1, y: 1 }]);
  assert.deepEqual(effect.state.level!.ice, [{ x: 1, y: 1 }]);
  assert.equal(effect.state.level!.collectedGems, 1);
  assert.equal(effect.state.level!.clearedIce, 2);
  assert.equal(effect.state.board[6][6], 0); assert.equal(effect.state.board[1][1], 3);
  assert.deepEqual(state, before);
});

test('tools preserve score, line count, combo, move budget, supply and seeded RNG without dealing', () => {
  const state = fixture();
  state.board[7][7] = 5;
  Object.assign(state, { score: 123, moves: 3, lines: 2, combo: 2, batch: 1, rng: 1234, seed: 4321, lastLongBatch: 0, refreshes: 1 });
  const before = structuredClone(state);
  for (const effect of [applyBomb(state, 1), applyBulldozer(state)]) {
    assert.ok(effect);
    for (const field of ['score', 'lines', 'combo', 'moves', 'batch', 'rng', 'seed', 'lastLongBatch', 'refreshes'] as const) assert.equal(effect.state[field], before[field]);
    assert.deepEqual(effect.state.pieces, before.pieces);
    assert.equal(effect.state.status, 'playing');
    assert.deepEqual(getLevelGoals(effect.state), getLevelGoals(before));
  }
  assert.deepEqual(state, before);
});

test('clearing bottom rows does not grant line-goal credit or automatically trigger row-clear scoring', () => {
  const state = fixture();
  state.board[5] = Array(8).fill(1); state.board[6] = Array(8).fill(2); state.board[7] = Array(8).fill(3);
  const effect = applyBulldozer(state)!;
  assert.equal(effect.cleared.length, 24);
  assert.equal(effect.state.lines, 0); assert.equal(effect.state.score, 0);
  assert.equal(effect.state.status, 'playing');
});

test('tools can finish star/color goals and dual goals only win after both are complete', t => {
  for (const tool of ['bomb', 'bulldozer'] as const) {
    const state = goalFixture(t, [{ kind: 'gems', target: 2 }, { kind: 'color', color: 0, target: 4 }]);
    state.board[7][7] = 1;
    state.level!.gems = [{ x: 7, y: 7 }]; state.level!.ice = [{ x: 7, y: 7 }];
    state.level!.collectedGems = 1;
    state.level!.clearedColors[0] = 3;
    const partial = structuredClone(state); partial.level!.clearedColors[0] = 2;
    const use = (value: GameState) => tool === 'bomb' ? applyBomb(value, 1)! : applyBulldozer(value)!;
    assert.equal(use(partial).state.status, 'playing');
    const effect = use(state);
    assert.equal(effect.state.status, 'won');
    assert.ok(getLevelGoals(effect.state).every(goal => goal.current >= goal.target));
    assert.equal(effect.state.moves, 0);
    assert.equal(applyBomb(effect.state, 0), null); assert.equal(applyBulldozer(effect.state), null);
  }
});

test('destruction clones all mutable state and does not expose original coordinates through effects', () => {
  const state = fixture('dual'); state.board[6][6] = 1;
  state.level!.gems = [{ x: 6, y: 6 }, { x: 0, y: 0 }];
  state.board[0][0] = 2; state.level!.ice = [{ x: 7, y: 7 }, { x: 0, y: 1 }];
  const before = structuredClone(state), effect = applyBulldozer(state)!;
  effect.state.board[0][0] = 7; effect.state.pieces[0]!.cells[0].x = 4;
  effect.state.level!.gems[0].x = 4; effect.state.level!.ice[0].y = 4;
  effect.state.level!.clearedColors[0] = 99;
  effect.area[0].x = 4; effect.cleared[0].y = 4;
  assert.deepEqual(state, before);
});

test('line clearing counts actual block colors, including the new piece, and crossing cells only once', t => {
  const state = goalFixture(t, [{ kind: 'color', color: 0, target: 8 }]);
  for (let i = 0; i < 8; i++) { state.board[3][i] = 1; state.board[i][4] = 2; }
  state.board[3][4] = 0;
  const before = structuredClone(state), effect = placePiece(state, 0, 4, 3)!;
  assert.equal(effect.cleared.length, 15);
  assert.deepEqual(effect.state.level!.clearedColors, [8, 7, 0, 0, 0]);
  assert.equal(getLevelGoals(effect.state)[0].current, 8);
  assert.equal(effect.state.status, 'won');
  assert.equal(effect.state.lines, 2); assert.equal(effect.state.moves, 1);
  assert.deepEqual(state, before);
});

test('an uncolored candidate counts as default color zero when its placement completes a line', t => {
  const state = goalFixture(t, [{ kind: 'color', color: 0, target: 1 }]);
  state.board[0] = [2, 2, 2, 2, 2, 2, 2, 0];
  state.pieces[0] = { id: 'default-color', cells: [{ x: 0, y: 0 }] };
  const next = placePiece(state, 0, 7, 0)!.state;
  assert.deepEqual(next.level!.clearedColors, [1, 7, 0, 0, 0]);
  assert.equal(next.status, 'won');
});

test('placing, rotating and refreshing do not count colors until blocks are actually cleared', t => {
  const state = goalFixture(t, [{ kind: 'color', color: 2, target: 3 }]);
  state.pieces = [{ id: 'blue-corner', color: 2, cells: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] }, null, null];
  const before = structuredClone(state);
  for (const next of [placePiece(state, 0, 0, 0)!.state, rotatePiece(state, 0, true)!, refreshPieces(state)!]) {
    assert.deepEqual(next.level!.clearedColors, Array(COLOR_COUNT).fill(0));
    assert.equal(getLevelGoals(next)[0].current, 0);
  }
  assert.deepEqual(state, before);
});

test('bomb and bulldozer count occupied colors but empty icy cells contribute no colors', t => {
  const state = goalFixture(t, [{ kind: 'color', color: 4, target: 2 }]);
  state.board[5][5] = 5; state.board[6][6] = 5; state.board[7][7] = 2;
  state.level!.ice = [{ x: 5, y: 6 }, { x: 6, y: 5 }];
  for (const effect of [applyBomb(state, 1)!, applyBulldozer(state)!]) {
    assert.equal(effect.state.status, 'won');
    assert.deepEqual(effect.state.level!.clearedColors, [0, 1, 0, 0, 2]);
    assert.equal(effect.state.level!.clearedIce, 2);
    assert.equal(effect.state.moves, 0); assert.equal(effect.state.lines, 0); assert.equal(effect.state.score, 0);
  }
});

test('revival preserves unfinished required colors, permits ordinary blockers, and gives no color progress', t => {
  const state = goalFixture(t, [{ kind: 'color', color: 0, target: 1 }]);
  state.board = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => (x + y) % 2));
  state.pieces = [{ id: 'blocked-square', color: 0, cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] }, null, null];
  state.status = 'lost';
  assert.equal(reviveGame(state), null, 'all blockers are still-required red blocks');
  const completed = structuredClone(state); completed.level!.clearedColors[0] = 1;
  const ordinary = reviveGame(completed)!;
  assert.ok(ordinary); assert.ok(ordinary.cleared.length > 0);
  assert.deepEqual(ordinary.state.level!.clearedColors, [1, 0, 0, 0, 0]);
  state.board[0][1] = 2; state.board[1][0] = 0;
  const before = structuredClone(state), allowed = reviveGame(state)!;
  assert.deepEqual(allowed.cleared, [{ x: 1, y: 0 }]);
  assert.deepEqual(allowed.state.level!.clearedColors, Array(COLOR_COUNT).fill(0));
  assert.equal(allowed.state.status, 'playing');
  assert.deepEqual(state, before);
});

test('retained ice goals still complete through destructive tools for future levels', t => {
  const state = goalFixture(t, [{ kind: 'ice', target: 1 }]);
  state.level!.ice = [{ x: 7, y: 7 }];
  assert.equal(applyBomb(state, 1)!.state.status, 'won');
  assert.equal(applyBulldozer(state)!.state.status, 'won');
  assert.deepEqual(state.level!.clearedColors, Array(COLOR_COUNT).fill(0));
});

test('destructive rescue can reopen a blocked lost campaign without adding moves', () => {
  const state = fixture(); state.status = 'lost';
  state.board = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => (x + y) % 2));
  state.pieces = [{ id: 'square', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] }, null, null];
  for (const effect of [applyBomb(state, 0)!, applyBulldozer(state)!]) {
    assert.equal(effect.state.status, 'playing');
    assert.equal(effect.state.moves, state.moves);
    assert.ok(effect.cleared.length > 0);
  }
});

test('random rescue remains lost when the cleared region still cannot fit the remaining candidate', () => {
  const state = fixture(); state.status = 'lost';
  state.board = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => (x + y) % 2));
  state.pieces = [{ id: 'tall', cells: Array.from({ length: 5 }, (_, y) => ({ x: 0, y })) }, null, null];
  assert.equal(applyBomb(state, 0)!.state.status, 'lost');
  assert.equal(applyBulldozer(state)!.state.status, 'lost');
});

test('campaign hint is one legal deterministic suggestion and does not place or advance seeded state', t => {
  const state = goalFixture(t, [{ kind: 'color', color: 0, target: 1 }]);
  state.board[0] = [2, 2, 2, 2, 2, 2, 2, 0];
  const before = structuredClone(state), hint = requestHint(state)!;
  assert.ok(hint); assert.ok(canPlacePiece(state, hint.index, hint.x, hint.y));
  assert.deepEqual(hint, { index: 0, x: 7, y: 0 });
  assert.deepEqual(getHint(state), hint);
  assert.deepEqual(state, before);
  for (const invalid of [{ ...state, status: 'lost' as const }, { ...state, status: 'won' as const },
    { ...state, tutorial: true }, createGame('goal', false)]) assert.equal(requestHint(invalid), null);
});

test('endless hint returns a deterministic legal placement without altering the run', () => {
  const state = createGame('endless', false, 7);
  state.board = Array.from({ length: 8 }, () => Array(8).fill(1));
  state.board[7][7] = 0;
  state.pieces = [{ id: 'single', color: 3, cells: [{ x: 0, y: 0 }] }, null, null];
  Object.assign(state, { score: 100, combo: 2, lines: 3, moves: 7 });
  const before = structuredClone(state), hint = requestHint(state)!;
  assert.deepEqual(hint, { index: 0, x: 7, y: 7 });
  assert.ok(canPlacePiece(state, hint.index, hint.x, hint.y));
  assert.deepEqual(requestHint(state), hint);
  assert.deepEqual(getHint(state), hint);
  assert.deepEqual(state, before);
  for (const invalid of [{ ...state, tutorial: true }, { ...state, status: 'lost' as const },
    { ...state, status: 'won' as const }, { ...state, pieces: [null, null, null] }]) assert.equal(requestHint(invalid), null);
});
