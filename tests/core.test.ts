import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_SIZE, LEVEL_SOLUTION, TUTORIAL_MOVE, canPlace, canPlacePiece, createGame, findHint, getPieceBounds, hasPlacement, placePiece, rotatePiece, refreshPieces, reviveGame } from '../src/core/game.ts';
import type { GameState, Piece } from '../src/core/game.ts';

const single: Piece = { id: 'test-single', cells: [{ x: 0, y: 0 }] };
const domino: Piece = { id: 'test-domino', cells: [{ x: 0, y: 0 }, { x: 0, y: 1 }] };
const emptyBoard = () => Array.from({ length: BOARD_SIZE }, () => Array<number>(BOARD_SIZE).fill(0));
function fixture(): GameState {
  return { ...createGame('endless', true, 123), tutorial: false, board: emptyBoard(), pieces: Array.from({ length: 3 }, (_, index) => ({
    id: `single-${index}`, cells: [{ x: 0, y: 0 }],
  })) };
}

function afterTutorial(mode: GameState['mode'] = 'endless', seed = 123): GameState {
  return placePiece(createGame(mode, true, seed), TUTORIAL_MOVE.index, TUTORIAL_MOVE.x, TUTORIAL_MOVE.y)!.state;
}

const fourCellBends = new Set(['.#/##/#.', '##./.##']);
const standardPatterns = new Set([
  '#', '#/#', '###', '####', '#####', '##/#.', '###/#..', '##/##', '##/##/##', '###/###', '###/###/###',
  '###/#../#..', '###/..#/..#', '####/#...', '####/...#',
  '###/.#.', ...fourCellBends,
]);
function pattern(piece: Piece): string {
  const { width, height } = getPieceBounds(piece);
  return Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) =>
    piece.cells.some(cell => cell.x === x && cell.y === y) ? '#' : '.').join('')).join('/');
}
for (const shape of [...standardPatterns]) {
  let cells = shape.split('/').flatMap((row, y) => [...row].flatMap((cell, x) => cell === '#' ? [{ x, y }] : []));
  for (let turn = 0; turn < 4; turn++) {
    standardPatterns.add(pattern({ id: '', cells }));
    const height = Math.max(...cells.map(cell => cell.y)) + 1;
    cells = cells.map(cell => ({ x: height - 1 - cell.y, y: cell.x }));
  }
}

test('the level is deterministic and exposes fresh mutable data per session', () => {
  const a = createGame('endless', true, 123);
  const b = createGame('endless', true, 123);
  assert.deepEqual(a, b);
  a.board[0][0] = 1;
  a.pieces[0]!.cells[0].x = 20;
  a.pieces[1]!.cells[0].x = 20;
  assert.equal(b.board[0][0], 0);
  assert.equal(b.pieces[0]!.cells[0].x, 0);
  assert.equal(b.pieces[1]!.cells[0].x, 0);
  assert.equal(b.pieces.length, 3);
  assert.equal(b.mode, 'endless');
  assert.equal(b.target, 210);
});

test('a game without the tutorial starts from an empty board and the first normal supply', () => {
  for (const mode of ['endless', 'goal'] as const) {
    const state = createGame(mode, false, 123);
    assert.equal(state.mode, mode);
    assert.equal(state.tutorial, false);
    assert.deepEqual(state.board, emptyBoard());
    assert.deepEqual(state.pieces, createGame(mode, false, 123).pieces);
    if (mode === 'goal') assert.deepEqual(state.pieces, afterTutorial(mode).pieces);
    assert.equal(state.pieces.length, 3);
    for (const key of ['score', 'moves', 'combo', 'lines', 'batch', 'refreshes'] as const) assert.equal(state[key], 0);
    assert.equal(state.status, 'playing');
    assert.equal(state.target, 210);
    assert.ok(state.pieces.every(piece => piece && hasPlacement(state.board, piece)));
    const next = placePiece(state, 0, 0, 0)!.state;
    assert.equal(next.tutorial, false);
    assert.equal(next.score, 10);
    assert.equal(next.pieces[0], null, 'the first move consumes a normal candidate instead of triggering tutorial supply');
    assert.equal(next.pieces.filter(Boolean).length, 2);
    assert.equal(next.batch, 0);
  }
});

test('empty starts own their board rows, normal candidates and nested cell data', () => {
  const first = createGame('endless', false, 123);
  const second = createGame('endless', false, 123);
  const tutorialSupply = createGame('endless', false, 123);
  const expected = structuredClone(second);
  first.board[0][0] = 1;
  first.pieces[0]!.cells[0].x = 7;
  first.pieces[1]!.cells.pop();
  assert.equal(first.board[1][0], 0, 'empty-board rows are distinct arrays');
  assert.deepEqual(second, expected);
  assert.deepEqual(tutorialSupply.pieces, expected.pieces, 'creating or mutating an empty start cannot alter the shared normal supply');
  assert.deepEqual(createGame('endless', false, 123), expected);
});

test('the opening offers three blocks but only the square has a natural legal placement', () => {
  const state = createGame();
  assert.equal(state.tutorial, true);
  assert.equal(state.pieces.filter(Boolean).length, 3);
  assert.deepEqual(state.pieces.slice(0, 3).map(piece => getPieceBounds(piece!)), [
    { width: 2, height: 3 }, { width: 2, height: 2 }, { width: 3, height: 2 },
  ]);
  const square = state.pieces[TUTORIAL_MOVE.index]!;
  assert.deepEqual(getPieceBounds(square), { width: 2, height: 2 });
  assert.equal(square.cells.length, 4);
  const snapshot = structuredClone(state);
  const legal = [];
  for (const [index, piece] of state.pieces.entries()) {
    if (!piece) continue;
    for (let y = 0; y < BOARD_SIZE; y++) for (let x = 0; x < BOARD_SIZE; x++) {
      const geometric = canPlace(state.board, piece, x, y);
      assert.equal(canPlacePiece(state, index, x, y), geometric, 'tutorial uses normal placement geometry');
      if (geometric) legal.push({ index, x, y });
      else assert.equal(placePiece(state, index, x, y), null, 'an invalid choice never places or consumes a block');
    }
  }
  assert.deepEqual(legal, [TUTORIAL_MOVE]);
  assert.deepEqual(state, snapshot, 'trying either distractor leaves the board, score and candidates untouched');
  assert.deepEqual(findHint(state), TUTORIAL_MOVE);
  assert.equal(placePiece(state, TUTORIAL_MOVE.index, 0, 0), null);
  for (const y of [1, 2, 5, 6]) {
    const color = y < 3 ? 1 : 3;
    assert.deepEqual(state.board[y], [0, color, color, color, color, color, color, 0], 'upper and lower 6×2 rectangles each keep a uniform color');
  }
  for (const y of [3, 4]) assert.deepEqual(state.board[y], [2, 2, 2, 0, 0, 5, 5, 5], 'the two middle groups have distinct uniform colors');
  assert.deepEqual(state.board[0], Array(8).fill(0));
  assert.deepEqual(state.board[7], Array(8).fill(0));
  assert.equal(placePiece(state, TUTORIAL_MOVE.index, 0, 5), null, 'filled lower rows cannot take another square');
});

