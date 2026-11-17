import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBulldozer, createLevel } from '../src/core/game.ts';
import { LEVELS } from '../src/core/levels.ts';
import { COLOR_COUNT } from '../src/core/colors.ts';

function fixture() {
  const state = createLevel(LEVELS.find(level => level.mechanic === 'gems')!.id);
  state.board = Array.from({ length: 8 }, () => Array(8).fill(0));
  state.board[1][2] = 3;
  for (let y = 5; y < 8; y++) for (let x = 0; x < 8; x++) state.board[y][x] = x % COLOR_COUNT + 1;
  state.level!.gems = [{ x: 0, y: 5 }, { x: 3, y: 6 }, { x: 7, y: 7 }];
  state.level!.collectedGems = 1;
  state.level!.clearedColors = Array(COLOR_COUNT).fill(0);
  state.pieces = [{ id: 'sweep-single', color: 0, cells: [{ x: 0, y: 0 }] }, null, null];
  return state;
}

test('each bulldozer prefix clears contacted columns immediately and leaves later columns intact', () => {
  const source = fixture(), snapshot = structuredClone(source);
  for (let column = 0; column < 8; column++) {
    const result = applyBulldozer(source, column)!;
    assert.ok(result);
    assert.equal(result.cleared.length, (column + 1) * 3);
    assert.equal(result.state.board[1][2], 3);
    for (let y = 5; y < 8; y++) for (let x = 0; x < 8; x++) {
      assert.equal(result.state.board[y][x], x <= column ? 0 : source.board[y][x]);
    }
    assert.deepEqual(source, snapshot, 'prefixes never mutate the animation snapshot');
  }
});

test('successive prefix snapshots count every contacted star and color once', () => {
  const source = fixture();
  for (let column = 0; column < 8; column++) {
    const state = applyBulldozer(source, column)!.state;
    assert.equal(state.level!.collectedGems, 1 + [0, 3, 7].filter(x => x <= column).length);
    for (let color = 0; color < COLOR_COUNT; color++) {
      const columns = Array.from({ length: column + 1 }, (_, x) => x).filter(x => x % COLOR_COUNT === color).length;
      assert.equal(state.level!.clearedColors[color], columns * 3);
    }
    for (const field of ['score', 'moves', 'lines', 'combo', 'batch', 'rng', 'seed'] as const) assert.equal(state[field], source[field]);
    assert.equal(state.level!.timeRemainingMs, source.level!.timeRemainingMs);
  }
  assert.deepEqual(applyBulldozer(source, 7), applyBulldozer(source), 'the final prefix equals the complete original power');
});

test('empty prefixes do not pretend to clear blocks, while later contacts still work', () => {
  const source = fixture();
  for (let y = 5; y < 8; y++) for (let x = 0; x < 4; x++) source.board[y][x] = 0;
  source.level!.gems = [{ x: 7, y: 7 }];
  assert.equal(applyBulldozer(source, 3), null);
  assert.equal(applyBulldozer(source, 4)!.cleared.length, 3);
});

test('bulldozer prefix API rejects invalid columns while unlimited planning ignores stale clock data', () => {
  const source = fixture();
  for (const column of [-1, 8, .5, NaN, Infinity]) assert.equal(applyBulldozer(source, column), null);
  source.level!.timeRemainingMs = 0;
  assert.ok(applyBulldozer(source, 0), 'a leftover zero clock is not a deadline in the unlimited campaign');
});
