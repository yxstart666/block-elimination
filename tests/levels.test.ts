import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceLevelTime, createGame, createLevel, getLevelGoals, getLevelTimeBonus, placePiece, refreshPieces, reviveGame, rotatePiece, LEVEL_SOLUTION } from '../src/core/game.ts';
import type { Cell, GameState, Piece } from '../src/core/game.ts';
import { LEVELS } from '../src/core/levels.ts';
import { COLOR_COUNT } from '../src/core/colors.ts';
import type { LevelDefinition, LevelGoal } from '../src/core/level-types.ts';

const emptyBoard = () => Array.from({ length: 8 }, () => Array<number>(8).fill(0));
const key = (p: Cell) => `${p.x},${p.y}`;
const single = (): Piece => ({ id: 'test-single', cells: [{ x: 0, y: 0 }], color: 1 });
const DIFFICULTIES = [4, 5, 5, 4, 5, 6, 4, 5, 6, 4, 6, 6, 5, 7, 6, 6, 5, 8, 6, 6, 5, 6, 6, 5, 7, 6, 6, 5, 8, 6];
const MECHANICS = ['lines', 'lines', 'lines', 'gems', 'gems', 'lines', 'colors', 'colors', 'gems', 'dual', 'dual', 'lines', 'dual', 'dual', 'colors', 'dual', 'gems', 'dual', 'colors', 'dual', 'lines', 'dual', 'gems', 'dual', 'dual', 'colors', 'dual', 'lines', 'dual', 'dual'];
const definitionFor = (kind: 'lines' | 'gems' | 'color', dual = false) => LEVELS.find(level =>
  level.goals.some(goal => goal.kind === kind) && (dual ? level.goals.length === 2 : level.goals.length === 1))!;
function fixture(definition = LEVELS[0]): GameState {
  return { ...createLevel(definition.id), board: emptyBoard(), pieces: [single(), single(), single()] };
}

// This witness verifier owns placement, line clearing and objective accounting.
// It intentionally does not call production canPlace/placePiece/findHint.
function verifyWitness(definition: LevelDefinition) {
  const board = definition.board.map(row => row.slice());
  let gems = new Set(definition.gems.map(key)), ice = new Set(definition.ice.map(key));
  let lines = 0, collectedGems = 0, clearedIce = 0, batch = 0, used = new Set<number>(), moves = 0, firstProgress = 0, combo = 0, score = 0;
  const clearedColors = Array<number>(COLOR_COUNT).fill(0);
  const progressFor = (goal: LevelGoal) => goal.kind === 'lines' ? lines : goal.kind === 'gems' ? collectedGems : goal.kind === 'ice' ? clearedIce : clearedColors[goal.color!];
  for (const move of definition.solution) {
    const piece = definition.batches[batch]?.[move.index];
    assert.ok(piece && !used.has(move.index), `${definition.id}: witness consumes a live slot`);
    for (const cell of piece.cells) {
      const x = move.x + cell.x, y = move.y + cell.y;
      assert.ok(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < 8 && y >= 0 && y < 8,
        `${definition.id}: witness stays on board`);
      assert.equal(board[y][x], 0, `${definition.id}: witness never overlaps at move ${moves + 1}`);
      board[y][x] = (piece.color ?? 0) + 1;
    }
    if (piece.star) gems.add(key({ x: move.x + piece.cells[0].x, y: move.y + piece.cells[0].y }));
    const fullRows = new Set(board.flatMap((row, y) => row.every(Boolean) ? [y] : []));
    const fullColumns = new Set(Array.from({ length: 8 }, (_, x) => x).filter(x => board.every(row => row[x])));
    const cleared = new Set<string>();
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      if (fullRows.has(y) || fullColumns.has(x)) {
        cleared.add(`${x},${y}`);
        clearedColors[board[y][x] - 1]++;
        board[y][x] = 0;
      }
    }
    const lineCount = fullRows.size + fullColumns.size;
    lines += lineCount;
    combo = lineCount ? combo + 1 : 0;
    score += 10 + lineCount * 20 + Math.max(0, combo - 1) * 10;
    for (const cell of cleared) {
      if (gems.delete(cell)) collectedGems++;
      if (ice.delete(cell)) clearedIce++;
    }
    moves++;
    if (!firstProgress && definition.goals.some(goal => progressFor(goal) > 0)) firstProgress = moves;
    if (definition.goals.every(goal => progressFor(goal) >= goal.target)) {
      return { moves, firstProgress, lines, gems: collectedGems, ice: clearedIce, clearedColors, score };
    }
    used.add(move.index);
    if (used.size === 3) { used = new Set(); batch++; }
  }
  assert.fail(`${definition.id}: independent witness did not reach every objective`);
}

