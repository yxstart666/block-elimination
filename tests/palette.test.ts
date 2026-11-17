import test from 'node:test';
import assert from 'node:assert/strict';
import { COLOR_BASES, COLOR_COUNT, COLOR_NAMES, LEGACY_COLOR_MAP, STAR_TILE_IDS, TILE_IDS, migrateLegacyColor } from '../src/core/colors.ts';
import { createGame, createLevel, findHint, placePiece } from '../src/core/game.ts';
import { LEVELS } from '../src/core/levels.ts';
import { sanitizeCampaign } from '../src/services/campaign.ts';
import { sanitizeEconomy } from '../src/services/economy.ts';

test('gameplay color indices, labels and ordinary/starred art share five distinct meanings', () => {
  assert.equal(COLOR_COUNT, 5);
  assert.deepEqual(COLOR_NAMES, ['红色', '黄色', '绿色', '蓝色', '紫色']);
  assert.deepEqual(TILE_IDS, ['tile_red', 'tile_yellow', 'tile_green', 'tile_blue', 'tile_purple']);
  assert.deepEqual(STAR_TILE_IDS, TILE_IDS.map(id => `${id}_star`));
  assert.equal(new Set(COLOR_BASES).size, COLOR_COUNT);
  for (const definition of LEVELS) {
    assert.ok(definition.board.every(row => row.every(value => Number.isInteger(value) && value >= 0 && value <= COLOR_COUNT)));
    assert.ok(definition.batches.every(batch => batch.every(piece => Number.isInteger(piece.color) && piece.color! >= 0 && piece.color! < COLOR_COUNT)));
    const colors = definition.goals.filter(goal => goal.kind === 'color').map(goal => goal.color);
    assert.ok(colors.every(color => Number.isInteger(color) && color! >= 0 && color! < COLOR_COUNT));
    assert.equal(new Set(colors).size, colors.length, `${definition.id}: no hidden duplicate target colors`);
  }
});

test('tutorial, retained goal and seeded endless supplies never produce a sixth gameplay color', () => {
  for (const mode of ['goal', 'endless'] as const) for (const tutorial of [false, true]) {
    for (const seed of [1, 77, 0xffffffff]) {
      let state = createGame(mode, tutorial, seed);
      for (let step = 0; step < 30 && state.status === 'playing'; step++) {
        assert.ok(state.board.every(row => row.every(value => value >= 0 && value <= COLOR_COUNT)));
        assert.ok(state.pieces.every(piece => !piece || Number.isInteger(piece.color) && piece.color! >= 0 && piece.color! < COLOR_COUNT));
        const move = findHint(state);
        assert.ok(move);
        state = placePiece(state, move.index, move.x, move.y)!.state;
      }
    }
  }
});

test('a named color goal counts only that five-color family, including newly placed cells', () => {
  const definition = LEVELS.find(level => level.mechanic === 'colors' && level.goals.length === 1)!;
  const targetColor = definition.goals[0].color!;
  const placedColor = (targetColor + 2) % COLOR_COUNT;
  let state = createLevel(definition.id);
  state.board = Array.from({ length: 8 }, () => Array(8).fill(0));
  state.board[0] = Array(8).fill(targetColor + 1); state.board[0][7] = 0;
  state.pieces = [{ id: 'different-color-single', cells: [{ x: 0, y: 0 }], color: placedColor }, null, null];
  state = placePiece(state, 0, 7, 0)!.state;
  assert.equal(state.level!.clearedColors.length, COLOR_COUNT);
  assert.equal(state.level!.clearedColors[targetColor], 7);
  assert.equal(state.level!.clearedColors[placedColor], 1);
  assert.equal(state.level!.clearedColors.reduce((sum, count) => sum + count, 0), 8);
});

test('the legacy seven-color mapping is explicit and never treats invalid data as a new color', () => {
  assert.deepEqual(LEGACY_COLOR_MAP, [3, 2, 4, 1, 0, 3, 2]);
  assert.deepEqual(Array.from({ length: 7 }, (_, color) => migrateLegacyColor(color)), [...LEGACY_COLOR_MAP]);
  for (const color of [-1, 7, .5, NaN]) assert.throws(() => migrateLegacyColor(color), RangeError);
});

test('five-color definitions retain v1 completion, lesson, score and claimed economy records', () => {
  const campaign = sanitizeCampaign({ version: 1, completed: ['level-01', 'level-07'], lessonsSeen: ['level-01', 'level-07:colors-v1'] });
  assert.deepEqual(campaign.completed, ['level-01', 'level-07']);
  assert.deepEqual(campaign.lessonsSeen, ['level-01', 'level-07:colors-v1']);
  const economy = sanitizeEconomy({ version: 1, coins: 15,
    inventory: { hint: 2, rotate: 1, refresh: 0, bomb: 1, bulldozer: 0 },
    levels: { 'level-07': { bestScore: 470, stars: 2, rewardStars: 2 } },
    claimedRuns: ['before-five-colors'], doubledRuns: ['before-five-colors'], pendingDoubles: [] });
  assert.equal(economy.coins, 15);
  assert.deepEqual(economy.levels['level-07'], { bestScore: 470, stars: 2, rewardStars: 2 });
  assert.deepEqual(economy.inventory, { hint: 2, rotate: 1, refresh: 0, bomb: 1, bulldozer: 0 });
  assert.deepEqual(economy.doubledRuns, ['before-five-colors']);
});
