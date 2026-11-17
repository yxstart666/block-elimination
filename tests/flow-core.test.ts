import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, createLevel, findHint, getLevelGoals, getLevelStage, placePiece, refreshPieces, rotatePiece } from '../src/core/game.ts';
import type { Cell, GameState, Hint, Piece } from '../src/core/game.ts';
import { LEVELS } from '../src/core/levels.ts';
import type { LevelDefinition } from '../src/core/level-types.ts';

const emptyBoard = () => Array.from({ length: 8 }, () => Array<number>(8).fill(0));
const single = (star = false): Piece => ({ id: 'fixture-single', color: 4, cells: [{ x: 0, y: 0 }], ...(star ? { star: true } : {}) });
let fixtureNumber = 0;
function withLevel(run: (level: LevelDefinition) => void, overrides: Partial<LevelDefinition> = {}) {
  const level: LevelDefinition = {
    id: `flow-unit-${++fixtureNumber}`, number: 1, mechanic: 'lines', learning: false,
    title: 'Flow fixture', subtitle: '', description: '', difficulty: 8, starScores: [1, 2, 3],
    board: emptyBoard(), gems: [], ice: [], goals: [{ kind: 'lines', target: 100 }],
    batches: [[single(), single(), single()]], solution: [], maxMoves: 300,
    flow: { seed: 145875, openingBatches: 4 }, ...overrides,
  };
  LEVELS.push(level);
  try { run(level); } finally { LEVELS.splice(LEVELS.indexOf(level), 1); }
}

// Independent geometry proves the dealt tray has a complete route, rather than
// trusting hasMove (which only establishes that one of its blocks can be used).
function resolve(board: number[][], piece: Piece, x: number, y: number): number[][] | null {
  const placed = piece.cells.map(cell => ({ x: x + cell.x, y: y + cell.y }));
  if (!placed.length || placed.some(cell => cell.x < 0 || cell.x > 7 || cell.y < 0 || cell.y > 7 || board[cell.y][cell.x])) return null;
  const next = board.map(row => row.slice());
  for (const cell of placed) next[cell.y][cell.x] = (piece.color ?? 0) + 1;
  const rows = next.flatMap((row, py) => row.every(Boolean) ? [py] : []);
  const columns = Array.from({ length: 8 }, (_, px) => px).filter(px => next.every(row => row[px]));
  for (let py = 0; py < 8; py++) for (let px = 0; px < 8; px++) if (rows.includes(py) || columns.includes(px)) next[py][px] = 0;
  return next;
}
function trayRoute(board: number[][], pieces: (Piece | null)[]): Hint[] | null {
  if (!pieces.some(Boolean)) return [];
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index];
    if (!piece) continue;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const next = resolve(board, piece, x, y);
      if (!next) continue;
      const remaining = pieces.map((entry, slot) => slot === index ? null : entry);
      const route = trayRoute(next, remaining);
      if (route) return [{ index, x, y }, ...route];
    }
  }
  return null;
}
function play(state: GameState, route: Hint[]): GameState {
  for (const move of route) {
    const result = placePiece(state, move.index, move.x, move.y);
    assert.ok(result, 'independently legal placement is accepted');
    state = result.state;
  }
  return state;
}

test('flow stages average capped goals, allow a warmup, and do not consume randomness', () => {
  withLevel(level => {
    const initial = createLevel(level.id);
    const snapshot = structuredClone(initial);
    const at = (moves: number, lines: number, stars: number) => ({ ...initial, moves, lines,
      level: { ...initial.level!, collectedGems: stars } });
    assert.equal(getLevelStage(at(0, 1000, 1000)), 'opening', 'a quick early clear cannot skip warmup');
    assert.equal(getLevelStage(at(11, 100, 100)), 'opening');
    assert.equal(getLevelStage(at(12, 0, 0)), 'opening', 'a slow start keeps early assistance');
    assert.equal(getLevelStage(at(12, 70, 0)), 'building', 'two goal fractions are averaged');
    assert.equal(getLevelStage(at(12, 1000, 0)), 'building', 'overshooting one objective cannot hide the other');
    assert.equal(getLevelStage(at(12, 100, 50)), 'finish');
    assert.equal(getLevelStage(at(15, 100, 49)), 'building');
    for (let i = 0; i < 10; i++) { getLevelStage(initial); getLevelGoals(initial); }
    assert.deepEqual(initial, snapshot);
  }, { goals: [{ kind: 'lines', target: 100 }, { kind: 'gems', target: 100 }] });
});