test('the campaign has thirty distinct numbered levels with four mechanics and a rising-and-falling difficulty rhythm', () => {
  assert.equal(LEVELS.length, 30);
  assert.deepEqual(LEVELS.map(level => level.id), Array.from({ length: 30 }, (_, i) => `level-${String(i + 1).padStart(2, '0')}`));
  assert.deepEqual(LEVELS.map(level => level.number), Array.from({ length: 30 }, (_, i) => i + 1));
  assert.deepEqual(LEVELS.map(level => level.difficulty), DIFFICULTIES);
  assert.deepEqual(LEVELS.map(level => level.mechanic), MECHANICS);
  assert.deepEqual(LEVELS.filter(level => level.learning).map(level => level.number), [1, 4, 7, 10]);
  assert.ok(LEVELS.every(level => level.timeLimitSeconds === null), 'all campaign levels allow unlimited planning');
  assert.equal(LEVELS.filter(level => level.mechanic === 'dual').length, 13, 'combination tasks are used more often after the learning sequence');
  assert.equal(new Set(LEVELS.map(level => level.board.map(row => row.map(Boolean).join('')).join('/'))).size, 30,
    'each initial geometry is distinct rather than recoloring the four prototypes');
  for (const [index, level] of LEVELS.entries()) {
    assert.equal(level.learning, MECHANICS.indexOf(level.mechanic) === index, 'the first level of a mechanic is its learning level');
    if (level.learning) assert.equal(level.difficulty, 4);
    assert.ok(LEVELS.slice(Math.max(0, index - 3), index + 1).some(other => other.mechanic !== level.mechanic) || index < 3,
      'the campaign switches away before four consecutive levels of one mechanic');
    assert.equal(level.board.length, 8);
    assert.ok(level.board.every(row => row.length === 8 && row.every(cell => Number.isInteger(cell) && cell >= 0 && cell <= COLOR_COUNT)));
    assert.ok(level.batches.length >= 1);
    assert.ok(level.batches.every(batch => batch.length === 3 && batch.every(piece => piece.cells.length > 0)));
    for (const batch of level.batches) {
      let straight = 0;
      for (const piece of batch) {
        assert.equal(new Set(piece.cells.map(key)).size, piece.cells.length, `${level.id}: piece coordinates are unique`);
        assert.ok(piece.cells.every(cell => Number.isInteger(cell.x) && Number.isInteger(cell.y) && cell.x >= 0 && cell.y >= 0 && cell.x < 8 && cell.y < 8));
        if (piece.cells.length >= 3 && (piece.cells.every(cell => cell.x === 0) || piece.cells.every(cell => cell.y === 0))) straight++;
      }
      assert.ok(straight <= 1, `${level.id}: no tray relies on multiple long straight blocks`);
    }
    for (const cells of [level.gems, level.ice]) {
      assert.equal(new Set(cells.map(key)).size, cells.length, `${level.id}: target positions are unique`);
      assert.ok(cells.every(cell => Number.isInteger(cell.x) && Number.isInteger(cell.y) && cell.x >= 0 && cell.x < 8 && cell.y >= 0 && cell.y < 8));
    }
    assert.ok(level.gems.every(cell => level.board[cell.y][cell.x] !== 0), `${level.id}: gems start on actual blocks`);
    assert.deepEqual(level.ice, [], `${level.id}: obsolete ice objectives are absent from the formal campaign`);
    assert.ok(level.goals.every(goal => goal.target > 0 && Number.isInteger(goal.target)));
    for (const goal of level.goals) if (goal.kind === 'color') assert.ok(Number.isInteger(goal.color) && goal.color! >= 0 && goal.color! < COLOR_COUNT, `${level.id}: color objectives name a visible palette color`);
    const kinds = [...new Set(level.goals.map(goal => goal.kind))].sort();
    if (level.mechanic === 'dual') assert.ok(kinds.length >= 2 && level.goals.length >= 2, 'combination levels require more than one objective family');
    else assert.deepEqual(kinds, level.mechanic === 'colors' ? ['color'] : [level.mechanic]);
    const colorGoals = level.goals.filter(goal => goal.kind === 'color');
    assert.equal(new Set(colorGoals.map(goal => goal.color)).size, colorGoals.length, 'multi-color goals name distinct palette entries');
    assert.ok(level.goals.length <= 3 && colorGoals.length <= 2, 'the campaign uses at most two colors plus stars');
    assert.equal(level.starScores.length, 3);
    assert.ok(level.starScores.every((score, index) => Number.isSafeInteger(score) && score >= 0 && (index === 0 || score > level.starScores[index - 1])));
    assert.ok(Number.isInteger(level.maxMoves) && level.maxMoves > 0, `${level.id}: server score estimate is a positive integer`);
    assert.equal(level.timeLimitSeconds, null, `${level.id}: no countdown or legacy move budget is active`);
    if (level.flow) {
      assert.ok(Number.isInteger(level.flow.seed) && level.flow.seed > 0, `${level.id}: adaptive supply has a reproducible seed`);
      assert.ok(Number.isInteger(level.flow.openingBatches) && level.flow.openingBatches >= 2, `${level.id}: assistance spans more than the opening tray`);
    } else assert.ok(level.maxMoves <= level.batches.length * 3, `${level.id}: fixed budget fits finite supply`);
    assert.ok(level.maxMoves >= level.solution.length);
  }
});