test('the tutorial uses normal rules to clear exactly two rows then continues on the same board', () => {
  const state = createGame('endless', true, 123);
  const snapshot = structuredClone(state);
  const result = placePiece(state, TUTORIAL_MOVE.index, TUTORIAL_MOVE.x, TUTORIAL_MOVE.y)!;
  assert.deepEqual(result.rows, [3, 4]);
  assert.deepEqual(result.columns, []);
  assert.equal(result.cleared.length, 16);
  assert.equal(result.gained, 50);
  assert.equal(result.state.tutorial, false);
  assert.equal(result.state.score, 50);
  assert.equal(result.state.moves, 1);
  assert.equal(result.state.lines, 2);
  assert.equal(result.state.combo, 1);
  assert.equal(result.state.batch, 0);
  assert.equal(result.state.target, 210);
  assert.equal(result.state.status, 'playing');
  assert.equal(result.state.pieces.filter(Boolean).length, 3);
  assert.ok(result.state.pieces.some(piece => piece && hasPlacement(result.state.board, piece)), 'the first normal batch has a playable candidate');
  for (let y = 0; y < BOARD_SIZE; y++) {
    assert.deepEqual(result.state.board[y], y === 3 || y === 4 ? Array(8).fill(0) : state.board[y]);
  }
  assert.deepEqual(state, snapshot);
  assert.deepEqual(createGame('endless', true, state.seed), state, 'the same seed can reproduce the untouched tutorial');
});

test('placement respects all edges, integer coordinates and occupied cells', () => {
  const board = emptyBoard();
  assert.equal(canPlace(board, domino, 7, 6), true);
  assert.equal(canPlace(board, domino, 7, 7), false);
  assert.equal(canPlace(board, domino, 8, 0), false);
  assert.equal(canPlace(board, domino, -1, 0), false);
  assert.equal(canPlace(board, domino, 0, -1), false);
  assert.equal(canPlace(board, domino, 1.5, 0), false);
  assert.equal(canPlace(board, domino, NaN, 0), false);
  assert.equal(canPlace(board, { id: 'empty', cells: [] }, 0, 0), false);
  board[7][7] = 1;
  assert.equal(canPlace(board, domino, 7, 6), false);
  assert.deepEqual(getPieceBounds(domino), { width: 1, height: 2 });
});

test('invalid and already consumed moves do not alter the state or score', () => {
  const state = afterTutorial('goal');
  const before = structuredClone(state);
  assert.equal(placePiece(state, 0, 1, 1), null);
  assert.equal(placePiece(state, -1, 0, 0), null);
  assert.equal(placePiece(state, 6, 0, 0), null);
  assert.deepEqual(state, before);
  const next = placePiece(state, 0, 3, 3)!.state;
  assert.equal(next.pieces[0], null);
  assert.equal(placePiece(next, 0, 0, 0), null);
});

test('crossing row and column clear simultaneously without double-counting the intersection', () => {
  const state = fixture();
  for (let i = 0; i < 8; i++) {
    state.board[3][i] = 1;
    state.board[i][4] = 1;
  }
  state.board[3][4] = 0;
  const result = placePiece(state, 0, 4, 3)!;
  assert.deepEqual(result.rows, [3]);
  assert.deepEqual(result.columns, [4]);
  assert.equal(result.cleared.length, 15);
  assert.equal(result.gained, 50);
  assert.equal(result.state.lines, 2);
  assert.deepEqual(result.state.board, emptyBoard());
  assert.equal(state.board[3][0], 1);
});

test('a colored piece keeps one color across its whole placement and untouched candidates retain their colors', () => {
  const state = fixture();
  state.pieces[0] = { id: 'colored-corner', color: 4, cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] };
  state.pieces[1]!.color = 3;
  const before = structuredClone(state);
  const result = placePiece(state, 0, 2, 2)!;
  assert.equal(result.gained, 10);
  for (const cell of result.placed) assert.equal(result.state.board[cell.y][cell.x], 5);
  assert.equal(result.state.pieces[1]!.color, 3);
  assert.equal(canPlace(result.state.board, single, 2, 2), false, 'every nonzero color blocks overlap');
  assert.deepEqual(state, before);
  const legacy = placePiece(fixture(), 0, 0, 0)!;
  assert.equal(legacy.state.board[0][0], 1, 'pieces without a color retain binary occupancy');
});

test('mixed colored cells clear rows and columns with the same score and crossing count', () => {
  const state = fixture();
  for (let i = 0; i < BOARD_SIZE; i++) {
    state.board[3][i] = i % 5 + 1;
    state.board[i][4] = (i + 2) % 5 + 1;
  }
  state.board[3][4] = 0;
  state.pieces[0]!.color = 4;
  const result = placePiece(state, 0, 4, 3)!;
  assert.deepEqual(result.rows, [3]);
  assert.deepEqual(result.columns, [4]);
  assert.equal(result.cleared.length, 15);
  assert.equal(result.gained, 50);
  assert.deepEqual(result.state.board, emptyBoard());
});

test('colors do not change hint evaluation, supply RNG or placement geometry', () => {
  let colored = createGame('endless', true, 1);
  for (let step = 0; step < 12; step++) {
    assert.equal(colored.status, 'playing');
    const plain = structuredClone(colored);
    plain.board = plain.board.map(row => row.map(cell => Number(cell !== 0)));
    plain.pieces = plain.pieces.map(piece => piece && { id: piece.id, cells: piece.cells });
    const coloredHint = findHint(colored)!;
    assert.deepEqual(coloredHint, findHint(plain));
    const nextColor = placePiece(colored, coloredHint.index, coloredHint.x, coloredHint.y)!.state;
    const nextPlain = placePiece(plain, coloredHint.index, coloredHint.x, coloredHint.y)!.state;
    assert.equal(nextColor.rng, nextPlain.rng);
    assert.equal(nextColor.score, nextPlain.score);
    assert.equal(nextColor.lines, nextPlain.lines);
    assert.deepEqual(nextColor.board.map(row => row.map(Boolean)), nextPlain.board.map(row => row.map(Boolean)));
    colored = nextColor;
  }
});

