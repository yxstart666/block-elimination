import test from 'node:test';
import assert from 'node:assert/strict';
import { LEVELS } from '../src/core/levels.ts';
import { advanceLevelTime, createLevel, placePiece } from '../src/core/game.ts';
import { completeLevel, consumeInventory, doubleReward, grantInventory, purchaseInventory, rateLevelStars, sanitizeEconomy, TOOL_PRICES } from '../src/services/economy.ts';
import type { EconomyState, InventoryKind } from '../src/services/economy.ts';

const first = LEVELS[0];
const initial = () => sanitizeEconomy(undefined);

test('new economy starts with zero coins and three of each ordinary tool only', () => {
  assert.deepEqual(initial(), { version: 1, coins: 0, inventory: { hint: 3, rotate: 3, refresh: 3, bomb: 0, bulldozer: 0 },
    levels: {}, claimedRuns: [], doubledRuns: [], pendingDoubles: [] });
  for (const value of [undefined, null, '', '{', [], 5, { version: 2, coins: 900 }]) assert.deepEqual(sanitizeEconomy(value), initial());
});

test('every authored witness can earn three stars and exact score thresholds select one/two/three', () => {
  for (const level of LEVELS) {
    assert.deepEqual(level.starScores[0], 0);
    assert.ok(level.starScores[1] > 0 && level.starScores[2] > level.starScores[1]);
    assert.equal(rateLevelStars(level.id, 0), 1);
    assert.equal(rateLevelStars(level.id, level.starScores[1] - 1), 1);
    assert.equal(rateLevelStars(level.id, level.starScores[1]), 2);
    assert.equal(rateLevelStars(level.id, level.starScores[2] - 1), 2);
    assert.equal(rateLevelStars(level.id, level.starScores[2]), 3);
    let state = createLevel(level.id);
    for (const move of level.solution) {
      state = advanceLevelTime(state, 4000);
      state = placePiece(state, move.index, move.x, move.y)!.state;
      if (state.status === 'won') break;
    }
    assert.equal(state.status, 'won');
    assert.equal(state.score, level.starScores[2], `${level.id}: the benchmark uses placement and clear points without a time bonus`);
    assert.equal(rateLevelStars(level.id, state.score), 3, `${level.id}: full stars are actually reachable`);
  }
});

test('first completion awards ten/fifteen/forty coins for the earned star band', () => {
  for (const [stars, score, coins] of [[1, 0, 10], [2, first.starScores[1], 15], [3, first.starScores[2], 40]]) {
    const source = initial(), before = structuredClone(source);
    const result = completeLevel(source, first.id, score, `first-${stars}`, () => 0)!;
    assert.equal(result.stars, stars); assert.equal(result.coinsGranted, coins);
    assert.equal(result.state.coins, coins); assert.equal(result.canDouble, true);
    assert.deepEqual(result.state.levels[first.id], { bestScore: score, stars, rewardStars: stars });
    assert.equal(result.chest?.count ?? 0, stars === 3 ? 1 : 0);
    assert.deepEqual(source, before);
  }
});

test('improved star ratings only grant the difference and the first full-star chest exactly once', () => {
  let account = initial(), randomCalls = 0;
  const random = () => { randomCalls++; return .5; };
  const one = completeLevel(account, first.id, 0, 'one', random)!; account = one.state;
  assert.equal(one.coinsGranted, 10); assert.equal(one.chest, null);
  const two = completeLevel(account, first.id, first.starScores[1], 'two', random)!; account = two.state;
  assert.equal(two.coinsGranted, 5); assert.equal(two.chest, null);
  const three = completeLevel(account, first.id, first.starScores[2], 'three', random)!; account = three.state;
  assert.equal(three.coinsGranted, 25); assert.deepEqual(three.chest, { kind: 'rotate', count: 1 });
  assert.equal(account.coins, 40); assert.equal(randomCalls, 1);
  assert.equal(account.inventory.rotate, 4);
  for (const [run, score] of [['repeat-full', first.starScores[2] + 50], ['repeat-low', 0]] as const) {
    const replay = completeLevel(account, first.id, score, run, random)!; account = replay.state;
    assert.equal(replay.coinsGranted, 0); assert.equal(replay.chest, null); assert.equal(replay.canDouble, false);
  }
  assert.equal(account.levels[first.id].bestScore, first.starScores[2] + 50);
  assert.equal(account.levels[first.id].stars, 3); assert.equal(account.levels[first.id].rewardStars, 3);
  assert.equal(account.coins, 40); assert.equal(randomCalls, 1);
});