for (const definition of LEVELS) {
  test(`${definition.id}: independent simulation and production rules both complete the authored route without tools`, () => {
    const independent = verifyWitness(definition);
    assert.ok(independent.moves <= definition.maxMoves);
    if (definition.learning) assert.ok(independent.firstProgress <= 2, `${definition.id}: learning starts with an early, relevant clear`);
    let state = createLevel(definition.id);
    const initial = structuredClone(state);
    const generatedBatches: Piece[][] = [];
    for (const [index, move] of definition.solution.entries()) {
      state = advanceLevelTime(state, 3_600_000);
      assert.equal(state.status, 'playing', `${definition.id}: route reaches move ${index + 1}`);
      if (!generatedBatches[state.batch]) {
        assert.ok(state.pieces.every(Boolean), `${definition.id}: a refill creates a complete tray`);
        generatedBatches[state.batch] = structuredClone(state.pieces) as Piece[];
        assert.deepEqual(generatedBatches[state.batch], definition.batches[state.batch],
          `${definition.id}: runtime tray ${state.batch + 1} matches the independently verified reference route`);
      }
      const before = structuredClone(state);
      const result = placePiece(state, move.index, move.x, move.y);
      assert.ok(result, `${definition.id}: legal route move ${index + 1}`);
      assert.deepEqual(state, before, 'playing a move leaves the source untouched');
      state = result.state;
      if (state.status === 'won') break;
    }
    assert.equal(state.status, 'won');
    assert.equal(state.moves, independent.moves);
    assert.equal(state.score, independent.score, 'independent scoring agrees with placement and combos alone');
    assert.equal(getLevelTimeBonus(state), 0, 'thinking time never affects campaign score');
    assert.ok(independent.score >= definition.starScores[2], `${definition.id}: three stars are achievable without tools`);
    assert.ok(getLevelGoals(state).every(goal => goal.current >= goal.target));
    assert.deepEqual(state.level!.clearedColors, independent.clearedColors, 'independent color accounting includes newly placed blocks and deduplicates crossing lines');
    assert.equal(state.refreshes, 0);
    assert.deepEqual(createLevel(definition.id), initial, 'retry exactly restores authored board, supply and targets');
  });
}

test('level starts are independent mutable sessions and never launch first-entry teaching', () => {
  const definition = LEVELS.find(level => level.mechanic === 'dual')!;
  const first = createLevel(definition.id), second = createLevel(definition.id), snapshot = structuredClone(second);
  assert.equal(first.mode, 'level');
  assert.equal(first.tutorial, false);
  first.board[0][0] = 99;
  first.pieces[0]!.cells[0].x = 99;
  first.level!.gems[0].x = 99;
  first.level!.ice.push({ x: 99, y: 99 });
  first.level!.clearedColors[0] = 99;
  assert.deepEqual(second, snapshot);
  assert.deepEqual(createLevel(definition.id), snapshot);
});

