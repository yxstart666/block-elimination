import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { buildAll } from './build.mjs';
import { serve } from './server.mjs';
import { LEVELS } from '../src/core/levels.ts';

await buildAll();
await mkdir('.local/qa', { recursive: true });
const server = serve(0);
await once(server, 'listening');
const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(localChrome) ? localChrome : undefined);
const definition = LEVELS.find(level => level.mechanic === 'dual');
assert.ok(definition);
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ ids, lesson }) => {
    localStorage.setItem('wood-blocks.tutorial-seen.v1', 'true');
    localStorage.setItem('wood-blocks.best.v1', '1');
    // A test-only isolated browser profile lets the real map select a dual
    // objective level without mutating the user's actual campaign save.
    localStorage.setItem('wood-blocks.campaign.v1', JSON.stringify({ version: 1, completed: ids, lessonsSeen: [lesson] }));
  }, { ids: LEVELS.slice(0, definition.number - 1).map(level => level.id), lesson: definition.id });
  await page.goto(`http://127.0.0.1:${server.address().port}/?debug=1&test=off`);
  await page.waitForFunction(() => window.__game?.assets?.ready);
  const read = () => page.evaluate(() => {
    const g = window.__game;
    const state = structuredClone(g.state); if (state.level) delete state.level.timeRemainingMs;
    return { state, uses: g.powerUses, grants: g.powerGrants, busy: g.rewardBusy,
      progress: g.campaignProgress, best: g.bestScore, overlay: g.overlay, acquireKind: g.acquireKind, economy: g.economy, settlement: g.settlement };
  });
  const click = async (method, index = 0) => {
    const point = await page.evaluate(({ method, index }) => {
      const g = window.__game, canvas = document.querySelector('canvas').getBoundingClientRect();
      const result = typeof g[method] === 'function' ? g[method]() : g[method], r = Array.isArray(result) ? result[index] : result;
      if (!r) throw new Error(`Missing ${method} ${index}`);
      return { x: canvas.left + g.offsetX + (r.x + r.w / 2) * g.scale,
        y: canvas.top + g.offsetY + (r.y + r.h / 2) * g.scale };
    }, { method, index });
    const viewport = page.viewportSize();
    assert.ok(point.x >= 0 && point.x <= viewport.width && point.y >= 0 && point.y <= viewport.height,
      `${method} ${index} is inside the actual viewport`);
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => !window.__game.pendingDestruction);
  };
  const texts = () => page.evaluate(() => {
    const g = window.__game, values = [], original = g.ctx.fillText;
    g.ctx.fillText = function (value, ...args) { values.push(String(value)); return original.call(this, value, ...args); };
    try { g.draw(); } finally { g.ctx.fillText = original; }
    return values;
  });
  const deferred = () => page.evaluate(() => {
    window.__destructiveCalls = []; window.__finishDestructive = null;
    window.__game.options.rewarded = { request(kind) {
      window.__destructiveCalls.push(kind);
      return new Promise(resolve => { window.__finishDestructive = resolve; });
    }, dispose() {} };
  });
  const settle = async result => {
    await page.evaluate(result => window.__finishDestructive(result), result);
    await page.waitForFunction(() => !window.__game.rewardBusy);
  };
  const fixture = async (kind = 'normal') => {
    await page.evaluate(({ kind, goals }) => {
      const g = window.__game;
      g.reset();
      g.economy.inventory.bomb = 0; g.economy.inventory.bulldozer = 0;
      const board = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => (x + y) % 2 === 0 ? (x + y * 3) % 5 + 1 : 0));
      let gems = [{ x: 0, y: 0 }, { x: 7, y: 7 }], ice = [];
      let collectedGems = 0, clearedIce = 0;
      const clearedColors = Array(5).fill(0);
      if (kind === 'empty') { for (const row of board) row.fill(0); gems = []; ice = []; }
      if (kind === 'top-only') { for (const row of board) row.fill(0); board[0][0] = 1; gems = [{ x: 0, y: 0 }]; ice = []; }
      if (kind === 'win') {
        const colorGoal = goals.find(goal => goal.kind === 'color');
        const otherColorValue = (colorGoal.color + 1) % 5 + 1;
        for (const row of board) for (let x = 0; x < 8; x++) if (row[x]) row[x] = otherColorValue;
        board[6][1] = colorGoal.color + 1;
        gems = [{ x: 2, y: 6 }]; ice = [];
        collectedGems = goals.find(goal => goal.kind === 'gems').target - gems.length;
        clearedColors[colorGoal.color] = colorGoal.target - 1;
      }
      g.state = { ...g.state, board, status: 'lost', tutorial: false, score: 123, lines: 2, moves: 3, combo: 2,
        pieces: [0, 1, 2].map(index => ({ id: `destructive-test-${index}`, color: index, cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] })),
        level: { ...g.state.level, gems, ice, collectedGems, clearedIce, clearedColors } };
      g.selected = -1; g.ghost = null; g.drag = null; g.overlay = null; g.rotationMode = false; g.rotationOriginals = null;
      g.particles = []; g.flash = []; g.flashAt = 0; g.clearFx = null; g.placeFx = null; g.gainFx = null; g.returnFx = null;
      g.pop.at = 0; g.toast.at = 0; g.resultAt = Date.now() - 1200; g.invalidate();
    }, { kind, goals: definition.goals });
  };
  const unchanged = (before, after, reason) => {
    for (const field of ['state', 'uses', 'grants', 'progress', 'best', 'economy', 'settlement']) assert.deepEqual(after[field], before[field], reason);
  };
  const preserved = (before, after) => {
    assert.equal(after.state.score, before.state.score, 'destruction awards neither placement points nor time points');
    for (const field of ['lines', 'moves', 'combo', 'batch', 'rng', 'seed', 'pieces', 'refreshes']) {
      assert.deepEqual(after.state[field], before.state[field], `${field} is not earned or consumed by destruction`);
    }
    assert.deepEqual(after.uses, before.uses, 'campaign ad powers never consume the two basic tools');
    assert.deepEqual(after.grants, before.grants);
    assert.equal(after.best, before.best, 'campaign destruction cannot change the endless best');
  };
  const checkArea = (before, after, area) => {
    const keys = new Set(area.map(p => `${p.x},${p.y}`));
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      assert.equal(after.state.board[y][x], keys.has(`${x},${y}`) ? 0 : before.state.board[y][x], 'only cells in the tool area change');
    }
    const remainingGems = before.state.level.gems.filter(p => !keys.has(`${p.x},${p.y}`));
    const remainingIce = before.state.level.ice.filter(p => !keys.has(`${p.x},${p.y}`));
    assert.deepEqual(after.state.level.gems, remainingGems);
    assert.deepEqual(after.state.level.ice, remainingIce);
    assert.equal(after.state.level.collectedGems, before.state.level.collectedGems + before.state.level.gems.length - remainingGems.length);
    assert.equal(after.state.level.clearedIce, before.state.level.clearedIce + before.state.level.ice.length - remainingIce.length);
    const expectedColors = [...before.state.level.clearedColors];
    for (const p of area) if (before.state.board[p.y][p.x]) expectedColors[before.state.board[p.y][p.x] - 1]++;
    assert.deepEqual(after.state.level.clearedColors, expectedColors, 'destruction advances the colors of the actual removed blocks only');
    preserved(before, after);
  };

  const beginAcquisition = async (index, method = 'destructiveButtons') => {
    const kind = index === 0 ? 'bomb' : 'bulldozer';
    await click(method, method === 'dockButtons' ? index + 3 : index);
    const opened = await read();
    assert.equal(opened.overlay, 'acquire');
    assert.equal(opened.acquireKind, kind);
    await click('acquireButtons', 0);
    return kind;
  };
  const acquired = (before, after, kind) => {
    assert.deepEqual(after.state, before.state, 'acquiring stock never applies a destructive effect');
    assert.equal(after.overlay, null);
    assert.equal(after.economy.inventory[kind], before.economy.inventory[kind] + 1);
    assert.equal(after.economy.coins, before.economy.coins, 'rewarded acquisition never spends coins');
  };

  assert.equal(await page.evaluate(() => window.__game.dockButtons().length), 5, 'endless exposes all five tool slots');
  const endlessLabels = await texts();
  assert.ok(endlessLabels.includes('炸弹') && endlessLabels.includes('推土机'));
  await click('settingsButton'); await click('settingsButtons', 2);
  for (let i = 0; i < Math.floor((definition.number - 1) / 10); i++) await click('levelPageButtons', 1);
  await click('levelButtons', (definition.number - 1) % 10);
  if ((await read()).overlay === 'lesson') await click('lessonButton');
  assert.equal((await read()).state.level.id, definition.id);
  assert.equal(await page.evaluate(() => window.__game.dockButtons().length), 5, 'normal campaign play exposes the same five tools');
  assert.equal(await page.evaluate(() => !!window.__game.hintButton()), true);

  for (const viewport of [{ width: 320, height: 568 }, { width: 375, height: 667 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); await page.waitForTimeout(80);
    const layout = await page.evaluate(() => {
      const g = window.__game;
      return { tools: g.dockButtons(), boardBottom: g.board.y + g.board.h, trayTop: g.slots[0].y,
        trayBottom: g.slots[0].y + g.slots[0].h, safeBottom: g.logicalH - g.safeBottom,
        canvasBottom: document.querySelector('canvas').getBoundingClientRect().bottom };
    });
    assert.equal(layout.tools.length, 5);
    const sorted = [...layout.tools].sort((a, b) => a.x - b.x);
    for (const [index, r] of sorted.entries()) {
      assert.ok(r.x >= 0 && r.x + r.w <= 390 && r.y > layout.trayBottom && r.y + r.h <= layout.safeBottom,
        'all five tools sit below the tray and above the bottom safe area');
      if (index) assert.ok(sorted[index - 1].x + sorted[index - 1].w <= r.x, 'all five tools have separate touch targets');
    }
    assert.ok(layout.boardBottom < layout.trayTop);
    assert.ok(layout.canvasBottom <= viewport.height + 1);
    await page.screenshot({ path: `.local/qa/destructive-tools-${viewport.width}.png` });
  }
  await page.evaluate(() => window.__game.resize(390, 844, 2, 44, 34, 60));
  await page.screenshot({ path: '.local/qa/destructive-tools-native.png' });

  await fixture();
  assert.equal(await page.evaluate(() => window.__game.destructiveButtons().length), 2, 'loss dialog retains quick access to both rescue tools');
  const rescueLayout = await page.evaluate(() => {
    const g = window.__game;
    return { tools: g.destructiveButtons(), modal: g.modalButtons(), safeBottom: g.logicalH - g.safeBottom, safeTop: g.safeTop };
  });
  assert.deepEqual(rescueLayout.tools, rescueLayout.modal.slice(3, 5));
  assert.ok(rescueLayout.tools.every(r => r.x >= 0 && r.x + r.w <= 390 && r.y >= rescueLayout.safeTop && r.y + r.h <= rescueLayout.safeBottom));
  await page.screenshot({ path: '.local/qa/destructive-failure-dialog.png' });

  // Empty stock opens the acquisition sheet first. An unavailable real browser
  // gateway, cancelled video or failed callback must neither grant nor apply.
  await fixture();
  let before = await read();
  await beginAcquisition(0); await page.waitForFunction(() => !window.__game.rewardBusy);
  unchanged(before, await read(), 'an unavailable ad gives no bomb');
  assert.equal((await read()).overlay, 'acquire', 'the player can retry or choose coins after an unavailable video');
  for (const index of [0, 1]) for (const result of ['unavailable', 'cancelled', 'error', 'busy']) {
    await fixture(); await deferred(); before = await read();
    const kind = await beginAcquisition(index); await page.waitForFunction(() => window.__game.rewardBusy);
    assert.deepEqual(await page.evaluate(() => window.__destructiveCalls), [kind]);
    await settle(result); unchanged(before, await read(), `${result} grants no ${kind}`);
  }

  // Complete viewing grants one inventory item. A second explicit click uses
  // that stock, independent of the ad callback, and debits exactly once.
  for (const [random, origin] of [[0, { x: 0, y: 0 }], [.999999, { x: 5, y: 5 }]]) {
    await fixture(); await deferred(); before = await read();
    await page.evaluate(random => { window.__originalRandom = Math.random; Math.random = () => random; }, random);
    await beginAcquisition(0); await page.waitForFunction(() => window.__game.rewardBusy);
    await click('acquireButtons', 0);
    assert.deepEqual(await page.evaluate(() => window.__destructiveCalls), ['bomb'], 'concurrent clicks cannot request a second ad');
    unchanged(before, await read(), 'loading/showing an ad never changes the board or stock');
    await settle('completed');
    const stocked = await read(); acquired(before, stocked, 'bomb');
    await page.evaluate(() => window.__finishDestructive('completed'));
    unchanged(stocked, await read(), 'a repeated completed callback cannot grant twice');
    await click('destructiveButtons', 0);
    await page.evaluate(() => { Math.random = window.__originalRandom; });
    const after = await read();
    checkArea(before, after, Array.from({ length: 9 }, (_, i) => ({ x: origin.x + i % 3, y: origin.y + Math.floor(i / 3) })));
    assert.equal(after.economy.inventory.bomb, 0);
    assert.equal(after.state.status, 'playing');
    await page.evaluate(() => window.__finishDestructive('completed'));
    unchanged(after, await read(), 'a repeated callback cannot explode twice after consumption');
    assert.equal(await page.evaluate(() => window.__game.dockButtons().length), 5, 'the dock remains available after rescue');
    await fixture(); await deferred(); before = await read();
    await beginAcquisition(0); await page.waitForFunction(() => window.__game.rewardBusy);
    await settle('cancelled'); unchanged(before, await read(), 'used stock cannot supply a later loss for free');
  }

  await fixture(); await deferred(); before = await read();
  await beginAcquisition(1); await page.waitForFunction(() => window.__game.rewardBusy); await settle('completed');
  acquired(before, await read(), 'bulldozer');
  await click('destructiveButtons', 1);
  checkArea(before, await read(), Array.from({ length: 24 }, (_, i) => ({ x: i % 8, y: 5 + Math.floor(i / 8) })));
  assert.equal((await read()).economy.inventory.bulldozer, 0);
  await page.waitForTimeout(80); await page.screenshot({ path: '.local/qa/bulldozer-applied.png' });

  // Owned tools are checked for efficacy before stock is consumed.
  for (const [index, value] of [[0, 'empty'], [1, 'top-only']]) {
    await fixture(value); await deferred();
    await page.evaluate(index => { const g = window.__game; g.economy.inventory[index === 0 ? 'bomb' : 'bulldozer'] = 1; }, index);
    before = await read();
    await click('destructiveButtons', index);
    assert.deepEqual(await page.evaluate(() => window.__destructiveCalls), []);
    const after = await read();
    // These deliberately malformed lost fixtures may normalize to playing in
    // rotation cleanup; no cells, goals, coins or inventory may be affected.
    unchanged(before, { ...after, state: { ...after.state, status: before.state.status } }, 'an ineffective tool consumes nothing');
  }

  for (const index of [0, 1]) {
    await fixture(); await deferred();
    await page.evaluate(index => {
      const g = window.__game; g.state = { ...g.state, moves: g.levelDefinition.maxMoves + 100,
        level: { ...g.state.level, timeRemainingMs: 0 } };
      g.economy.inventory[index === 0 ? 'bomb' : 'bulldozer'] = 1;
      if (index === 0) { window.__originalRandom = Math.random; Math.random = () => 0; }
      g.invalidate();
    }, index);
    before = await read();
    await click('destructiveButtons', index);
    if (index === 0) await page.evaluate(() => { Math.random = window.__originalRandom; });
    const after = await read();
    assert.deepEqual(await page.evaluate(() => window.__destructiveCalls), [], 'owned rescue stock needs no new ad');
    assert.equal(after.state.status, 'playing', 'unlimited campaign rescue ignores stale clock data and the offline move estimate');
    assert.equal(after.economy.inventory[index === 0 ? 'bomb' : 'bulldozer'], 0);
    checkArea(before, after, index === 0
      ? Array.from({ length: 9 }, (_, i) => ({ x: i % 3, y: Math.floor(i / 3) }))
      : Array.from({ length: 24 }, (_, i) => ({ x: i % 8, y: 5 + Math.floor(i / 8) })));
    assert.equal(await page.evaluate(() => window.__game.levelClockTimer), null, 'no countdown worker is created by a rescue');
  }

  await fixture(); await deferred();
  await beginAcquisition(0); await page.waitForFunction(() => window.__game.rewardBusy);
  await page.evaluate(() => window.__game.reset());
  before = await read();
  await settle('completed'); unchanged(before, await read(), 'a callback from an earlier session cannot grant into a retried run');

  await fixture('win'); await deferred(); before = await read();
  await beginAcquisition(1); await page.waitForFunction(() => window.__game.rewardBusy); await settle('completed');
  await click('destructiveButtons', 1);
  const won = await read();
  assert.equal(won.state.status, 'won');
  assert.ok(won.progress.completed.includes(definition.id));
  const expectedStars = won.state.score >= definition.starScores[2] ? 3 : won.state.score >= definition.starScores[1] ? 2 : 1;
  assert.equal(won.settlement.stars, expectedStars);
  assert.equal(won.economy.coins - before.economy.coins, [0, 10, 15, 40][expectedStars]);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('wood-blocks.campaign.v1')));
  assert.ok(saved.completed.includes(definition.id));
  preserved(before, won);
  await page.waitForTimeout(650); await page.screenshot({ path: '.local/qa/destructive-win.png' });

  // The same dock can clear blocks during live campaign and endless play.
  await fixture();
  await page.evaluate(() => {
    const g = window.__game; g.state = { ...g.state, status: 'playing' };
    g.economy.inventory.bomb = 1; g.invalidate();
  });
  before = await read();
  await click('dockButtons', 3);
  let after = await read();
  assert.equal(after.economy.inventory.bomb, 0);
  assert.notDeepEqual(after.state.board, before.state.board);
  preserved(before, after);
  for (const index of [3, 4]) {
    await page.evaluate(index => {
      const g = window.__game; g.reset();
      const board = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => (x + y) % 2 ? 3 : 0));
      g.state = { ...g.state, mode: 'endless', level: undefined, board, status: 'playing', score: 555, tutorial: false };
      g.overlay = null; g.economy.inventory[index === 3 ? 'bomb' : 'bulldozer'] = 1; g.invalidate();
    }, index);
    before = await read();
    await click('dockButtons', index); after = await read();
    assert.equal(after.economy.inventory[index === 3 ? 'bomb' : 'bulldozer'], 0);
    assert.notDeepEqual(after.state.board, before.state.board);
    assert.equal(after.state.level, undefined);
    assert.equal(after.state.status, 'playing');
    preserved(before, after);
  }

  // Destruction of the app while an acquisition is pending must not grant.
  await fixture(); await deferred();
  await page.evaluate(() => { const g = window.__game; g.state = { ...g.state, status: 'playing' }; g.invalidate(); });
  await beginAcquisition(1, 'dockButtons'); await page.waitForFunction(() => window.__game.rewardBusy);
  await page.evaluate(() => window.__game.destroy()); before = await read();
  await page.evaluate(() => window.__finishDestructive('completed')); await page.waitForTimeout(30);
  unchanged(before, await read(), 'an ad completion after unload cannot grant stock');
  assert.deepEqual(errors, []);
  console.log('Destructive UI smoke passed: five-tool responsive dock, explicit ad acquisition and one-stock consumption, campaign/endless live use, in-bounds 3×3 bomb, bottom-three-row bulldozer, objectives and wins, stale/duplicate callbacks, no-op guards, unlimited rescues beyond the move estimate with stale zero clock data.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