test('removing full lines never moves the other blocks down', () => {
  const state = fixture();
  state.board[2][2] = 1;
  state.board[6] = Array(8).fill(1);
  state.board[6][7] = 0;
  const result = placePiece(state, 0, 7, 6)!;
  assert.equal(result.state.board[2][2], 1);
  assert.equal(result.state.board[3][2], 0);
  assert.deepEqual(result.rows, [6]);
});

test('back-to-back clearing earns a combo and an ordinary placement resets it', () => {
  const state = fixture();
  state.board[0] = Array(8).fill(1);
  state.board[1] = Array(8).fill(1);
  state.board[0][7] = state.board[1][7] = 0;
  const first = placePiece(state, 0, 7, 0)!;
  const second = placePiece(first.state, 1, 7, 1)!;
  const third = placePiece(second.state, 2, 2, 2)!;
  assert.equal(first.gained, 30);
  assert.equal(first.state.combo, 1);
  assert.equal(second.gained, 40);
  assert.equal(second.state.combo, 2);
  assert.equal(third.gained, 10);
  assert.equal(third.state.combo, 0);
});

test('all three slots must be used before the next seeded supply is dealt', () => {
  const state = fixture();
  const one = placePiece(state, 0, 0, 0)!.state;
  assert.equal(one.batch, 0);
  assert.equal(one.pieces.filter(Boolean).length, 2);
  const two = placePiece(one, 1, 2, 0)!.state;
  assert.equal(two.batch, 0);
  assert.equal(two.pieces.filter(Boolean).length, 1);
  const next = placePiece(two, 2, 4, 0)!.state;
  assert.equal(next.batch, 1);
  assert.equal(next.pieces.filter(Boolean).length, 3);
  assert.ok(next.pieces.every(piece => piece?.id.startsWith('1-')));
  assert.equal(state.pieces.filter(Boolean).length, 3);
});

test('goal supplies retain their fixed rectangles, L blocks, bends, T blocks and occasional small fillers', () => {
  let largeCount = 0, singleCount = 0, dominoCount = 0, totalBends = 0, totalRectangles = 0;
  for (let batch = 0; batch < 6; batch++) {
    let state = afterTutorial('goal');
    if (batch > 0) {
      const deal = fixture();
      deal.mode = 'goal';
      deal.batch = batch - 1;
      deal.pieces = [single, null, null];
      state = placePiece(deal, 0, 0, 0)!.state;
    }
    let irregular = 0, bends = 0, rectangles = 0, batchLarge = 0;
    if (batch === 2) {
      assert.equal(pattern(state.pieces[0]!), '##/##/##', 'the former branch choice is a solid 2×3 rectangle');
      assert.equal(pattern(state.pieces[2]!), '###/.#.', 'the long T choice is shortened to four cells');
    }
    for (const piece of state.pieces) {
      assert.ok(piece);
      const { width, height } = getPieceBounds(piece);
      assert.ok(standardPatterns.has(pattern(piece)), 'only familiar, compact shapes enter normal supply');
      assert.ok([1, 2, 4, 5, 6].includes(piece.cells.length));
      if (piece.cells.length >= 4) {
        largeCount++; batchLarge++;
        assert.ok(width >= 2 && height >= 2, 'large blocks require two-dimensional planning');
      } else if (piece.cells.length === 1) singleCount++;
      else if (piece.cells.length === 2) dominoCount++;
      if (piece.cells.length < width * height) irregular++;
      if (piece.cells.length === 6) {
        assert.equal(width * height, 6, 'six-cell blocks are solid rectangles, never branches');
        rectangles++;
      }
      if (fourCellBends.has(pattern(piece))) {
        assert.equal(piece.cells.length, 4, 'K-style bends use exactly four cells');
        bends++;
      }
      const cells = new Set(piece.cells.map(cell => `${cell.x},${cell.y}`));
      assert.equal(cells.size, piece.cells.length, 'all cells are distinct');
      const reached = new Set<string>(), pending = [piece.cells[0]];
      while (pending.length) {
        const cell = pending.pop()!, key = `${cell.x},${cell.y}`;
        if (reached.has(key)) continue;
        reached.add(key);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const next = { x: cell.x + dx, y: cell.y + dy };
          if (cells.has(`${next.x},${next.y}`)) pending.push(next);
        }
      }
      assert.equal(reached.size, piece.cells.length, 'branches connect through edges, not just diagonal corners');
    }
    totalBends += bends; totalRectangles += rectangles;
    assert.equal(state.pieces.length, 3);
    assert.ok(irregular >= 1, 'each supply includes a familiar planning shape');
    assert.ok(batchLarge >= 2, 'small relief pieces never dominate any normal supply');
  }
  assert.equal(largeCount, 16, 'sixteen of eighteen normal candidates are substantial blocks');
  assert.equal(singleCount, 1, 'one single cell appears across six three-piece supplies');
  assert.equal(dominoCount, 1, 'one domino appears across six three-piece supplies');
  assert.ok(totalBends >= 2);
  assert.ok(totalRectangles >= 3);
});

function nextOpenBatch(state: GameState, board = emptyBoard()): GameState {
  return placePiece({ ...state, board, status: 'playing', tutorial: false, pieces: [single, null, null] }, 0, 0, 0)!.state;
}

function isStraight(piece: Piece, minimumSize = 3): boolean {
  const { width, height } = getPieceBounds(piece);
  return piece.cells.length >= minimumSize && (width === 1 || height === 1);
}

type TestMove = { index: number; x: number; y: number };

// This verifier deliberately owns its geometry and simultaneous-clear rules.
// It never calls placePiece/findHint or the production supply planner, and it
// stops at the last current slot instead of accidentally testing a fresh tray.
function simulateCurrentMove(board: number[][], piece: Piece, x: number, y: number): number[][] | null {
  if (!piece.cells.length || piece.cells.some(cell => cell.x + x < 0 || cell.y + y < 0
    || cell.x + x >= BOARD_SIZE || cell.y + y >= BOARD_SIZE || board[cell.y + y][cell.x + x] !== 0)) return null;
  const next = board.map(row => [...row]);
  for (const cell of piece.cells) next[cell.y + y][cell.x + x] = 1;
  const rows = next.map((row, index) => row.every(Boolean) ? index : -1).filter(index => index >= 0);
  const columns = Array.from({ length: BOARD_SIZE }, (_, index) => index)
    .filter(index => next.every(row => row[index] !== 0));
  for (const row of rows) next[row].fill(0);
  for (const column of columns) for (const row of next) row[column] = 0;
  return next;
}

