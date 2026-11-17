import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { buildAll } from './build.mjs';
import { serve } from './server.mjs';
import { LEVELS } from '../src/core/levels.ts';
import { TOOL_PRICES } from '../src/services/economy.ts';

await buildAll();
await mkdir('.local/qa', { recursive: true });
const server = serve(0); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(localChrome) ? localChrome : undefined);
const kinds = ['hint', 'rotate', 'refresh', 'bomb', 'bulldozer'];
const errors = [];
let browser;

function driver(page) {
  const read = () => page.evaluate(() => {
    const g = window.__game;
    const state = structuredClone(g.state); if (state.level) delete state.level.timeRemainingMs;
    return { state, economy: g.economy, overlay: g.overlay, busy: g.rewardBusy,
      hint: g.hint, rotation: g.rotationMode, uses: g.powerUses, settlement: g.settlement,
      message: g.acquireMessage, calls: window.__rewardCalls };
  });
  const click = async (method, index = 0) => {
    const point = await page.evaluate(({ method, index }) => {
      const g = window.__game, canvas = document.querySelector('canvas').getBoundingClientRect();
      const value = typeof g[method] === 'function' ? g[method]() : g[method];
      const r = Array.isArray(value) ? value[index] : value;
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
      const g = window.__game, p = g.state.pieces[move.index], slot = g.slots[move.index];
      const bounds = { w: Math.max(...p.cells.map(c => c.x + 1)), h: Math.max(...p.cells.map(c => c.y + 1)) };
      const canvas = document.querySelector('canvas').getBoundingClientRect();
      const convert = (x, y) => ({ x: canvas.left + g.offsetX + x * g.scale, y: canvas.top + g.offsetY + y * g.scale });
      return { start: convert(slot.x + slot.w / 2, slot.y + slot.h / 2),
        end: convert(g.board.x + (move.x + bounds.w / 2) * g.cell, g.board.y + (move.y + bounds.h / 2) * g.cell) };
    }, move);
    await page.mouse.move(points.start.x, points.start.y); await page.mouse.down();
    await page.mouse.move(points.end.x, points.end.y, { steps: 3 }); await page.mouse.up();
  };
  const finishLevel = async () => {
    await page.evaluate(() => window.__game.reset());
    for (const move of LEVELS[0].solution) {
      await drag(move);
      if ((await read()).state.status === 'won') break;
    }
    assert.equal((await read()).state.status, 'won');
  };
  const prepare = async (kind, coins = 0) => page.evaluate(({ kind, coins }) => {
    const g = window.__game; g.reset();
    g.economy = { ...g.economy, coins, inventory: { ...g.economy.inventory, [kind]: 0 } };
    g.state = { ...g.state, board: Array.from({ length: 8 }, () => Array(8).fill(0)),
      pieces: [
        { id: 'convenience-turnable', color: 0, cells: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] },
        { id: 'convenience-square', color: 4, cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] }, null],
      status: 'playing', tutorial: false };
    g.invalidate();
  }, { kind, coins });
  const chooseFirst = async () => {
    assert.equal((await read()).overlay, 'levels');
    await click('levelButtons', 0);
    if ((await read()).overlay === 'lesson') await click('lessonButton');
    assert.equal((await read()).state.level.id, LEVELS[0].id);
  };
  const lostFixture = async () => page.evaluate(() => {
    const g = window.__game; g.reset();
    g.state = { ...g.state, board: Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => (x + y) % 2 ? 0 : 1)),
      pieces: [{ id: 'convenience-blocked-square', color: 1, cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] }, null, null],
      status: 'lost', tutorial: false, moves: 1, lines: 0, score: 0 };
    g.resultAt = Date.now() - 1000; g.invalidate();
  });
  return { read, click, drag, finishLevel, prepare, chooseFirst, lostFixture };
}

async function openPage(testOff = false) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('wood-blocks.tutorial-seen.v1', 'true'));
  await page.goto(`${origin}/?play=levels&unlock=all&debug=1${testOff ? '&test=off' : ''}`);
  await page.waitForFunction(() => window.__game?.assets?.ready);
  const d = driver(page); await d.chooseFirst();
  return { context, page, ...d };
}