test('full-star chest draws only one of hint/rotate/refresh and never destructive tools', () => {
  const kinds = new Set<string>();
  for (const [index, random] of [0, .5, 1].entries()) {
    const reward = completeLevel(initial(), first.id, first.starScores[2], `chest-${index}`, () => random)!;
    assert.ok(reward.chest); kinds.add(reward.chest.kind);
    const inventories = Object.entries(reward.state.inventory);
    assert.equal(inventories.length, 5); assert.equal(inventories.filter(([, count]) => count === 4).length, 1);
    assert.equal(reward.state.inventory.bomb, 0); assert.equal(reward.state.inventory.bulldozer, 0);
  }
  assert.deepEqual([...kinds].sort(), ['hint', 'refresh', 'rotate']);
});

test('each new coin reward doubles once without repeating the chest or changing best stars', () => {
  const won = completeLevel(initial(), first.id, first.starScores[2], 'double-me', () => 0)!;
  const before = structuredClone(won.state), doubled = doubleReward(won.state, 'double-me')!;
  assert.equal(doubled.coinsGranted, 40); assert.equal(doubled.state.coins, 80);
  assert.deepEqual(doubled.state.inventory, before.inventory); assert.deepEqual(doubled.state.levels, before.levels);
  assert.deepEqual(won.state, before);
  assert.equal(doubleReward(doubled.state, 'double-me'), null);
  assert.equal(doubleReward(doubled.state, 'unknown'), null);
  const duplicateCompletion = completeLevel(doubled.state, first.id, first.starScores[2], 'double-me', () => { throw new Error('must not draw again'); })!;
  assert.equal(duplicateCompletion.coinsGranted, 0); assert.equal(duplicateCompletion.canDouble, false);
  assert.equal(duplicateCompletion.chest, null); assert.equal(duplicateCompletion.state.coins, 80);
});

test('star-upgrade rewards can each double, while the combined per-level base total stays 40', () => {
  let account = initial();
  for (const [index, score] of [0, first.starScores[1], first.starScores[2]].entries()) {
    const reward = completeLevel(account, first.id, score, `upgrade-${index}`, () => 0)!;
    account = doubleReward(reward.state, reward.runId)!.state;
  }
  assert.equal(account.coins, 80); assert.equal(account.levels[first.id].rewardStars, 3);
  assert.equal(account.inventory.hint, 4);
});

test('duplicate completion run IDs do not grant again or consume another random chest draw', () => {
  const firstReward = completeLevel(initial(), first.id, first.starScores[2], 'same-run', () => 0)!;
  const duplicate = completeLevel(firstReward.state, first.id, first.starScores[2], 'same-run', () => { throw new Error('no second chest'); })!;
  assert.equal(duplicate.coinsGranted, 0); assert.equal(duplicate.chest, null);
  assert.equal(duplicate.canDouble, true, 'the original, unclaimed double remains available');
  assert.deepEqual(duplicate.state, firstReward.state);
});

test('run history is bounded but evicting an old run cannot make a completed star band farmable', () => {
  const old = completeLevel(initial(), first.id, first.starScores[2], 'old-run', () => 0)!;
  let account = old.state;
  for (let index = 0; index < 130; index++) account = completeLevel(account, first.id, first.starScores[2], `replay-${index}`, () => { throw new Error('no repeat chest'); })!.state;
  assert.equal(account.claimedRuns.length, 100);
  assert.equal(account.claimedRuns.includes('old-run'), false);
  assert.equal(account.pendingDoubles.some(entry => entry.runId === 'old-run'), false);
  const replay = completeLevel(account, first.id, first.starScores[2], 'old-run', () => { throw new Error('no replay chest'); })!;
  assert.equal(replay.coinsGranted, 0); assert.equal(replay.chest, null); assert.equal(replay.canDouble, false);
  assert.equal(replay.state.coins, 40); assert.equal(replay.state.inventory.hint, 4);
});