function completeCurrentTray(state: Pick<GameState, 'board' | 'pieces'>): TestMove[] | null {
  const failed = new Set<string>();
  let nodes = 0;
  function search(board: number[][], mask: number): TestMove[] | null {
    if (!mask) return [];
    assert.ok(++nodes <= 100_000, 'independent verifier exceeded its node budget; result is unknown, not unsolvable');
    const key = `${mask}:${board.map(row => row.map(Boolean).map(Number).join('')).join('')}`;
    if (failed.has(key)) return null;
    for (let index = 0; index < state.pieces.length; index++) {
      if (!(mask & 1 << index)) continue;
      const piece = state.pieces[index]!;
      for (let y = 0; y < BOARD_SIZE; y++) for (let x = 0; x < BOARD_SIZE; x++) {
        const next = simulateCurrentMove(board, piece, x, y);
        if (!next) continue;
        const rest = search(next, mask & ~(1 << index));
        if (rest) return [{ index, x, y }, ...rest];
      }
    }
    failed.add(key);
    return null;
  }
  const mask = state.pieces.reduce((value, piece, index) => piece ? value | 1 << index : value, 0);
  return search(state.board, mask);
}

function shapeFamily(piece: Piece): string {
  let cells = piece.cells;
  const rotations: string[] = [];
  for (let turn = 0; turn < 4; turn++) {
    rotations.push(pattern({ id: '', cells }));
    const height = Math.max(...cells.map(cell => cell.y)) + 1;
    cells = cells.map(cell => ({ x: height - 1 - cell.y, y: cell.x }));
  }
  return rotations.sort()[0];
}

// Actual boards reached by the pre-adaptation A policy (seeds 2, 4, 5, 6).
// Each used to receive a tray with a legal first move but no complete route.
const crowdedBoards = [
  '##...###/.......#/.#######/.#####.#/......../.......#/#..#.###/..###...',
  '#######./#######./###.###./.##..###/.#..####/.....#../#######./........',
  '#.#.#..#/#.#.#.../..#.##../#......./#..##.../#######./#..##.../........',
  '...#####/####.#.#/..####../#.#####./#.#..###/##..###./##..###./##......',
].map(shape => shape.split('/').map((row, y) => [...row].map((cell, x) => cell === '#' ? (x + y) % 5 + 1 : 0)));

function dealOnBoard(state: GameState, board: number[][]): GameState {
  const y = board.findIndex(row => row.some(Boolean));
  assert.ok(y >= 0, 'fixture requires an occupied cell to restore with the last previous slot');
  const x = board[y].findIndex(Boolean);
  const before = board.map(row => [...row]);
  before[y][x] = 0;
  return placePiece({ ...state, board: before, tutorial: false, status: 'playing',
    pieces: [{ ...single, color: board[y][x] - 1 }, null, null] }, 0, x, y)!.state;
}

test('seeded adaptive supplies have complete routes, familiar diverse blocks and spaced long lines', () => {
  const families = new Set<string>();
  let substantial = 0, total = 0, groups = 0, smallDominated = 0, familyDominated = 0;
  const lineDirections = new Set<string>();
  for (let seed = 0; seed < 32; seed++) {
    let state = createGame('endless', false, seed);
    let expectedLastLongBatch = -2;
    for (let batch = 0; batch < 10; batch++) {
      assert.equal(state.pieces.length, 3);
      let batchHard = 0, batchStraights = 0, batchLongLines = 0;
      assert.equal(completeCurrentTray(state)?.length, 3, `seed ${seed}, batch ${batch} needs a full fixed-orientation route`);
      if (state.pieces.filter(piece => piece && piece.cells.length <= 2).length > 1) smallDominated++;
      const batchFamilies = state.pieces.map(piece => shapeFamily(piece!));
      if (new Set(batchFamilies).size < 3) familyDominated++;
      groups++;
      for (const piece of state.pieces) {
        assert.ok(piece);
        assert.ok(Number.isInteger(piece.color) && piece.color! >= 0 && piece.color! < 5);
        const size = piece.cells.length;
        const { width, height } = getPieceBounds(piece);
        assert.ok(standardPatterns.has(pattern(piece)), `unfamiliar shape ${pattern(piece)}`);
        assert.ok([1, 2, 3, 4, 5, 6, 9].includes(size));
        if (size >= 4) substantial++;
        families.add(shapeFamily(piece));
        if (size === 9) { assert.equal(width, 3); assert.equal(height, 3); }
        if (size === 9 || isStraight(piece, 4)) batchHard++;
        if (isStraight(piece)) batchStraights++;
        if (isStraight(piece, 4)) batchLongLines++;
        if ((size === 4 || size === 5) && (width === 1 || height === 1)) lineDirections.add(`${size}-${width === 1 ? 'vertical' : 'horizontal'}`);
        if (size === 6) assert.equal(width * height, 6, 'six-cell pieces remain solid rectangles');
        const cells = new Set(piece.cells.map(cell => `${cell.x},${cell.y}`));
        const reached = new Set<string>(), pending = [piece.cells[0]];
        while (pending.length) {
          const cell = pending.pop()!, key = `${cell.x},${cell.y}`;
          if (reached.has(key)) continue;
          reached.add(key);
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const next = { x: cell.x + dx, y: cell.y + dy };
            if (cells.has(`${next.x},${next.y}`)) pending.push(next);
          }
        }
        assert.equal(cells.size, size);
        assert.equal(reached.size, size, 'pieces connect through edges, never diagonal corners');
        total++;
      }
      assert.ok(batchHard <= 1, 'each group contains at most one 3×3 square or four-/five-cell line');
      assert.ok(batchStraights <= 1, 'each group contains at most one straight block of three or more cells');
      if (batch < 2) assert.equal(batchHard, 0, 'the first two groups avoid the hardest blocks');
      if (batch < 3) assert.equal(batchLongLines, 0, 'the first three groups avoid four- and five-cell lines');
      if (batchLongLines) {
        assert.ok(expectedLastLongBatch < batch - 1, 'four- and five-cell lines never occur in consecutive groups');
        expectedLastLongBatch = batch;
      }
      assert.equal(state.lastLongBatch, expectedLastLongBatch, 'the saved spacing cursor describes the actual final supply');
      if (batch < 9) state = nextOpenBatch(state);
    }
  }
  assert.ok(substantial > total / 2, 'roomy boards still offer substantial planning blocks');
  assert.ok(smallDominated < groups / 4, 'small fillers do not dominate normal supplies overall');
  assert.ok(familyDominated < groups / 4, 'normal supply usually mixes shape families, counting rotated copies together');
  assert.ok(families.size >= 10, 'adaptation retains a broad set of compact block families');
  assert.deepEqual([...lineDirections].sort(), ['4-horizontal', '4-vertical', '5-horizontal', '5-vertical']);
});

