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
const server = serve(0); await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}/?debug=1&test=off`;
const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(localChrome) ? localChrome : undefined);
const errors = [];
let browser;
function driver(page) {
  const read = () => page.evaluate(() => {
    const g = window.__game;
    const state = structuredClone(g.state); if (state.level) delete state.level.timeRemainingMs;
    return { state, economy: g.economy, settlement: g.settlement, run: g.levelRunId, busy: g.rewardBusy, acquireKind: g.acquireKind,
      progress: g.campaignProgress, overlay: g.overlay, ghost: g.ghost, hint: g.hint, rotation: g.rotationMode,
      saved: localStorage.getItem('wood-blocks.economy.v1') };
  });
  const click = async (method, index = 0) => {
    const point = await page.evaluate(({ method, index }) => {
      const g = window.__game, canvas = document.querySelector('canvas').getBoundingClientRect();
      const result = typeof g[method] === 'function' ? g[method]() : g[method], r = Array.isArray(result) ? result[index] : result;
      if (!r) throw new Error(`Missing ${method} ${index}`);
      return { x: canvas.left + g.offsetX + (r.x + r.w / 2) * g.scale,
        y: canvas.top + g.offsetY + (r.y + r.h / 2) * g.scale };
    }, { method, index });
    assert.ok(point.x >= 0 && point.x <= page.viewportSize().width && point.y >= 0 && point.y <= page.viewportSize().height);
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => !window.__game.pendingDestruction);
  };
  const drag = async move => {
    const points = await page.evaluate(move => {
      const g = window.__game, p = g.state.pieces[move.index], slot = g.slots[move.index], canvas = document.querySelector('canvas').getBoundingClientRect();
      const width = Math.max(...p.cells.map(c => c.x + 1)), height = Math.max(...p.cells.map(c => c.y + 1));
      const convert = (x, y) => ({ x: canvas.left + g.offsetX + x * g.scale, y: canvas.top + g.offsetY + y * g.scale });
      return { start: convert(slot.x + slot.w / 2, slot.y + slot.h / 2), end: convert(g.board.x + (move.x + width / 2) * g.cell, g.board.y + (move.y + height / 2) * g.cell) };
    }, move);
    await page.mouse.move(points.start.x, points.start.y); await page.mouse.down();
    await page.mouse.move(points.end.x, points.end.y, { steps: 3 }); await page.mouse.up();
  };
  const map = async () => {
    const snapshot = await read();
    if (snapshot.overlay !== 'levels') {
      if (snapshot.state.status === 'playing') { await click('settingsButton'); await click('settingsButtons', 2); }
      else await click('modalButtons', 2);
    }
  };
  const choose = async index => {
    await map();
    while (await page.evaluate(() => window.__game.levelPage) !== Math.floor(index / 10)) {
      const current = await page.evaluate(() => window.__game.levelPage);
      await click('levelPageButtons', current < Math.floor(index / 10) ? 1 : 0);
    }
    await click('levelButtons', index % 10);
    if ((await read()).overlay === 'lesson') await click('lessonButton');
  };
  const play = async definition => {
    for (const move of definition.solution) { await drag(move); if ((await read()).state.status === 'won') break; }
    assert.equal((await read()).state.status, 'won');
  };
  const deferred = () => page.evaluate(() => {
    window.__economyCalls = []; window.__economyFinish = null;
    window.__game.options.rewarded = { request(kind) { window.__economyCalls.push(kind); return new Promise(resolve => { window.__economyFinish = resolve; }); }, dispose() {} };
  });
  const settle = async result => { await page.evaluate(result => window.__economyFinish(result), result); await page.waitForFunction(() => !window.__game.rewardBusy); };
  return { read, click, drag, map, choose, play, deferred, settle };
}
const inventoryTotal = state => Object.values(state.inventory).reduce((sum, count) => sum + count, 0);
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('wood-blocks.tutorial-seen.v1', 'true'));
  await page.goto(url); await page.waitForFunction(() => window.__game?.assets?.ready);
  const d = driver(page);
  assert.deepEqual((await d.read()).economy.inventory, { hint: 3, rotate: 3, refresh: 3, bomb: 0, bulldozer: 0 });
  assert.equal((await d.read()).economy.coins, 0);
  await d.choose(0); await d.play(LEVELS[0]);
  let snapshot = await d.read();
  assert.equal(snapshot.settlement.stars, 3);
  assert.equal(snapshot.economy.coins, 40);
  assert.equal(snapshot.settlement.coinsGranted, 40);
  assert.equal(snapshot.settlement.chest.count, 1);
  assert.ok(['hint', 'rotate', 'refresh'].includes(snapshot.settlement.chest.kind));
  assert.equal(inventoryTotal(snapshot.economy), 10, 'a first three-star win grants exactly one ordinary tool');
  assert.deepEqual(JSON.parse(snapshot.saved), snapshot.economy);
  await page.waitForTimeout(650); await page.screenshot({ path: '.local/qa/economy-first-three-stars.png' });
  const beforeDouble = structuredClone(snapshot.economy);
  // The real preview gateway has no ad SDK and cannot mint doubled coins.
  await d.click('modalButtons', 3); await page.waitForFunction(() => !window.__game.rewardBusy);
  assert.deepEqual((await d.read()).economy, beforeDouble);
  for (const result of ['cancelled', 'error']) {
    await d.deferred(); await d.click('modalButtons', 3); await page.waitForFunction(() => window.__game.rewardBusy);
    assert.deepEqual(await page.evaluate(() => window.__economyCalls), ['doubleCoins']);
    await d.settle(result); assert.deepEqual((await d.read()).economy, beforeDouble);
  }
  await d.deferred(); await d.click('modalButtons', 3); await page.waitForFunction(() => window.__game.rewardBusy);
  await d.click('modalButtons', 0);
  assert.equal((await d.read()).state.level.id, LEVELS[0].id, 'next-level clicks are blocked while a reward is pending');
  assert.deepEqual(await page.evaluate(() => window.__economyCalls), ['doubleCoins']);
  await d.settle('completed'); snapshot = await d.read();
  assert.equal(snapshot.economy.coins, 80);
  assert.deepEqual(snapshot.economy.inventory, beforeDouble.inventory, 'coin doubling never duplicates the three-star chest');
  const doubled = structuredClone(snapshot.economy);
  await page.evaluate(() => window.__economyFinish('completed'));
  assert.deepEqual((await d.read()).economy, doubled, 'duplicate ad callbacks cannot double twice');
  await d.click('modalButtons', 3);
  assert.equal((await page.evaluate(() => window.__economyCalls)).length, 1, 'a claimed double does not request another video');

  await d.click('modalButtons', 1); await d.play(LEVELS[0]); snapshot = await d.read();
  assert.equal(snapshot.settlement.coinsGranted, 0);
  assert.equal(snapshot.settlement.chest, null);
  assert.deepEqual(snapshot.economy.inventory, doubled.inventory);
  assert.equal(snapshot.economy.coins, 80, 'replaying the same three-star level earns no repeat currency');

  // Isolate star-band accounting with real placements; the independent rule
  // tests and full witness run separately prove these score bands are valid.
  await d.click('modalButtons', 0);
  const rewardFixture = async finalScore => page.evaluate(finalScore => {
    const g = window.__game; g.reset();
    const board = Array.from({ length: 8 }, () => Array(8).fill(0)); board[0] = [1, 1, 1, 1, 1, 1, 1, 0];
    // Ten displayed seconds add 100 on this final drop. Keep the target band
    // inclusive of the genuine one-time clock reward, rather than bypassing it.
    g.state = { ...g.state, board, score: finalScore - 130, combo: 0, moves: 0, lines: g.levelDefinition.goals[0].target - 1,
      level: { ...g.state.level, timeRemainingMs: 10_000 },
      pieces: [{ id: 'score-band-drop', color: 1, cells: [{ x: 0, y: 0 }] }, null, null], status: 'playing' };
    g.overlay = null; g.particles = []; g.clearFx = null; g.placeFx = null; g.pop.at = 0; g.invalidate();
  }, finalScore);
  await rewardFixture(LEVELS[1].starScores[1] - 1); await d.drag({ index: 0, x: 7, y: 0 });
  snapshot = await d.read();
  assert.equal(snapshot.settlement.stars, 1); assert.equal(snapshot.settlement.coinsGranted, 10); assert.equal(snapshot.economy.coins, 90);
  await d.deferred(); await d.click('modalButtons', 3); await page.waitForFunction(() => window.__game.rewardBusy);
  await page.evaluate(() => window.__game.reset()); const afterReset = (await d.read()).economy;
  await d.settle('completed'); assert.deepEqual((await d.read()).economy, afterReset, 'an old-run double cannot reward a retried session');
  await rewardFixture(LEVELS[1].starScores[1] - 1); await d.drag({ index: 0, x: 7, y: 0 });
  assert.equal((await d.read()).settlement.coinsGranted, 0, 'a repeated one-star band also pays zero');
  await rewardFixture(LEVELS[1].starScores[1]); await d.drag({ index: 0, x: 7, y: 0 });
  snapshot = await d.read();
  assert.equal(snapshot.settlement.stars, 2); assert.equal(snapshot.settlement.coinsGranted, 5); assert.equal(snapshot.economy.coins, 95);
  await d.deferred(); await d.click('modalButtons', 3); await page.waitForFunction(() => window.__game.rewardBusy); await d.settle('completed');
  assert.equal((await d.read()).economy.coins, 100, 'two-star upgrade doubling adds this run\'s 5, not the cumulative15');
  const beforeThird = (await d.read()).economy;
  await rewardFixture(LEVELS[1].starScores[2]); await d.drag({ index: 0, x: 7, y: 0 });
  snapshot = await d.read();
  assert.equal(snapshot.settlement.stars, 3); assert.equal(snapshot.settlement.coinsGranted, 25); assert.equal(snapshot.economy.coins, 125);
  assert.equal(inventoryTotal(snapshot.economy), inventoryTotal(beforeThird) + 1, 'upgrading to three stars grants a single chest once');

  await d.click('modalButtons', 1);
  await page.evaluate(() => {
    const g = window.__game, board = Array.from({ length: 8 }, () => Array(8).fill(0));
    for (let y = 0; y < 2; y++) for (let x = 0; x < 6; x++) board[y][x] = 2;
    g.state = { ...g.state, board, pieces: [0, 4].map((color, index) => ({ id: `same-shape-color-${index}`, color,
      cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] })).concat(null) };
    g.invalidate();
  });
  let before = await d.read();
  await d.click('hintButton'); snapshot = await d.read();
  assert.equal(snapshot.economy.inventory.hint, before.economy.inventory.hint - 1);
  assert.equal(snapshot.state.moves, before.state.moves, 'a hint previews a legal move without placing it');
  assert.ok(snapshot.hint, 'the hint highlights a legal origin without using the placement ghost');
  const hintLabels = await page.evaluate(() => {
    const g = window.__game, labels = [], strokes = [], fillText = g.ctx.fillText, stroke = g.ctx.stroke;
    g.ctx.fillText = function (value, x, y, ...args) { labels.push({ text: String(value), x, y, color: this.fillStyle }); return fillText.call(this, value, x, y, ...args); };
    g.ctx.stroke = function (...args) { strokes.push(this.strokeStyle); return stroke.apply(this, args); };
    try { g.draw(); } finally { g.ctx.fillText = fillText; g.ctx.stroke = stroke; }
    return { labels, strokes, slot: g.slots[g.hint.index], index: g.hint.index };
  });
  const hintLabel = hintLabels.labels.find(label => label.text === '提示方块');
  assert.ok(hintLabel, 'the candidate tray explicitly identifies the hinted piece');
  assert.equal(hintLabel.x, hintLabels.slot.x + hintLabels.slot.w / 2);
  assert.ok(hintLabels.labels.some(label => new RegExp(`第\\s*${hintLabels.index + 1}\\s*块`).test(label.text)), 'the hint message names the exact candidate slot');
  assert.ok(hintLabels.strokes.includes(hintLabel.color), 'the candidate label color is also used by the hint outlines');
  await page.screenshot({ path: '.local/qa/economy-hint-same-shape-colors.png' });
  await page.evaluate(() => window.__game.reset());
  assert.equal((await d.read()).economy.inventory.hint, snapshot.economy.inventory.hint, 'retry never replenishes campaign stock');
  before = await d.read(); await d.click('powerButtons', 1); snapshot = await d.read();
  assert.equal(snapshot.economy.inventory.refresh, before.economy.inventory.refresh - 1);
  assert.ok(snapshot.state.pieces.every(piece => !piece || piece.cells.length === 1));
  assert.equal(snapshot.state.moves, before.state.moves);
  await page.evaluate(() => {
    const g = window.__game; g.reset();
    g.state = { ...g.state, board: Array.from({ length: 8 }, () => Array(8).fill(0)), pieces: [
      { id: 'inventory-turnable', color: 2, cells: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] },
      { id: 'inventory-square', color: 1, cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] }, null] };
    g.invalidate();
  });
  before = await d.read(); await d.click('powerButtons', 0); await d.click('slots', 0);
  assert.equal((await d.read()).economy.inventory.rotate, before.economy.inventory.rotate, 'rotation preview is free');
  await d.drag({ index: 0, x: 0, y: 0 });
  assert.equal((await d.read()).economy.inventory.rotate, before.economy.inventory.rotate - 1, 'only placed changed orientation spends stock');
  await page.evaluate(() => { const g = window.__game; g.reset(); g.economy = { ...g.economy, inventory: { ...g.economy.inventory, hint: 0 } }; });
  await d.deferred(); before = await d.read(); await d.click('hintButton');
  snapshot = await d.read();
  assert.equal(snapshot.overlay, 'acquire'); assert.equal(snapshot.acquireKind, 'hint');
  assert.equal(snapshot.busy, false, 'an empty tool opens acquisition choices without automatically starting a video');
  assert.deepEqual(await page.evaluate(() => window.__economyCalls), []);
  await d.click('acquireButtons', 0); await page.waitForFunction(() => window.__game.rewardBusy);
  await d.settle('cancelled'); snapshot = await d.read();
  assert.equal(snapshot.economy.inventory.hint, 0); assert.equal(snapshot.overlay, 'acquire');
  assert.deepEqual(snapshot.economy, before.economy, 'cancelling a video neither grants a tool nor charges coins');
  await d.click('acquireButtons', 0); await page.waitForFunction(() => window.__game.rewardBusy); await d.settle('completed');
  snapshot = await d.read();
  assert.equal(snapshot.overlay, null); assert.equal(snapshot.acquireKind, null);
  assert.equal(snapshot.economy.inventory.hint, 1, 'a completed video grants one hint and closes acquisition without consuming it');
  assert.equal(snapshot.economy.coins, before.economy.coins);
  assert.equal(snapshot.state.moves, before.state.moves);
  assert.deepEqual(await page.evaluate(() => window.__economyCalls), ['hint', 'hint']);
  await d.click('hintButton'); snapshot = await d.read();
  assert.equal(snapshot.economy.inventory.hint, 0, 'a separate click uses the newly acquired hint exactly once');
  assert.ok(snapshot.hint); assert.equal(snapshot.state.moves, before.state.moves);
  const savedEconomy = snapshot.economy;
  await page.reload(); await page.waitForFunction(() => window.__game?.assets?.ready);
  assert.deepEqual((await d.read()).economy, savedEconomy, 'currency, stock and best stars survive reload');

  await d.map(); await d.click('rankButton');
  await page.waitForFunction(() => window.__game.rankingResult && !window.__game.rankingLoading);
  assert.equal(await page.evaluate(() => window.__game.rankingResult.status), 'unconfigured');
  assert.deepEqual(await page.evaluate(() => window.__game.rankingResult.entries), [], 'preview has no fabricated global users');
  await d.click('rankingTabs', 1); await page.waitForFunction(() => !window.__game.rankingLoading);
  assert.deepEqual(await page.evaluate(() => window.__game.rankingResult.entries), [], 'preview has no fabricated friend scores');
  await page.screenshot({ path: '.local/qa/leaderboard-unconfigured.png' });

  const unlockedContext = await browser.newContext({ viewport: { width: 375, height: 667 } });
  const unlockedPage = await unlockedContext.newPage(); unlockedPage.on('pageerror', error => errors.push(`unlock: ${error.message}`));
  await unlockedPage.addInitScript(() => localStorage.setItem('wood-blocks.tutorial-seen.v1', 'true'));
  await unlockedPage.goto(`${url}&unlock=all`); await unlockedPage.waitForFunction(() => window.__game?.assets?.ready);
  const u = driver(unlockedPage);
  assert.deepEqual((await u.read()).progress.completed, []); assert.equal((await u.read()).economy.coins, 0);
  await u.choose(29); await u.play(LEVELS[29]);
  assert.deepEqual((await u.read()).progress.completed, [LEVELS[29].id], 'test unlock records only the actually completed level');
  assert.deepEqual(Object.keys((await u.read()).economy.levels), [LEVELS[29].id]);
  assert.equal((await u.read()).economy.coins, 40, 'test unlock never grants the skipped levels\' rewards');
  await unlockedPage.goto(url); await unlockedPage.waitForFunction(() => window.__game?.assets?.ready);
  await u.choose(1);
  assert.equal((await u.read()).overlay, 'levels', 'ordinary entry still requires missing earlier wins');
  await unlockedContext.close();
  assert.deepEqual(errors, []);
  console.log('Economy UI smoke passed: real three-star win/chest, score-band upgrade differences, single completed-ad coin doubles, replay/stale-callback guards, five-tool inventory, explicit ad acquisition then separate tool use, reload, unavailable rankings, and test unlock without invented progress.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