test('inventory is consumed one at a time, remains immutable and cannot spend beyond zero', () => {
  const source = initial(), before = structuredClone(source);
  for (const kind of ['hint', 'rotate', 'refresh'] as const) {
    let account = source;
    for (let count = 2; count >= 0; count--) {
      account = consumeInventory(account, kind)!; assert.equal(account.inventory[kind], count);
    }
    assert.equal(consumeInventory(account, kind), null);
    const granted = grantInventory(account, kind);
    assert.equal(granted.inventory[kind], 1); assert.equal(consumeInventory(granted, kind)!.inventory[kind], 0);
  }
  assert.deepEqual(source, before);
  assert.equal(consumeInventory(source, 'unknown' as InventoryKind), null);
  assert.deepEqual(grantInventory(source, 'unknown' as InventoryKind), source);
  assert.deepEqual(grantInventory(source, 'hint', -1), source);
});

test('serialized saves keep pending double rewards, claimed chests, inventory and best records', () => {
  const won = completeLevel(initial(), first.id, first.starScores[2], 'persist-run', () => .8)!;
  const spent = consumeInventory(won.state, 'hint')!;
  const saved = sanitizeEconomy(JSON.stringify(spent));
  assert.deepEqual(saved, spent);
  assert.equal(saved.inventory.refresh, 4); assert.equal(saved.inventory.hint, 2);
  const doubled = doubleReward(saved, 'persist-run')!;
  assert.equal(doubled.state.coins, 80);
  const reopened = sanitizeEconomy(JSON.stringify(doubled.state));
  assert.equal(doubleReward(reopened, 'persist-run'), null);
  assert.equal(completeLevel(reopened, first.id, first.starScores[2], 'persist-replay', () => 0)!.chest, null);
});

test('malformed valid-version saves filter unknown levels, illegal tools and invalid pending rewards', () => {
  const malformed = { version: 1, coins: Infinity, inventory: { hint: -1, rotate: 1.5, refresh: 8, bomb: 999, bulldozer: -2, unknown: 1000 },
    levels: { [first.id]: { bestScore: 20, stars: 5, rewardStars: 99 }, unknown: { bestScore: 999, stars: 3, rewardStars: 3 } },
    claimedRuns: ['ok', 'ok', ' paid ', '', 5], doubledRuns: ['used', 'not-claimed'],
    pendingDoubles: [{ runId: 'ok', coins: 10 }, { runId: 'not-claimed', coins: 40 }, { runId: 'ok', coins: 41 }] };
  const saved = sanitizeEconomy(malformed);
  assert.equal(saved.coins, 0); assert.deepEqual(saved.inventory, { hint: 0, rotate: 0, refresh: 8, bomb: 999, bulldozer: 0 });
  assert.deepEqual(Object.keys(saved.levels), [first.id]);
  assert.deepEqual(saved.levels[first.id], { bestScore: 20, stars: 3, rewardStars: 3 });
  assert.deepEqual(saved.claimedRuns, ['ok']); assert.deepEqual(saved.doubledRuns, []);
  assert.deepEqual(saved.pendingDoubles, [{ runId: 'ok', coins: 10 }]);
});

test('invalid completion requests do not change the source or grant anything', () => {
  const source = initial(), before = structuredClone(source);
  for (const [id, score, run] of [[first.id, -1, 'a'], [first.id, NaN, 'b'], [first.id, 1.5, 'c'], ['missing', 10, 'd'],
    [first.id, 0, ''], [first.id, 0, ' padded ']] as const) {
    assert.equal(completeLevel(source, id, score, run, () => { throw new Error('no reward random draw'); }), null);
  }
  assert.deepEqual(source, before);
});