test('crossing lines collect target cells once and leave unhit targets intact', () => {
  const state = fixture(definitionFor('gems', true));
  for (let i = 0; i < 8; i++) { state.board[3][i] = 3; state.board[i][4] = 4; }
  state.board[3][4] = 0;
  state.board[7][7] = 1;
  state.level!.gems = [{ x: 1, y: 3 }, { x: 4, y: 1 }, { x: 7, y: 7 }];
  state.level!.ice = [{ x: 4, y: 3 }, { x: 2, y: 3 }, { x: 4, y: 2 }, { x: 0, y: 0 }];
  const before = structuredClone(state), result = placePiece(state, 0, 4, 3)!;
  assert.equal(result.cleared.length, 15);
  assert.equal(result.state.lines, 2);
  assert.equal(result.state.level!.collectedGems, 2);
  assert.equal(result.state.level!.clearedIce, 3, 'the crossing ice cell counts only once');
  assert.equal(result.state.level!.clearedColors[1], 1, 'the newly placed crossing block contributes its own color once');
  assert.equal(result.state.level!.clearedColors[2], 7);
  assert.equal(result.state.level!.clearedColors[3], 7);
  assert.equal(result.state.level!.clearedColors.reduce((sum, count) => sum + count, 0), 15);
  assert.deepEqual(result.state.level!.gems, [{ x: 7, y: 7 }]);
  assert.deepEqual(result.state.level!.ice, [{ x: 0, y: 0 }]);
  assert.deepEqual(state, before);
});

test('placing without a line clear does not collect stars, colors or the retained legacy ice layer', () => {
  const state = fixture(definitionFor('gems', true));
  state.board[7][7] = 1;
  state.level!.gems = [{ x: 7, y: 7 }];
  state.level!.ice = [{ x: 0, y: 0 }];
  const result = placePiece(state, 0, 0, 0)!;
  assert.equal(result.cleared.length, 0);
  assert.equal(result.state.level!.collectedGems, 0);
  assert.equal(result.state.level!.clearedIce, 0);
  assert.deepEqual(result.state.level!.clearedColors, Array(COLOR_COUNT).fill(0));
  assert.deepEqual(result.state.level!.gems, state.level!.gems);
  assert.deepEqual(result.state.level!.ice, state.level!.ice);
  assert.ok(result.state.board[0][0]);
});

test('dual challenges require both objectives; a high score or one completed goal is insufficient', () => {
  const definition = definitionFor('gems', true);
  for (const completed of ['gems', 'color'] as const) {
    const state = fixture(definition);
    const target = definition.goals.find(goal => goal.kind === completed)!.target;
    if (completed === 'gems') state.level!.collectedGems = target;
    else state.level!.clearedColors[definition.goals.find(goal => goal.kind === 'color')!.color!] = target;
    state.score = 10_000;
    assert.equal(placePiece(state, 0, 0, 0)!.state.status, 'playing');
  }
});

test('a color goal counts only its named palette color rather than all colored blocks or score', () => {
  const definition = definitionFor('color'), state = fixture(definition);
  const color = definition.goals.find(goal => goal.kind === 'color')!.color!;
  state.level!.clearedColors = Array(COLOR_COUNT).fill(99);
  state.level!.clearedColors[color] = 0;
  state.score = 10_000;
  const next = placePiece(state, 0, 0, 0)!.state;
  assert.equal(getLevelGoals(next)[0].current, 0);
  assert.equal(next.status, 'playing');
});

test('an invalid level placement consumes neither a move nor any objective', () => {
  const state = createLevel(LEVELS[0].id), before = structuredClone(state);
  assert.equal(placePiece(state, 0, -1, 0), null);
  assert.equal(placePiece(state, 0, 0.5, 0), null);
  assert.deepEqual(state, before);
});