test('seeded flow retries are independent and replenish beyond the reference witness', () => {
  withLevel(level => {
    let state = createLevel(level.id);
    const retry = createLevel(level.id);
    assert.deepEqual(state, retry);
    assert.equal(state.seed, level.flow!.seed);
    assert.notEqual(state.rng, state.seed);
    for (let group = 0; group < 5; group++) {
      assert.ok(state.pieces.every(piece => piece && piece.cells.length <= 4));
      assert.ok(state.pieces.every(piece => !piece || piece.cells.length < 4 ||
        !piece.cells.every(cell => cell.x === piece.cells[0].x) && !piece.cells.every(cell => cell.y === piece.cells[0].y)));
      const route = trayRoute(state.board, state.pieces);
      assert.ok(route && route.length === 3);
      state = play(state, route);
      assert.equal(state.batch, group + 1);
      assert.equal(state.status, 'playing');
    }
    assert.ok(state.batch > level.batches.length);
    assert.deepEqual(createLevel(level.id), retry);
    state.board[0][0] = 7;
    state.pieces[0]!.cells[0].x = 70;
    assert.deepEqual(createLevel(level.id), retry, 'sessions do not alias authored or earlier data');
  });
});

test('opening, building and finish trays have a complete three-placement route, including crowded boards', () => {
  withLevel(level => {
    for (const seed of [2, 19, 172, 4321]) for (const progress of [0, 50, 85]) {
      level.flow!.seed = seed;
      const start = createLevel(level.id);
      const board = emptyBoard();
      for (let y = 1; y < 8; y++) for (let x = 0; x < 8; x++) if ((x + y) % 3 !== 0) board[y][x] = 1;
      const state = { ...start, moves: 15, lines: progress, board, pieces: [single(), null, null] };
      const dealt = placePiece(state, 0, 0, 0)!.state;
      assert.equal(dealt.status, 'playing');
      assert.ok(trayRoute(dealt.board, dealt.pieces), `seed ${seed} progress ${progress}`);
      if (progress < 35) assert.ok(dealt.pieces.every(piece => piece!.cells.length <= 4));
      if (progress === 50) assert.ok(dealt.pieces.every(piece => piece!.cells.length <= 6));
    }
  });
});

test('a refill reads progress from the move that just completed the group, while victory precedes the budget', () => {
  withLevel(level => {
    const initial = createLevel(level.id);
    const board = emptyBoard();
    board[0] = [0, 1, 1, 1, 1, 1, 1, 1];
    const state = { ...initial, board, pieces: [single(), null, null], moves: 14, lines: 74 };
    const after = placePiece(state, 0, 0, 0)!.state;
    assert.equal(getLevelStage(after), 'finish');
    assert.equal(after.batch, 1);
    assert.notEqual(after.rng, state.rng, 'only a real refill advances supply RNG');
    const last = placePiece({ ...state, moves: level.maxMoves - 1, lines: 99 }, 0, 0, 0)!.state;
    assert.equal(last.status, 'won');
    assert.equal(last.rng, state.rng, 'a winning last move never deals an unnecessary group');
    assert.equal(last.batch, state.batch);
  });
});

test('star anchor follows rotation, refresh retains it, and neither tool mutates the source', () => {
  withLevel(level => {
    const state = createLevel(level.id);
    state.pieces = [{ id: 'star-corner', color: 3, star: true,
      cells: [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] }, null, null];
    const before = structuredClone(state);
    const rotated = rotatePiece(state, 0)!;
    assert.equal(rotated.pieces[0]!.star, true);
    assert.deepEqual(rotated.pieces[0]!.cells[0], { x: 1, y: 1 });
    const placed = placePiece(rotated, 0, 2, 2)!.state;
    assert.ok(placed.level!.gems.some(cell => cell.x === 3 && cell.y === 3));
    const refreshed = refreshPieces(state)!;
    assert.equal(refreshed.pieces[0]!.star, true);
    assert.deepEqual(refreshed.pieces[0]!.cells, [{ x: 0, y: 0 }]);
    const dot = placePiece(refreshed, 0, 3, 4)!.state;
    assert.ok(dot.level!.gems.some(cell => cell.x === 3 && cell.y === 4));
    assert.deepEqual(state, before);
  }, { goals: [{ kind: 'gems', target: 100 }] });
});