test('the first post-tutorial group always has a complete normal-placement route with another two-row clear', () => {
  for (let seed = 0; seed < 24; seed++) {
    let state = afterTutorial('endless', seed);
    const opening = structuredClone(state);
    assert.equal(completeCurrentTray(state)?.length, 3);
    const dominoSlots = state.pieces.flatMap((piece, index) => piece?.cells.length === 2 ? [index] : []);
    assert.equal(dominoSlots.length, 2);
    const first = placePiece(state, dominoSlots[0], 0, 1)!;
    assert.ok(first);
    const second = placePiece(first.state, dominoSlots[1], 7, 1)!;
    assert.ok(second);
    assert.deepEqual(second.rows, [1, 2]);
    const index = second.state.pieces.findIndex(Boolean);
    assert.ok(second.state.pieces[index]!.cells.length >= 4, 'the gentle group still contains a substantial block');
    const third = placePiece(second.state, index, 0, 0)!;
    assert.ok(third);
    assert.equal(third.state.batch, 1);
    assert.equal(third.state.status, 'playing');
    assert.deepEqual(state, opening);
  }
});

test('seeds and saved RNG cursors reproduce supply and undo without sharing mutable cells', () => {
  for (const seed of [0, 1, 123, 0xffffffff]) {
    let first = createGame('endless', false, seed);
    let second = createGame('endless', false, seed);
    assert.deepEqual(first, second);
    for (let batch = 0; batch < 5; batch++) {
      const before = structuredClone(first);
      first = nextOpenBatch(first);
      second = nextOpenBatch(second);
      assert.deepEqual(first, second);
      assert.deepEqual(nextOpenBatch(before), first, 'restoring a state before the deal restores its exact RNG continuation');
      assert.equal(first.lastLongBatch, first.pieces.some(piece => piece && isStraight(piece, 4)) ? first.batch : before.lastLongBatch);
      assert.notEqual(first.rng, before.rng);
    }
    const snapshot = structuredClone(second);
    first.board[0][0] = 7;
    first.pieces[0]!.cells[0].x = 7;
    assert.deepEqual(second, snapshot);
  }
  const variants = new Set(Array.from({ length: 32 }, (_, seed) => JSON.stringify(createGame('endless', false, seed).pieces)));
  assert.ok(variants.size > 25, 'different seeds produce varied supply rather than a short fixed cycle');
  const freshSeeds = new Set(Array.from({ length: 16 }, () => createGame('endless', false).seed));
  assert.ok(freshSeeds.size > 1, 'new games choose a seed when one is not supplied');
  const state = createGame('endless', false, 123);
  const snapshot = structuredClone(state);
  findHint(state);
  assert.deepEqual(state, snapshot, 'hint calculation never consumes the live RNG cursor');
});

test('saved long-line cooldown survives consumed slots, replacement and replay', () => {
  for (let seed = 0; seed < 64; seed++) {
    const saved = { ...createGame('endless', false, seed), batch: 4, lastLongBatch: 4, pieces: [null, domino, single] };
    const replaced = refreshPieces(saved)!;
    assert.equal(replaced.lastLongBatch, 4);
    const one = placePiece(replaced, 1, 0, 0)!.state;
    assert.equal(one.lastLongBatch, 4, 'using one slot preserves the current group history');
    const beforeDeal = structuredClone(one);
    const dealt = placePiece(one, 2, 2, 0)!.state;
    assert.equal(dealt.batch, 5);
    assert.equal(dealt.lastLongBatch, 4);
    assert.ok(dealt.pieces.every(piece => piece && !isStraight(piece, 4)), 'a consumed or replaced long block still prevents a long block in the next group');
    assert.deepEqual(placePiece(beforeDeal, 2, 2, 0)!.state, dealt, 'restoring a save restores both the RNG cursor and long-line spacing');
  }
});

test('adaptive trays can use every slot on real crowded boards and fragmented isolated holes', () => {
  const fragmented = emptyBoard().map((row, y) => row.map((_, x) => (x + y) % 2));
  const boards = [...crowdedBoards, fragmented];
  for (const [boardIndex, board] of boards.entries()) {
    for (const seed of [2, 4, 5, 6, 23, 2026, 0x12345678, 0xffffffff]) {
      const before = { ...createGame('endless', false, seed), batch: 5, score: 170, moves: 18, lines: 5, combo: 2 };
      const snapshot = structuredClone(before);
      const dealt = dealOnBoard(before, board);
      assert.deepEqual(before, snapshot, 'planning does not mutate the previous state');
      assert.deepEqual(dealt.board, board, 'dealing cannot clear, move or add extra board cells');
      assert.equal(dealt.score, before.score + 10, 'planning cannot award the simulated route score');
      assert.equal(dealt.moves, before.moves + 1, 'only the actual final previous placement counts');
      assert.equal(dealt.lines, before.lines);
      assert.equal(dealt.batch, 6);
      assert.equal(dealt.status, 'playing');
      const route = completeCurrentTray(dealt);
      assert.equal(route?.length, 3, `board ${boardIndex}, seed ${seed} must have a complete route`);
      let replay = dealt;
      for (const [step, move] of route!.entries()) {
        const result = placePiece(replay, move.index, move.x, move.y);
        assert.ok(result, 'the independent geometric route also works through the public placement API');
        replay = result.state;
        assert.equal(replay.status, 'playing');
        assert.equal(replay.batch, step === 2 ? dealt.batch + 1 : dealt.batch);
      }
      assert.deepEqual(dealOnBoard(structuredClone(before), board), dealt, 'the adapted route remains deterministic from the saved RNG cursor');
      assert.ok(dealt.pieces.filter(piece => piece && isStraight(piece)).length <= 1);
      assert.ok(dealt.pieces.filter(piece => piece && (piece.cells.length === 9 || isStraight(piece, 4))).length <= 1);
    }
  }
});