test('untimed legacy fixtures retain their placement budget without meeting the target', () => {
  const definition = { ...definitionFor('lines'), id: 'legacy-budget-exhausted', timeLimitSeconds: undefined };
  LEVELS.push(definition);
  try {
    const state = fixture(definition); state.moves = definition.maxMoves - 1;
    const next = placePiece(state, 0, 0, 0)!.state;
    assert.equal(next.moves, definition.maxMoves);
    assert.equal(next.status, 'lost');
    assert.equal(reviveGame(next), null, 'ad revival cannot restore an exhausted legacy move budget');
  } finally { LEVELS.splice(LEVELS.indexOf(definition), 1); }
});

test('an untimed legacy target on its final allowed placement still wins first', () => {
  const definition = { ...definitionFor('lines'), id: 'legacy-budget-victory', timeLimitSeconds: undefined };
  LEVELS.push(definition);
  try {
    const state = fixture(definition); state.moves = definition.maxMoves - 1;
    state.lines = definition.goals[0].target - 1;
    state.board[0] = [1, 1, 1, 1, 1, 1, 1, 0];
    assert.equal(placePiece(state, 0, 7, 0)!.state.status, 'won');
  } finally { LEVELS.splice(LEVELS.indexOf(definition), 1); }
});

test('a retained fixed-supply fixture cannot silently loop after its final tray', () => {
  const definition = { ...definitionFor('lines'), id: 'test-fixed-supply', flow: undefined };
  LEVELS.push(definition);
  try {
    const state = fixture(definition);
    state.batch = definition.batches.length - 1;
    state.pieces = [single(), null, null];
    const next = placePiece(state, 0, 0, 0)!.state;
    assert.equal(next.status, 'lost');
    assert.ok(next.pieces.every(piece => piece === null));
    assert.equal(reviveGame(next), null, 'ad revival cannot invent a new fixed tray');
  } finally { LEVELS.splice(LEVELS.indexOf(definition), 1); }
});

test('a blocked remaining tray loses while the campaign still has time', () => {
  const state = fixture();
  state.board = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => (x + y) % 2));
  state.pieces = [single(), { id: 'blocked-square', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] }, null];
  assert.equal(placePiece(state, 0, 0, 0)!.state.status, 'lost');
});

test('refresh and rotation preserve target state and cost no objective progress or placement moves', () => {
  const state = fixture(definitionFor('gems', true));
  state.pieces[0] = { id: 'corner', cells: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] };
  const before = structuredClone(state);
  for (const next of [refreshPieces(state), rotatePiece(state, 0, true)]) {
    assert.ok(next);
    assert.deepEqual(next.level, before.level);
    assert.deepEqual(getLevelGoals(next), getLevelGoals(before));
    assert.equal(next.moves, before.moves);
    assert.equal(next.lines, before.lines);
    assert.equal(next.score, before.score);
  }
  assert.deepEqual(state, before);
});

test('revival frees only non-gem obstacles and does not collect targets', () => {
  const state = fixture(definitionFor('gems', true));
  state.status = 'lost';
  state.board = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => (x + y) % 2));
  state.pieces = [{ id: 'blocked-square', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] }, null, null];
  state.level!.gems = [{ x: 1, y: 0 }, { x: 0, y: 1 }];
  state.level!.ice = [{ x: 1, y: 0 }, { x: 3, y: 2 }];
  const before = structuredClone(state), result = reviveGame(state)!;
  assert.ok(result);
  assert.equal(result.state.status, 'playing');
  assert.deepEqual(result.state.level, before.level);
  assert.ok(result.cleared.every(cell => !before.level!.gems.some(gem => key(gem) === key(cell))));
  for (const gem of before.level!.gems) assert.ok(result.state.board[gem.y][gem.x]);
  for (const field of ['score', 'lines', 'moves', 'combo'] as const) assert.equal(result.state[field], before[field]);
  assert.deepEqual(state, before);
});

test('legacy goal and endless modes keep their prior completion behavior', () => {
  let goal = createGame('goal');
  for (const move of LEVEL_SOLUTION) {
    if (goal.status !== 'playing') break;
    goal = placePiece(goal, move.index, move.x, move.y)!.state;
  }
  assert.equal(goal.status, 'won');
  const endless = createGame('endless', false, 77);
  assert.equal(endless.mode, 'endless');
  assert.equal(endless.level, undefined);
  assert.ok(endless.board.flat().every(cell => cell === 0));
  assert.deepEqual(endless, createGame('endless', false, 77));
});