test('a newly placed star clears immediately once, independently from overlapping line and color counts', () => {
  withLevel(level => {
    const state = createLevel(level.id);
    state.board[0] = [0, 3, 3, 3, 3, 3, 3, 3];
    for (let y = 1; y < 8; y++) state.board[y][0] = 3;
    state.pieces = [single(true), single(), single()];
    state.level!.gems = [{ x: 1, y: 0 }, { x: 1, y: 0 }];
    const before = structuredClone(state);
    const result = placePiece(state, 0, 0, 0)!;
    assert.equal(result.state.lines, 2);
    assert.equal(result.cleared.length, 15);
    assert.equal(result.state.level!.collectedGems, 2, 'existing and placed stars each count once');
    assert.deepEqual(result.state.level!.gems, []);
    assert.equal(result.state.level!.clearedColors[2], 14);
    assert.equal(result.state.level!.clearedColors[4], 1);
    assert.equal(result.state.level!.clearedColors.reduce((sum, count) => sum + count, 0), 15);
    assert.deepEqual(state, before);
  }, { goals: [{ kind: 'gems', target: 100 }, { kind: 'color', target: 100, color: 2 }] });
});

test('flow keeps stars and both unfinished objective colors available late in a run', () => {
  withLevel(level => {
    let state = createLevel(level.id);
    assert.equal(state.pieces.filter(piece => piece?.star).length, 1);
    state = { ...state, moves: 30, batch: 1, pieces: [single(), null, null], level: { ...state.level!, collectedGems: 80,
      gems: [], clearedColors: [80, 80, 0, 0, 0] } };
    const after = placePiece(state, 0, 0, 0)!.state;
    assert.equal(getLevelStage(after), 'finish');
    assert.equal(after.pieces.filter(piece => piece?.star).length, 2);
    assert.ok(after.pieces.some(piece => piece?.color === 0));
    assert.ok(after.pieces.some(piece => piece?.color === 1));
    const snapshot = structuredClone(after);
    assert.ok(findHint(after));
    assert.deepEqual(after, snapshot, 'hint search stays local to the current group and does not consume RNG');
  }, { goals: [{ kind: 'gems', target: 100 }, { kind: 'color', target: 100, color: 0 }, { kind: 'color', target: 100, color: 1 }] });
});

test('most late trays carry one star, with occasional catchup only when the board lacks enough stars', () => {
  withLevel(level => {
    const initial = createLevel(level.id);
    for (let batch = 0; batch < 6; batch++) {
      const state = { ...initial, moves: 30, batch, pieces: [single(), null, null],
        level: { ...initial.level!, collectedGems: 80, gems: [] } };
      const after = placePiece(state, 0, 0, 0)!.state;
      assert.equal(after.pieces.filter(piece => piece?.star).length, after.batch % 3 === 2 ? 2 : 1);
    }
    const state = { ...initial, moves: 30, batch: 1, pieces: [single(), null, null],
      level: { ...initial.level!, collectedGems: 98, gems: [] } };
    const close = placePiece(state, 0, 0, 0)!.state;
    assert.equal(close.pieces.filter(piece => piece?.star).length, 1, 'small remaining targets still receive a star without excess catchup');
    const present = { ...state, level: { ...state.level, collectedGems: 80,
      gems: Array.from({ length: 10 }, (_, index) => ({ x: index % 8, y: 5 + Math.floor(index / 8) })) } };
    assert.equal(placePiece(present, 0, 0, 0)!.state.pieces.filter(piece => piece?.star).length, 1,
      'stars already on the board prevent unnecessary catchup');
  }, { goals: [{ kind: 'gems', target: 100 }] });
});

test('legacy fixed levels still use authored batches and stop when their finite supply ends', () => {
  withLevel(level => {
    const state = createLevel(level.id);
    assert.equal(state.seed, 0);
    assert.deepEqual(state.pieces, level.batches[0]);
    const after = play(state, [{ index: 0, x: 0, y: 0 }, { index: 1, x: 1, y: 0 }, { index: 2, x: 2, y: 0 }]);
    assert.equal(after.status, 'lost');
    assert.deepEqual(after.pieces, [null, null, null]);
    assert.equal(after.rng, state.rng);
  }, { flow: undefined });
});

test('endless start retains accepted seed, shapes and RNG with five-color output', () => {
  const state = createGame('endless', false, 123);
  assert.equal(state.rng, 800930484);
  assert.deepEqual(state.pieces.map(piece => ({ id: piece!.id, color: piece!.color })), [
    { id: '0-0-8-3', color: 3 }, { id: '0-1-12-3', color: 0 }, { id: '0-2-9-1', color: 0 },
  ]);
});