test('complete-route rescue respects straight limits and long-line cooldown in narrow corridors', () => {
  for (const length of [3, 4, 5]) {
    const board = Array.from({ length: BOARD_SIZE }, () => Array<number>(BOARD_SIZE).fill(1));
    // Isolated holes keep every row and column incomplete. Only this horizontal
    // corridor admits a connected block of three or more cells.
    for (const [x, y] of [[0, 0], [4, 0], [2, 1], [7, 2], [0, 4], [3, 5], [5, 6], [6, 7]]) board[y][x] = 0;
    for (let x = 1; x <= length; x++) board[3][x] = 0;
    for (const [batch, lastLongBatch] of [[1, -2], [2, -2], [5, -2], [5, 4]]) {
      for (const seed of [0, 1, 7, 23, 123, 0xffffffff]) {
        const before = { ...createGame('endless', false, seed), batch: batch - 1, lastLongBatch };
        const dealt = nextOpenBatch(before, board);
        const straights = dealt.pieces.filter(piece => piece && isStraight(piece));
        const longLines = dealt.pieces.filter(piece => piece && isStraight(piece, 4));
        assert.equal(completeCurrentTray(dealt)?.length, 3, 'all three rescued slots can be used in a legal order');
        assert.equal(dealt.status, 'playing');
        assert.ok(straights.length <= 1, 'fallback cannot add a second three-or-more-cell straight block');
        assert.ok(dealt.pieces.filter(piece => piece && (piece.cells.length === 9 || isStraight(piece, 4))).length <= 1);
        if (batch < 3 || lastLongBatch === batch - 1) assert.equal(longLines.length, 0, 'fallback preserves opening protection and the saved cooldown');
        assert.equal(dealt.lastLongBatch, longLines.length ? batch : lastLongBatch, 'spacing history reflects the final rescued group');
        assert.deepEqual(nextOpenBatch(structuredClone(before), board), dealt, 'rescue and cooldown replay exactly from a saved state');
      }
    }
  }
});

test('current-tray hints ignore future supply RNG and preserve a complete route on crowded boards', () => {
  for (const [index, board] of crowdedBoards.entries()) {
    let state = dealOnBoard({ ...createGame('endless', false, index + 31), batch: 5 }, board);
    const batch = state.batch;
    for (let slot = 0; slot < 3; slot++) {
      const snapshot = structuredClone(state);
      const move = findHint(state);
      assert.deepEqual(state, snapshot, 'hint search cannot advance the live RNG, board, score or tray');
      assert.ok(move);
      const futureVariant = { ...state, seed: 0xabcdef01, rng: (state.rng ^ 0xffffffff) >>> 0, lastLongBatch: batch - 1 };
      assert.deepEqual(findHint(futureVariant), move, 'the selected move depends on the current tray rather than a hypothetical refill');
      const nextBoard = simulateCurrentMove(state.board, state.pieces[move.index]!, move.x, move.y);
      assert.ok(nextBoard, 'every hint has a real geometric landing');
      const remaining = state.pieces.map((piece, index) => index === move.index ? null : piece);
      assert.equal(completeCurrentTray({ board: nextBoard, pieces: remaining })?.length, 2 - slot,
        'each hint leaves a complete route for the remaining current slots');
      state = placePiece(state, move.index, move.x, move.y)!.state;
      assert.equal(state.batch, slot === 2 ? batch + 1 : batch);
    }
  }
});

test('planning and hints stay bounded across representative synchronous crowded-board calls', () => {
  const started = performance.now();
  for (let index = 0; index < 12; index++) {
    const state = dealOnBoard({ ...createGame('endless', false, index * 7919), batch: 5 }, crowdedBoards[index % crowdedBoards.length]);
    assert.ok(findHint(state));
  }
  // Generous enough for slow hosts; catches a runaway tree/refill recursion.
  assert.ok(performance.now() - started < 30_000, 'twelve supply/hint calls should finish within 30 seconds');
});

test('a state with no legal placement ends as lost', () => {
  const state = fixture();
  state.board = state.board.map((row, y) => row.map((_, x) => (x + y) % 2));
  state.pieces = [single, domino, null, null, null, null];
  const result = placePiece(state, 0, 3, 3)!;
  assert.equal(result.state.status, 'lost');
  assert.equal(findHint(result.state), null);
  assert.equal(placePiece(result.state, 1, 0, 2), null);
});

test('endless play crosses the goal score without a victory or a forced new board', () => {
  const state = fixture(); state.score = 209;
  const before = structuredClone(state);
  const next = placePiece(state, 0, 0, 0)!.state;
  assert.equal(next.mode, 'endless');
  assert.equal(next.score, 219);
  assert.equal(next.status, 'playing');
  assert.equal(next.board[0][0], 1);
  assert.equal(next.moves, 1);
  assert.deepEqual(state, before);
  assert.equal(placePiece({ ...state, mode: 'goal' }, 0, 0, 0)!.state.status, 'won');
});

test('a blocked candidate stays in the tray while another remains playable, and all blocked ends the run', () => {
  const state = fixture();
  state.board = state.board.map((row, y) => row.map((_, x) => (x + y) % 2));
  const square: Piece = { id: 'blocked-square', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] };
  state.pieces = [single, square, { ...single, id: 'last-single' }];
  assert.equal(hasPlacement(state.board, square), false);
  assert.equal(hasPlacement(state.board, single), true);
  const snapshot = structuredClone(state);
  assert.equal(placePiece(state, 1, 0, 0), null);
  assert.deepEqual(state, snapshot, 'trying a gray candidate consumes nothing');
  const next = placePiece(state, 0, 0, 0)!.state;
  assert.equal(next.status, 'playing');
  assert.equal(next.pieces[1]!.id, square.id);
  assert.equal(hasPlacement(next.board, next.pieces[1]!), false);
  assert.equal(hasPlacement(next.board, next.pieces[2]!), true);
  const ended = placePiece(next, 2, 2, 0)!.state;
  assert.equal(ended.status, 'lost');
  assert.equal(ended.batch, 0, 'the game does not replace blocked leftover candidates');
  assert.equal(ended.pieces.filter(Boolean).length, 1);
  assert.equal(ended.pieces[1]!.id, square.id);
});