test('separate levels have separate reward caps and ordinary reward state owns all mutable data', () => {
  let account = initial();
  for (const level of LEVELS) account = completeLevel(account, level.id, 0, `first-${level.id}`)!.state;
  assert.equal(account.coins, LEVELS.length * 10);
  assert.equal(Object.keys(account.levels).length, LEVELS.length);
  const before = structuredClone(account), copy = sanitizeEconomy(account);
  copy.inventory.hint = 99; copy.levels[first.id].stars = 0; copy.claimedRuns[0] = 'changed'; copy.pendingDoubles[0].coins = 100;
  assert.deepEqual(account, before);
});

test('existing v1 saves gain empty destructive inventories without replenishing spent tools', () => {
  const legacy = { ...initial(), coins: 37, inventory: { hint: 0, rotate: 1, refresh: 2 } };
  const before = structuredClone(legacy), migrated = sanitizeEconomy(JSON.stringify(legacy));
  assert.equal(migrated.version, 1); assert.equal(migrated.coins, 37);
  assert.deepEqual(migrated.inventory, { hint: 0, rotate: 1, refresh: 2, bomb: 0, bulldozer: 0 });
  assert.deepEqual(legacy, before);
});

test('each tool can be bought for its exact coin price as one atomic immutable operation', () => {
  assert.deepEqual(TOOL_PRICES, { hint: 10, rotate: 15, refresh: 20, bomb: 30, bulldozer: 40 });
  for (const kind of Object.keys(TOOL_PRICES) as InventoryKind[]) {
    const source = completeLevel(initial(), first.id, 0, `purchase-${kind}`)!.state;
    source.coins = TOOL_PRICES[kind];
    const before = structuredClone(source), purchased = purchaseInventory(source, kind)!;
    assert.ok(purchased); assert.equal(purchased.coins, 0);
    assert.deepEqual(purchased.inventory, { ...before.inventory, [kind]: before.inventory[kind] + 1 });
    assert.deepEqual(purchased.levels, before.levels); assert.deepEqual(purchased.pendingDoubles, before.pendingDoubles);
    assert.deepEqual(source, before);
    purchased.inventory[kind] = 99; purchased.levels[first.id].stars = 0; purchased.pendingDoubles[0].coins = 1;
    assert.deepEqual(source, before, 'purchase state owns its nested records');
  }
});

test('insufficient coins, invalid tools and full inventory fail without charging or granting', () => {
  for (const kind of Object.keys(TOOL_PRICES) as InventoryKind[]) {
    const source = initial(); source.coins = TOOL_PRICES[kind] - 1;
    const before = structuredClone(source);
    assert.equal(purchaseInventory(source, kind), null); assert.deepEqual(source, before);
    source.coins = 100; source.inventory[kind] = Number.MAX_SAFE_INTEGER;
    const full = structuredClone(source);
    assert.equal(purchaseInventory(source, kind), null); assert.deepEqual(source, full);
  }
  const source = initial(); source.coins = 100;
  const before = structuredClone(source);
  for (const kind of ['unknown', '__proto__', 'constructor']) assert.equal(purchaseInventory(source, kind as InventoryKind), null);
  assert.deepEqual(source, before);
});

test('destructive tools can be granted, persisted and consumed once without changing ordinary tools', () => {
  for (const kind of ['bomb', 'bulldozer'] as const) {
    const source = initial(), before = structuredClone(source);
    assert.equal(consumeInventory(source, kind), null);
    const granted = grantInventory(source, kind), restored = sanitizeEconomy(JSON.stringify(granted));
    assert.equal(restored.inventory[kind], 1);
    const consumed = consumeInventory(restored, kind)!;
    assert.equal(consumed.inventory[kind], 0); assert.equal(consumeInventory(consumed, kind), null);
    assert.deepEqual(consumed.inventory, before.inventory); assert.deepEqual(source, before);
  }
});