try {
  browser = await chromium.launch({ executablePath, headless: true });
  const d = await openPage();
  assert.equal(await d.page.evaluate(() => window.__game.options.testConvenience), true);
  await d.page.evaluate(() => {
    window.__rewardCalls = [];
    window.__game.options.rewarded = { request(kind) { window.__rewardCalls.push(kind); throw new Error('Test mode must never call the ad gateway'); }, dispose() {} };
  });

  for (const [index, kind] of kinds.entries()) for (const acquisition of [0, 1]) {
    await d.prepare(kind, 0);
    const before = await d.read();
    await d.click('dockButtons', index);
    assert.equal((await d.read()).overlay, 'acquire');
    await d.click('acquireButtons', acquisition);
    await d.page.waitForFunction(kind => window.__game.economy.inventory[kind] === 1 && window.__game.overlay === null, kind);
    const after = await d.read();
    assert.equal(after.economy.coins, 0, `${kind}: ${acquisition === 0 ? 'ad' : 'coin'} test acquisition needs no funds and debits none`);
    assert.deepEqual(after.state, before.state, 'acquisition never places or destroys blocks before a separate use click');
    assert.deepEqual(after.calls, [], 'test acquisition calls no real or injected ad interface');
  }

  await d.prepare('hint', 100); await d.click('dockButtons', 0); await d.click('acquireButtons', 1);
  await d.page.waitForFunction(() => window.__game.overlay === null);
  assert.equal((await d.read()).economy.coins, 100, 'test coin acquisition also preserves an existing positive balance');
  assert.equal((await d.read()).economy.inventory.hint, 1);

  await d.prepare('hint'); await d.click('dockButtons', 0); await d.click('acquireButtons', 0);
  await d.page.waitForFunction(() => window.__game.overlay === null);
  await d.click('dockButtons', 0);
  assert.equal((await d.read()).economy.inventory.hint, 0); assert.ok((await d.read()).hint);
  assert.equal((await d.read()).state.moves, 0);

  await d.prepare('refresh'); await d.click('dockButtons', 2); await d.click('acquireButtons', 1);
  await d.page.waitForFunction(() => window.__game.overlay === null);
  await d.click('dockButtons', 2);
  assert.equal((await d.read()).economy.inventory.refresh, 0);
  assert.ok((await d.read()).state.pieces.every(piece => !piece || piece.cells.length === 1));

  await d.prepare('rotate'); await d.click('dockButtons', 1); await d.click('acquireButtons', 0);
  await d.page.waitForFunction(() => window.__game.overlay === null);
  await d.click('dockButtons', 1); await d.click('slots', 0);
  assert.equal((await d.read()).economy.inventory.rotate, 1, 'rotation previews stay free');
  await d.drag({ index: 0, x: 0, y: 0 });
  assert.equal((await d.read()).economy.inventory.rotate, 0); assert.equal((await d.read()).state.moves, 1);

  for (const [kind, dockIndex] of [['bomb', 3], ['bulldozer', 4]]) {
    await d.prepare(kind); await d.click('dockButtons', dockIndex); await d.click('acquireButtons', 1);
    await d.page.waitForFunction(() => window.__game.overlay === null);
    await d.page.evaluate(() => {
      const g = window.__game;
      g.state = { ...g.state, board: Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => (x + y) % 2 ? 0 : 1)) };
      window.__originalRandom = Math.random; Math.random = () => 0; g.invalidate();
    });
    const before = await d.read(); await d.click('dockButtons', dockIndex); const after = await d.read();
    await d.page.evaluate(() => { Math.random = window.__originalRandom; });
    assert.equal(after.economy.inventory[kind], 0, 'separate tool use consumes the granted item once');
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const inside = kind === 'bomb' ? x < 3 && y < 3 : y >= 5;
      assert.equal(after.state.board[y][x], inside ? 0 : before.state.board[y][x], 'a test grant never changes the actual destruction geometry');
    }
    assert.equal(after.state.moves, before.state.moves); assert.equal(after.economy.coins, 0);
  }

  await d.lostFixture(); const beforeRevive = await d.read();
  await d.click('modalButtons', 0); await d.page.waitForFunction(() => window.__game.state.status === 'playing');
  const revived = await d.read();
  assert.equal(revived.uses.revive, 1); assert.equal(revived.state.score, beforeRevive.state.score);
  assert.equal(revived.economy.coins, beforeRevive.economy.coins);

  await d.finishLevel(); const win = await d.read();
  assert.equal(win.settlement.coinsGranted, 40);
  await d.click('modalButtons', 3); await d.page.waitForFunction(() => !window.__game.rewardBusy);
  const doubled = await d.read();
  assert.equal(doubled.economy.coins, win.economy.coins + 40);
  assert.deepEqual(doubled.economy.inventory, win.economy.inventory, 'test double coins cannot duplicate the chest');
  await d.click('modalButtons', 3); assert.deepEqual((await d.read()).economy, doubled.economy);
  assert.deepEqual((await d.read()).calls, [], 'all seven ad placements remain inside the local test branch');
  await d.page.waitForTimeout(50); await d.page.screenshot({ path: '.local/qa/test-convenience-double.png' });

  const live = await openPage(true);
  assert.equal(await live.page.evaluate(() => window.__game.options.testConvenience), false);
  await live.page.evaluate(() => {
    window.__rewardCalls = []; window.__rewardResult = 'cancelled';
    window.__game.options.rewarded = { request(kind) { window.__rewardCalls.push(kind); return Promise.resolve(window.__rewardResult); }, dispose() {} };
  });
  await live.prepare('hint', 0); const beforeLive = await live.read();
  await live.click('dockButtons', 0);
  for (const result of ['cancelled', 'error']) {
    await live.page.evaluate(result => { window.__rewardResult = result; }, result);
    const count = (await live.read()).calls.length;
    await live.click('acquireButtons', 0);
    await live.page.waitForFunction(count => !window.__game.rewardBusy && window.__rewardCalls.length === count + 1, count);
    assert.deepEqual((await live.read()).economy, beforeLive.economy, 'normal-mode cancelled or failed ads never grant tools');
    assert.equal((await live.read()).overlay, 'acquire');
  }
  const beforePoor = await live.read();
  await live.click('acquireButtons', 1);
  assert.equal((await live.read()).overlay, 'acquire');
  assert.deepEqual((await live.read()).economy, beforePoor.economy, 'normal-mode coin acquisition still needs enough coins');
  await live.page.evaluate(() => { window.__game.economy = { ...window.__game.economy, coins: 100 }; });
  await live.click('acquireButtons', 1); const purchased = await live.read();
  assert.equal(purchased.overlay, null); assert.equal(purchased.economy.inventory.hint, 1);
  assert.equal(purchased.economy.coins, 100 - TOOL_PRICES.hint, 'normal purchases debit the real tool price');

  await live.lostFixture(); const lost = await live.read();
  await live.click('modalButtons', 0); await live.page.waitForFunction(() => !window.__game.rewardBusy);
  assert.deepEqual((await live.read()).state, lost.state);
  assert.equal((await live.read()).calls.at(-1), 'revive', 'normal revival still calls the ad gateway');
  await live.finishLevel(); const beforeLiveDouble = await live.read();
  await live.click('modalButtons', 3); await live.page.waitForFunction(() => !window.__game.rewardBusy);
  assert.deepEqual((await live.read()).economy, beforeLiveDouble.economy);
  assert.equal((await live.read()).calls.at(-1), 'doubleCoins', 'normal coin doubling still calls the ad gateway');
  assert.deepEqual(errors, []);
  console.log('Test convenience UI passed: all five ad/coin grants at zero coins, zero gateway calls, normal one-use effects, revive and one-time coin double; test=off keeps real gateway and purchase checks.');
  await live.context.close(); await d.context.close();
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