test('a tray with a complete route can still lose after the player blocks its only square cavity', () => {
  const state = fixture();
  state.board = state.board.map((row, y) => row.map((_, x) => (x + y) % 2));
  for (const [x, y] of [[2, 2], [3, 2], [2, 3], [3, 3], [6, 6], [6, 7]]) state.board[y][x] = 0;
  const square: Piece = { id: 'needed-cavity', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] };
  state.pieces = [single, square, domino];
  assert.equal(completeCurrentTray(state)?.length, 3, 'the initial tray has an ordinary complete route');
  const mistaken = placePiece(state, 0, 2, 2)!.state;
  assert.equal(mistaken.status, 'playing');
  assert.equal(hasPlacement(mistaken.board, square), false);
  const ended = placePiece(mistaken, 2, 6, 6)!.state;
  assert.equal(ended.status, 'lost');
  assert.equal(ended.batch, state.batch, 'an unconsumed blocked slot does not trigger a replacement supply');
  assert.equal(ended.pieces[1]!.id, square.id);
  assert.equal(findHint(ended), null);
});

test('clearing a line can make a previously blocked candidate playable again', () => {
  const state = fixture();
  state.board = state.board.map((row, y) => row.map((_, x) => (x + y) % 2));
  state.board[1][0] = 0;
  state.board[2] = Array(8).fill(1); state.board[2][7] = 0;
  const square: Piece = { id: 'square-after-clear', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] };
  state.pieces = [single, square, null];
  assert.equal(hasPlacement(state.board, square), false);
  const result = placePiece(state, 0, 7, 2)!;
  assert.deepEqual(result.rows, [2]);
  assert.equal(result.state.status, 'playing');
  assert.equal(hasPlacement(result.state.board, result.state.pieces[1]!), true);
  assert.equal(canPlacePiece(result.state, 1, 0, 1), true);
});

test('endless hints can continue beyond 210 and any loss comes from the remaining geometry', () => {
  let state = createGame('endless', true, 123);
  for (let i = 0; i < 100 && state.status === 'playing'; i++) {
    const move = findHint(state)!;
    state = placePiece(state, move.index, move.x, move.y)!.state;
  }
  assert.ok(state.score > 210);
  assert.notEqual(state.status, 'won');
  if (state.status === 'lost') {
    assert.ok(state.pieces.filter(Boolean).every(piece => !hasPlacement(state.board, piece!)));
    const revived = reviveGame(state)!;
    assert.equal(revived.state.mode, 'endless');
    assert.equal(revived.state.status, 'playing');
    assert.equal(revived.state.score, state.score);
    assert.ok(revived.state.pieces.some(piece => piece && hasPlacement(revived.state.board, piece)));
  }
});

test('placements clone the board, pieces and their nested coordinates', () => {
  const state = afterTutorial('goal');
  const snapshot = structuredClone(state);
  const result = placePiece(state, 0, 3, 3)!;
  result.state.board[1][1] = 0;
  result.state.pieces[1]!.cells[0].x = 99;
  assert.deepEqual(state, snapshot);
});

test('the retained goal mode reaches the 210-point target and locks further play', () => {
  let state = createGame('goal');
  for (const move of LEVEL_SOLUTION) {
    const result = placePiece(state, move.index, move.x, move.y);
    assert.ok(result, `move ${JSON.stringify(move)} must be legal`);
    state = result.state;
  }
  assert.equal(state.status, 'won');
  assert.equal(state.score, 210);
  assert.equal(state.moves, 8);
  assert.equal(state.lines, 6);
  assert.equal(placePiece(state, 5, 0, 0), null);
  assert.equal(findHint(state), null);
});

test('clockwise rotation normalizes coordinates and four turns recover an asymmetric block', () => {
  const state = fixture();
  state.pieces[2] = { id: 'corner', color: 4, cells: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] };
  const before = structuredClone(state);
  const once = rotatePiece(state, 2)!;
  assert.deepEqual(once.pieces[2]!.cells, [{ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }]);
  const signature = (piece: Piece) => piece.cells.map(cell => `${cell.x},${cell.y}`).sort();
  let next = state;
  for (let i = 0; i < 4; i++) next = rotatePiece(next, 2)!;
  assert.deepEqual(signature(next.pieces[2]!), signature(state.pieces[2]!));
  assert.equal(once.score, state.score);
  assert.equal(once.moves, state.moves);
  assert.equal(once.combo, state.combo);
  assert.equal(once.pieces[2]!.id, 'corner');
  assert.equal(once.pieces[2]!.color, 4);
  assert.equal(next.pieces[2]!.color, 4, 'all quarter turns preserve the original piece color');
  once.board[0][0] = 1;
  once.pieces[0]!.cells[0].x = 7;
  assert.deepEqual(state, before);
  const offset = fixture();
  offset.pieces[0] = { id: 'offset', cells: [{ x: 3, y: 4 }, { x: 4, y: 4 }] };
  assert.deepEqual(rotatePiece(offset, 0)!.pieces[0]!.cells, [{ x: 0, y: 0 }, { x: 0, y: 1 }]);
});

test('rotation refuses unavailable, symmetric, tutorial and finished blocks', () => {
  const state = afterTutorial('goal');
  assert.equal(rotatePiece(state, 0), null, 'a square has no different orientation');
  assert.equal(rotatePiece(state, -1), null);
  assert.equal(rotatePiece(state, 6), null);
  assert.equal(rotatePiece(createGame(), 1), null);
  assert.equal(rotatePiece({ ...state, status: 'lost' }, 1), null);
  assert.equal(rotatePiece({ ...state, status: 'won' }, 1), null);
  state.pieces[1] = null;
  assert.equal(rotatePiece(state, 1), null);
  const corridor = fixture();
  corridor.board = Array.from({ length: 8 }, () => Array(8).fill(1));
  corridor.board[0][0] = corridor.board[0][1] = 0;
  corridor.pieces = [{ id: 'horizontal', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }, null, null, null, null, null];
  assert.equal(rotatePiece(corridor, 0), null, 'a reward must not turn the last usable block into a dead end');
});

test('rotation preview can cross an unplaceable quarter turn to reach a usable half turn', () => {
  const state = fixture();
  state.board = Array.from({ length: 8 }, () => Array(8).fill(1));
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [5, 5], [4, 6], [5, 6]]) state.board[y][x] = 0;
  state.pieces = [{ id: 'corner', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] }, null, null];
  const before = structuredClone(state);
  assert.ok(hasPlacement(state.board, state.pieces[0]!));
  assert.equal(rotatePiece(state, 0), null, 'committing an unusable last candidate remains forbidden');
  const quarter = rotatePiece(state, 0, true)!;
  assert.equal(quarter.status, 'playing');
  assert.equal(hasPlacement(quarter.board, quarter.pieces[0]!), false);
  const half = rotatePiece(quarter, 0, true)!;
  assert.equal(pattern(half.pieces[0]!), '.#/##');
  assert.ok(canPlacePiece(half, 0, 4, 5));
  assert.deepEqual(state, before, 'preview rotations leave the original state and direction available for cancellation');
  assert.equal(rotatePiece(createGame(), 0, true), null);
  assert.equal(rotatePiece({ ...state, status: 'lost' }, 0, true), null);
  assert.equal(rotatePiece(fixture(), 0, true), null, 'symmetric singles do not produce a preview');
});

test('replacement turns the remaining candidates into single cells without modifying progress or board', () => {
  const state = afterTutorial();
  const before = structuredClone(state);
  const next = refreshPieces(state)!;
  assert.deepEqual(state, before);
  assert.deepEqual(next.board, state.board);
  for (const key of ['mode', 'score', 'target', 'moves', 'lines', 'combo', 'batch', 'tutorial', 'status'] as const) assert.equal(next[key], state[key]);
  assert.equal(next.refreshes, 1);
  assert.equal(next.pieces.filter(Boolean).length, 3);
  for (let index = 0; index < 3; index++) {
    const piece = next.pieces[index]!;
    assert.ok(Number.isInteger(piece.color) && piece.color! >= 0 && piece.color! < 5);
    assert.deepEqual(piece.cells, [{ x: 0, y: 0 }]);
    assert.notEqual(piece.id, state.pieces[index]!.id);
    let fits = false;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) fits ||= canPlacePiece(next, index, x, y);
    assert.ok(fits, 'every replacement candidate has a real legal landing');
  }
  assert.equal(refreshPieces(next), null, 'an already single-cell tray cannot consume another use');
  next.board[0][0] = 1; next.pieces[0]!.cells[0].x = 7;
  assert.deepEqual(state, before);
});

test('replacement preserves consumed slots and normal supply waits for the remaining single cells', () => {
  const state = fixture();
  state.pieces = [null, domino, single];
  state.refreshes = 2;
  const before = structuredClone(state);
  const next = refreshPieces(state)!;
  assert.deepEqual(state, before);
  assert.equal(next.refreshes, 3);
  assert.equal(next.pieces.length, 3);
  assert.equal(next.pieces[0], null);
  assert.deepEqual(next.pieces.slice(1).map(piece => piece!.cells), [[{ x: 0, y: 0 }], [{ x: 0, y: 0 }]]);
  assert.equal(next.batch, state.batch, 'replacement never advances the normal supply');
  const one = placePiece(next, 1, 0, 0)!.state;
  assert.equal(one.pieces[0], null);
  assert.equal(one.pieces[1], null);
  assert.equal(one.pieces.filter(Boolean).length, 1);
  assert.equal(one.batch, state.batch);
  assert.equal(refreshPieces(one), null, 'a lone remaining single cell cannot consume a use');
  const dealt = placePiece(one, 2, 2, 0)!.state;
  assert.equal(dealt.batch, state.batch + 1);
  assert.equal(dealt.pieces.filter(Boolean).length, 3);
  assert.deepEqual(dealt.pieces, dealOnBoard({ ...state, rng: next.rng }, dealt.board).pieces,
    'replacement preserves the pending normal RNG supply for the board reached by the actual placements');
});

test('replacement works in isolated holes and refuses unavailable or ineffective uses', () => {
  const state = fixture();
  state.board = state.board.map((row, y) => row.map((_, x) => (x + y) % 2));
  state.pieces = [domino, null, single];
  const next = refreshPieces(state)!;
  assert.ok(next.pieces.filter(Boolean).every(piece => piece!.cells.length === 1));
  assert.equal(next.pieces[1], null);
  assert.equal(next.status, 'playing');
  assert.equal(refreshPieces(createGame()), null);
  assert.equal(refreshPieces({ ...state, status: 'lost' }), null);
  assert.equal(refreshPieces({ ...state, status: 'won' }), null);
  assert.equal(refreshPieces({ ...state, board: Array.from({ length: 8 }, () => Array(8).fill(1)) }), null);
  assert.equal(refreshPieces(fixture()), null, 'all single cells are already the desired result');
  assert.equal(refreshPieces({ ...state, pieces: [null, null, null] }), null, 'no remaining candidate means there is nothing to replace');
  assert.equal(refreshPieces({ ...state, pieces: [] }), null);
});

test('revival clears the minimum obstruction for an existing block and preserves progress', () => {
  const state = fixture();
  state.board = state.board.map((row, y) => row.map((_, x) => (x + y) % 2));
  state.pieces = [domino, null, null, null, null, null];
  state.status = 'lost'; state.score = 70; state.moves = 4; state.lines = 2; state.combo = 1;
  const before = structuredClone(state);
  assert.equal(findHint(state), null);
  const result = reviveGame(state)!;
  assert.equal(result.cleared.length, 1, 'a checkerboard domino needs precisely one cleared obstruction');
  assert.equal(result.state.status, 'playing');
  assert.ok(findHint(result.state));
  for (const key of ['score', 'moves', 'lines', 'combo', 'batch', 'refreshes'] as const) assert.equal(result.state[key], state[key]);
  assert.deepEqual(result.state.pieces, state.pieces);
  const differences: { x: number; y: number }[] = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (state.board[y][x] !== result.state.board[y][x]) differences.push({ x, y });
  assert.deepEqual(differences, result.cleared);
  result.state.pieces[0]!.cells[0].x = 7;
  assert.deepEqual(state, before);
});

test('revival is only offered after loss and can recover an exhausted malformed supply safely', () => {
  assert.equal(reviveGame(createGame()), null);
  const state = fixture();
  assert.equal(reviveGame(state), null);
  assert.equal(reviveGame({ ...state, status: 'won' }), null);
  const recovered = reviveGame({ ...state, status: 'lost', pieces: Array(3).fill(null) });
  assert.ok(recovered);
  assert.equal(recovered.state.pieces.filter(Boolean).length, 3);
  assert.equal(recovered.state.status, 'playing');
});

test('repeated hints can finish the retained goal mode without special rules or auto-placement', () => {
  let state = createGame('goal');
  for (let i = 0; i < 30 && state.status === 'playing'; i++) {
    const snapshot = structuredClone(state);
    const move = findHint(state);
    assert.deepEqual(state, snapshot);
    assert.ok(move, 'a playing level must have a hint');
    assert.ok(canPlace(state.board, state.pieces[move.index]!, move.x, move.y));
    state = placePiece(state, move.index, move.x, move.y)!.state;
  }
  assert.equal(state.status, 'won');
});
